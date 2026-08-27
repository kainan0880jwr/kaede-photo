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

// 件名用サニタイズ（改行・制御文字を除去して件名偽装/ヘッダ混入を防ぐ）
function subj(value = '') {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// URL無害化。
// お客様宛の自動返信は「フォームに入力された任意のアドレス」宛に、認証済みの独自ドメインから届く。
// 入力内容をそのまま反射すると、予約フォームがフィッシングメールの配信経路になってしまう
// （＝送信ドメインの評判が落ち、正規の予約確認メールまで届かなくなる）。
// HTMLとしての無害化は esc が担うが、メールクライアントは素のURL文字列を自動リンク化するため別途必要。
// ※ オーナー宛には適用しない（本人が状況を把握したうえで全文を読む必要があるため）
function deLink(value = '') {
  return String(value)
    .replace(/https?:\/\/\S+/gi, '［URLは自動返信では省略されます］')
    .replace(/\bwww\.\S+/gi, '［URLは自動返信では省略されます］');
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

// opts.forCustomer = true のときは、お客様宛自動返信向けにURLを無害化し本文を切り詰める。
// （オーナー宛・アラート宛は全文をそのまま表示する）
function detailsTable(data, opts = {}) {
  const forCustomer = opts.forCustomer === true;
  // お客様宛（forCustomer）は、name/messageに限らず自由入力・準自由入力の全フィールドを無害化する。
  // plan/genreはホワイトリスト済みだが、preferredDate・phoneは自由記述のため引き続きURLを反射しうる
  const dl = forCustomer ? deLink : (v => v);
  const name = dl(data.name);
  const message = forCustomer
    ? dl(String(data.message || '').slice(0, 1000))
    : data.message;
  const preferredDate = dl(data.preferredDate);
  const phone = dl(data.phone);
  const plan = dl(data.plan);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    ${row('お名前', esc(name))}
    ${row('メール', esc(data.email))}
    ${row('電話番号', esc(phone) || '—')}
    ${row('ご希望日', esc(preferredDate) || '—')}
    ${row('プラン', esc(plan) || '—')}
    ${(() => {
      // お客様宛には、改ざん試行やフロント側バグの痕跡（「未計上のオプション」「フォーム表示額と
      // 不一致」等の内部向け診断メモ）を含まない estimateTextCustomer を使う。
      // 未設定（古い呼び出し経路）の場合のみ estimateText にフォールバックする
      const text = forCustomer ? (data.estimateTextCustomer ?? data.estimateText) : data.estimateText;
      return text ? row('概算金額', esc(text)) : '';
    })()}
    ${row('ご要望', nl2br(message) || '—')}
  </table>`;
}

// だいきさん宛：新規予約通知
export function ownerNotification(data) {
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;">新しい予約リクエストが届きました。内容を確認のうえ、お客様へご返信ください。</p>
    ${detailsTable(data)}
    <p style="margin:24px 0 0;font-size:12px;color:#9a938b;">受付日時：${esc(data.receivedAt)}</p>`;
  return {
    subject: subj(`【新規予約】${data.name} 様（${data.preferredDate || '日程未定'}）`),
    html: wrap('新しい予約リクエスト', inner),
  };
}

// お客様宛：自動返信
export function customerConfirmation(data) {
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;">${esc(deLink(data.name))} 様<br><br>
    この度は kaede photo へご予約リクエストをいただき、誠にありがとうございます。<br>
    以下の内容で承りました。担当より改めてご連絡いたしますので、今しばらくお待ちくださいませ。</p>
    ${detailsTable(data, { forCustomer: true })}
    <p style="margin:24px 0 0;font-size:13px;line-height:1.8;color:#6b645c;">
    ※このメールは自動送信です。ご返信いただいてもお答えできない場合がございます。<br>
    お急ぎの場合は、このメールへの返信ではなく公式の連絡先までお問い合わせください。</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #eee;padding-top:20px;">
      <tr><td style="font-size:12px;line-height:1.9;color:#6b645c;">
        <a href="https://lin.ee/Pz3VLXT" style="color:${BRAND};">LINE公式アカウント</a>を友だち追加いただくと、やり取りがスムーズです。<br>
        ご友人・ご家族をご紹介いただくと、次回のご予約が3,000円引きになります。<br>
        ニューボーンフォト用の衣装・小物は<a href="https://kaede-photo.com/rental.html" style="color:${BRAND};">レンタルショップ</a>でもご用意しています。
      </td></tr>
    </table>`;
  return {
    subject: 'ご予約リクエストを受け付けました｜kaede photo',
    html: wrap('ご予約ありがとうございます', inner),
  };
}

// だいきさん宛：サイト全体のレート制限に達したときのアラート
// （この状態では正規のお客様も予約フォームを送信できないため、放置すると機会損失に直結する）
export function globalLimitAlert({ limit, windowLabel, lastIp, at }) {
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:#c0392b;">
    ⚠️ 予約フォームの送信が、サイト全体の上限（${esc(windowLabel)}あたり${esc(String(limit))}件）に達しました。<br>
    <strong>この間、正規のお客様も予約を送信できません。</strong></p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;">
    心当たりのない場合はいたずら送信の可能性があります。Netlify → Functions → booking → Logs で
    送信元をご確認ください。上限の引き上げが必要な場合は booking.js の globalRatelimit を調整します。</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${row('検知時刻', esc(at))}
      ${row('直近の送信元', esc(lastIp))}
    </table>
    <p style="margin:24px 0 0;font-size:12px;color:#9a938b;">このアラートは1日1回のみ送信されます。</p>`;
  return {
    subject: '【要対応】予約フォームが送信上限に達しています｜kaede photo',
    html: wrap('予約フォームが一時的に停止しています', inner),
  };
}

// だいきさん宛：表示額とサーバー再計算額の不一致アラート（単価表ドリフトの早期発見用）。
// 予約自体は成立させたうえで送るため、通常のご予約通知メールとは別に届く。
export function priceMismatchAlert(data, { clientValue, serverValue }) {
  const yen = n => Number.isFinite(n) ? `¥${n.toLocaleString('ja-JP')}` : '—';
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:#c0392b;">
    ⚠️ フォーム表示額とサーバー側の再計算額が一致しませんでした。<br>
    改ざん試行の可能性もありますが、多くの場合は index.html の単価表と
    booking.js の単価表がズレている（値上げ時の直し忘れ等）ことが原因です。
    <code>npm run check:prices</code> で確認してください。</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${row('フォーム表示額', esc(yen(Number(clientValue))))}
      ${row('サーバー再計算額', esc(yen(serverValue)))}
      ${row('お名前', esc(data.name))}
      ${row('プラン', esc(data.plan))}
      ${row('エリア', esc(data.area || '—'))}
    </table>
    <p style="margin:24px 0 0;font-size:12px;color:#9a938b;">この予約自体は通常どおり受け付けています（お客様にはサーバー側の金額のみをご案内しています）。</p>`;
  return {
    subject: subj(`【要確認】概算金額の不一致 - ${data.name} 様の予約`),
    html: wrap('概算金額が一致しませんでした', inner),
  };
}

// だいきさん宛：Notion記録失敗アラート
export function notionFailureAlert(data, errorMessage) {
  // Notion SDKの例外はレスポンスボディを含むことがあり、原因調査に必要な範囲を
  // 超えて詳細が長文でメール（＝Gmail等のメールサーバー）に残り続けるのを避けるため、
  // 表示は先頭200文字までに切り詰める（Opus 5監査 セキュリティL-5）
  const truncated = String(errorMessage || '').slice(0, 200);
  const inner = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:#c0392b;">
    ⚠️ メールは送信されましたが、Notion台帳への記録に失敗しました。<br>
    お手数ですが、以下の内容を手動で台帳へ追記してください。</p>
    ${detailsTable(data)}
    <p style="margin:24px 0 0;font-size:12px;color:#9a938b;">エラー内容：${esc(truncated)}${String(errorMessage || '').length > 200 ? '…（詳細はNetlifyのFunctionログをご確認ください）' : ''}</p>`;
  return {
    subject: subj(`【要対応】Notion記録失敗 - ${data.name} 様の予約`),
    html: wrap('Notion記録に失敗しました', inner),
  };
}
