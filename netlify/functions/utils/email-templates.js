// ============================================================
// メールHTMLテンプレート
//   - ownerNotification : だいきさん宛（新規予約の通知）
//   - customerConfirmation : お客様宛（自動返信）
//   - notionFailureAlert : Notion記録に失敗したときのだいきさん宛アラート
// ============================================================

// HTMLエスケープ（メール本文へのインジェクション対策）
function esc(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 改行を <br> に変換（エスケープ後に呼ぶこと）
function nl2br(value = '') {
  return esc(value).replace(/\n/g, '<br>');
}

const BRAND = '#b07d62';
const BG = '#faf7f4';

function wrap(title, innerHtml) {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};font-family:'Hiragino Sans','Yu Gothic',sans-serif;color:#3a352f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
        <tr><td style="background:${BRAND};padding:24px 32px;">
          <span style="color:#fff;font-size:20px;letter-spacing:2px;font-weight:600;">kaede photo</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 20px;font-size:18px;color:${BRAND};">${esc(title)}</h1>
          ${innerHtml}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #eee;color:#9a938b;font-size:12px;">
          このメールは kaede photo 予約フォームから自動送信されています。
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function row(label, value) {
  return `<tr>
    <td style="padding:10px 0;width:120px;color:#9a938b;font-size:13px;vertical-align:top;">${esc(label)}</td>
    <td style="padding:10px 0;font-size:14px;line-height:1.7;">${value}</td>
  </tr>`;
}

function detailsTable(data) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    ${row('お名前', esc(data.name))}
    ${row('メール', esc(data.email))}
    ${row('電話番号', esc(data.phone) || '—')}
    ${row('ご希望日', esc(data.preferredDate) || '—')}
    ${row('プラン', esc(data.plan) || '—')}
    ${row('ご要望', nl2br(data.message) || '—')}
  </table>`;
}

// だいきさん宛：新規予約通知
export function ownerNotification(data) {
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;">新しい予約リクエストが届きました。内容を確認のうえ、お客様へご返信ください。</p>
    ${detailsTable(data)}
    <p style="margin:24px 0 0;font-size:12px;color:#9a938b;">受付日時：${esc(data.receivedAt)}</p>`;
  return {
    subject: `【新規予約】${data.name} 様（${data.preferredDate || '日程未定'}）`,
    html: wrap('新しい予約リクエスト', inner),
  };
}

// お客様宛：自動返信
export function customerConfirmation(data) {
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;">${esc(data.name)} 様<br><br>
    この度は kaede photo へご予約リクエストをいただき、誠にありがとうございます。<br>
    以下の内容で承りました。担当より改めてご連絡いたしますので、今しばらくお待ちくださいませ。</p>
    ${detailsTable(data)}
    <p style="margin:24px 0 0;font-size:13px;line-height:1.8;color:#6b645c;">
    ※このメールは自動送信です。ご返信いただいてもお答えできない場合がございます。<br>
    お急ぎの場合は、このメールへの返信ではなく公式の連絡先までお問い合わせください。</p>`;
  return {
    subject: 'ご予約リクエストを受け付けました｜kaede photo',
    html: wrap('ご予約ありがとうございます', inner),
  };
}

// だいきさん宛：Notion記録失敗アラート
export function notionFailureAlert(data, errorMessage) {
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:#c0392b;">
    ⚠️ メールは送信されましたが、Notion台帳への記録に失敗しました。<br>
    お手数ですが、以下の内容を手動で台帳へ追記してください。</p>
    ${detailsTable(data)}
    <p style="margin:24px 0 0;font-size:12px;color:#9a938b;">エラー内容：${esc(errorMessage)}</p>`;
  return {
    subject: `【要対応】Notion記録失敗 - ${data.name} 様の予約`,
    html: wrap('Notion記録に失敗しました', inner),
  };
}
