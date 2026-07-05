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
//   ステータス  … Status または Select（既定値「新規」）
//   受付日時    … Date
// ============================================================

import { Client } from '@notionhq/client';

let cachedClient = null;

function getClient() {
  if (!cachedClient) {
    cachedClient = new Client({ auth: process.env.NOTION_API_KEY });
  }
  return cachedClient;
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

  return getClient().pages.create({
    parent: { database_id: databaseId },
    properties,
  });
}
