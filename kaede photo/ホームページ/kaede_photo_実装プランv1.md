# kaede photo — バックエンド実装プラン v1

> 作成者: シニアエンジニア視点  
> 対象: フロントエンド実装済み単一HTMLファイルを本番運用可能なシステムに昇格させる  
> フェーズ構成: Phase 1（最速MVP）→ Phase 2（運用安定化）→ Phase 3（スケール）

---

## 0. 現状と課題の整理

### 現状
- 単一 HTML ファイル（72KB）で全ページ実装済み
- フォーム送信がモック（`submitForm` が `goPage('success')` を呼ぶだけ）
- PayPay 保証金決済フローが手動
- ギャラリー画像が Unsplash プレースホルダー
- ホスティング先未定

### 解決すべき課題（優先順）
| # | 課題 | ビジネス影響 |
|---|------|------------|
| 1 | フォームが届かない | 予約がゼロになる |
| 2 | PayPay 決済が手動 | スケールすると破綻 |
| 3 | 画像が自分のものでない | ブランドの信頼性ゼロ |
| 4 | ホスティング先がない | サイトが存在しない |
| 5 | 管理画面がない | コンテンツ更新のたびにコード変更 |

---

## 1. アーキテクチャ概要

```
┌─────────────────────────────────────────────────────┐
│  ユーザーブラウザ                                     │
│  kaede_photo_website.html（静的ファイル）             │
└──────────────┬──────────────────────────────────────┘
               │ HTTPS
┌──────────────▼──────────────┐
│  Vercel（ホスティング + Edge）│  ← 静的アセット配信
│  - CDN グローバルエッジ       │
│  - 自動 HTTPS / HTTP/2       │
│  - Serverless Functions      │
└──────────────┬──────────────┘
               │
    ┌──────────┴──────────────────────────────┐
    │                                          │
┌───▼────────────┐              ┌──────────────▼──────┐
│ Serverless API │              │   Cloudinary          │
│ (Vercel Funcs) │              │   (画像CDN・最適化)    │
│ POST /api/book │              │   WebP変換・リサイズ   │
└───┬────────────┘              └─────────────────────┘
    │
    ├── Resend（メール送信）
    │   └── 予約受付通知 → だいきさん
    │   └── 自動返信     → お客様
    │
    ├── Google Sheets（予約台帳）
    │   └── Sheets API で行追加
    │
    └── PayPay API（決済）
        └── 保証金 2,000円リンク生成
```

---

## 2. Phase 1 — 最速 MVP（1〜2日）

### 目標: 「フォームが届く」を最優先で達成

### 2-1. ホスティング: Vercel

**選定理由:**
- 無料プランで十分（個人事業主レベル）
- GitHub push → 自動デプロイ（CI/CD 内蔵）
- Serverless Functions が同一リポジトリで管理可能
- 日本リージョンのエッジノードあり（表示速度）
- カスタムドメイン対応（SSL 自動）

**セットアップ手順:**
```bash
# 1. GitHubリポジトリ作成（kaede-photo）
# 2. HTMLファイルをpush
# 3. Vercel でインポート
# 4. カスタムドメイン設定（例: kaedephoto.com）
```

**ディレクトリ構成:**
```
kaede-photo/
├── public/
│   └── index.html          # 現在の kaede_photo_website.html をリネーム
├── api/
│   └── booking.js          # 予約受付 Serverless Function
├── package.json
└── vercel.json
```

### 2-2. フォームバックエンド: Vercel Serverless Functions + Resend

**なぜ Resend か:**
- 日本語メール対応
- 無料: 3,000通/月（個人事業主に十分）
- Vercel との相性が最良（公式インテグレーション）
- React Email でリッチなHTMLメール作成可能

