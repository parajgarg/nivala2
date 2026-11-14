'use strict';
// Free email: Nodemailer + Gmail SMTP with an App Password. Without SMTP_USER/SMTP_PASS the invoice
// is written to data/outbox/ as an HTML preview and the path is logged, so the flow still completes.
const path = require('node:path'), fs = require('node:fs');
const nodemailer = require('nodemailer');
const C = require('./config');
const {DATA} = require('./db');

const OUTBOX = path.join(DATA, 'outbox');
const configured = !!(C.SMTP_USER && C.SMTP_PASS);
const transport = configured ? nodemailer.createTransport({
  host: C.SMTP_HOST, port: C.SMTP_PORT, secure: C.SMTP_PORT === 465,
  auth: {user: C.SMTP_USER, pass: C.SMTP_PASS},
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
}) : null;

/**
 * Send any email. `tag` names the preview file when SMTP is not set up.
 * @returns {Promise<{status:'SENT'|'PREVIEW_ONLY'|'FAILED', info?:string, error?:string}>}
 */
async function sendEmail({to, subject, html, text, tag}) {
  if (!configured) {
    fs.mkdirSync(OUTBOX, {recursive: true});
    const file = path.join(OUTBOX, String(tag || 'mail-' + Date.now()).replace(/[^\w.-]/g, '_') + '.html');
    fs.writeFileSync(file, html);
    console.log(`[mail] SMTP not configured. Preview of "${subject}" for ${to}: ${file}`);
    return {status: 'PREVIEW_ONLY', info: file};
  }
  try {
    const r = await transport.sendMail({from: {name: C.MAIL_FROM_NAME, address: C.SMTP_USER}, to, subject, html,
      text: text || `${subject}\nOpen this email in an HTML-capable mail app to read it.`});
    console.log(`[mail] ${subject} -> ${to} (${r.messageId})`);
    return {status: 'SENT', info: r.messageId};
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    return {status: 'FAILED', error: e.message.slice(0, 300)};
  }
}

const sendInvoice = ({to, subject, html, billNo}) => sendEmail({to, subject, html, tag: billNo,
  text: `${subject}\nOpen this email in an HTML-capable mail app to view your invoice.`});

/** Log in to the SMTP server without sending anything. Explains the usual Gmail mistakes. */
async function verifyMail() {
  if (!configured) return {ok: false, reason: 'SMTP_USER / SMTP_PASS are empty in .env'};
  try { await transport.verify(); return {ok: true}; } catch (e) {
    const m = e.message || String(e);
    const hint = /535|Username and Password not accepted|Invalid login|BadCredentials/i.test(m)
      ? 'Gmail rejected the login. Use a 16-letter App Password (not your normal Gmail password), and check SMTP_USER is the same Gmail account that created it.'
      : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ESOCKET|getaddrinfo/i.test(m) ? 'Could not reach smtp.gmail.com. Check the internet connection, or a college/office network blocking port 465.' : '';
    return {ok: false, reason: m.slice(0, 200), hint};
  }
}

module.exports = {sendEmail, sendInvoice, verifyMail, mailConfigured: configured};
