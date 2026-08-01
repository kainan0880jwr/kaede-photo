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
let redis = null;
let ratelimit = null;         // IPごと：1時間に5件
let globalRatelimit = null;   // サイト全体：1日40件（メール爆撃・送信ドメイン汚染の頭打ち）
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = Redis.fromEnv();
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, '1 h'),
    prefix: 'ratelimit:booking',
    analytics: false,
  });
  globalRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(40, '1 d'),
    prefix: 'ratelimit:booking:global',
    analytics: false,
  });
} else {
  // 環境変数が欠けるとレート制限が無効化される＝無警告の全開放を防ぐため明示的に警告
  console.error('[ratelimit] 警告: Upstashが未設定のため、レート制限が無効です。環境変数を確認してください。');
}

// 予約プランのホワイトリスト（フォームの選択肢と完全一致で判定）
const ALLOWED_PLANS = new Set([
  'simple ¥19,000',
  'standard ¥29,000（おすすめ）',
  'special ¥39,000',
  'premium ¥77,000',
  // 期間限定コラボ企画「1st BIRTHDAY smash cake photo」（mémoire×kaede photo）専用プラン
  'smash cake photo 40cuts ¥35,000',
  'smash cake photo 50cuts ¥38,000',
]);

// 撮影ジャンルのホワイトリスト（表示ラベルではなく安定キーで判定する。
// キーは public/index.html の GENRE_LIST と一致させること。
// 表示ラベルを変更してもここは変更不要 ← 表示文言変更時の検証漏れによる
// 予約失敗を防ぐための設計。空文字＝指定なしは別途許可）
const ALLOWED_GENRES = new Set([
  'maternity',
  'newborn',
  'omiyamairi',
  'birthday',
  'shichigosan',
]);

// Notion記録・メール表示用の日本語ラベル変換（キー→表示名）
const GENRE_LABELS = {
  maternity: 'マタニティ',
  newborn: 'ニューボーン',
  omiyamairi: 'お宮参り',
  birthday: 'ファーストバースデー',
  shichigosan: '七五三',
};