**`api/booking.js` 実装:**
```javascript
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // メソッドチェック
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, date1, date2, location, plan, kids_count, kids_age, message } = req.body;

  // 簡易バリデーション
  if (!name || !email || !date1 || !location || !plan) {
    return res.status(400).json({ error: '必須項目が未入力です' });
  }

  try {
    // 1. だいきさんへの通知メール
    await resend.emails.send({
      from: 'kaede photo <noreply@kaedephoto.com>',
      to: 'kaepafu1995@gmail.com',
      subject: `【予約申込】${name} 様 — ${date1}`,
      html: buildOwnerEmail({ name, email, date1, date2, location, plan, kids_count, kids_age, message }),
    });

    // 2. お客様への自動返信
    await resend.emails.send({
      from: 'kaede photo <noreply@kaedephoto.com>',
      to: email,
      subject: 'ご予約申込を受け付けました — kaede photo',
      html: buildCustomerEmail({ name, date1 }),
    });

    // 3. Google Sheets へ記録（Phase 2 で追加）

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'メール送信に失敗しました' });
  }
}

function buildOwnerEmail({ name, email, date1, date2, location, plan, kids_count, kids_age, message }) {
  return `
    <h2>新しい予約申込が届きました</h2>
    <table border="1" cellpadding="8" style="border-collapse:collapse">
      <tr><td>お名前</td><td>${name}</td></tr>
      <tr><td>メール</td><td>${email}</td></tr>
      <tr><td>第1希望</td><td>${date1}</td></tr>
      <tr><td>第2希望</td><td>${date2 || '未入力'}</td></tr>
      <tr><td>撮影場所</td><td>${location}</td></tr>
      <tr><td>プラン</td><td>${plan}</td></tr>
      <tr><td>お子さまの人数</td><td>${kids_count}</td></tr>
      <tr><td>お子さまの年齢</td><td>${kids_age}</td></tr>
      <tr><td>ご要望</td><td>${message || 'なし'}</td></tr>
    </table>
  `;
}

function buildCustomerEmail({ name, date1 }) {
  return `
    <p>${name} 様</p>
    <p>kaede photo へのご予約申込ありがとうございます。<br>
    2営業日以内にご連絡いたします。</p>
    <p>◆ご予約内容<br>
    撮影希望日（第1希望）：${date1}</p>
    <p>ご不明な点はこちらへ：kaepafu1995@gmail.com</p>
    <p>— kaede photo</p>
  `;
}
```

**フロントエンド側の変更（`submitForm` を fetch に差し替え）:**
```javascript
async function submitForm(e) {
  e.preventDefault();
  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = '送信中...';

  const formData = new FormData(e.target);
  const body = Object.fromEntries(formData.entries());

  try {
    const res = await fetch('/api/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error();
    goPage('success');
    e.target.reset();
  } catch {
    alert('送信に失敗しました。お手数ですが、kaepafu1995@gmail.com までご連絡ください。');
  } finally {
    btn.disabled = false;
    btn.textContent = '予約を申し込む';
  }
}
```

**環境変数:**
```env
RESEND_API_KEY=re_xxxxxxxxxxxxx
```

---

## 3. Phase 2 — 運用安定化（1〜2週間）

### 3-1. 予約台帳: Google Sheets API

**目的:** 予約一覧を Excel 感覚で管理、PayPay 送金ステータス管理

**実装:**
```javascript
// api/booking.js に追記
import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';

async function appendToSheet(data) {
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Sheet1!A:L',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        new Date().toLocaleDateString('ja-JP'),  // 申込日
        data.name,
        data.email,
        data.date1,
        data.date2 || '',
        data.location,
        data.plan,
        data.kids_count,
        data.kids_age,
        '未確認',    // PayPay ステータス（手動更新）
        '未送金',    // 保証金返金ステータス
        data.message || '',
      ]],
    },
  });
}
```

**Google Sheets 列設計:**
| A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 申込日 | 氏名 | メール | 第1希望 | 第2希望 | 場所 | プラン | 子ども人数 | 年齢 | PayPay状態 | 返金状態 | 備考 |

### 3-2. 画像管理: Cloudinary

**目的:** 実際の写真をアップロード・最適化・CDN配信

