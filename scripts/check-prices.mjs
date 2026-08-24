#!/usr/bin/env node
// ============================================================
// 料金の整合性チェック
//   HTML側の表示価格（プランカード6ファイル分・料金シミュレーター・
//   表示用オプション表・交通費参考表・予約フォーム）⇔
//   netlify/functions/booking.js の単価表（OPTION_PRICES / AREA_PRICES / ALLOWED_PLANS）
//
// このプロジェクトはビルドステップの無い静的サイトのため、上記は手動で二重管理されている。
// 値上げ・プラン改定時に一部だけ更新すると、お客様に見せた概算金額と実際にサーバーが
// 記録・請求根拠とする金額がズレる（computeEstimate()のmismatch検知はログ・注記を
// 残すだけで送信自体は止めない設計のため）。
//
// デプロイ前に手動実行し、ズレを検出する:
//   node scripts/check-prices.mjs
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = p => readFileSync(path.join(root, p), 'utf8');

const bookingSrc = read('netlify/functions/booking.js');
const indexSrc = read('public/index.html');
const LP_FILES = ['newborn.html', 'maternity.html', 'omiyamairi.html', 'shichigosan.html', 'birthday.html'];

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
// プラン名prefix（simple/standard/special/premium）→ 価格。要約カード・シミュレーターの突き合わせに使う
const PLAN_PRICE_BY_PREFIX = {};
for (const p of ALLOWED_PLANS) {
  const m = p.match(/^([a-z]+)\s*¥([\d,]+)/);
  if (m) PLAN_PRICE_BY_PREFIX[m[1]] = parseInt(m[2].replace(/,/g, ''), 10);
}

function normalizePlanForMatch(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
}

// ラベル文言から金額を読む（public/index.html の _optYen() と同じロジック＝HTML側の「真実の値」）
function optYen(label) {
  const neg = /[−\-]\s*[\d,]+\s*円/.test(label || '');
  const m = (label || '').replace(/,/g, '').match(/(\d+)\s*円/);
  if (!m) return null;
  return (neg ? -1 : 1) * parseInt(m[1], 10);
}

// ラベルから末尾の金額表記（＋3,000円 / −500円）を取り除き、説明文だけを残す
// （シミュレーター・表示用テーブルとdata-optラベルを同一項目として突き合わせるための共通キー）
function stripPriceSuffix(label) {
  return String(label || '')
    .replace(/[＋+−\-]\s*[\d,]+\s*円\s*$/, '')
    .replace(/\s+/g, '')
    .trim();
}

// <option>タグの中身をすべて拾う（valueが唯一/先頭の属性という前提を置かない）
function extractOptions(blockHtml) {
  const out = [];
  for (const m of blockHtml.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)) {
    const [, attrs, text] = m;
    const valueMatch = attrs.match(/\bvalue="([^"]*)"/);
    out.push({ value: valueMatch ? valueMatch[1] : undefined, text: text.trim(), attrs });
  }
  return out;
}

const mismatches = [];

// ---- 1) data-opt 付きチェックボックス（予約フォーム側。これを「正」として他項目と突き合わせる） ----
const seenOpts = new Set();
const descToOptPrice = new Map(); // stripPriceSuffix(label) -> OPTION_PRICESの値（信頼できる対応表）
for (const m of indexSrc.matchAll(/<input[^>]*data-opt="([a-z0-9_]+)"[^>]*>([^<]*)/g)) {
  const [, key, labelText] = m;
  const htmlYen = optYen(labelText);
  if (htmlYen === null) continue;
  seenOpts.add(key);
  descToOptPrice.set(stripPriceSuffix(labelText), { key, price: htmlYen });
  const serverYen = OPTION_PRICES[key];
  if (serverYen === undefined) {
    mismatches.push(`data-opt="${key}" はHTMLにあるが OPTION_PRICES に存在しない（HTML表示 ¥${htmlYen}）`);
  } else if (serverYen !== htmlYen) {
    mismatches.push(`data-opt="${key}": HTML表示 ¥${htmlYen} ≠ OPTION_PRICES ¥${serverYen}`);
  }
}

