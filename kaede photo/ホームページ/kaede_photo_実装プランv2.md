# kaede photo — バックエンド実装プラン v2

> v1 からの変更点は ⚠️ アイコンで示す  
> レビュー指摘: Vercel商用禁止・エラー設計・Rate Limit・台帳・状態遷移・技術的負債・PayPay

---

## 0. v1 からの主な変更

| # | v1 の問題 | v2 での対処 |
|---|-----------|------------|
| 1 | Vercel Hobby は商用利用禁止 | ⚠️ **Netlify** に変更（無料プランでも商用OK） |
| 2 | エラー時フォールバック未設計 | ⚠️ メール送信を最優先に分離、Sheets失敗はアラートメールで補完 |
| 3 | Rate Limiting が Vercel Hobby 非対応 | ⚠️ **Upstash Redis** + `@upstash/ratelimit` を Phase 1 から導入 |
| 4 | 予約確定の状態遷移が未定義 | ⚠️ 仮予約 → 確定 → 入金 → 撮影 → 返金 の5段階を設計 |
| 5 | SPF/DKIM/DMARC 未記載 | ⚠️ Resend DNS 設定を Phase 1 の必須ステップに追加 |
| 6 | Google Sheets API は非エンジニアに危険 | ⚠️ **Notion API** に変更（UIが直感的・トークン管理が単純） |
| 7 | Cloudinary のトランスフォーメーション上限 | ⚠️ URL パラメータ固定 + キャッシュ設計を追記 |
| 8 | Contentful は過剰 | ⚠️ 計画から削除。Cloudinary の Media Library で代替 |
| 9 | 72KB 単一HTML は技術的負債 | ⚠️ Phase 2 で **Astro** 再構築を計画に追加 |
| 10 | PayPay 手動フローが曖昧 | ⚠️ 具体的な手順と確認ポイントを明文化 |
| 11 | PayPay SDK が非メンテナンス | ⚠️ Phase 3 では SDK を使わず REST API 直叩き |

---

## 1. アーキテクチャ概要（v2）

```
┌─────────────────────────────────────────────────────────┐
│  ユーザーブラウザ（HTML / Astro 再構築後）                │
└──────────────┬──────────────────────────────────────────┘
               │ HTTPS
┌──────────────▼───────────────────┐
│  Netlify（ホスティング + Functions）│  ← 商用利用OK・無料枠あり
│  - グローバル CDN                  │
│  - 自動 HTTPS / HTTP/2             │
│  - Netlify Functions（API）        │
└──────────────┬───────────────────┘
               │
    ┌──────────┴─────────────────────────────────┐
    │                                              │
┌───▼────────────┐                   ┌────────────▼──────┐
│ Netlify Function│                   │   Cloudinary       │
│ POST /api/book  │                   │  （画像CDN・最適化）│
└───┬────────────┘                   └───────────────────┘
    │
    ├── Upstash Redis（Rate Limiting）
    │
    ├── Resend（メール: 最優先・独立）
    │   ├── 仮予約通知 → だいきさん
    │   └── 自動返信   → お客様
    │
    └── Notion API（予約台帳: メール成功後に非同期記録）
        └── 失敗時 → だいきさんへアラートメール
```

---

## 2. 予約の状態遷移設計（⚠️ v1 になかった重要設計）

```
[1. 仮予約]    ← フォーム送信
    ↓ だいきさんがメール確認・日程調整
[2. 仮確定]    ← だいきさんが返信・PayPay リンク送付
    ↓ お客様が PayPay で 2,000円 支払い
[3. 予約確定]  ← だいきさんが入金確認
    ↓ 撮影日当日
[4. 撮影完了]  ← だいきさんがアプリから返金
[5. 返金完了]  ← PayPay 返金処理
    ↓ 約1ヶ月後
[6. 納品完了]  ← オンラインアルバム URL を送付
```

**Notion データベースの列設計:**

| 列名 | 型 | 内容 |
|------|---|------|
| 状態 | セレクト | 仮予約 / 仮確定 / 予約確定 / 撮影完了 / 返金完了 / 納品完了 |
| 申込日 | 日付 | 自動入力 |
| 氏名 | テキスト | フォームから |
| メール | メール | フォームから |
| 第1希望 | 日付 | フォームから |
| 第2希望 | 日付 | フォームから |
| 撮影場所 | テキスト | フォームから |
| プラン | セレクト | simple / standard / special / premium |
| 子ども人数 | 数値 | フォームから |
| 子ども年齢 | テキスト | フォームから |
| PayPay URL | URL | だいきさんが手動入力 |
| 入金確認 | チェック | だいきさんが確認後にチェック |
| 返金完了 | チェック | 返金後にチェック |
| 備考 | テキスト | フォームのご要望 |