**選定理由:**
- 無料: 25GB ストレージ、25GB/月 転送量
- 自動 WebP 変換・リサイズ（URLパラメータで制御）
- 日本語フォルダ整理対応
- アップロードは Cloudinary ダッシュボードから（コード不要）

**URLパターン:**
```
# 元画像（Unsplashプレースホルダーを差し替え）
https://res.cloudinary.com/kaedephoto/image/upload/w_800,f_auto,q_75/gallery/family_001.jpg

# パラメータ解説:
# w_800    → 幅800pxにリサイズ
# f_auto   → フォーマット自動選択（WebP対応ブラウザにはWebPを返す）
# q_75     → 品質75（ファイルサイズと品質のバランス）
```

**HTMLの差し替え例:**
```html
<!-- Unsplash → Cloudinary に変更 -->
<img
  src="https://res.cloudinary.com/kaedephoto/image/upload/w_400,f_auto,q_75/gallery/family_001.jpg"
  srcset="
    https://res.cloudinary.com/kaedephoto/image/upload/w_400,f_auto,q_75/gallery/family_001.jpg 400w,
    https://res.cloudinary.com/kaedephoto/image/upload/w_800,f_auto,q_75/gallery/family_001.jpg 800w"
  sizes="(max-width:767px) 50vw, 33vw"
  loading="lazy"
  decoding="async"
  alt="家族写真撮影の様子">
```

### 3-3. PayPay 決済リンク

**方針:** PayPay API フル統合は工数が大きいため、Phase 2 では PayPay の「支払いリンク」機能を活用

**フロー:**
1. お客様が予約フォーム送信
2. だいきさんがメール確認 → PayPay アプリで「支払いリンク」を 2,000円 で発行
3. お客様にメールで送付（手動 or Resend での自動化）
4. 撮影後、PayPay アプリから返金

**Phase 3 で自動化:** PayPay API（`/v1/codes`）でサーバー側から支払いリンクを自動生成

---

## 4. Phase 3 — スケール（必要になったら）

### 4-1. PayPay API 統合

```javascript
// api/paypay-create.js
import PAYPAY from '@paypayopa/paypayopa-sdk-node';

const client = PAYPAY.default;
client.Configure({
  clientId:     process.env.PAYPAY_CLIENT_ID,
  clientSecret: process.env.PAYPAY_CLIENT_SECRET,
  merchantId:   process.env.PAYPAY_MERCHANT_ID,
  productionMode: true,
});

export default async function handler(req, res) {
  const { bookingId, email } = req.body;

  const payload = {
    merchantPaymentId: bookingId,
    amount: { amount: 2000, currency: 'JPY' },
    orderDescription: 'kaede photo 安心保証金',
    redirectUrl: `https://kaedephoto.com/booking-confirmed?id=${bookingId}`,
    redirectType: 'WEB_LINK',
  };

  const response = await client.QRCodeCreate(payload);
  const paymentUrl = response.BODY.data.url;

  // Resend でお客様にPayPay URLを送信
  await resend.emails.send({
    to: email,
    subject: '【安心保証金のお支払いについて】kaede photo',
    html: `<p>安心保証金 2,000円 のお支払いはこちら：<br><a href="${paymentUrl}">${paymentUrl}</a></p>`,
  });

  res.json({ ok: true, paymentUrl });
}
```

### 4-2. CMS: Contentful（ヘッドレス CMS）

**目的:** だいきさんがコードを触らずギャラリー・レビューを更新できる管理画面

**コンテンツモデル:**
```
Gallery (ギャラリー)
├── title: Text
├── photo: Media
├── category: Symbol (baby / family / maternity)
└── sortOrder: Integer

Review (お客様の声)
├── authorName: Symbol
├── childAge: Symbol
├── reviewText: Long text
├── rating: Integer
└── publishedAt: Date
```

**API 呼び出し（Vercel Edge Function）:**
```javascript
// api/gallery.js
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const res = await fetch(
    `https://cdn.contentful.com/spaces/${process.env.CONTENTFUL_SPACE_ID}/entries?content_type=gallery&order=fields.sortOrder`,
    { headers: { Authorization: `Bearer ${process.env.CONTENTFUL_ACCESS_TOKEN}` } }
  );
  const data = await res.json();
  return Response.json(data.items);
}
```

### 4-3. 分析: Vercel Analytics + Google Analytics 4

```html
<!-- Vercel Speed Insights（Core Web Vitals モニタリング） -->
<script defer src="/_vercel/insights/script.js"></script>