// ---- 2) ジャンル別オプション（GENRE_OPTIONS内の { key: '...', label: '...' } ） ----
for (const m of indexSrc.matchAll(/\{\s*key:\s*'([a-z0-9_]+)',\s*label:\s*'([^']*)'/g)) {
  const [, key, labelText] = m;
  const htmlYen = optYen(labelText);
  if (htmlYen === null) continue;
  seenOpts.add(key);
  descToOptPrice.set(stripPriceSuffix(labelText), { key, price: htmlYen });
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

// ---- 3) エリア（data-area属性つき<option>） ----
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

// ---- 4) 予約フォームのプラン<option>（#f-plan、装飾テキストを除いた価格部分のみ比較） ----
// value属性が明示されていればそれを、無ければテキスト内容を送信値とみなす
const fPlanBlock = indexSrc.match(/<select[^>]*id="f-plan"[^>]*>([\s\S]*?)<\/select>/);
if (!fPlanBlock) throw new Error('#f-plan セレクトが index.html 内に見つかりません');
const seenPlans = new Set();
for (const opt of extractOptions(fPlanBlock[1])) {
  const raw = (opt.value !== undefined ? opt.value : opt.text).trim();
  if (!raw) continue; // 「選択してください」等の空プレースホルダーは対象外
  const normalized = normalizePlanForMatch(raw);
  seenPlans.add(normalized);
  if (!ALLOWED_PLANS.includes(normalized)) {
    mismatches.push(`プラン "${raw}"（正規化後 "${normalized}"）はHTML(#f-plan)にあるが ALLOWED_PLANS に存在しない`);
  }
}
const smashCakeMatch = bookingSrc.match(/const SMASH_CAKE_PLANS = new Set\(\[([\s\S]*?)\]\);/);
const SMASH_CAKE_PLANS = smashCakeMatch ? [...smashCakeMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
// ALLOWED_PLANS と SMASH_CAKE_PLANS は booking.js 内で別々のリテラル配列として二重管理されている。
// 片方だけプラン名を変更すると受付期限チェックが静かに無効化されるため、ここで先に検出する
for (const p of SMASH_CAKE_PLANS) {
  if (!ALLOWED_PLANS.includes(p)) {
    mismatches.push(`SMASH_CAKE_PLANS の "${p}" が ALLOWED_PLANS に存在しない（受付期限チェックが効かなくなっている可能性）`);
  }
}
for (const p of ALLOWED_PLANS) {
  // 期間限定コラボ企画のプランは index.html の #f-plan ではなく birthday-collab.html 側にあるため対象外
  if (SMASH_CAKE_PLANS.includes(p)) continue;
  if (!seenPlans.has(p)) {
    mismatches.push(`ALLOWED_PLANS の "${p}" が index.html の #f-plan に見つからない`);
  }
}

// 期間限定コラボ企画のプランは birthday-collab.html の #c-plan 側で突き合わせる
if (SMASH_CAKE_PLANS.length) {
  const collabSrc = read('public/birthday-collab.html');
  const cPlanBlock = collabSrc.match(/<select[^>]*id="c-plan"[^>]*>([\s\S]*?)<\/select>/);
  if (!cPlanBlock) {
    mismatches.push('#c-plan セレクトが birthday-collab.html 内に見つからない（SMASH_CAKE_PLANSの突き合わせ不可）');
  } else {
    const seenCollabPlans = new Set();
    for (const opt of extractOptions(cPlanBlock[1])) {
      const raw = (opt.value !== undefined ? opt.value : opt.text).trim();
      if (raw) seenCollabPlans.add(raw);
    }
    for (const p of SMASH_CAKE_PLANS) {
      if (!seenCollabPlans.has(p)) {
        mismatches.push(`SMASH_CAKE_PLANS の "${p}" が birthday-collab.html の #c-plan に見つからない`);
      }
    }
  }
}

// ---- 5) 料金シミュレーター（プラン#sp・オプション.so）：valueがOPTION_PRICES/プラン価格と一致するか ----
const spBlock = indexSrc.match(/<select[^>]*id="sp"[^>]*>([\s\S]*?)<\/select>/);
if (spBlock) {
  for (const opt of extractOptions(spBlock[1])) {
    const prefix = (opt.text.match(/^([a-z]+)/) || [])[1];
    const htmlYen = parseInt(opt.value, 10);
    if (!prefix || Number.isNaN(htmlYen)) continue;
    const serverYen = PLAN_PRICE_BY_PREFIX[prefix];
    if (serverYen === undefined) {
      mismatches.push(`シミュレーター #sp の "${opt.text}" に対応するプランが ALLOWED_PLANS に無い`);
    } else if (serverYen !== htmlYen) {
      mismatches.push(`シミュレーター #sp "${opt.text}": value=¥${htmlYen} ≠ ALLOWED_PLANS ¥${serverYen}`);
    }
  }
} else {
  mismatches.push('シミュレーターのプラン選択 #sp が index.html に見つからない（要確認）');
}

for (const m of indexSrc.matchAll(/<input[^>]*class="so"[^>]*value="(-?\d+)"[^>]*>([^<]*)/g)) {
  const [, valueStr, labelText] = m;
  const htmlValueYen = parseInt(valueStr, 10);
  const desc = stripPriceSuffix(labelText);
  if (!desc) continue; // ラベルに金額を含まない項目
  const known = descToOptPrice.get(desc);
  if (!known) {
    // 例:「ご紹介あり」は今回の金額に影響しない設計（value="0"）で、
    // 予約フォーム側のラベル文言（次回適用の説明文）とは意図的に短く書き分けているため対象外
    if (htmlValueYen === 0) continue;
    mismatches.push(`シミュレーターの ".so" 項目 "${labelText.trim()}" が予約フォーム側のオプション一覧と対応付けできない`);
    continue;
  }
  if (known.price !== htmlValueYen) {
    mismatches.push(`シミュレーター ".so" "${desc}": value=¥${htmlValueYen} ≠ OPTION_PRICES.${known.key} ¥${known.price}`);
  }
}

// 表示用オプション表は、予約フォームのチェックボックスと実質同じ項目を指しながら
// 敬語などで文言が微妙に異なる箇所がある（例:「お顔」/「顔」）。誤検知を避けるための別名対応。
// ここに載っていない項目は文言を完全一致させること
const OPTION_TABLE_DESC_ALIASES = new Map([
  ['SNS割（お顔を含む）', 'SNS割（顔を含む）'],
  ['SNS割（お顔を含まない・パーツショットのみ）', 'SNS割（顔を含まない）'],
]);
// 価格チェック対象外の行（ジャンル限定オプションは§2で、紹介割は0円のため別枠で確認済み）
const OPTION_TABLE_SKIP_DESC = new Set(['ニューボーンフォトセット', 'ご紹介割（紹介者・ご本人）']);

// ---- 6) 表示用オプション表・交通費参考表（<table class="option-table">/<table class="area-table">の最初のもの） ----
function checkDisplayTable(tableHtml, { isArea }) {
  for (const rowM of tableHtml.matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<\/tr>/g)) {
    const [, rawDesc, priceCell] = rowM;
    const htmlYen = optYen(priceCell);
    if (htmlYen === null) continue; // 見出し行・金額を含まない行
    let desc = stripPriceSuffix(rawDesc.replace(/<br\s*\/?>[\s\S]*/i, '')); // <br>以降の補足説明は除く
    if (!isArea) {
      if (OPTION_TABLE_SKIP_DESC.has(desc)) continue;
      desc = OPTION_TABLE_DESC_ALIASES.get(desc) || desc;
    }
    if (isArea) {
      if (!(desc in AREA_PRICES)) {
        mismatches.push(`交通費参考表の "${desc}" が AREA_PRICES に無い`);
      } else if (AREA_PRICES[desc] !== htmlYen) {
        mismatches.push(`交通費参考表 "${desc}": 表示 ¥${htmlYen} ≠ AREA_PRICES ¥${AREA_PRICES[desc]}`);
      }
    } else {
      const known = descToOptPrice.get(desc);
      if (!known) {
        mismatches.push(`オプション表の "${desc}" が予約フォーム側のオプション一覧と対応付けできない`);
      } else if (known.price !== htmlYen) {
        mismatches.push(`オプション表 "${desc}": 表示 ¥${htmlYen} ≠ OPTION_PRICES.${known.key} ¥${known.price}`);
      }
    }
  }
}
const optionTableM = indexSrc.match(/<table class="option-table">([\s\S]*?)<\/table>/);
if (optionTableM) checkDisplayTable(optionTableM[1], { isArea: false });
const areaTableM = indexSrc.match(/<table class="area-table">([\s\S]*?)<\/table>/);
if (areaTableM) checkDisplayTable(areaTableM[1], { isArea: true });

// ---- 7) プランカード（index.html 2箇所 + 5つのジャンルLP）：plan-name と plan-price の対応を全箇所で確認 ----
function checkPlanCards(html, label) {
  // plan-card 内の plan-name（先頭の英字プラン名）と plan-price（¥表示）をブロック単位で拾う
  for (const cardM of html.matchAll(/<div class="plan-card[^"]*">([\s\S]*?)<\/div>\s*(?=<div class="plan-card|<\/div>\s*<div class="text-center"|<div class="text-center"|<\/div>\s*<\/div>)/g)) {
    const block = cardM[1];
    const nameM = block.match(/<div class="plan-name">([a-z]+)<\/div>/);
    const priceM = block.match(/<div class="plan-price">¥([\d,]+)/);
    if (!nameM || !priceM) continue;
    const prefix = nameM[1];
    const htmlYen = parseInt(priceM[1].replace(/,/g, ''), 10);
    const serverYen = PLAN_PRICE_BY_PREFIX[prefix];
    if (serverYen === undefined) {
      mismatches.push(`${label}: プランカード "${prefix}" に対応する価格が ALLOWED_PLANS に無い`);
    } else if (serverYen !== htmlYen) {
      mismatches.push(`${label}: プランカード "${prefix}" 表示 ¥${htmlYen} ≠ ALLOWED_PLANS ¥${serverYen}`);
    }
  }
}
checkPlanCards(indexSrc, 'index.html');
for (const file of LP_FILES) {
  checkPlanCards(read(`public/${file}`), file);
}

if (mismatches.length) {
  console.error(`料金の不一致が ${mismatches.length} 件見つかりました:\n`);
  mismatches.forEach(msg => console.error(' - ' + msg));
  process.exitCode = 1;
} else {
  console.log('OK: プランカード（index.html + 5ジャンルLP）・料金シミュレーター・表示用オプション表/交通費表・予約フォームの表示価格は、booking.js の単価表とすべて一致しています。');
}
