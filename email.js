// ============================================================
// QFwork.ai — Email
// ------------------------------------------------------------
// Without accounts, the access code IS the customer's login, so it is
// emailed as well as shown on screen: a lost tab or a new phone must not
// mean a lost subscription. Also sent on request ("Lost your code?").
//
// Sent through Resend (resend.com) when RESEND_API_KEY is set. Without it,
// every email is printed to the server log instead — enough for local
// testing, and nothing is lost if the key is missing in production (the
// code is still on the return page, and "Lost your code?" can resend it).
//
// EMAIL_FROM must be on a domain verified in Resend (e.g. hello@qfworkai.com).
// Before the domain is verified, Resend's own onboarding@resend.dev works,
// but only for sending to the Resend account owner's address.
// ============================================================

const FROM = () => process.env.EMAIL_FROM || 'QFwork.ai <hello@qfworkai.com>';

function enabled() {
  return !!process.env.RESEND_API_KEY;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function send({ to, subject, html, text }) {
  if (!to) return { sent: false, reason: 'no recipient' };
  if (!enabled()) {
    console.log(`\n[email] NOT SENT (RESEND_API_KEY not set) — would send:\n  to: ${to}\n  subject: ${subject}\n${text.split('\n').map(l => '  | ' + l).join('\n')}\n`);
    return { sent: false, reason: 'not configured' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject, html, text })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[email] Resend refused (${r.status}): ${body.slice(0, 300)}`);
      return { sent: false, reason: `resend ${r.status}` };
    }
    console.log(`[email] sent "${subject}"`);
    return { sent: true };
  } catch (e) {
    console.error(`[email] send failed: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

// Shared frame, inline styles only — email clients ignore <style>.
function frame(inner) {
  return `<!doctype html><html><body style="margin:0;background:#f6f8fa;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#101828;">
<div style="max-width:520px;margin:0 auto;padding:28px 16px;">
  <div style="font-weight:700;font-size:17px;margin:0 0 18px;">QFwork<span style="color:#fc5603;">.ai</span></div>
  <div style="background:#fff;border:1px solid #e7eaee;border-radius:16px;padding:26px 24px;">${inner}</div>
  <p style="font-size:12px;color:#98a2b3;margin:16px 4px 0;line-height:1.5;">You are receiving this because this address was used to subscribe to QFwork.ai.</p>
</div></body></html>`;
}

function codeBlock(code) {
  return `<div style="margin:16px 0;padding:14px;border:1.5px dashed #fdba8c;border-radius:12px;background:#fff8f3;text-align:center;font:600 21px/1.2 Menlo,Consolas,monospace;letter-spacing:.06em;">${esc(code)}</div>`;
}

function button(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#fc5603;background-image:linear-gradient(135deg,#fc5603,#fda307);color:#fff;text-decoration:none;font-weight:600;border-radius:10px;padding:12px 20px;">${esc(label)}</a>`;
}

// After a successful checkout.
function welcome({ to, code, startUrl, manageUrl, minutes, coachingUrl }) {
  const sessions = minutes ? `${minutes} minutes of live AI practice every week, over as many sessions as you like` : 'unlimited live AI practice';
  const coaching = coachingUrl ? `
    <div style="margin:20px 0 0;padding:14px 16px;background:#fff8eb;border:1px solid #f5e1b8;border-radius:12px;font-size:14px;line-height:1.5;">
      <b>You're one of our first subscribers.</b> Your free 20-minute 1-on-1 career coaching session with Grace is included.<br>
      <a href="${esc(coachingUrl)}" style="color:#fc5603;font-weight:600;">Book your coaching session →</a>
    </div>` : '';
  const html = frame(`
    <h1 style="font-size:21px;margin:0 0 8px;">You're subscribed</h1>
    <p style="margin:0 0 4px;color:#475467;line-height:1.55;">Your plan includes ${sessions}, each with a full report. Here is your access code:</p>
    ${codeBlock(code)}
    <p style="margin:0 0 18px;color:#475467;font-size:14px;line-height:1.55;">Enter it on any device to practise. Keep this email: the code is your key to your subscription.</p>
    ${button(startUrl, 'Start practising')}
    ${coaching}
    <p style="margin:20px 0 0;font-size:13px;color:#667085;line-height:1.5;">Your plan renews weekly. <a href="${esc(manageUrl)}" style="color:#fc5603;">Manage or cancel your subscription</a> at any time.</p>`);
  const text = [
    "You're subscribed to QFwork.ai.",
    `Your plan includes ${sessions}, each with a full report.`,
    '',
    `Your access code: ${code}`,
    'Enter it on any device to practise. Keep this email.',
    '',
    `Start practising: ${startUrl}`,
    ...(coachingUrl ? ['', `You're one of our first subscribers: book your free 20-minute coaching with Grace: ${coachingUrl}`] : []),
    '',
    `Manage or cancel your subscription: ${manageUrl}`
  ].join('\n');
  return send({ to, subject: 'Your QFwork.ai access code', html, text });
}

// "Lost your code?" — every code on this address.
function recovery({ to, codes, startUrl }) {
  const list = codes.map(c => `${codeBlock(c.code)}<p style="margin:-8px 0 14px;text-align:center;font-size:13px;color:#667085;">${esc(c.state)}</p>`).join('');
  const html = frame(`
    <h1 style="font-size:21px;margin:0 0 8px;">Your access code${codes.length > 1 ? 's' : ''}</h1>
    <p style="margin:0;color:#475467;line-height:1.55;">You asked us to resend your QFwork.ai access code.</p>
    ${list}
    ${button(startUrl, 'Start practising')}
    <p style="margin:18px 0 0;font-size:13px;color:#667085;">Didn't ask for this? You can ignore this email.</p>`);
  const text = ['Your QFwork.ai access code' + (codes.length > 1 ? 's' : '') + ':', '',
    ...codes.map(c => `${c.code}  (${c.state})`), '', `Start practising: ${startUrl}`,
    '', "Didn't ask for this? You can ignore this email."].join('\n');
  return send({ to, subject: 'Your QFwork.ai access code', html, text });
}

module.exports = { enabled, send, welcome, recovery };