---

## 3. Phase 1 — 最速 MVP（2〜3日）

### 3-1. ホスティング: Netlify（⚠️ Vercel から変更）

**Vercel Hobby と Netlify 無料プランの比較:**

| 項目 | Vercel Hobby | Netlify Starter |
|------|-------------|-----------------|
| 商用利用 | ❌ 禁止 | ✅ OK |
| 帯域 | 100GB/月 | 100GB/月 |
| Functions 実行時間 | 10秒 | 26秒 |
| デプロイ | GitHub自動 | GitHub自動 |
| カスタムドメイン | ✅ | ✅ |
| 月額 | 無料 | 無料 |

**ディレクトリ構成:**
```
kaede-photo/
├── public/
│   └── index.html        # 現在の kaede_photo_website.html をリネーム
├── netlify/
│   └── functions/
│       └── booking.js    # 予約受付 Function
├── netlify.toml
└── package.json
```

**`netlify.toml`:**
```toml
[build]
  functions = "netlify/functions"
  publish = "public"

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    X-Frame-Options = "DENY"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
```

### 3-2. Rate Limiting: Upstash Redis（⚠️ v1 になかった）

**Upstash 無料枠:** 10,000リクエスト/日（個人サービスに十分）

```javascript
// netlify/functions/booking.js 先頭に追加
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(3, '1 h'), // 同一IPから1時間に3回まで
});

export const handler = async (event) => {
  const ip = event.headers['x-nf-client-connection-ip'] || '127.0.0.1';
  const { success } = await ratelimit.limit(ip);

  if (!success) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: '送信回数の上限に達しました。しばらく後にお試しください。' }),
    };
  }
  // ... 以降の処理
};
```

### 3-3. フォームバックエンド: Resend（メール送信を最優先に独立）

**設計原則: メール送信 → Notion 記録 の順で優先度を分ける**

```javascript
// netlify/functions/booking.js（⚠️ v1 から設計変更）
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Rate Limit チェック（上記参照）

  const data = JSON.parse(event.body);
  const { name, email, date1, date2, location, plan, kids_count, kids_age, message } = data;

  // バリデーション
  if (!name || !email || !date1 || !location || !plan) {
    return { statusCode: 400, body: JSON.stringify({ error: '必須項目が未入力です' }) };
  }

  // ─── ① メール送信（最優先・独立処理）───
  // 両方のメールを並列送信して時間短縮
  const emailResults = await Promise.allSettled([
    // だいきさんへの通知
    resend.emails.send({
      from: 'kaede photo <noreply@kaedephoto.com>',
      to: 'kaepafu1995@gmail.com',
      replyTo: email,
      subject: `【仮予約】${name} 様 — 第1希望: ${date1}`,
      html: buildOwnerEmail(data),
    }),
    // お客様への自動返信
    resend.emails.send({
      from: 'kaede photo <noreply@kaedephoto.com>',
      to: email,
      subject: 'ご予約申込を受け付けました — kaede photo',
      html: buildCustomerEmail(data),
    }),
  ]);

  // メール失敗はここでキャッチして 500 を返す
  const emailFailed = emailResults.some(r => r.status === 'rejected');
  if (emailFailed) {
    console.error('Email failed:', emailResults);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'メール送信に失敗しました。kaepafu1995@gmail.com に直接ご連絡ください。' }),
    };
  }

  // ─── ② Notion 記録（メール成功後に実行、失敗してもユーザーには通知しない）───
  try {
    await appendToNotion(data);
  } catch (err) {
    // Notion 失敗時はだいきさんにアラートを送るだけ（お客様には影響させない）
    console.error('Notion write failed:', err);
    await resend.emails.send({
      from: 'kaede photo system <noreply@kaedephoto.com>',
      to: 'kaepafu1995@gmail.com',
      subject: '⚠️ 予約台帳の記録に失敗しました',
      html: `<p>${name} 様（${email}）の予約が Notion に記録されませんでした。手動で追加してください。</p><pre>${JSON.stringify(data, null, 2)}</pre>`,
    });
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
```

### 3-4. Resend DNS 設定（⚠️ v1 になかった必須ステップ）

**Resend ダッシュボードで「Domains」→「Add Domain」→ kaedephoto.com を登録すると以下の DNS レコードが発行される:**

