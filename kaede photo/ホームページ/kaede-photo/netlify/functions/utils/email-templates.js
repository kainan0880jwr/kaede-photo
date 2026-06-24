/**
 * kaede photo — メールテンプレート
 *
 * buildOwnerEmail  : だいきさんへの予約通知メール
 * buildCustomerEmail : お客様への自動返信メール
 */

/**
 * HTML をエスケープして XSS を防ぐ
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 共通スタイル */
const BASE_STYLE = `
  body { margin: 0; padding: 0; background: #FAF8F5; font-family: 'Hiragino Kaku Gothic Pro', 'Yu Gothic', Meiryo, sans-serif; }
  .wrap { max-width: 600px; margin: 0 auto; background: #fff; }
  .header { background: #2C1F1A; padding: 32px 40px; text-align: center; }
  .logo { color: rgba(255,255,255,.9); font-size: 22px; letter-spacing: .22em; }
  .body { padding: 40px; }
  .title { font-size: 20px; color: #2C1F1A; margin: 0 0 24px; font-weight: normal; }
  .table { width: 100%; border-collapse: collapse; margin: 0 0 24px; }
  .table th { text-align: left; padding: 10px 14px; background: #F3EDE4; font-size: 12px;
              color: #8B7355; letter-spacing: .06em; width: 140px; font-weight: normal;
              border-bottom: 1px solid #E8DDD0; }
  .table td { padding: 10px 14px; font-size: 14px; color: #4A3728;
              border-bottom: 1px solid #E8DDD0; }
  .highlight { background: #FDF1EB; border-left: 3px solid #B5633F;
               padding: 14px 18px; font-size: 13px; color: #2C1F1A;
               margin: 0 0 24px; border-radius: 2px; }
  .footer { background: #F3EDE4; padding: 24px 40px; text-align: center;
            font-size: 11px; color: #8B7355; line-height: 1.8; }
  .btn { display: inline-block; background: #B5633F; color: #fff !important;
         padding: 14px 32px; border-radius: 2px; text-decoration: none;
         font-size: 13px; letter-spacing: .08em; margin: 0 0 24px; }
`;

/**
 * だいきさん向け：新規予約通知メール
 * @param {Object} data - フォームデータ
 */
export function buildOwnerEmail(data) {
  const {
    name, email, date1, date2, location, plan,
    kids_count, kids_age, message,
  } = data;

  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><style>${BASE_STYLE}</style></head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">kaede photo</div></div>
  <div class="body">
    <h1 class="title">新しい予約申込が届きました</h1>
    <p style="font-size:13px;color:#8B7355;margin:0 0 24px;">申込日時: ${esc(now)}</p>

    <div class="highlight">
      <strong>${esc(name)} 様</strong> より予約申込が届きました。<br>
      2営業日以内にご連絡の上、PayPay リンクをお送りください。
    </div>

    <table class="table">
      <tr><th>お名前</th><td>${esc(name)}</td></tr>
      <tr><th>メールアドレス</th><td><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
      <tr><th>撮影希望日 第1希望</th><td>${esc(date1)}</td></tr>
      <tr><th>撮影希望日 第2希望</th><td>${esc(date2) || '未入力'}</td></tr>
      <tr><th>撮影場所・エリア</th><td>${esc(location)}</td></tr>
      <tr><th>ご希望のプラン</th><td>${esc(plan)}</td></tr>
      <tr><th>お子さまの人数</th><td>${esc(kids_count)} 人</td></tr>
      <tr><th>お子さまの年齢</th><td>${esc(kids_age)}</td></tr>
      <tr><th>ご要望・ご質問</th><td>${esc(message) || 'なし'}</td></tr>
    </table>

    <a href="mailto:${esc(email)}?subject=【kaede photo】撮影日程のご確認&body=${encodeURIComponent(`${name} 様\n\nkaede photo のだいきです。\nこの度はご予約ありがとうございます。\n\n第1希望の ${date1} について確認いたします...\n`)}" class="btn">
      このお客様に返信する
    </a>

    <p style="font-size:12px;color:#8B7355;line-height:1.8;">
      ※ Notion 予約台帳にも同時に記録されています。<br>
      ※ 返信後、PayPay 支払いリンク（2,000円）を送付して予約を確定させてください。
    </p>
  </div>
  <div class="footer">
    kaede photo 自動通知システム<br>
    このメールは自動送信です。ご返信は不要です。
  </div>
</div>
</body>
</html>`;
}

/**
 * お客様向け：予約受付自動返信メール
 * @param {Object} data - フォームデータ
 */
export function buildCustomerEmail(data) {
  const { name, date1, date2, plan } = data;

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><style>${BASE_STYLE}</style></head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">kaede photo</div></div>
  <div class="body">
    <h1 class="title">${esc(name)} 様<br>ご予約を受け付けました</h1>

    <p style="font-size:14px;color:#4A3728;line-height:1.9;margin:0 0 24px;">
      この度は kaede photo にご予約いただき、ありがとうございます。<br>
      内容を確認し、<strong>2営業日以内</strong>にご連絡いたします。
    </p>

    <div class="highlight">
      ご予約内容の確認<br><br>
      プラン: ${esc(plan)}<br>
      撮影希望日 第1希望: ${esc(date1)}<br>
      ${date2 ? `撮影希望日 第2希望: ${esc(date2)}<br>` : ''}
    </div>

    <h2 style="font-size:15px;color:#2C1F1A;font-weight:normal;margin:0 0 16px;">
      ご予約の流れ
    </h2>
    <table class="table">
      <tr>
        <th style="width:40px;text-align:center;">①</th>
        <td>フォーム送信完了（今ここです）</td>
      </tr>
      <tr>
        <th style="text-align:center;">②</th>
        <td>カメラマンより日程確認のメールをお送りします（2営業日以内）</td>
      </tr>
      <tr>
        <th style="text-align:center;background:#FDF1EB;">③</th>
        <td style="background:#FDF1EB;"><strong>安心保証金 2,000円（PayPay）</strong>をお支払いいただきます<br>
          <span style="font-size:12px;color:#8B7355;">撮影当日に全額お返しします</span></td>
      </tr>
      <tr>
        <th style="text-align:center;">④</th>
        <td>予約確定！撮影日をお楽しみに</td>
      </tr>
      <tr>
        <th style="text-align:center;">⑤</th>
        <td>撮影当日 → 撮影終了後に保証金 2,000円を全額返金</td>
      </tr>
      <tr>
        <th style="text-align:center;">⑥</th>
        <td>約1ヶ月後にデータ納品（オンラインアルバムのURL送付）</td>
      </tr>
    </table>

    <p style="font-size:13px;color:#8B7355;line-height:1.8;">
      ご不明な点は下記へお気軽にご連絡ください。<br>
      メール：<a href="mailto:kaepafu1995@gmail.com" style="color:#B5633F;">kaepafu1995@gmail.com</a>
    </p>
  </div>
  <div class="footer">
    kaede photo — 子ども・家族専門出張カメラマン<br>
    大阪・和歌山を中心に全国対応<br><br>
    このメールは自動送信です。返信はカメラマンより別途お送りします。
  </div>
</div>
</body>
</html>`;
}
