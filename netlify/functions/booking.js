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
  globalLimitAlert,
  priceMismatchAlert,
} from './utils/email-templates.js';
import { createBookingRecord } from './utils/notion.js';

// --- 初期化（コールド起動時のみ実行）-------------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// Upstash の環境変数が揃っているときだけレート制限を有効化
// サイト全体の上限。上限に達している間は正規のお客様も送信できなくなるため、
// 到達時はオーナーへ通知する（notifyGlobalLimit）。
const GLOBAL_LIMIT_PER_DAY = 40;

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
    limiter: Ratelimit.slidingWindow(GLOBAL_LIMIT_PER_DAY, '1 d'),
    prefix: 'ratelimit:booking:global',
    analytics: false,
  });
} else {
  // 環境変数が欠けるとレート制限が無効化される＝無警告の全開放を防ぐため明示的に警告
  console.error('[ratelimit] 警告: Upstashが未設定のため、レート制限が無効です。環境変数を確認してください。');
}

// プラン名の末尾についた「（おすすめ）」等の装飾的な補足テキストを除いて比較するための正規化。
// バッジ文言・キャッチコピーだけをHTML側で変更した際に、ALLOWED_PLANSとの同期を忘れて
// 該当プランの予約が全て「ご希望のプランが正しくありません」で弾かれる事故を防ぐ。
// （撮影ジャンルが安定キーで判定されているのと同様の考え方だが、プラン名は
// Notion記録・メール表示にそのまま使う都合上、キー化はせず正規化のみで対応する）
function normalizePlanForMatch(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
}

// 東京時間の「今日」をYYYY-MM-DD形式で返す。
// toLocaleDateString('sv-SE') はスウェーデン語ロケールデータを要求するため、
// Node がfull-icu無し（small-icuやsystem-icuの一部設定）でビルドされていると
// en-USへフォールバックし "9/6/2026" のような別形式を返す。その状態だと
// 文字列比較の today が常に不正な値になり、日付の前後判定（過去日チェック・
// 期間限定プランの受付期限）が意図に関わらず常にtrue/falseに固定されてしまう。
// Intl.DateTimeFormat('en-CA', ...).formatToParts() はsmall-icu（Nodeの既定ビルド）
// でも確実にYYYY-MM-DD相当のパーツを返せるため、ロケール名に依存しない組み立て方にする。
function todayJST() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 予約プランのホワイトリスト（価格まで含めた文言で判定。末尾の装飾テキストは無視する）
const ALLOWED_PLANS = new Set([
  'simple ¥19,000',
  'standard ¥29,000',
  'special ¥39,000',
  'premium ¥77,000',
  // 期間限定コラボ企画「1st BIRTHDAY smash cake photo」（mémoire×kaede photo）専用プラン
  'smash cake photo 40cuts ¥35,000',
  'smash cake photo 50cuts ¥38,000',
]);

// 上記の期間限定プランは、開催日（2026-09-04/05）を過ぎてもこの文字列さえ分かれば
// 予約が通り続けてしまう（ページソースやアーカイブから拾われる可能性がある）。
// 企画終了後は自動的に受付を締め切るため、受付期限を明示的に持たせる。
const SMASH_CAKE_PLANS = new Set([
  'smash cake photo 40cuts ¥35,000',
  'smash cake photo 50cuts ¥38,000',
]);
const SMASH_CAKE_PLAN_DEADLINE = '2026-09-06'; // この日付(Asia/Tokyo)以降は受付終了

// ALLOWED_PLANS と SMASH_CAKE_PLANS は同じ文字列を別々のリテラル配列として二重管理している
// （scripts/check-prices.mjs がソースを正規表現で読むため、spread構文にはできない）。
// 片方だけプラン名を変更すると、そのプランの受付期限チェックが静かに効かなくなる
// （ALLOWED_PLANS側だけ変えるとホワイトリスト自体を通らなくなるので気づけるが、
// SMASH_CAKE_PLANS側だけ変え忘れると期限なしで受付し続けてしまう）。
// コールドスタート時に1回だけ突き合わせ、ズレていたら気づけるようにする。
// ここでthrowすると以降このコンテナへの全リクエストが道連れで失敗する（予約API全体の障害）
// ため、あくまでログのみに留める（scripts/check-prices.mjs にも同種のチェックがあり、
// デプロイ前に気づける可能性が高い）
for (const p of SMASH_CAKE_PLANS) {
  if (!ALLOWED_PLANS.has(p)) {
    console.error(`[config] SMASH_CAKE_PLANS の "${p}" が ALLOWED_PLANS に存在しません（プラン名の変更漏れの可能性があります）`);
  }
}

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

