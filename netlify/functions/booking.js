// ============================================================
// 予約受付 API（メイン）
//
// 処理の流れ:
//   1. CORS / メソッドチェック（POSTのみ）
//   2. レート制限（Upstash Redis：IPごと 1時間に5件まで）
//   3. バリデーション（必須項目・形式・文字数・honeypot）
//   4. メール2通を並列送信（だいきさん宛 ＋ お客様自動返信）
//   5. Notionへ記録
//      - Notionが落ちてもメールは届く設計
//      - Notion失敗時はだいきさんへアラートメールを送る
// ============================================================

import { Resend } from 'resend';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import {
  ownerNotification,
  customerConfirmation,
  notionFailureAlert,
} from './utils/email-templates.js';
import { createBookingRecord } from './utils/notion.js';

// --- 初期化（コールド起動時のみ実行）-------------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// Upstash の環境変数が揃っているときだけレート制限を有効化
let ratelimit = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(5, '1 h'),
    prefix: 'ratelimit:booking',
    analytics: false,
  });
}

// --- ヘルパー ------------------------------------------------
function corsHeaders() {
  const origin = process.env.SITE_URL || '';
  return {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

function getClientIp(event) {
  const headers = event.headers || {};
  return (
    headers['x-nf-client-connection-ip'] ||
    (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(data) {
  const errors = [];

  if (!data.name || data.name.trim().length < 1) {
    errors.push('お名前を入力してください。');
  } else if (data.name.length > 100) {
    errors.push('お名前が長すぎます。');
  }

  if (!data.email || !EMAIL_RE.test(data.email)) {
    errors.push('メールアドレスの形式が正しくありません。');
  } else if (data.email.length > 254) {
    errors.push('メールアドレスが長すぎます。');
  }

  if (data.phone && data.phone.length > 30) {
    errors.push('電話番号が長すぎます。');
  }
  if (data.message && data.message.length > 2000) {
    errors.push('ご要望は2000文字以内で入力してください。');
  }

  return errors;
}

// --- ハンドラ ------------------------------------------------
export const handler = async (event) => {
  // 1. メソッドチェック
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method Not Allowed' });
  }

  // ボディのパース
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'リクエストの形式が正しくありません。' });
  }

  // honeypot（botが埋めがちな隠しフィールド。値が入っていたら静かに成功扱い）
  if (payload.company) {
    return json(200, { ok: true });
  }

  // 2. レート制限
  if (ratelimit) {
    try {
      const ip = getClientIp(event);
      const { success } = await ratelimit.limit(ip);
      if (!success) {
        return json(429, {
          ok: false,
          error: '送信回数が上限に達しました。しばらく時間をおいてからお試しください。',
        });
      }
    } catch (err) {
      // レート制限基盤の障害で予約をブロックしないよう、ログのみで続行
      console.error('[ratelimit] failed, continuing:', err);
    }
  }

  // 3. バリデーション
  const now = new Date();
  const data = {
    name: (payload.name || '').trim(),
    email: (payload.email || '').trim(),
    phone: (payload.phone || '').trim(),
    preferredDate: (payload.preferredDate || '').trim(),
    plan: (payload.plan || '').trim(),
    message: (payload.message || '').trim(),
    receivedAt: now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    receivedAtISO: now.toISOString(),
  };

  const errors = validate(data);
  if (errors.length > 0) {
    return json(400, { ok: false, error: errors.join('\n') });
  }

  // 4. メール2通を並列送信
  const from = process.env.MAIL_FROM;
  const ownerMail = ownerNotification(data);
  const customerMail = customerConfirmation(data);

  const [ownerResult, customerResult] = await Promise.allSettled([
    resend.emails.send({
      from,
      to: process.env.OWNER_EMAIL,
      replyTo: data.email,
      subject: ownerMail.subject,
      html: ownerMail.html,
    }),
    resend.emails.send({
      from,
      to: data.email,
      subject: customerMail.subject,
      html: customerMail.html,
    }),
  ]);

  if (ownerResult.status === 'rejected' || ownerResult.value?.error) {
    // だいきさんへの通知が失敗 = 予約を取りこぼす致命的状態なのでエラーを返す
    console.error('[mail:owner] failed:', ownerResult.reason || ownerResult.value?.error);
    return json(502, {
      ok: false,
      error: '送信処理に失敗しました。時間をおいて再度お試しください。',
    });
  }
  if (customerResult.status === 'rejected' || customerResult.value?.error) {
    // お客様への自動返信失敗は記録だけして処理は続行（予約自体は成立）
    console.error('[mail:customer] failed:', customerResult.reason || customerResult.value?.error);
  }

  // 5. Notionへ記録（失敗してもメールは届いているので成功を返す）
  let notionDebug = null; // ← 一時デバッグ：原因特定後に削除する
  try {
    await createBookingRecord(data);
  } catch (err) {
    notionDebug = err?.message || String(err); // ← 一時デバッグ
    console.error('[notion] failed:', err);
    // だいきさんへアラート（手動で台帳に追記してもらう）
    try {
      const alert = notionFailureAlert(data, err?.message || String(err));
      await resend.emails.send({
        from,
        to: process.env.OWNER_EMAIL,
        subject: alert.subject,
        html: alert.html,
      });
    } catch (alertErr) {
      console.error('[mail:notion-alert] failed:', alertErr);
    }
  }

  return json(200, { ok: true, _notionDebug: notionDebug }); // ← 一時デバッグ
};