```
# ドメインのDNS設定（お名前.com / Xserver等で設定）

# SPF（なりすましメール防止）
TXT  @  "v=spf1 include:amazonses.com ~all"

# DKIM（メール改ざん防止）
CNAME  resend._domainkey  [Resendが発行するCNAME]

# DMARC（不正メールの処理方針）
TXT  _dmarc  "v=DMARC1; p=none; rua=mailto:kaepafu1995@gmail.com"
```

> ⚠️ これを設定しないと Gmail にスパム判定される可能性が高い。  
> 設定後、Resend ダッシュボードで「Verify」ボタンを押して確認できる。

### 3-5. フロントエンドの変更点

```javascript
// HTML の submitForm 関数を差し替え
async function submitForm(e) {
  e.preventDefault();
  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = '送信中...';

  const formData = new FormData(e.target);
  const body = Object.fromEntries(formData.entries());

  try {
    const res = await fetch('/.netlify/functions/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '送信失敗');
    goPage('success');
    e.target.reset();
  } catch (err) {
    alert(err.message || '送信に失敗しました。kaepafu1995@gmail.com までご連絡ください。');
  } finally {
    btn.disabled = false;
    btn.textContent = '予約を申し込む';
  }
}
```

---

## 4. Phase 2 — 運用安定化（1〜2週間）

### 4-1. 予約台帳: Notion API（⚠️ Google Sheets から変更）

**なぜ Notion か:**
- だいきさんが直感的に使えるUI（ステータスをドラッグで変更できる）
- API トークンが Bearer Token のみで管理が単純
- データベースをそのままカレンダー/ボードビューで見られる
- 無料プランで十分

**セットアップ:**
```
1. Notion で「kaede photo 予約管理」データベースを作成（上記の列設計で）
2. Notion Integrations で「kaede photo bot」を作成
3. データベースと Integration を連携（「共有」→ Integration を追加）
4. Integration Token を Netlify 環境変数に設定
```

**`appendToNotion` の実装:**
```javascript
async function appendToNotion(data) {
  const { name, email, date1, date2, location, plan, kids_count, kids_age, message } = data;

  await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DB_ID },
      properties: {
        '氏名':     { title: [{ text: { content: name } }] },
        'メール':   { email },
        '状態':     { select: { name: '仮予約' } },
        '第1希望':  { date: { start: date1 } },
        '第2希望':  date2 ? { date: { start: date2 } } : { date: null },
        '撮影場所': { rich_text: [{ text: { content: location } }] },
        'プラン':   { select: { name: plan } },
        '子ども人数': { number: Number(kids_count) },
        '子ども年齢': { rich_text: [{ text: { content: kids_age } }] },
        '備考':     { rich_text: [{ text: { content: message || '' } }] },
        '申込日':   { date: { start: new Date().toISOString().split('T')[0] } },
      },
    }),
  });
}
```

### 4-2. 画像管理: Cloudinary（キャッシュ設計を追加）

**⚠️ v1 の問題:** URL ごとに変換が走ると無料枠（月25クレジット）を使い切る

**正しい実装 — 変換パラメータを URL に固定してキャッシュ活用:**
```html
<!-- 同じ変換パラメータ文字列を使えば Cloudinary のキャッシュが効く -->
<img
  src="https://res.cloudinary.com/kaedephoto/image/upload/w_800,f_auto,q_auto:good/v1/gallery/family_001.jpg"
  srcset="
    https://res.cloudinary.com/kaedephoto/image/upload/w_400,f_auto,q_auto:good/v1/gallery/family_001.jpg 400w,
    https://res.cloudinary.com/kaedephoto/image/upload/w_800,f_auto,q_auto:good/v1/gallery/family_001.jpg 800w"
  sizes="(max-width:767px) 100vw, 50vw"
  loading="lazy"
  decoding="async"
  width="800" height="1000"
  alt="家族写真撮影の様子">
```

**ポイント:**
- `q_auto:good` は自動品質調整（同じURLに対しては変換済みキャッシュが返る）
- `v1` を URL に含めると画像更新時に `/v2/` に変えてキャッシュバスティングができる
- **アップロードは Cloudinary Media Library のGUIから（コード不要）**

### 4-3. PayPay 手動フローの明文化（⚠️ v1 が曖昧だった）

