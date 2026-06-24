# kaede photo 導入手順書

このフォルダ（`kaede-photo`）をGitHubにアップロードし、Netlifyに接続すれば予約サイトが公開できます。
下のStep 1〜8を上から順番に進めてください。所要時間は約60〜90分です。

> 用意するもの：メールアドレス、サイトに使う独自ドメイン（任意）、クレジットカード不要（全て無料枠でOK）

---

## 全体像

```
お客様がフォーム送信
   ↓
Netlify Functions（booking.js）
   ├─ Upstash Redis でスパム連投をブロック
   ├─ Resend でメール2通を送信（だいきさん宛 ＋ お客様への自動返信）
   └─ Notion に予約台帳として記録
```

必要なアカウントは **GitHub / Netlify / Resend / Upstash / Notion** の5つです。

---

## Step 1. GitHub にアップロード

1. [github.com](https://github.com) でアカウントを作成（既にあればログイン）。
2. 右上「＋」→ **New repository** → 名前を `kaede-photo` にして **Create repository**。
3. このフォルダ（`kaede-photo`）の中身をアップロード。
   - 簡単な方法：リポジトリ画面の **uploading an existing file** リンクから、フォルダ内のファイルをドラッグ＆ドロップ。
   - `.env` は**絶対にアップロードしない**でください（`.gitignore` で除外済みですが念のため）。

✅ ゴール：GitHub上に `public/`・`netlify/`・`netlify.toml` などが並んでいればOK。

---

## Step 2. Netlify に接続してデプロイ

1. [netlify.com](https://www.netlify.com) で **GitHubアカウントでサインアップ**。
2. **Add new site → Import an existing project → GitHub** を選び、`kaede-photo` を選択。
3. ビルド設定は `netlify.toml` が自動で読み込まれるので、そのまま **Deploy**。
4. 数十秒後、`https://〇〇〇.netlify.app` というURLが発行されます。

✅ ゴール：発行されたURLを開いてサイトが表示されればOK（この時点ではフォーム送信はまだ動きません）。

---

## Step 3. Resend（メール送信）

1. [resend.com](https://resend.com) でサインアップ。
2. 左メニュー **API Keys → Create API Key** → 名前を付けて作成し、`re_` で始まるキーをコピー。→ あとで `RESEND_API_KEY` に使います。
3. **送信元ドメインの設定**（推奨）：
   - **Domains → Add Domain** で独自ドメインを追加し、表示されるDNSレコードをドメイン側に登録。
   - 独自ドメインが無い場合は、まずResendのテスト用アドレス `onboarding@resend.dev` を `MAIL_FROM` に使えます（お客様宛の自動返信は届きにくいので、本番では独自ドメイン推奨）。

✅ ゴール：APIキーと、送信元アドレス（例 `kaede photo <booking@あなたのドメイン>`）が決まっていればOK。

---

## Step 4. Upstash Redis（スパム対策）

1. [console.upstash.com](https://console.upstash.com) でサインアップ。
2. **Create Database** → Redis を選択 → リージョンは「Japan / Tokyo」推奨 → 作成。
3. データベース詳細ページの **REST API** セクションで以下をコピー：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

> ※ Upstashを設定しなくてもサイトは動きます（その場合スパム連投の制限だけ無効になります）。

✅ ゴール：URLとTOKENの2つが手元にあればOK。

---

## Step 5. Notion 連携（インテグレーション作成）

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration** → 名前を `kaede-photo` にして作成。
2. **Internal Integration Secret**（`ntn_` で始まる）をコピー。→ `NOTION_API_KEY` に使います。

---

## Step 6. Notion 予約台帳データベースを作る

1. Notionで新しいページを作り、**「データベース - フルページ」** を追加。名前は「予約台帳」など。
2. 次のプロパティ（列）を作成します（**名前を完全一致**させてください）：

   | プロパティ名 | 種類 |
   |---|---|
   | お名前 | タイトル（最初からあるもの） |
   | メール | メール |
   | 電話番号 | 電話 |
   | ご希望日 | テキスト |
   | プラン | セレクト |
   | ご要望 | テキスト |
   | 受付日時 | 日付 |

   ※「プラン」セレクトの選択肢は、送信時に自動で追加されるので空でOKです。

3. データベース右上 **「•••」→ コネクト → 連携 →** Step 5で作った `kaede-photo` を選んで接続。
4. データベースの **ID** を取得：
   - データベースをブラウザで開き、URLの `notion.so/` の後ろにある32文字の英数字（`?` より前）が `NOTION_DATABASE_ID` です。

✅ ゴール：`NOTION_API_KEY` と `NOTION_DATABASE_ID` が揃い、台帳がインテグレーションに接続されていればOK。

---

## Step 7. Netlify に環境変数を登録

1. Netlifyのサイト画面 → **Site configuration → Environment variables → Add a variable**。
2. 下の表のキーと値を**1つずつ**登録します（`.env.example` も参照）。

   | キー | 値の例・取得元 |
   |---|---|
   | `RESEND_API_KEY` | Step 3 のキー |
   | `MAIL_FROM` | `kaede photo <booking@あなたのドメイン>` |
   | `OWNER_EMAIL` | 通知を受け取るだいきさんのアドレス |
   | `UPSTASH_REDIS_REST_URL` | Step 4 のURL |
   | `UPSTASH_REDIS_REST_TOKEN` | Step 4 のTOKEN |
   | `NOTION_API_KEY` | Step 5 のシークレット |
   | `NOTION_DATABASE_ID` | Step 6 のID |
   | `SITE_URL` | Step 2 で発行された `https://〇〇.netlify.app` |

3. 登録後、**Deploys → Trigger deploy → Deploy site** で再デプロイ（環境変数を反映させるため必須）。

✅ ゴール：8個の環境変数が登録され、再デプロイが完了していればOK。

---

## Step 8. テスト送信して確認

1. 公開URLを開き、予約フォームに**自分のメールアドレス**を入れて送信。
2. 次の3つを確認：
   - [ ] 画面に「ご予約リクエストを受け付けました」と緑色で表示される
   - [ ] `OWNER_EMAIL` 宛に **【新規予約】** のメールが届く
   - [ ] 入力したアドレス宛に **自動返信メール** が届く
   - [ ] Notionの「予約台帳」に新しい行が追加されている

### うまくいかないときは

- **メールが届かない** → Netlify → Functions → `booking` の **Logs** を確認。`MAIL_FROM` のドメインがResendで認証済みか／`RESEND_API_KEY` が正しいかを見直す。迷惑メールフォルダも確認。
- **Notionだけ記録されない** → だいきさん宛に「【要対応】Notion記録失敗」メールが届きます。Step 6のプロパティ名が完全一致しているか、台帳がインテグレーションに接続されているかを確認。
- **「送信回数が上限に達しました」と出る** → スパム対策（1時間に5件まで）が効いています。1時間待つか、Upstashのデータをクリアしてください。

---

## 公開後にやること（残タスク）

- [ ] **実写真への差し替え**：`public/index.html` 内の `https://res.cloudinary.com/demo/...` を、Cloudinaryにアップロードした本番写真のURLに置き換える（hero背景・about・gallery 6枚）。
- [ ] **独自ドメインの接続**：Netlify → Domain management から設定。
- [ ] **プラン・料金・対応エリア・お客様の声**を実際の内容に更新。

---

## メモ：ファイル構成

```
kaede-photo/
├── public/index.html              … サイト本体（フォーム送信は /api/booking へ）
├── netlify/functions/booking.js   … 予約受付API（本体）
├── netlify/functions/utils/
│   ├── email-templates.js         … メールHTML（だいきさん宛・お客様宛・アラート）
│   └── notion.js                  … 予約台帳への記録
├── netlify.toml                   … セキュリティヘッダー・ルーティング
├── package.json                   … 依存パッケージ
├── .env.example                   … 環境変数テンプレート
└── .gitignore
```
