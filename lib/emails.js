'use strict';
// Account emails (welcome + password-reset code). Inline styles only, so they look right in Gmail/Outlook.
const C = require('./config');
const {NV} = require('../public/shared.js');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f7efe0;font-family:Arial,Helvetica,sans-serif;color:#210100">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #ead9b8">
<tr><td style="background:#8C0902;padding:22px 24px;color:#FECE79">
  <div style="font-size:26px;line-height:1;color:#FECE79">निवाला</div>
  <div style="font-family:Arial,Helvetica,sans-serif;font-weight:bold;letter-spacing:4px;font-size:14px;margin-top:6px;color:#FECE79">${esc(C.RESTAURANT_NAME.toUpperCase())}</div>
</td></tr>
${body}
<tr><td style="padding:14px 24px 20px;font-size:11px;color:#8a6a55;line-height:1.5;border-top:1px solid #f0e2c8">${esc(C.RESTAURANT_NAME)} · ${esc(C.RESTAURANT_ADDRESS)}<br>You are receiving this because this email was used on our website.</td></tr>
</table></body></html>`;

function welcome(name) {
  const first = esc(String(name).split(' ')[0]);
  const tiers = NV.VTIERS.filter(t => t.off).map(t => `<tr><td style="padding:6px 0;font-size:14px"><b>${t.n}</b></td><td style="padding:6px 0;font-size:14px;color:#5a2a1a">after ${t.min} visits</td><td style="padding:6px 0;font-size:14px;text-align:right"><b>${t.off}% off</b> every bill</td></tr>`).join('');
  const html = shell(`Welcome to ${C.RESTAURANT_NAME}`, `
<tr><td style="padding:24px 24px 8px">
  <div style="font-family:Georgia,serif;font-size:28px;line-height:1.15">Welcome to the family, ${first}.</div>
  <p style="font-size:15px;line-height:1.6;color:#3a1a10;margin:12px 0 0"><i>Nivala</i> means a morsel: the bite someone feeds you with their own hand. Your account is ready, and from now on we remember you.</p>
</td></tr>
<tr><td style="padding:12px 24px">
  <div style="background:#fff7e6;border:1px solid #f0d9a8;border-radius:10px;padding:14px 16px">
    <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8C0902;font-weight:bold">What your account does</div>
    <ul style="margin:10px 0 0;padding-left:18px;font-size:14px;line-height:1.7;color:#3a1a10">
      <li>Every paid visit counts towards an automatic bill discount</li>
      <li>Points for every ₹10, plus rewards like free dessert and queue jumps</li>
      <li>All your GST tax invoices in one place, on any device</li>
      <li>Your name and email filled in at checkout</li>
    </ul>
  </div>
</td></tr>
<tr><td style="padding:4px 24px 8px">
  <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8C0902;font-weight:bold;margin-bottom:4px">Loyalty tiers</div>
  <table role="presentation" width="100%" style="border-collapse:collapse">${tiers}</table>
</td></tr>
<tr><td style="padding:12px 24px 22px">
  <div style="background:#210100;color:#FECE79;border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.5">Scan the code on your table, order, pay by UPI, and your bill lands in this inbox before the food reaches you. See you soon!</div>
</td></tr>`);
  const text = `Welcome to ${C.RESTAURANT_NAME}, ${String(name).split(' ')[0]}!\nYour account is ready: visits count towards automatic discounts, you earn points, and all your tax invoices are saved in one place.\nSee you soon!`;
  return {subject: `Welcome to ${C.RESTAURANT_NAME}, ${String(name).split(' ')[0]}!`, html, text};
}

function resetCode(name, code, minutes) {
  const html = shell(`${C.RESTAURANT_NAME} password reset code`, `
<tr><td style="padding:24px 24px 6px">
  <div style="font-family:Georgia,serif;font-size:24px;line-height:1.2">Your password reset code</div>
  <p style="font-size:15px;line-height:1.6;color:#3a1a10;margin:10px 0 0">Hi ${esc(String(name).split(' ')[0])}, enter this code on the ${esc(C.RESTAURANT_NAME)} website to choose a new password.</p>
</td></tr>
<tr><td style="padding:14px 24px" align="center">
  <div style="display:inline-block;background:#210100;color:#FECE79;border-radius:12px;padding:16px 26px;font-size:34px;letter-spacing:10px;font-weight:bold;font-family:'Courier New',monospace">${esc(code)}</div>
  <div style="font-size:13px;color:#5a2a1a;margin-top:10px">Valid for ${minutes} minutes. Use it once.</div>
</td></tr>
<tr><td style="padding:8px 24px 20px">
  <p style="font-size:13px;line-height:1.6;color:#5a2a1a;margin:0">Didn't ask for this? You can ignore this email: your password stays the same. Never share this code. ${esc(C.RESTAURANT_NAME)} staff will never ask for it.</p>
</td></tr>`);
  const text = `Your ${C.RESTAURANT_NAME} password reset code is ${code}. It is valid for ${minutes} minutes. If you didn't ask for it, ignore this email.`;
  return {subject: `${code} is your ${C.RESTAURANT_NAME} password reset code`, html, text};
}

module.exports = {welcome, resetCode};
