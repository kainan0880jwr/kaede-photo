# kaede photo セットアップガイド

> 所要時間: 約2〜3時間（初回のみ）  
> 必要なもの: PC、ブラウザ、メールアドレス

---

## 全体の流れ

```
Step 1: GitHubにアカウントを作る
Step 2: ファイルをGitHubにアップロードする
Step 3: Netlifyでサイトを公開する
Step 4: Resendでメール送信を設定する
Step 5: Upstashでスパム防止を設定する
Step 6: Notionで予約台帳を作る
Step 7: Netlifyに各サービスのキーを登録する
Step 8: 動作確認をする
```

---

## Step 1: GitHub アカウントを作る

1. [github.com](https://github.com) を開く
2. 「Sign up」をクリックしてアカウントを作成する
3. メール認証を済ませる

---

## Step 2: ファイルを GitHub にアップロードする

1. GitHub にログイン → 右上の「+」→「New repository」
2. Repository name に `kaede-photo` と入力
3. 「Private」を選択（サイトは公開されるが、コードは非公開に）
4. 「Create repository」をクリック
5. 「uploading an existing file」のリンクをクリック
6. この `kaede-photo` フォルダの中身をすべてドラッグ＆ドロップ
7. 「Commit changes」をクリック

---

## Step 3: Netlify でサイトを公開する

1. [netlify.com](https://netlify.com) を開いてアカウント作成（「Sign up with GitHub」が楽）
2. ダッシュボードの「Add new site」→「Import an existing project」
3. 「GitHub」を選択 → `kaede-photo` リポジトリを選択
4. ビルド設定はそのまま（自動検出されます）→「Deploy site」
5. 数分後にサイトが公開される（URL は `xxxxx.netlify.app` のような形式）

### カスタムドメインの設定（kaedephoto.com を使う場合）
1. Netlify のサイト設定 →「Domain management」→「Add domain alias」
2. `kaedephoto.com` を入力
3. 指定された DNS レコードをドメイン会社（お名前.com など）の管理画面で設定する
4. 数時間〜1日で HTTPS が有効になる

---

## Step 4: Resend でメール送信を設定する

**Resend は予約フォームの送信メールを届けるサービスです（無料で月3,000通まで）**

1. [resend.com](https://resend.com) でアカウント作成
2. 「Domains」→「Add Domain」→ `kaedephoto.com` を入力して「Add」
3. 表示された DNS レコードを **ドメイン会社の管理画面** で設定する

   > ⚠️ **この設定をしないとメールがスパムに振り分けられます。必ず設定してください。**

   設定する DNS レコード（例）:

   | 種類 | ホスト名 | 値 |
   |------|---------|---|
   | TXT | @ | `v=spf1 include:amazonses.com ~all` |
   | CNAME | resend._domainkey | `（Resend が表示する値をコピー）` |
   | TXT | _dmarc | `v=DMARC1; p=none; rua=mailto:kaepafu1995@gmail.com` |

4. Resend ダッシュボードに戻り「Verify」ボタンを押す → 緑色のチェックが付けばOK
5. 「API Keys」→「Create API Key」→ 名前を `kaede-photo-production` として作成
6. 表示された `re_` で始まるキーをメモ帳にコピーしておく（**一度しか表示されません**）

---

## Step 5: Upstash でスパム防止を設定する

**Upstash は同じ人が何度もフォームを送信するのを防ぐサービスです（無料）**

1. [console.upstash.com](https://console.upstash.com) でアカウント作成
2. 「Create Database」→ 名前を `kaede-photo`、リージョンを `ap-northeast-1（東京）` にして作成
3. 作成後、「REST API」タブを開く
4. `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` の値をメモ帳にコピー

---

## Step 6: Notion で予約台帳を作る

**Notion は予約一覧を管理するツールです（無料）**

### データベースの作成
1. [notion.so](https://notion.so) でアカウント作成
2. 新しいページを作成 → 「/database」と入力 → 「Table」を選択
3. ページ名を「kaede photo 予約管理」にする
4. 以下の列を追加する（「＋列を追加」ボタンで追加）:

   | 列名 | 種類 |
   |------|------|
   | 氏名（最初から存在する列の名前を変更） | タイトル |
   | 状態 | セレクト（選択肢: 仮予約・仮確定・予約確定・撮影完了・返金完了・納品完了） |
   | メール | メール |
   | 申込日 | 日付 |
   | 第1希望 | 日付 |
   | 第2希望 | 日付 |
   | 撮影場所 | テキスト |
   | プラン | セレクト（選択肢: simple plan・standard plan・special plan・premium plan） |
   | 子ども人数 | 数値 |
   | 子ども年齢 | テキスト |
   | PayPay URL | URL |
   | 入金確認 | チェックボックス |
   | 返金完了 | チェックボックス |
   | 備考 | テキスト |

### API 連携の設定
1. [notion.so/my-integrations](https://www.notion.so/my-integrations) を開く
2. 「New integration」→ 名前を「kaede photo bot」にして作成
3. 「Internal Integration Secret」の値をメモ帳にコピー（`secret_` で始まる文字列）
4. 作成した予約台帳のページに戻る
5. 右上の「...」→「Add connections」→「kaede photo bot」を選択
6. データベースの URL から ID をコピーする  
   例: `https://notion.so/workspace/`**`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`**`?v=...`  
   → 太字部分の32文字が `NOTION_DB_ID`

---

## Step 7: Netlify に各サービスのキーを登録する

1. Netlify ダッシュボード → 自分のサイト → 「Site configuration」→「Environment variables」
2. 「Add a variable」を押して以下を1つずつ登録する:

   | キー名 | 値 |
   |-------|---|
   | `RESEND_API_KEY` | Step 4 でコピーした `re_` で始まる値 |
   | `UPSTASH_REDIS_REST_URL` | Step 5 でコピーした URL |
   | `UPSTASH_REDIS_REST_TOKEN` | Step 5 でコピーした TOKEN |
   | `NOTION_TOKEN` | Step 6 でコピーした `secret_` で始まる値 |
   | `NOTION_DB_ID` | Step 6 でコピーした 32文字の ID |
   | `OWNER_EMAIL` | `kaepafu1995@gmail.com` |
   | `SITE_DOMAIN` | `https://kaedephoto.com`（ドメインを設定した場合） |

3. 全部登録したら「Deploys」→「Trigger deploy」→「Deploy site」を押して再デプロイ

---

## Step 8: 動作確認をする

1. 公開されたサイト（`kaedephoto.com` または `xxxxx.netlify.app`）を開く
2. 予約フォームに**テスト用の情報**を入力して送信する
3. 以下をすべて確認する:

   - [ ] `kaepafu1995@gmail.com` に通知メールが届いた
   - [ ] フォームに入力したメールアドレス宛に自動返信メールが届いた
   - [ ] Notion の予約台帳に新しい行が追加された
   - [ ] フォーム画面に「ご予約を受け付けました」の完了画面が表示された

すべて確認できたら公開完了です！

---

## 日常の運用手順（撮影予約が入ったとき）

### ① 予約申込が届いたら（メール確認）
1. `kaepafu1995@gmail.com` に届いた通知メールを確認する
2. Notion の予約台帳を開いて申込内容を確認する
3. 日程・場所に問題がなければお客様に返信する（通知メールの「このお客様に返信する」ボタンを押すと楽）

### ② PayPay リンクを送る（予約を仮確定にする）
1. PayPay アプリ → 「受け取る」タブ
2. 金額「2000」と入力 → 「リンクで受け取る」
3. 説明欄に「kaede photo 安心保証金（撮影当日に全額返金）」と入力
4. リンクをコピーして返信メールにペーストして送信
5. Notion の該当行の「PayPay URL」列にリンクを貼り付け
6. 「状態」を「仮確定」に変更

### ③ 入金を確認する
1. PayPay アプリ → 受け取り履歴で入金確認
2. 確認できたら Notion の「入金確認」にチェック
3. 「状態」を「予約確定」に変更
4. お客様に「予約確定のご連絡」メールを送る

### ④ 撮影当日
1. 撮影終了後、その場で PayPay から返金
   - PayPay アプリ → 「支払い履歴」→ 該当の受け取りを選択 → 返金
2. Notion の「返金完了」にチェック、「状態」を「撮影完了」に変更

### ⑤ データ納品（約1ヶ月後）
1. オンラインアルバムの URL をお客様に送付
2. Notion の「状態」を「納品完了」に変更

---

## 月次チェックリスト（毎月1日に確認）

- [ ] [Resend ダッシュボード](https://resend.com) → 送信数が 2,500通 を超えていないか確認
- [ ] [Cloudinary ダッシュボード](https://cloudinary.com) → ストレージ使用量を確認
- [ ] [Upstash ダッシュボード](https://console.upstash.com) → リクエスト数を確認
- [ ] [Netlify ダッシュボード](https://app.netlify.com) → 「Functions」タブでエラーがないか確認
- [ ] Notion → 「仮予約」「仮確定」のまま長期放置している予約がないか確認

---

## トラブルシューティング

### メールが届かなくなった
1. [status.resend.com](https://status.resend.com) でサービス障害を確認
2. Netlify → 「Functions」タブ → `booking` のログを確認
3. 解決できない場合は LINE やメールで「現在フォームをメンテナンス中のため、こちらにご連絡ください」と案内

### フォームが動かなくなった
1. [www.netlifystatus.com](https://www.netlifystatus.com) でサービス障害を確認
2. フォームが使えない間は、LINE の予約フォームまたは Google Forms に誘導する

### Notion に記録されない
- メールは届いているなら問題なし（「⚠️ 予約台帳の記録に失敗しました」というアラートメールが届いているはず）
- Notion に手動で予約を追加してください

---

## サポート窓口

不明な点があれば、将来依頼するエンジニアの連絡先をここに記録しておきましょう。

```
担当エンジニア: 
連絡先:
```
