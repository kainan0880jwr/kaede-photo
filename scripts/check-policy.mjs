#!/usr/bin/env node
// ============================================================
// キャンセルポリシー文言の整合性チェック
//
// キャンセル・返金に関する数値（安心保証金の金額／無料キャンセルの締切日数／
// 保証金が返らなくなる締切日数）は、index.html だけでも予約フォームの注記・
// #page-policy・特商法表・料金シミュレーターの説明文など複数箇所に、
// birthday-collab.html にも別文脈で書き出されている（CLAUDE.mdの
// 「キャンセルポリシー文言の重複」参照）。ビルドステップの無い静的サイトのため
// これらは手動で二重管理されており、値上げやポリシー変更で一部だけ更新すると
// お客様への案内が食い違う。
//
// check-prices.mjs と同じ発想（全出現箇所を機械的に集めて一致を検証し、
// 0件ヒットは「検査してすらいない」ことを示すので必ずエラーにする）で、
// デプロイ前に手動実行してズレを検出する:
//   node scripts/check-policy.mjs
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = p => readFileSync(path.join(root, p), 'utf8');

// rental.html はレンタル業（別事業・別ポリシー）、genre/areaページは
// index.html#policy へのリンクのみで数値の書き出しが無いため対象外。
const FILES = ['public/index.html', 'public/birthday-collab.html'];

let mismatches = [];

// src内の全マッチについて {value, file, line, context} を集める
function findAll(file, src, regex) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(regex)) {
      out.push({ value: m[1] || m[2], file, line: i + 1, context: lines[i].trim().slice(0, 80) });
    }
  }
  return out;
}

function assertAllEqual(label, found, expected) {
  if (found.length === 0) {
    throw new Error(`${label}: 0件しかヒットしませんでした（正規表現が壊れている可能性）`);
  }
  for (const f of found) {
    if (f.value !== expected) {
      mismatches.push(
        `${label}: ${f.file}:${f.line} に ${f.value} という値がありますが、期待値は ${expected} です\n    > ${f.context}`
      );
    }
  }
  return found.length;
}

// ---- 1. 安心保証金・キャンセル料の金額（「◯,◯◯◯円」の◯部分） ----
// 例: 「安心保証金2,000円」「キャンセル料は一律2,000円」「お預かりした保証金2,000円」
const DEPOSIT_RE = /(?:安心)?保証金(?:は一律|は通常のご予約と同じく|（|\s)*[（(]?\s*([\d,]+)\s*円|キャンセル料(?:は一律|は通常のご予約と同じく)?\s*([\d,]+)\s*円/g;

// ---- 2. 無料キャンセルの締切（「撮影日のN日前まで」に返金する側） ----
const FREE_CUTOFF_RE = /([0-9]+)日前(?:まで|までの)(?:に)?(?:ご連絡|の)/g;

// ---- 3. 保証金が返らなくなる締切（「N日前以降」は返金しない側） ----
const CHARGE_CUTOFF_RE = /([0-9]+)日前以降/g;

let depositCount = 0, freeCount = 0, chargeCount = 0;
for (const file of FILES) {
  const src = read(file);
  depositCount += assertAllEqual('安心保証金・キャンセル料の金額', findAll(file, src, DEPOSIT_RE), '2,000');
  freeCount += assertAllEqual('無料キャンセルの締切日数', findAll(file, src, FREE_CUTOFF_RE), '5');
  chargeCount += assertAllEqual('保証金が返らなくなる締切日数', findAll(file, src, CHARGE_CUTOFF_RE), '4');
}

console.log(`[check-policy] 金額の出現: ${depositCount}件 / 無料締切(5日前)の出現: ${freeCount}件 / 有償締切(4日前)の出現: ${chargeCount}件`);

if (mismatches.length > 0) {
  console.error('\n[check-policy] 不一致が見つかりました:\n');
  for (const m of mismatches) console.error(' - ' + m + '\n');
  process.exit(1);
}

console.log('[check-policy] OK: キャンセルポリシーの金額・締切日数はすべて一致しています');
