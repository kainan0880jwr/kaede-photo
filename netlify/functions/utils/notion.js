// ============================================================
// Notion 予約台帳への記録
//
// 想定するデータベースのプロパティ（SETUP.md Step 6 参照）:
//   お名前      … Title
//   メール      … Email
//   電話番号    … Phone
//   ご希望日    … Rich text
//   プラン      … Select
//   ご要望      … Rich text
//   受付日時    … Date
//
// 任意プロパティ（作成すると自動的に記録されるようになる。未作成でもエラーにはならない）:
//   撮影ジャンル … Select
//   エリア      … Rich text
//   概算金額    … Number（お客様に提示した概算をサーバー側で再計算した値）
//   ステータス  … Select（「ステータス」型ではない。新規予約時に「新規」で作成する）
// ============================================================

import { Client } from '@notionhq/client';

let cachedClient = null;

function getClient() {
  if (!cachedClient) {
    cachedClient = new Client({ auth: process.env.NOTION_API_KEY });
  }
  return cachedClient;
}

// データベースのプロパティ名一覧（TTL付きでキャッシュ。ウォームなFunctionインスタンスが
// 古いプロパティ一覧を使い続け、運用者が後からプロパティを追加しても反映されない事態を防ぐ）
// 「撮影ジャンル」「エリア」など、まだ作成されていない可能性のある任意プロパティを
// 安全に送るかどうかの判定に使う（未作成のプロパティを送るとNotion APIがエラーになるため）
const PROPERTY_CACHE_TTL_MS = 10 * 60 * 1000; // 10分
let cachedPropertyNames = null;
let cachedPropertyNamesAt = 0;
async function getDatabasePropertyNames(databaseId) {
  if (cachedPropertyNames && Date.now() - cachedPropertyNamesAt < PROPERTY_CACHE_TTL_MS) {
    return cachedPropertyNames;
  }
  try {
    const db = await getClient().databases.retrieve({ database_id: databaseId });
    cachedPropertyNames = new Set(Object.keys(db.properties || {}));
    cachedPropertyNamesAt = Date.now();
  } catch (err) {
    console.error('[notion] databases.retrieve failed, skipping optional properties:', err?.message || err);
    cachedPropertyNames = cachedPropertyNames || new Set();
  }
  return cachedPropertyNames;
}

// Notionのrich_text/title用に長すぎる文字列を安全な長さに丸める
function text(value = '') {
  return String(value).slice(0, 2000);
}

// Notionは rich_text 1オブジェクトあたり2000文字までのため、
// 長文は2000文字ごとに複数オブジェクトに分割する（切り捨てを防ぐ）
function richText(value = '') {
  const s = String(value);
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length && i < 100000; i += 2000) {
    chunks.push({ text: { content: s.slice(i, i + 2000) } });
  }
  return chunks;
}

export async function createBookingRecord(data) {
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) {
    throw new Error('NOTION_DATABASE_ID is not set');
  }

  const properties = {
    'お名前': {
      title: [{ text: { content: text(data.name) || '（無名）' } }],
    },
    'メール': {
      email: data.email || null,
    },
    'ご希望日': {
      rich_text: richText(data.preferredDate),
    },
    'ご要望': {
      rich_text: richText(data.message),
    },
    '受付日時': {
      date: { start: data.receivedAtISO },
    },
  };

  // 任意項目は値があるときだけ送る（プロパティ未作成でも壊れにくいように）
  if (data.phone) {
    properties['電話番号'] = { phone_number: text(data.phone) };
  }
  if (data.plan) {
    // Notionのセレクト名はカンマ不可のため除去（例: ¥29,000 → ¥29000）
    properties['プラン'] = { select: { name: text(data.plan).replace(/,/g, '') } };
  }

  // 「撮影ジャンル」「エリア」は、データベース側にプロパティが作成されている場合のみ送信
  // （未作成の状態で送るとNotion APIがエラーを返し、予約記録全体が失敗してしまうため）
  const existingProps = await getDatabasePropertyNames(databaseId);
  if (data.genre && existingProps.has('撮影ジャンル')) {
    properties['撮影ジャンル'] = { select: { name: text(data.genre).replace(/,/g, '') } };
  }
  if (data.area && existingProps.has('エリア')) {
    properties['エリア'] = { rich_text: richText(data.area) };
  }
  // 概算金額（booking.js の computeEstimate がサーバー側で再計算した値）。
  // 特商法12条の6の最終確認画面でお客様に提示した対価を、台帳側にも残すためのもの。
  if (typeof data.estimateYen === 'number' && existingProps.has('概算金額')) {
    properties['概算金額'] = { number: data.estimateYen };
  }
  // ステータスは「選択（Select）」型のプロパティ（「ステータス」型ではない点に注意。
  // 型が違うとNotion APIがエラーを返し予約記録全体が失敗するため、変更する際は
  // 実際のプロパティ設定を確認すること）。新規予約は常に「新規」で作成する。
  if (existingProps.has('ステータス')) {
    properties['ステータス'] = { select: { name: '新規' } };
  }

  return getClient().pages.create({
    parent: { database_id: databaseId },
    properties,
  });
}
