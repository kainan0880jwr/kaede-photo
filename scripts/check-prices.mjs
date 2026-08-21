#!/usr/bin/env node
// ============================================================
// 料金の整合性チェック（public/index.html の表示価格 ⇔ netlify/functions/booking.js の単価表）
//
// このプロジェクトはビルドステップの無い静的サイトのため、
// HTML側のラベル文言とサーバー側の単価表（OPTION_PRICES / AREA_PRICES / ALLOWED_PLANS）は
// それぞれ手動で二重管理されている。値上げ・プラン改定時に片方だけ更新すると、
// お客様に見せた概算金額と実際にサーバーが記録・請求根拠とする金額がズレる
// （computeEstimate()のmismatch検知はログ・注記を残すだけで送信自体は止めない設計のため）。
//
// デプロイ前に手動実行し、ズレを検出する:
//   node scripts/check-prices.mjs
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bookingSrc = readFileSync(path.join(root, 'netlify/functions/booking.js'), 'utf8');
const indexSrc = readFileSync(path.join(root, 'public/index.html'), 'utf8');

function extractNumericObjectLiteral(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  if (!m) throw new Error(`${name} が booking.js 内に見つかりません`);
  const entries = {};
  for (const line of m[1].split('\n')) {
    const em = line.match(/^\s*(?:'([^']+)'|([A-Za-z0-9_]+)):\s*(-?\d+),/);
    if (em) entries[em[1] || em[2]] = parseInt(em[3], 10);
  }
  return entries;
}

const OPTION_PRICES = extractNumericObjectLiteral(bookingSrc, 'OPTION_PRICES');
const AREA_PRICES = extractNumericObjectLiteral(bookingSrc, 'AREA_PRICES');

const plansMatch = bookingSrc.match(/const ALLOWED_PLANS = new Set\(\[([\s\S]*?)\]\);/);
if (!plansMatch) throw new Error('ALLOWED_PLANS が booking.js 内に見つかりません');
const ALLOWED_PLANS = [...plansMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

function normalizePlanForMatch(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
}

// public/index.html の _optYen() と同じロジック（HTML側の「真実の値」＝表示ラベルから金額を読む）
function optYen(label) {
  const neg = /[−\-]\s*[\d,]+\s*円/.test(label || '');
  const m = (label || '').replace(/,/g, '').match(/(\d+)\s*円/);
  if (!m) return null; // 金額を含まないラベル（例: ご紹介割。今回の合計には影響しない設計）
  return (neg ? -1 : 1) * parseInt(m[1], 10);
}

const mismatches = [];

// 1) data-opt 付きチェックボックス（静的HTML）
const seenOpts = new Set();
for (const m of indexSrc.matchAll(/<input[^>]*data-opt="([a-z0-9_]+)"[^>]*>([^<]*)/g)) {
  const [, key, labelText] = m;
  const htmlYen = optYen(labelText);
  if (htmlYen === null) continue;
  seenOpts.add(key);
  const serverYen = OPTION_PRICES[key];
  if (serverYen === undefined) {
    mismatches.push(`data-opt="${key}" はHTMLにあるが OPTION_PRICES に存在しない（HTML表示 ¥${htmlYen}）`);
  } else if (serverYen !== htmlYen) {
    mismatches.push(`data-opt="${key}": HTML表示 ¥${htmlYen} ≠ OPTION_PRICES ¥${serverYen}`);
  }
}

// 2) ジャンル別オプション（GENRE_OPTIONS内の { key: '...', label: '...' } ）
for (const m of indexSrc.matchAll(/\{\s*key:\s*'([a-z0-9_]+)',\s*label:\s*'([^']*)'/g)) {
  const [, key, labelText] = m;
  const htmlYen = optYen(labelText);
  if (htmlYen === null) continue;
  seenOpts.add(key);
  const serverYen = OPTION_PRICES[key];
  if (serverYen === undefined) {
    mismatches.push(`GENRE_OPTIONS key="${key}" はHTMLにあるが OPTION_PRICES に存在しない（HTML表示 ¥${htmlYen}）`);
  } else if (serverYen !== htmlYen) {
    mismatches.push(`GENRE_OPTIONS key="${key}": HTML表示 ¥${htmlYen} ≠ OPTION_PRICES ¥${serverYen}`);
  }
}

for (const key of Object.keys(OPTION_PRICES)) {
  // 0円の項目（例: referral＝今回の金額には影響しない設計）はHTML側に価格表示が無くて正常
  if (!seenOpts.has(key) && OPTION_PRICES[key] !== 0) {
    mismatches.push(`OPTION_PRICES.${key} は booking.js にあるが index.html のdata-optで見つからない`);
  }
}

// 3) エリア（data-area属性つき<option>）
const seenAreas = new Set();
for (const m of indexSrc.matchAll(/<option value="(-?\d+)" data-area="([^"]+)">/g)) {
  const [, yenStr, areaName] = m;
  const htmlYen = parseInt(yenStr, 10);
  seenAreas.add(areaName);
  const serverYen = AREA_PRICES[areaName];
  if (serverYen === undefined) {
    mismatches.push(`data-area="${areaName}" はHTMLにあるが AREA_PRICES に存在しない（HTML表示 ¥${htmlYen}）`);
  } else if (serverYen !== htmlYen) {
    mismatches.push(`data-area="${areaName}": HTML表示 ¥${htmlYen} ≠ AREA_PRICES ¥${serverYen}`);
  }
}
for (const areaName of Object.keys(AREA_PRICES)) {
  if (!seenAreas.has(areaName)) {
    mismatches.push(`AREA_PRICES['${areaName}'] は booking.js にあるが index.html のdata-areaで見つからない`);
  }
}

// 4) 予約フォームのプラン<option>（#f-plan、装飾テキストを除いた価格部分のみ比較）
// value属性が明示されていればそれを、無ければテキスト内容を送信値とみなす（index.htmlは明示、
// 過去のHTMLや他ページが暗黙依存のままでも両方拾えるようにしておく）
const fPlanBlock = indexSrc.match(/<select[^>]*id="f-plan"[^>]*>([\s\S]*?)<\/select>/);
if (!fPlanBlock) throw new Error('#f-plan セレクトが index.html 内に見つかりません');
for (const m of fPlanBlock[1].matchAll(/<option(?:\s+value="([^"]*)")?>([^<]*)<\/option>/g)) {
  const [, valueAttr, text] = m;
  const raw = (valueAttr !== undefined ? valueAttr : text).trim();
  if (!raw) continue; // 「選択してください」等の空プレースホルダーは対象外
  const normalized = normalizePlanForMatch(raw);
  if (!ALLOWED_PLANS.includes(normalized)) {
    mismatches.push(`プラン "${raw}"（正規化後 "${normalized}"）はHTML(#f-plan)にあるが ALLOWED_PLANS に存在しない`);
  }
}

if (mismatches.length) {
  console.error(`料金の不一致が ${mismatches.length} 件見つかりました:\n`);
  mismatches.forEach(msg => console.error(' - ' + msg));
  process.exitCode = 1;
} else {
  console.log('OK: index.html の表示価格と booking.js の単価表は一致しています。');
}