// --- 料金の再計算 --------------------------------------------
// フロントエンドが表示した概算金額をそのまま信用せず、サーバー側でも独立に計算する。
// 目的は「安く見せかけた注文を通さない」ことではなく（決済は当日オフラインのため改ざん動機は薄い）、
// 特商法12条の6でお客様に提示した対価と、事業者側の記録を一致させ、後日の齟齬を防ぐこと。
// フォームは金額そのものではなく安定キー（optionKeys）を送り、単価はここだけで管理する。
// キーは public/index.html の data-opt / data-area 属性と一致させること。
const OPTION_PRICES = {
  weekend: 3000,        // 土日祝日
  early7: 5000,         // 早期納品（7日以内）
  early10: 3000,        // 早期納品（10日以内）
  data10: 3000,         // データ追加（10枚単位）
  selfselect: 3000,     // ご自身でデータ選択
  twoplaces: 10000,     // 2箇所での撮影
  movie: 39800,         // お手紙ムービー
  newborn_set: 2000,    // ニューボーンフォトセット
  sns_face: -1000,      // SNS割（顔を含む）
  sns_noface: -500,     // SNS割（顔を含まない）
  // ご紹介割は「今回」ではなく紹介者・被紹介者それぞれの「次回」の予約に適用される
  // （フォーム文言・オプション表参照）。この予約自体の概算には反映しないため0円。
  // チェック状態と紹介者名（referral-name欄）はメール本文に記載され、
  // 次回予約時に手動で−3,000円を適用する運用。
  referral: 0,           // ご紹介あり（今回の金額には影響しない。次回適用は手動運用）
  // コラボ企画（birthday-collab.html）専用のSNS掲載同意チェック。通常予約のsns_face/sns_nofaceと
  // 異なり割引ではないため0円。同意の有無自体はdata.snsConsentとしてNotion記録に渡す。
  collab_sns: 0,
};

const AREA_PRICES = {
  '大阪府内・和歌山県北部': 0,
  '奈良県全域': 3000,
  '兵庫県南部': 3000,
  '兵庫県北部': 6000,
  '京都府南部': 5000,
  '京都府北部': 8000,
  '和歌山県南部': 5000,
  'その他': 0, // 交通費は別途見積り
};

// エリアのホワイトリスト（AREA_PRICESのキー＋コラボ企画の固定エリア文字列）。
// plan/genre/optionKeysと違い、area は文字数上限だけで中身は未検証だったため、
// 直接APIを叩けば任意の100文字をNotion・オーナー宛メールへ注入できてしまっていた
//（HTMLエスケープ済みでXSSには至らないが、台帳・通知メールの汚染が可能だった。Opus 5監査 セキュリティM-3）
const ALLOWED_AREAS = new Set([...Object.keys(AREA_PRICES), 'mémoireスタジオ（大阪市福島区大開）']);

const YEN = n => `¥${n.toLocaleString('ja-JP')}`;