// --- ヘルパー ------------------------------------------------
function corsHeaders() {
  const origin = process.env.SITE_URL || '';
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
  // SITE_URL が設定されているときだけ許可オリジンを明示（未設定時は 'null' を返さない）
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// リクエスト元オリジンの検証（他サイトからのPOSTを弾く）
// ホスト名ベースで判定し、末尾スラッシュやドメイン表記の差で正規の予約を誤って弾かないようにする。
function hostOf(value) {
  try { return new URL(value).host.toLowerCase(); } catch { return ''; }
}
function isAllowedOrigin(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  // ブラウザから送信されるPOST（Content-Type: application/json）には必ずOriginが付与されるため、
  // 未送信の直接POST（curl等）は許可しない
  if (!origin) return false;
  const host = hostOf(origin);
  if (!host) return false;
  const allowed = new Set(['kaede-photo.com', 'www.kaede-photo.com']);
  const siteHost = hostOf(process.env.SITE_URL || '');
  if (siteHost) allowed.add(siteHost);
  // このプロジェクト自身のNetlify URL（本番・プレビュー/ブランチデプロイ）のみ許可。
  // ※ *.netlify.app 全体を許可すると、第三者が無料で作成した別サイトも信頼してしまうため使わない
  [process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL].forEach(u => {
    const h = hostOf(u || '');
    if (h) allowed.add(h);
  });
  return allowed.has(host);
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
  // message はフォームの各項目（撮影場所・お子さま情報・オプション等）を集約するため上限を広めに
  if (data.message && data.message.length > 6000) {
    errors.push('入力内容が長すぎます。ご要望を短くしてお試しください。');
  }
  if (data.preferredDate && data.preferredDate.length > 200) {
    errors.push('ご希望日の形式が正しくありません。');
  }
  // プランはホワイトリスト照合（直接APIを叩かれた場合の不正値・巨大文字列を弾く）
  if (data.plan && !ALLOWED_PLANS.has(data.plan)) {
    errors.push('ご希望のプランが正しくありません。');
  }
  // ジャンルはホワイトリスト照合（空文字＝指定なしは許可）
  if (data.genre && !ALLOWED_GENRES.has(data.genre)) {
    errors.push('撮影ジャンルの形式が正しくありません。');
  }
  if (data.area && data.area.length > 100) {
    errors.push('エリアの形式が正しくありません。');
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

  // 別オリジンからのPOSTを拒否（CSRF/スパム対策・SITE_URL設定時のみ）
  if (!isAllowedOrigin(event)) {
    return json(403, { ok: false, error: 'Forbidden' });
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

  // 2-a. レート制限（IPごと ＋ サイト全体）
  // ※ 冪等性キーの書き込みより先に行い、レート制限で弾かれるリクエストが
  //   Redisに書き込みを発生させない（コストDoS対策）ようにする
  if (ratelimit) {
    try {
      const ip = getClientIp(event);
      const [perIp, global] = await Promise.all([
        ratelimit.limit(ip),
        globalRatelimit ? globalRatelimit.limit('global') : Promise.resolve({ success: true }),
      ]);
      if (!perIp.success || !global.success) {
        return json(429, {
          ok: false,
          error: '送信回数が上限に達しました。しばらく時間をおいてからお試しください。',
        });
      }
    } catch (err) {
      // レート制限基盤の障害で予約をブロックしないよう、ログのみで続行
      console.error('[ratelimit] failed, continuing:', err?.message || err);
    }
  }

  // 2-b. 冪等性（二重送信対策）：同じ requestId が短時間に再送されたら重複とみなす
  //   後続処理（バリデーション・メール送信）が失敗した場合はキーを解放し、
  //   お客様が再送信したときに誤って「成功扱い（duplicate）」にならないようにする
  const reqId = String(payload.requestId || '').slice(0, 64);
  let idempotencyKeySet = false;
  if (redis && reqId) {
    try {
      const set = await redis.set(`booking:req:${reqId}`, '1', { nx: true, ex: 3600 });
      if (set === null) {
        // 既に処理済み（再送・戻る操作など）→ 成功扱いで静かに終了
        return json(200, { ok: true, duplicate: true });
      }
      idempotencyKeySet = true;
    } catch (err) {
      console.error('[idempotency] failed, continuing:', err?.message || err);
    }
  }
  async function releaseIdempotencyKey() {
    if (!redis || !idempotencyKeySet) return;
    try {
      await redis.del(`booking:req:${reqId}`);
    } catch (err) {
      console.error('[idempotency] release failed:', err?.message || err);
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
    genre: (payload.genre || '').trim(),
    area: (payload.area || '').trim(),
    message: (payload.message || '').trim(),
    receivedAt: now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    receivedAtISO: now.toISOString(),
  };

  const errors = validate(data);
  if (errors.length > 0) {
    await releaseIdempotencyKey();
    return json(400, { ok: false, error: errors.join('\n') });
  }

  // 検証（安定キーでの照合）が済んだ後、メール本文・Notion記録用に日本語ラベルへ変換する
  if (data.genre) {
    data.genre = GENRE_LABELS[data.genre] || data.genre;
  }

  // 4. メール送信（直列）
  //    まずオーナー宛を送り、成功したときだけお客様宛の自動返信を送る。
  //    （並列だと「オーナー宛失敗なのにお客様には受付完了メールが届く」矛盾が起きるため）
  const from = process.env.MAIL_FROM;
  const ownerMail = ownerNotification(data);
  const customerMail = customerConfirmation(data);

  let ownerResult;
  try {
    ownerResult = await resend.emails.send({
      from,
      to: process.env.OWNER_EMAIL,
      replyTo: data.email,
      subject: ownerMail.subject,
      html: ownerMail.html,
    });
  } catch (err) {
    ownerResult = { error: err };
  }

  if (ownerResult?.error) {
    // だいきさんへの通知が失敗 = 予約を取りこぼす致命的状態なのでエラーを返す（お客様宛は送らない）
    console.error('[mail:owner] failed:', ownerResult.error?.message || ownerResult.error);
    await releaseIdempotencyKey();
    return json(502, {
      ok: false,
      error: '送信処理に失敗しました。時間をおいて再度お試しください。',
    });
  }

  try {
    const customerResult = await resend.emails.send({
      from,
      to: data.email,
      subject: customerMail.subject,
      html: customerMail.html,
    });
    if (customerResult?.error) {
      // お客様への自動返信失敗は記録だけして処理は続行（予約自体は成立）
      console.error('[mail:customer] failed:', customerResult.error?.message || customerResult.error);
    }
  } catch (err) {
    console.error('[mail:customer] failed:', err?.message || err);
  }

  // 5. Notionへ記録（失敗してもメールは届いているので成功を返す）
  try {
    await createBookingRecord(data);
  } catch (err) {
    console.error('[notion] failed:', err?.message || err);
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
      console.error('[mail:notion-alert] failed:', alertErr?.message || alertErr);
    }
  }

  return json(200, { ok: true });
};
