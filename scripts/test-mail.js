'use strict';
// Check the Gmail setup and send one real invoice email.
//   npm run test-mail -- you@example.com
const C = require('../lib/config');
const {get} = require('../lib/db');
const {sendInvoice, verifyMail, mailConfigured} = require('../lib/mailer');

(async () => {
  const to = (process.argv[2] || '').trim();
  if (!/^\S+@\S+\.\S{2,}$/.test(to)) { console.log('Usage: npm run test-mail -- you@example.com'); process.exit(1); }

  console.log(`From: ${C.SMTP_USER || '(SMTP_USER empty)'} via ${C.SMTP_HOST}:${C.SMTP_PORT}`);
  if (!mailConfigured) console.log('SMTP_USER / SMTP_PASS are empty, so this will only save an HTML preview.');
  else {
    const v = await verifyMail();
    if (!v.ok) { console.log('Login FAILED: ' + v.reason + (v.hint ? '\n' + v.hint : '')); process.exit(1); }
    console.log('Login OK.');
  }

  const bill = get('SELECT * FROM bills ORDER BY created DESC LIMIT 1');
  if (!bill) { console.log('No invoices in the database yet. Place and pay one order first (or press "Reset demo" as staff).'); process.exit(1); }
  const r = await sendInvoice({to, subject: `Official Tax Invoice #${bill.bill_no} | ${C.RESTAURANT_NAME} (test)`, html: bill.html, billNo: bill.bill_no + '-test'});
  console.log(r.status === 'SENT' ? `Sent ${bill.bill_no} to ${to}. Check the inbox (and Spam the first time).`
    : r.status === 'PREVIEW_ONLY' ? `Saved preview: ${r.info}` : `Send FAILED: ${r.error}`);
  process.exit(r.status === 'FAILED' ? 1 : 0);
})();