// プラン単価はホワイトリスト済みラベルから抽出する（単価表の二重管理による食い違いを避ける）
function planYen(plan) {
  const m = String(plan || '').replace(/,/g, '').match(/¥(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// フロント側のdata-exclと対になる排他グループ。UIでは同時選択できないが、
// 直接APIを叩かれた場合に両方を送られると二重計上・矛盾した組み合わせになるため、
// 先に現れたキーだけを有効にする
const EXCLUSIVE_OPTION_GROUPS = [
  ['early7', 'early10'],
  ['sns_face', 'sns_noface'],
];

// 掲載同意（肖像権・プライバシーポリシー「利用目的」参照）の有無を、料金とは別に
// サーバー側で確定させる。金額はOPTION_PRICESが担うが、同意の記録はここで
// 独立に判定する。呼び出し側は computeEstimate() が返す正規化済み keys を渡すこと
// （重複除去・排他グループ適用済みのため、料金計算と矛盾しない判定になる）。
function deriveSnsConsent(optionKeys) {
  const keys = new Set((Array.isArray(optionKeys) ? optionKeys : []).map(k => String(k)));
  if (keys.has('sns_face')) return { consent: true, scope: '顔を含む' };
  if (keys.has('sns_noface')) return { consent: true, scope: '顔を含まない' };
  if (keys.has('collab_sns')) return { consent: true, scope: 'コラボ企画（kaede photo・mémoire双方）' };
  return { consent: false, scope: '' };
}

function computeEstimate({ plan, areaKey, optionKeys, clientValue }) {
  // 件数（30件）に加え、各要素の文字数も上限を設ける（多重防御。ログ・注記文の肥大化を防ぐ）。
  // 同じキーの重複送信は1回分にまとめる
  const rawKeys = (Array.isArray(optionKeys) ? optionKeys.slice(0, 30) : []).map(k => String(k).slice(0, 64));
  const keys = [...new Set(rawKeys)];
  for (const group of EXCLUSIVE_OPTION_GROUPS) {
    const present = keys.filter(k => group.includes(k));
    for (const extra of present.slice(1)) {
      keys.splice(keys.indexOf(extra), 1);
    }
  }

  let total = planYen(plan);
  const unknown = [];
  for (const k of keys) {
    // 素の添字アクセスだと 'toString' / '__proto__' / 'constructor' 等が
    // Object.prototype 由来の値（関数など）を返してしまい、total が数値でなく
    // 文字列化する（AREA_PRICESの直後のチェックと同じ書き方に揃える）
    const hasKey = Object.prototype.hasOwnProperty.call(OPTION_PRICES, k);
    if (!hasKey) unknown.push(k.slice(0, 40));
    else total += OPTION_PRICES[k];
  }
  // 上記のガードで通常は数値のはずだが、多重防御として最終値も検証する
  if (!Number.isFinite(total)) total = planYen(plan);
  // 想定外のキーは改ざん試行かフロント側のバグの可能性があるため、注記だけでなくログにも残す
  if (unknown.length) {
    console.warn('[estimate] unknown option keys:', unknown);
  }

  if (Object.prototype.hasOwnProperty.call(AREA_PRICES, areaKey)) {
    total += AREA_PRICES[areaKey];
  }
  // 値引きの合計がプラン代金を上回ることは想定していない。直接APIを叩かれた場合の
  // 異常値（マイナスの概算金額がメール・Notionに記録される事態）を防ぐ下限ガード
  total = Math.max(0, total);

  const notes = [];
  if (areaKey === 'その他') notes.push('交通費別途');
  // 想定外のキーが混ざったときは金額を黙って過少表示せず、必ず注記する
  if (unknown.length) notes.push(`未計上のオプション: ${unknown.join(', ')}`);
  // フォーム表示額との不一致は、改ざんか単価表のズレのどちらか。どちらも人が見て気づけるようにする
  const cv = Number(clientValue);
  const mismatch = Number.isFinite(cv) && cv !== total;
  if (mismatch) notes.push(`フォーム表示額 ${YEN(cv)} と不一致`);

  return {
    total,
    // オーナー宛・Notion向け：改ざん試行やフロント側バグの痕跡を含む診断メモ込みの全文
    text: `${YEN(total)}（税込）${notes.length ? `　※ ${notes.join(' / ')}` : ''}`,
    // お客様宛：診断メモは内部向けの情報でしかないため反射しない、金額のみのクリーンな文言
    // （「交通費別途」はお客様に必要な案内なので残す）
    customerText: `${YEN(total)}（税込）${areaKey === 'その他' ? '　※ 交通費別途' : ''}`,
    mismatch,
    // 重複除去・30件切り詰め・排他グループ適用後の正規化済みキー。
    // deriveSnsConsent はこの keys を使うこと（payload.optionKeysを直接渡すと、
    // 料金計算とSNS掲載同意の判定基準がズレて記録が矛盾しうる。Opus 5監査 M-1）。
    keys,
  };
}

// --- ヘルパー ------------------------------------------------
function corsHeaders() {
  const origin = process.env.SITE_URL || '';
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    // netlify.tomlの[[headers]]は静的アセットにのみ適用され、Functionsのレスポンスには
    // 効かない（本番で実測確認済み）。レスポンスは常に固定のJSON文字列でユーザー入力を
    // 反射しないため実害は小さいが、念のため主要なセキュリティヘッダーをここでも
    // 明示的に付与する（Opus 5監査 セキュリティM-2）
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  };
  // SITE_URL が設定されているときだけ許可オリジンを明示（未設定時は 'null' を返さない）
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// リクエスト元オリジンの検証（他サイトからのPOSTを弾く）
// スキーム＋ホスト名で判定し、末尾スラッシュやドメイン表記の差で正規の予約を誤って弾かないようにする。
// （以前はホスト名のみの比較で、Origin: http://kaede-photo.com のような非HTTPSの
//   オリジンも通過してしまっていた。HSTS preload・301リダイレクトにより実際に平文HTTPの
//   ページがこのドメインに存在する経路は無いため実害は限定的だったが、Opus 5監査 セキュリティM-4対応）
function originOf(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch { return ''; }
}
function isAllowedOrigin(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  // ブラウザから送信されるPOST（Content-Type: application/json）には必ずOriginが付与されるため、
  // Originが無いリクエストは弾ける。
  // ただしこれは「他サイトのページからのCSRF」を防ぐ仕組みであって、スパム対策ではない。
  // curl等は -H "Origin: https://kaede-photo.com" を付ければ通過するため、
  // 機械的な連投への防御はレート制限とhoneypotが担っている。
  if (!origin) return false;
  const originNormalized = originOf(origin);
  if (!originNormalized) return false;
  const allowed = new Set(['https://kaede-photo.com', 'https://www.kaede-photo.com']);
  const siteOrigin = originOf(process.env.SITE_URL || '');
  if (siteOrigin) allowed.add(siteOrigin);
  // このプロジェクト自身のNetlify URL（本番・プレビュー/ブランチデプロイ）のみ許可。
  // ※ *.netlify.app 全体を許可すると、第三者が無料で作成した別サイトも信頼してしまうため使わない
  [process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL].forEach(u => {
    const o = originOf(u || '');
    if (o) allowed.add(o);
  });
  return allowed.has(originNormalized);
}

function json(statusCode, body, extraHeaders) {
  // 予約内容を含むレスポンスが共有端末のキャッシュや中間キャッシュに残らないようにする
  const headers = { ...corsHeaders(), 'Cache-Control': 'no-store', ...extraHeaders };
  return { statusCode, headers, body: JSON.stringify(body) };
}

// レート制限のキーに生のIPをそのまま使うと、IPv6環境では攻撃者が/64プレフィックス内の
// アドレスを1件ごとに変えるだけでper-IP制限を無限に回避できてしまう（同一契約者に
// 割り当てられる典型的なブロックサイズが/64のため）。IPv6のみ先頭4グループ（=/64）に
// 丸めてバケット化し、IPv4はそのまま使う。
function rateLimitKey(ip) {
  if (!ip.includes(':')) return `v4:${ip}`;
  let groups;
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const headParts = head ? head.split(':').filter(Boolean) : [];
    const tailParts = tail ? tail.split(':').filter(Boolean) : [];
    const zeros = Math.max(8 - headParts.length - tailParts.length, 0);
    groups = [...headParts, ...Array(zeros).fill('0'), ...tailParts];
  } else {
    groups = ip.split(':');
  }
  return `v6:${groups.slice(0, 4).join(':')}`;
}

function getClientIp(event) {
  const headers = event.headers || {};
  // Netlifyが付与する x-nf-client-connection-ip を最優先（クライアントからは詐称できない）。
  // x-forwarded-for はクライアントが任意の値を「先頭に」付けて送れるヘッダで、
  // 実際の接続元は経路上のプロキシによって「末尾に」追記される。
  // したがって先頭要素を採ると、攻撃者が毎回別のIPを名乗ってレート制限を回避できてしまうため末尾を採る。
  const xff = (headers['x-forwarded-for'] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return (
    headers['x-nf-client-connection-ip'] ||
    xff[xff.length - 1] ||
    'unknown'
  );
}

// サイト全体の上限に達したことをオーナーへ通知する（Redisのキーで1日1回に制限）。
// アラート自体が連投されて受信箱を埋めるのを防ぐのが目的。
async function notifyGlobalLimit(lastIp) {
  if (!redis) return;
  try {
    const day = todayJST();
    const first = await redis.set(`booking:global-alert:${day}`, '1', { nx: true, ex: 86400 });
    if (first === null) return; // 本日は通知済み
    const alert = globalLimitAlert({
      limit: GLOBAL_LIMIT_PER_DAY,
      windowLabel: '1日',
      lastIp,
      at: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    });
    await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: process.env.OWNER_EMAIL,
      subject: alert.subject,
      html: alert.html,
    });
  } catch (err) {
    console.error('[ratelimit] global alert failed:', err?.message || err);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(data) {
  const errors = [];

  // プライバシーポリシー（コラボ企画では共同利用への同意を含む）への同意はフォーム側で
  // 必須チェックボックスにしているが、直接APIを叩けばその検証を回避できるため、
  // ここでも必須項目として扱う。
  if (!data.privacyConsent) {
    errors.push('プライバシーポリシーへの同意が必要です。');
  }

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
    errors.push('ご希望日が長すぎます。');
  } else if (data.preferredDate) {
    // フォームは <input type="date"> の値（YYYY-MM-DD）を含む文字列を送る。
    // min属性による過去日の抑止はブラウザ側だけの制約なので、サーバーでも同じ判定を行う。
    // ※ コラボ企画のフォームは「2026年9月4日（金）」形式で送るため、
    //   YYYY-MM-DD が含まれる場合にだけ検査する（含まれない形式は従来どおり通す）
    const iso = data.preferredDate.match(/\d{4}-\d{2}-\d{2}/g) || [];
    const today = todayJST();
    if (iso.some(d => d < today)) {
      errors.push('撮影希望日に過去の日付が含まれています。');
    }
  }
  // プランはホワイトリスト照合（直接APIを叩かれた場合の不正値・巨大文字列を弾く）。
  // フォーム（index.html / birthday-collab.html）はどちらもプラン選択をrequiredにしているため、
  // 空文字（未選択のまま直接APIを叩いた場合）もここで弾く
  if (!data.plan) {
    errors.push('ご希望のプランを選択してください。');
  } else if (data.plan.length > 120) {
    // normalizePlanForMatch は末尾の（...）の中身を無条件に無視するため、
    // 括弧の中に任意の長文を仕込んでホワイトリストを通す経路を長さ制限で塞ぐ
    errors.push('ご希望のプランが正しくありません。');
  } else {
    const normalizedPlan = normalizePlanForMatch(data.plan);
    if (!ALLOWED_PLANS.has(normalizedPlan)) {
      errors.push('ご希望のプランが正しくありません。');
    } else if (SMASH_CAKE_PLANS.has(normalizedPlan)) {
      // 期間限定コラボ企画：開催日を過ぎたら、文字列を知っているだけでの予約を拒否する
      const today = todayJST();
      if (today >= SMASH_CAKE_PLAN_DEADLINE) {
        errors.push('このプランは受付を終了しました。');
      }
    }
  }
  // ジャンルはホワイトリスト照合（空文字＝指定なしは許可）
  if (data.genre && !ALLOWED_GENRES.has(data.genre)) {
    errors.push('撮影ジャンルの形式が正しくありません。');
  }
  if (data.area && !ALLOWED_AREAS.has(data.area)) {
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
  // 誤検知は「お客様には予約完了と表示されるのに予約が消える」サイレントな取りこぼしになるため、
  // 必ずログを残して誤検知率を監視できるようにする（Netlify → Functions → booking → Logs）。
  // company は旧フィールド名。キャッシュされた古いページからの送信を取りこぼさないため当面受理する
  const honeypot = payload.hp_token || payload.company;
  if (honeypot) {
    console.warn('[honeypot] triggered:', {
      ip: getClientIp(event),
      len: String(honeypot).length,
      hasName: Boolean(payload.name),
      hasEmail: Boolean(payload.email),
    });
    return json(200, { ok: true });
  }

  // 2-a. レート制限（IPごと ＋ サイト全体）
  // ※ 冪等性キーの書き込みより先に行い、レート制限で弾かれるリクエストが
  //   Redisに書き込みを発生させない（コストDoS対策）ようにする
  if (ratelimit) {
    const ip = getClientIp(event);
    let perIp, global;
    try {
      [perIp, global] = await Promise.all([
        ratelimit.limit(rateLimitKey(ip)),
        globalRatelimit ? globalRatelimit.limit('global') : Promise.resolve({ success: true }),
      ]);
    } catch (err) {
      // Upstashは設定済みだが呼び出しが失敗した状態（無料プランの長期アイドル停止・
      // 一時的な障害など）。ここでフェイルオープンにすると、認証済みドメイン
      // (kaede-photo.com)から攻撃者が指定した任意アドレス宛に無制限にメールを
      // 送信できる中継点になり、送信ドメインのレピュテーション毀損という
      // 復旧困難な被害に直結するため、フェイルクローズ（503）する。
      // ※ Upstashが最初から未設定（環境変数自体が無い）の場合はこのブロックに入らず、
      //   従来どおりフェイルオープンのまま（ローカル開発等でUpstashを使わない構成を壊さないため）。
      console.error('[ratelimit] failed, rejecting request (fail-closed):', err?.message || err);
      return json(503, {
        ok: false,
        error: 'ただいま送信が混み合っております。しばらく時間をおいて再度お試しいただくか、LINE・Instagramにてご連絡ください。',
      });
    }
    if (!perIp.success || !global.success) {
      // サイト全体の上限に達している間は、正規のお客様も一律で予約できなくなる。
      // 気づかないまま丸一日フォームが死ぬのを避けるため、1日1回だけオーナーへ通知する。
      if (!global.success) await notifyGlobalLimit(ip);
      // Ratelimit.limit()の戻り値に含まれるresetを使って、あとどれくらいで
      // 再試行できるかをクライアントに伝える
      const resetAt = Math.max(perIp.reset || 0, global.success ? 0 : (global.reset || 0));
      const retryAfterSec = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : undefined;
      return json(429, {
        ok: false,
        error: '送信回数が上限に達しました。しばらく時間をおいてからお試しください。',
      }, retryAfterSec ? { 'Retry-After': String(retryAfterSec) } : undefined);
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
  // 直接APIを叩かれた場合、各フィールドが文字列でない（数値・配列・オブジェクト等）
  // JSONが来ると (payload.name || '').trim() がTypeErrorを投げて500エラーになる
  // （catchで囲まれておらずCORSヘッダも付かない）。文字列以外は空文字扱いにする
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const data = {
    name: str(payload.name),
    email: str(payload.email),
    phone: str(payload.phone),
    preferredDate: str(payload.preferredDate),
    plan: str(payload.plan),
    genre: str(payload.genre),
    area: str(payload.area),
    message: str(payload.message),
    privacyConsent: payload.privacyConsent === true,
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
  // ホワイトリスト通過後の data.plan を正準値（末尾の装飾テキストを除いた値）に置き換える。
  // normalizePlanForMatch は照合にしか使っていなかったため、括弧内に任意の文字列（URL等）を
  // 仕込んだ元の文字列がそのままメール本文・Notionに渡ってしまっていた（フィッシング中継経路）。
  data.plan = normalizePlanForMatch(data.plan);

  // 概算金額はフォームから受け取った値をそのまま使わず、サーバー側で再計算する。
  // area には data-area 属性の値（地名のみの安定値）が入るため、そのままキーとして使える。
  const estimate = computeEstimate({
    plan: data.plan,
    areaKey: data.area,
    optionKeys: payload.optionKeys,
    clientValue: payload.value,
  });
  data.estimateText = estimate.text;
  data.estimateTextCustomer = estimate.customerText;
  data.estimateYen = estimate.total;

  // 掲載同意の記録（金額とは独立に、optionKeysから確定させる。#f4/#f6の監査対応）。
  // 料金計算(computeEstimate)と同じ正規化済みキー(estimate.keys)を使うことで、
  // 順序・重複・30件超過による判定のズレを防ぐ
  const snsConsent = deriveSnsConsent(estimate.keys);
  data.snsConsent = snsConsent.consent;
  data.snsConsentScope = snsConsent.scope;
  if (estimate.mismatch) {
    // 単価表のズレ（＝表示と請求の食い違い）を早期に発見するためのログ
    console.warn('[estimate] client/server mismatch:', {
      client: payload.value,
      server: estimate.total,
      plan: data.plan,
      area: data.area,
    });
    // ログはNetlifyの画面を開かないと気づけないため、オーナーへ即時メールでも知らせる
    // （予約自体はブロックしない。このアラート送信の成否も予約の成否に影響させない）
    try {
      const mismatchAlert = priceMismatchAlert(data, {
        clientValue: payload.value,
        serverValue: estimate.total,
      });
      await resend.emails.send({
        from: process.env.MAIL_FROM,
        to: process.env.OWNER_EMAIL,
        subject: mismatchAlert.subject,
        html: mismatchAlert.html,
      });
    } catch (alertErr) {
      console.error('[mail:mismatch-alert] failed:', alertErr?.message || alertErr);
    }
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
