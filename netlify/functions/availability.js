// ============================================================
// 予約の空き状況（ブロック日）API
//
// だいきさんがNotionの「予約不可日」データベースに日付を追加するだけで、
// 予約フォームの日付欄でお客様に「その日は現在ご案内できない可能性がある」旨を
// その場で伝えられるようにする（成長ロードマップ提案①）。
//
// このプロジェクトは「フォーム送信＝即予約確定」ではなくリクエスト制（受付後に
// だいきさんが個別に確認・返信する運用）のため、ここでの判定はあくまで参考表示。
// 送信自体をブロックはしない（サーバー側にもクライアント側にも空き状況の
// 強制力は持たせない＝二重予約の最終防止は引き続き人間の確認に委ねる）。
//
// NOTION_BLOCKED_DATES_DATABASE_ID が未設定の場合は空配列を返すだけで、
// 予約フォーム自体には一切影響しない（SETUP.md参照・完全に任意の機能）。
// ============================================================

import { Client } from '@notionhq/client';

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    cachedClient = new Client({ auth: process.env.NOTION_API_KEY });
  }
  return cachedClient;
}

// ブロック日はだいきさんが日々Notionを編集するたびに増減するため、booking.jsの
// プロパティ名キャッシュ（10分TTL）よりは短めに。予約フォームを開くたびに毎回
// Notion APIを叩くとレート制限に当たりうるため、完全リアルタイムより
// 「数分以内に反映される」を優先する。
const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedDates = null;
let cachedAt = 0;

async function fetchBlockedDates() {
  const databaseId = process.env.NOTION_BLOCKED_DATES_DATABASE_ID;
  if (!databaseId) return [];

  const dates = [];
  let cursor;
  do {
    const res = await getClient().databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      const prop = page.properties && page.properties['日付'];
      const start = prop && prop.date && prop.date.start;
      // Notionの日付プロパティは日時範囲も持てるが、ここでは開始日（YYYY-MM-DD）だけを使う
      if (start) dates.push(String(start).slice(0, 10));
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return [...new Set(dates)].sort();
}

async function getBlockedDates() {
  if (cachedDates && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedDates;
  }
  try {
    cachedDates = await fetchBlockedDates();
    cachedAt = Date.now();
  } catch (err) {
    // Notion側の一時的な不調で予約フォーム自体が壊れては本末転倒なので、
    // 失敗時は「空配列」で握りつぶす（参考表示が出ないだけで済ませる）
    console.error('[availability] Notionからの取得に失敗:', err?.message || err);
    cachedDates = cachedDates || [];
  }
  return cachedDates;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  const blockedDates = await getBlockedDates();
  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, blockedDates }) };
};
