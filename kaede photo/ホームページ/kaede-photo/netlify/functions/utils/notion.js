/**
 * kaede photo — Notion API ユーティリティ
 *
 * 予約フォームのデータを Notion データベースに記録する。
 * メール送信が成功した後に呼び出す（失敗してもユーザー体験に影響させない）。
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * テキストプロパティ用ヘルパー
 */
function richText(content) {
  return { rich_text: [{ text: { content: String(content || '') } }] };
}

/**
 * 予約データを Notion データベースに追記する
 *
 * @param {Object} data - フォームデータ
 * @param {string} data.name
 * @param {string} data.email
 * @param {string} data.date1     - YYYY-MM-DD
 * @param {string} [data.date2]   - YYYY-MM-DD
 * @param {string} data.location
 * @param {string} data.plan
 * @param {string|number} data.kids_count
 * @param {string} data.kids_age
 * @param {string} [data.message]
 * @returns {Promise<void>}
 * @throws {Error} Notion API エラー時
 */
export async function appendToNotion(data) {
  const {
    name, email, date1, date2,
    location, plan, kids_count, kids_age, message,
  } = data;

  const today = new Date().toISOString().split('T')[0];

  const properties = {
    // タイトル列（Notion DB の必須列）
    '氏名': {
      title: [{ text: { content: String(name || '') } }],
    },
    'メール': {
      email: String(email || ''),
    },
    '状態': {
      select: { name: '仮予約' },
    },
    '申込日': {
      date: { start: today },
    },
    '第1希望': {
      date: { start: String(date1 || '') },
    },
    '撮影場所': richText(location),
    'プラン':   richText(plan),
    '子ども人数': {
      number: Number(kids_count) || 0,
    },
    '子ども年齢': richText(kids_age),
    '備考':       richText(message || ''),
    '入金確認': { checkbox: false },
    '返金完了': { checkbox: false },
  };

  // 第2希望は入力があった場合のみ追加
  if (date2) {
    properties['第2希望'] = { date: { start: String(date2) } };
  }

  const body = {
    parent: { database_id: process.env.NOTION_DB_ID },
    properties,
  };

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Notion API error ${res.status}: ${errBody}`);
  }
}
