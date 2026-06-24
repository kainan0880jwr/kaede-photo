/**
 * kaede photo — 予約受付 Serverless Function
 *
 * POST /.netlify/functions/booking
 *
 * 処理の流れ:
 *   1. Rate Limit チェック（Upstash Redis）
 *   2. 入力バリデーション
 *   3. メール送信（だいきさん宛 + お客様自動返信）← 最優先・独立
 *   4. Notion 台帳記録（失敗してもユーザーには影響させない）
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis }     from '@upstash/redis';
import { Resend }    from 'resend';
import { buildOwnerEmail, buildCustomerEmail } from './utils/email-templates.js';
import { appendToNotion } from './utils/notion.js';

// ── クライアント初期化（コールドスタート時に一度だけ実行）──────────
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ratelimit = new Ratelimit({
  redis,
  // 同一 IP から1時間に5回まで（スパム対策）
  limiter: Ratelimit.slidingWindow(5, '1 h'),
  analytics: true,
  prefix: 'kaede:booking',
});

const resend = new Resend(process.env.RESEND_API_KEY);

// ── CORS プリフライト対応 ──────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.SITE_DOMAIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── バリデーション定義 ─────────────────────────────────────────────
const REQUIRED_FIELDS = ['name', 'email', 'date1', 'location', 'plan', 'kids_count', 'kids_age'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_REGEX  = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {Object} data
 * @returns {string|null} エラーメッセージ or null（バリデーション通過）
 */
function validate(data) {
  for (const field of REQUIRED_FIELDS) {
    if (!data[field] || String(data[field]).trim() === '') {
      return `「${FIELD_LABELS[field]}」は必須です。`;
    }
  }
  if (!EMAIL_REGEX.test(data.email)) {
    return 'メールアドレスの形式が正しくありません。';
  }
  if (!DATE_REGEX.test(data.date1)) {
    return '撮影希望日の形式が正しくありません。';
  }
  if (data.date2 && !DATE_REGEX.test(data.date2)) {
    return '撮影希望日（第2希望）の形式が正しくありません。';
  }
  const kids = Number(data.kids_count);
  if (!Number.isInteger(kids) || kids < 1 || kids > 10) {
    return 'お子さまの人数は 1〜10 の範囲で入力してください。';
  }
  return null;
}

const FIELD_LABELS = {
  name:       'お名前',
  email:      'メールアドレス',
  date1:      '撮影希望日 第1希望',
  location:   '撮影場所・エリア',
  plan:       'ご希望のプラン',
  kids_count: 'お子さまの人数',
  kids_age:   'お子さまの年齢',
};

// ── メインハンドラー ────────────────────────────────────────────────
export const handler = async (event) => {
  // プリフライトリクエスト（OPTIONS）への対応
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  // ── 1. Rate Limit チェック ──────────────────────────────────────
  const ip =
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    '127.0.0.1';

  const { success, limit, remaining, reset } = await ratelimit.limit(ip);

  if (!success) {
    const resetDate = new Date(reset).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    return {
      statusCode: 429,
      headers: {
        ...CORS_HEADERS,
        'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
      },
      body: JSON.stringify({
        error: `送信回数の上限（${limit}回/時間）に達しました。${resetDate} 以降に再度お試しください。`,
      }),
    };
  }

  // ── 2. 入力バリデーション ───────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'リクエストの形式が正しくありません。' }),
    };
  }

  const validationError = validate(data);
  if (validationError) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: validationError }),
    };
  }

  // ── 3. メール送信（最優先・並列実行）──────────────────────────────
  const ownerEmail    = process.env.OWNER_EMAIL    || 'kaepafu1995@gmail.com';
  const fromAddress   = `kaede photo <noreply@${(process.env.SITE_DOMAIN || 'kaedephoto.com').replace('https://', '')}>`;

  const emailResults = await Promise.allSettled([
    // だいきさんへの通知（replyTo にお客様メールをセット → 直接返信できる）
    resend.emails.send({
      from:    fromAddress,
      to:      ownerEmail,
      replyTo: data.email,
      subject: `【仮予約】${data.name} 様 — 第1希望: ${data.date1}`,
      html:    buildOwnerEmail(data),
    }),
    // お客様への自動返信
    resend.emails.send({
      from:    fromAddress,
      to:      data.email,
      subject: 'ご予約申込を受け付けました — kaede photo',
      html:    buildCustomerEmail(data),
    }),
  ]);

  // どちらか一方でもメール失敗 → 500 を返す（メールが届かない予約は受け付けない）
  const failures = emailResults.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    console.error('[booking] Email send failed:', failures.map(f => f.reason));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'メールの送信に失敗しました。お手数ですが、kaepafu1995@gmail.com に直接ご連絡ください。',
      }),
    };
  }

  // ── 4. Notion 台帳記録（失敗してもユーザーには影響させない）────────
  try {
    await appendToNotion(data);
  } catch (notionError) {
    // Notion が落ちていてもお客様のメール送信は完了しているため、
    // だいきさんにアラートだけ送って処理を続行する
    console.error('[booking] Notion write failed:', notionError);
    try {
      await resend.emails.send({
        from:    fromAddress,
        to:      ownerEmail,
        subject: '⚠️ 予約台帳の記録に失敗しました — 手動で追加してください',
        html: `
          <p><strong>${data.name} 様</strong>（${data.email}）の予約が Notion に記録されませんでした。</p>
          <p>Notion を開いて手動で追加してください。</p>
          <hr>
          <pre style="font-size:12px;background:#f5f5f5;padding:12px;">${JSON.stringify(data, null, 2)}</pre>
          <p style="font-size:12px;color:#888;">エラー: ${String(notionError.message)}</p>
        `,
      });
    } catch (alertError) {
      // アラートメール自体が失敗した場合は Netlify のログに記録するだけ
      console.error('[booking] Alert email also failed:', alertError);
    }
  }

  // ── 成功レスポンス ─────────────────────────────────────────────
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ok: true,
      message: 'ご予約を受け付けました。2営業日以内にご連絡いたします。',
      remaining, // デバッグ用（クライアント側では表示しない）
    }),
  };
};