```
【だいきさんの運用手順書（PayPay フロー）】

① フォーム送信通知メールが届いたら:
   - Notion で状態を「仮予約」から「確認中」に変更
   - 日程・場所に問題がなければ返信メールを送信

② お客様に PayPay リンクを送る手順:
   1. PayPay アプリ → 「受け取る」タブ
   2. 金額を「2000」と入力 → 「リンクで受け取る」
   3. 説明欄に「kaede photo 安心保証金（撮影当日に全額返金）」と入力
   4. リンクをコピーして確定メールにペースト
   5. Notion の「PayPay URL」列に同じURLを記録
   6. 状態を「仮確定」に変更

③ 入金確認:
   - PayPay アプリの「受け取り履歴」で確認
   - 確認できたら Notion の「入金確認」をチェック
   - 状態を「予約確定」に変更
   - お客様に「予約確定しました」メールを送信

④ 撮影当日の返金:
   - PayPay アプリ → 送金履歴 → 該当の受け取りを選択 → 返金
   - Notion の「返金完了」をチェック
   - 状態を「撮影完了」に変更
```

### 4-4. Astro による再構築計画（⚠️ 技術的負債対応）

**なぜ今の単一HTML は長期維持困難か:**
- 72KB の inline CSS/JS は数ヶ月後には可読性が著しく低下する
- 将来の依頼エンジニアがコンテキストなしに触れないコードになる
- ページ追加・デザイン変更のたびに全体への影響を考慮する必要がある

**推奨: Astro（静的サイトジェネレーター）**

選定理由:
- HTML/CSS/JS の知識がそのまま使える（React等の学習不要）
- 静的生成なので Netlify デプロイと相性が最良
- コンポーネント化でギャラリー・プランカードの管理が格段に楽になる
- STUDIO への移行は「デザインをゼロから作る」必要があるため、Astro で維持する方がコスト低

**移行ロードマップ:**
```
現在:  単一HTML（72KB）→ Netlify に静的配信
↓ Phase 2（運用が軌道に乗ったら）
目標:  Astro プロジェクトに移行
       src/
       ├── pages/
       │   ├── index.astro       ← TOP
       │   ├── plan.astro
       │   ├── gallery.astro
       │   ├── booking.astro
       │   └── ...
       ├── components/
       │   ├── PlanCard.astro
       │   ├── GalleryGrid.astro
       │   └── BookingForm.astro
       └── layouts/
           └── Layout.astro      ← nav/footer 共通化
```

---

## 5. Phase 3 — スケール（必要になったら）

### 5-1. PayPay API（⚠️ SDK 使用を廃止、REST 直叩きに変更）

**理由:** `@paypayopa/paypayopa-sdk-node` は 2023年以降メンテナンス停止