<!-- GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
  // ページ遷移時に仮想PVを送信
  const _goPage = goPage;
  goPage = (name, opts) => {
    _goPage(name, opts);
    gtag('event', 'page_view', { page_path: '#' + name, page_title: document.title });
  };
</script>
```

---

## 5. セキュリティ

| 対策 | 実装箇所 | 優先度 |
|------|---------|--------|
| Rate limiting（同一IPから短時間に連続送信を防ぐ） | Vercel Firewall / `api/booking.js` | P1 |
| 入力サニタイズ（XSS防止） | `api/booking.js` でHTMLエスケープ | P1 |
| CSRF対策 | Vercel の CORS 設定で `same-origin` に制限 | P1 |
| 環境変数の管理 | Vercel 環境変数（コードにAPIキーを書かない） | P0 |
| Content-Security-Policy ヘッダー | `vercel.json` headers 設定 | P2 |
| DKIM・SPF設定（メール到達率） | Resend のドメイン認証 | P1 |

**`vercel.json` セキュリティヘッダー:**
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" }
      ]
    }
  ]
}
```

---

## 6. 費用試算

| サービス | 無料枠 | 月額（無料超過時） | 備考 |
|---------|-------|----------------|------|
| Vercel | 100GB帯域、無制限デプロイ | $20〜 | 個人事業主なら無料で十分 |
| Resend | 3,000通/月 | $20/月〜 | 予約数が月100件超で検討 |
| Cloudinary | 25GB | $89/月〜 | 無料で500枚以上管理可能 |
| Google Sheets API | 無料 | 無料 | Sheets は G Suite 不要 |
| Contentful（CMS） | 25,000レコード | $300/月〜 | Phase 3 以降で検討 |
| **合計（MVP）** | **$0/月** | — | Phase 1〜2 は完全無料 |

---

## 7. 実装ロードマップ

```
Week 1（MVP）
├── Day 1: GitHub リポジトリ作成 → Vercel デプロイ → カスタムドメイン設定
├── Day 1: Resend アカウント作成 → ドメイン認証
├── Day 2: api/booking.js 実装・テスト
└── Day 2: フロントエンドの submitForm を fetch に差し替え

Week 2（運用安定化）
├── Day 3-4: Cloudinary アカウント作成 → 実写真アップロード → HTML差し替え
├── Day 5: Google Sheets API 連携
└── Day 6-7: 本番テスト（フォーム送信→メール受信→Sheets記録）

Month 2〜（スケール）
├── PayPay API 統合（予約増加が確認できたら）
├── Contentful CMS 導入（コンテンツ更新が頻繁になったら）
└── GA4 / Vercel Analytics 導入（アクセス分析が必要になったら）
```

---

## 8. 技術スタック サマリー

| レイヤー | 技術選定 | 理由 |
|---------|---------|------|
| ホスティング | Vercel | 無料・自動デプロイ・Serverless Functions 内蔵 |
| フロントエンド | 単一HTML（現状維持） | 移行コストゼロ、STUDIO への移行も容易 |
| API | Vercel Serverless Functions (Node.js) | Vercel と同一環境、デプロイが最も簡単 |
| メール | Resend | 日本語対応・無料枠十分・Vercel 公式パートナー |
| 予約台帳 | Google Sheets | だいきさんが使い慣れているツールで運用コスト最小 |
| 画像 CDN | Cloudinary | 自動最適化・無料枠で十分 |
| 決済 | PayPay（手動 → Phase 3 で API） | まず手動で検証、規模拡大時に自動化 |
| CI/CD | Vercel（GitHub連携） | コミットでそのまま本番反映 |