```javascript
// netlify/functions/paypay-create.js
// SDK を使わず REST API を直接呼ぶ

import crypto from 'crypto';

function generatePayPaySignature(method, endpoint, body, epoch, nonce) {
  const hashBody = body
    ? crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64')
    : 'empty';
  const message = [hashBody, method, endpoint, epoch, nonce].join('\n');
  return crypto
    .createHmac('sha256', process.env.PAYPAY_CLIENT_SECRET)
    .update(message)
    .digest('base64');
}

export const handler = async (event) => {
  const { bookingId, customerEmail } = JSON.parse(event.body);
  const epoch = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const endpoint = '/v1/codes';

  const body = {
    merchantPaymentId: bookingId,
    amount: { amount: 2000, currency: 'JPY' },
    orderDescription: 'kaede photo 安心保証金（撮影当日に全額返金）',
    redirectUrl: `https://kaedephoto.com/booking?confirmed=${bookingId}`,
    redirectType: 'WEB_LINK',
    codeType: 'ORDER_QR',
  };

  const signature = generatePayPaySignature('POST', endpoint, body, epoch, nonce);

  const response = await fetch(`https://api.paypay.ne.jp${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `hmac OPA-Auth:${process.env.PAYPAY_CLIENT_ID}:${signature}`,
      'X-ASSUME-MERCHANT': process.env.PAYPAY_MERCHANT_ID,
      'X-DATE': epoch,
      'X-NONCE': nonce,
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  const paymentUrl = result.data?.url;

  // Resend でお客様に PayPay リンクを送信
  // ...

  return { statusCode: 200, body: JSON.stringify({ paymentUrl }) };
};
```

### 5-2. 分析: GA4 + Netlify Analytics

```html
<!-- GA4（仮想ページビューをページ遷移に同期） -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-XXXXXXXXXX', { send_page_view: false });

// goPage() に GA4 のページビュー計測を組み込む
const _origGoPage = goPage;
window.goPage = function(name, opts) {
  _origGoPage(name, opts);
  gtag('event', 'page_view', {
    page_path: '#' + name,
    page_title: document.title,
  });
};
</script>
```

---

## 6. セキュリティ（更新）

| 対策 | 実装 | 優先度 |
|------|------|--------|
| Rate Limiting | Upstash Redis（Phase 1 から） | 🔴 P0 |
| 環境変数管理 | Netlify 環境変数（コードにキーを書かない） | 🔴 P0 |
| SPF/DKIM/DMARC | Resend ドメイン認証（Phase 1 で設定） | 🔴 P0 |
| セキュリティヘッダー | `netlify.toml` で設定 | 🟠 P1 |
| 入力サニタイズ | Function 側で HTML エスケープ | 🟠 P1 |
| CSRF | Netlify Functions は CORS ヘッダーで origin 制限 + Rate Limit で補完 | 🟡 P2 |

---

## 7. 障害対応マニュアル（⚠️ v1 になかった運用設計）

### だいきさん向け・緊急時の手順

**「メールが来なくなった」が発生したら:**
```
1. https://status.resend.com でサービス障害を確認
2. 障害なし → Netlify のダッシュボードで Function のログを確認
   → Netlify > Site > Functions > booking のログを見る
3. 解決できない場合 → SNS や直接連絡で「現在フォームをメンテナンス中です」と告知
4. 緊急連絡先（将来依頼するエンジニアの連絡先をここに記録）
```

**「フォームが動かない」が発生したら:**
```
1. https://www.netlifystatus.com でサービス障害を確認
2. フォームの一時代替: LINE の予約フォーム / Google Forms に切り替え
   → TOPページの「LINEで相談」ボタンに誘導するバナーを手動で追加
```

**月次確認チェックリスト（毎月1日）:**
```
□ Resend ダッシュボード → 送信数が 3,000通 に近づいていないか確認
□ Cloudinary ダッシュボード → ストレージ使用量確認
□ Upstash ダッシュボード → Redis リクエスト数確認
□ Netlify → Function のエラーログ確認
□ Notion → 「仮予約」のまま放置されている予約がないか確認
```

---

## 8. 費用試算（v2 更新）

| サービス | 無料枠 | 商用可否 | 月額（超過時） |
|---------|-------|---------|-------------|
| **Netlify** | 100GB帯域、無制限デプロイ | ✅ OK | $19/月〜 |
| Resend | 3,000通/月 | ✅ OK | $20/月〜 |
| Cloudinary | 25GB / 25クレジット | ✅ OK | $89/月〜 |
| Notion | 無制限ページ | ✅ OK | 無料 |
| Upstash Redis | 10,000リクエスト/日 | ✅ OK | $10/月〜 |
| **合計（MVP）** | **$0/月** | — | — |

---

## 9. 実装ロードマップ（v2）

```
Week 1（MVP・Phase 1）
├── Day 1:  GitHub リポジトリ作成 → Netlify デプロイ → カスタムドメイン設定
├── Day 1:  Resend アカウント → ドメイン認証（SPF/DKIM/DMARC 設定）
├── Day 1:  Upstash Redis アカウント作成
├── Day 2:  netlify/functions/booking.js 実装（Rate Limit + メール）
└── Day 2:  HTML の submitForm を fetch に差し替え → 動作テスト

Week 2（Phase 2 前半）
├── Day 3:  Notion データベース作成 → Integration 設定
├── Day 4:  Notion API を booking.js に追加（非同期・フォールバック付き）
├── Day 5:  実写真を Cloudinary にアップロード → HTML の img src 差し替え
└── Day 6-7: 本番テスト（フォーム → メール → Notion → エラーケース確認）

Week 3〜4（Phase 2 後半・任意）
└── Astro 移行の検討・着手（運用が安定してから）

Month 2〜（Phase 3・必要になったら）
├── PayPay REST API 統合（予約が月30件を超えたら）
└── GA4 導入（アクセス分析が必要になったら）
```

---

## 10. 技術スタック サマリー（v2）

| レイヤー | 技術 | 理由 |
|---------|------|------|
| ホスティング | **Netlify**（⚠️ 変更） | 商用OK・無料枠・Functions内蔵 |
| フロントエンド（現在） | 単一HTML | 移行コストゼロで即公開 |
| フロントエンド（将来） | **Astro**（⚠️ 追加） | 長期メンテナンス性、Netlify との相性 |
| API | Netlify Functions（Node.js） | ホスティングと同一環境 |
| Rate Limiting | **Upstash Redis**（⚠️ 追加） | スパム防止・無料枠あり |
| メール | Resend | 日本語・無料3000通・DNS認証 |
| 予約台帳 | **Notion API**（⚠️ 変更） | だいきさんが直感的に使えるUI |
| 画像 CDN | Cloudinary | 自動最適化・無料枠で十分 |
| 決済 | PayPay（手動→Phase 3でREST） | 検証後に自動化 |
| 分析 | GA4（Phase 3） | 仮想PVをゴールに設定 |
