'use strict';
// UPI payment portal: PENDING_PAYMENT -> (VERIFYING_PAYMENT) -> PAID -> RECEIVED_BY_STAFF
//
// Confirmation is the same pipeline whichever way the money is proven (UTR auto-check, staff approval,
// or a gateway-style webhook), and it runs in this strict order:
//   1. PAID   2. visit_count += 1   3. FEFO stock deduction + frozen COGS (+ ledger + archived invoice)
//   4. official email invoice       5. RECEIVED_BY_STAFF + live push to the kitchen screen
// Steps 1-3 are one database transaction (all or nothing). Email cannot live inside a DB transaction,
// so it runs right after the commit; dispatch waits for it. If the server stops between 3 and 5,
// resumeStuck() finishes the job on the next start.
const crypto = require('node:crypto');
const QR = require('qrcode');
const C = require('./config');
const {all, get, run, tx} = require('./db');
const {NV} = require('../public/shared.js');
const B = require('./billing');
const inv = require('./inventory');
const ledger = require('./ledger');
const stations = require('./stations');
const {sendInvoice} = require('./mailer');

class Bad extends Error {}
const bad = msg => { throw new Bad(msg); };

const DISH = Object.fromEntries(NV.MENU.map(d => [d.id, d]));
const TABLES = new Set([...Array.from({length: 12}, (_, i) => String(i + 1)), 'Takeaway']);
const OPEN = ['PENDING_PAYMENT', 'VERIFYING_PAYMENT', 'EXPIRED'];          // may still be confirmed
const DONE = ['PAID', 'RECEIVED_BY_STAFF', 'cooking', 'ready', 'served']; // already confirmed
const UTR_RE = /^\d{12}$/;
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;

let hooks = {guest: () => ({points: 0}), addPts: () => {}, broadcast: () => {}, dispatched: () => {}};
const init = h => { hooks = {...hooks, ...h}; };

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
const customer = email => get('SELECT * FROM customers WHERE email = ?', email);

/* ---------- 1. create the order + UPI intent ---------- */
function createOrder({gid, cart, table, reward, name, email, tip, pickup}) {
  const entries = Object.entries(cart && typeof cart === 'object' ? cart : {});
  if (!entries.length || entries.length > NV.MENU.length) bad('Your cart is empty.');
  const items = {};
  for (const [id, q] of entries) { if (!DISH[id] || !Number.isInteger(q) || q < 1 || q > 20) bad('That cart has something we do not serve.'); items[id] = q; }
  if (!TABLES.has(String(table))) bad('Pick your table first.');
  if (pickup != null && +pickup !== 0 && !(String(table) === 'Takeaway' && NV.PICKUPS.includes(+pickup))) bad('Pick a pickup time: ASAP, 15, 30 or 45 minutes.');
  name = clean(name, 40); email = clean(email, 120).toLowerCase();
  if (!name) bad('Enter your name for the bill.');
  if (!EMAIL_RE.test(email)) bad('Enter a valid email so we can send your tax invoice.');
  if (reward && !NV.REW.find(r => r.id === reward && !r.jump)) bad('That reward does not exist.');
  if (tip != null && typeof tip !== 'object') bad('That tip is not valid.');
  if (tip?.amount != null && !(Number.isInteger(+tip.amount) && +tip.amount >= 0 && +tip.amount <= 5000)) bad('Tip must be a whole amount from ₹1 to ₹5,000.');
  if (tip?.pct != null && +tip.pct !== 0 && !NV.TIP_PCTS.includes(+tip.pct)) bad('Pick a tip of 5%, 10% or 15%.');
  if (reward && hooks.guest(gid).points < NV.REW.find(r => r.id === reward).cost) bad('Not enough points for that reward.');
  const short = inv.shortages(items);
  if (short.length) bad('Sorry, the kitchen is out of ' + short.slice(0, 3).join(', ') + ' right now. Please change your order.');

  return tx(() => {
    const now = Date.now();
    // one open checkout per guest: a new one replaces an old one nobody has claimed to pay
    // (VERIFYING_PAYMENT orders, with or without UTR, stay alive for staff to approve)
    run("UPDATE orders SET status = 'CANCELLED' WHERE guest = ? AND status = 'PENDING_PAYMENT'", gid);
    const c = customer(email);
    if (c) run('UPDATE customers SET name = ?, last_gid = ? WHERE email = ?', name, gid, email);
    else run('INSERT INTO customers (email, name, visit_count, last_gid, created) VALUES (?, ?, 0, ?, ?)', email, name, gid, now);
    const visits = c?.visit_count || 0, b = NV.bill(items, visits, reward, tip);
    // Every open order gets a different total (to the paisa), so a bank credit of ₹X points at exactly one order.
    let round = 0;
    while (round < 99 && get(`SELECT 1 AS x FROM orders WHERE total_paise = ? AND (status IN ('PENDING_PAYMENT', 'VERIFYING_PAYMENT') OR (status IN ('EXPIRED', 'CANCELLED') AND created > ?))`,
      b.totalPayable + round, now - C.BANK_MATCH_WINDOW_MIN * 60000)) round++;
    const total = b.totalPayable + round;
    const pickupAt = String(table) === 'Takeaway' && +pickup ? now + +pickup * 60000 : null;
    const id = run(`INSERT INTO orders (guest, table_no, items, total, status, created, customer_name, customer_email, reward, visit_no, loyalty_tier, loyalty_pct,
                    subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, roundoff_paise, tip_paise, total_paise, expires_at, pickup_at)
                    VALUES (?, ?, ?, ?, 'PENDING_PAYMENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      gid, String(table), JSON.stringify(items), Math.round(total / 100), now, name, email, reward || null, visits + 1, b.tier.n, b.pct,
      b.subtotal, b.loyaltyDiscount, b.taxableAmount, b.cgst, b.sgst, round, b.tip, total, now + C.PAYMENT_WINDOW_MIN * 60000, pickupAt).lastInsertRowid;
    const o = get('SELECT * FROM orders WHERE id = ?', id);
    run('UPDATE orders SET upi_uri = ? WHERE id = ?', B.upiUri(o), id);
    return Number(id);
  });
}

async function checkout(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  return {
    id: 'o' + o.id, orderNo: B.orderNo(o.id), billNo: B.billNo(o.id), status: o.status, table: o.table_no,
    name: o.customer_name, email: o.customer_email, items: JSON.parse(o.items),
    subtotal: o.subtotal_paise, loyaltyDiscount: o.discount_paise, taxableAmount: o.taxable_paise, cgst: o.cgst_paise, sgst: o.sgst_paise, roundoff: o.roundoff_paise || 0, tip: o.tip_paise || 0, pickupAt: o.pickup_at || null, totalPayable: o.total_paise,
    tier: B.tierLabel(o.loyalty_tier, o.loyalty_pct), visitNo: o.visit_no,
    upiUri: o.upi_uri, qr: await QR.toDataURL(o.upi_uri, {margin: 1, width: 300, errorCorrectionLevel: 'M', color: {dark: '#210100', light: '#ffffff'}}),
    expiresAt: o.expires_at, merchant: {vpa: C.MERCHANT_UPI_ID, name: C.MERCHANT_NAME}, demo: C.DEMO_MODE, utr: o.utr,
  };
}

/* ---------- 2a. Mode A: customer submits the UPI reference / UTR ---------- */
async function submitUtr(gid, id, utr) {
  utr = String(utr ?? '').replace(/\s+/g, '');
  if (!UTR_RE.test(utr)) bad('A UPI reference (UTR) is exactly 12 digits. Find it under "UPI transaction ID" in your payment app.');
  const o = get('SELECT * FROM orders WHERE id = ? AND guest = ?', id, gid);
  if (!o) bad('That order was not found.');
  if (DONE.includes(o.status)) return {status: o.status, duplicate: true};
  if (o.status === 'CANCELLED') bad('This checkout was replaced by a newer one.');
  if (o.status === 'EXPIRED') bad('This payment window has expired. If you already paid, show your UTR to the staff and they will approve it.');
  const dupe = get('SELECT id FROM orders WHERE utr = ? AND id != ?', utr, id);
  if (dupe) bad('That UTR is already attached to another order.');
  run("UPDATE orders SET utr = ?, status = 'VERIFYING_PAYMENT', pay_method = 'UPI_UTR' WHERE id = ?", utr, id);
  hooks.broadcast();
  if (C.UTR_AUTO_CONFIRM) return confirmPayment(id, {utr, method: 'UPI_UTR_AUTO'});
  return {status: 'VERIFYING_PAYMENT'};
}

/* ---------- 2a'. one-tap "I've paid" (no UTR needed; staff match the amount in their UPI app) ---------- */
function claimPaid(gid, id) {
  const o = get('SELECT * FROM orders WHERE id = ? AND guest = ?', id, gid);
  if (!o) bad('That order was not found.');
  if (DONE.includes(o.status) || o.status === 'VERIFYING_PAYMENT') return {status: o.status, duplicate: true};
  if (o.status === 'CANCELLED') bad('This checkout was replaced by a newer one.');
  if (o.status === 'EXPIRED') bad('This payment window has expired. If you already paid, tell the staff and they will approve it.');
  run("UPDATE orders SET status = 'VERIFYING_PAYMENT', pay_method = 'UPI_CLAIMED' WHERE id = ?", id);
  hooks.broadcast();
  return {status: 'VERIFYING_PAYMENT'};
}

/* ---------- the confirmation pipeline ---------- */
const inFlight = new Map(); // orderId -> promise, so two confirmations for one order never interleave

function confirmPayment(id, {utr, method}) {
  if (inFlight.has(id)) return inFlight.get(id).then(r => ({...r, duplicate: true}));
  const p = runPipeline(id, {utr, method}).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

async function runPipeline(id, {utr, method}) {
  // Steps 1-3 in ONE transaction.
  const res = tx(() => {
    const o = get('SELECT * FROM orders WHERE id = ?', id);
    if (!o) bad('Order not found.');
    if (DONE.includes(o.status)) return {duplicate: true, status: o.status};      // idempotent
    if (!OPEN.includes(o.status)) bad('This order cannot be paid (status ' + o.status + ').');
    utr = utr ? String(utr).replace(/\s+/g, '') : o.utr;
    if (utr && !UTR_RE.test(utr)) bad('UTR must be 12 digits.');
    if (utr && get('SELECT id FROM orders WHERE utr = ? AND id != ?', utr, id)) bad('That UTR is already attached to another order.');
    const now = Date.now();

    // 1. PAID
    run("UPDATE orders SET status = 'PAID', utr = ?, pay_method = ?, paid_at = ? WHERE id = ?", utr || null, method, now, id);
    // 2. visit count + loyalty tier (the tier used for THIS bill was fixed when the QR amount was shown)
    run('UPDATE customers SET visit_count = visit_count + 1, last_visit = ?, last_gid = COALESCE(?, last_gid) WHERE email = ?', now, o.guest, o.customer_email);
    const visitNo = customer(o.customer_email).visit_count;
    if (o.reward && o.guest) { const rw = NV.REW.find(r => r.id === o.reward); hooks.addPts(o.guest, -rw.cost, 'Redeemed: ' + rw.t); }
    // 3. FEFO deduction, COGS frozen at batch cost
    const cogs = inv.consumeForOrder(id, JSON.parse(o.items), now);
    run('UPDATE orders SET cogs_paise = ?, bill_no = ?, visit_no = ? WHERE id = ?', cogs, B.billNo(id), visitNo, id);
    const paid = get('SELECT * FROM orders WHERE id = ?', id);
    ledger.recordSale(paid, B.billNo(id), now);
    run('INSERT INTO bills (order_id, bill_no, html, created) VALUES (?, ?, ?, ?)', id, B.billNo(id), B.invoiceHtml(paid), now);
    return {duplicate: false};
  });
  if (res.duplicate) return {status: res.status, duplicate: true};
  hooks.broadcast();
  return finishPaid(id);
}

/** Steps 4 and 5. Safe to call again for an order stuck in PAID. */
async function finishPaid(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  if (o.status !== 'PAID') return {status: o.status, duplicate: true};
  const bill = get('SELECT * FROM bills WHERE order_id = ?', id);
  // 4. official email invoice
  const mail = await sendInvoice({to: o.customer_email, subject: `Official Tax Invoice #${bill.bill_no} | ${C.RESTAURANT_NAME}`, html: bill.html, billNo: bill.bill_no});
  const now = Date.now();
  run('UPDATE orders SET bill_status = ?, bill_sent = ?, bill_sent_at = ?, bill_error = ? WHERE id = ?', mail.status, mail.status === 'SENT' ? 1 : 0, now, mail.error || null, id);
  // 5. only now does the kitchen get it
  const sent = Date.now();
  run("UPDATE orders SET status = 'RECEIVED_BY_STAFF', dispatched_at = ?, stations = ? WHERE id = ? AND status = 'PAID'", sent, JSON.stringify(stations.plan(JSON.parse(o.items), sent, o.pickup_at)), id);
  hooks.broadcast();
  hooks.dispatched(get('SELECT * FROM orders WHERE id = ?', id));
  return {status: 'RECEIVED_BY_STAFF', billStatus: mail.status};
}

async function resumeStuck() {
  for (const o of all("SELECT id FROM orders WHERE status = 'PAID'")) { console.log('[pay] resuming order', o.id); await finishPaid(o.id).catch(e => console.error(e)); }
}

/* ---------- 2b. Mode B: gateway-style server-to-server webhook ---------- */
function verifySignature(raw, sig) {
  if (!C.WEBHOOK_SECRET || !raw || !sig) return false;
  const want = crypto.createHmac('sha256', C.WEBHOOK_SECRET).update(raw).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(String(sig).replace(/^sha256=/, ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/**
 * Body: {orderNo|orderId, amount (rupees, string/number), status: "SUCCESS", utr?}
 * Auth: header X-Nivala-Signature = hex HMAC-SHA256(rawBody, WEBHOOK_SECRET). In DEMO_MODE an unsigned call
 * is accepted only from the guest who owns the order or from logged-in staff (the "Simulate" button).
 */
async function webhook({body, raw, signature, gid, staff}) {
  const signed = verifySignature(raw, signature);
  const num = String(body?.orderNo ?? body?.orderId ?? '').replace(/^ORD|^o/i, '');
  const id = body?.orderNo != null || /^ORD/i.test(String(body?.orderId)) ? +num - 1000 : +num;
  const o = Number.isInteger(id) && id > 0 ? get('SELECT * FROM orders WHERE id = ?', id) : null;
  if (!signed) {
    if (!C.DEMO_MODE) return {code: 401, body: {ok: false, error: 'Invalid webhook signature.'}};
    if (!o || !(staff || (gid && o.guest === gid))) return {code: 401, body: {ok: false, error: 'Unsigned demo webhook must come from the order owner.'}};
  }
  if (!o) return {code: 404, body: {ok: false, error: 'Unknown order.'}};
  if (DONE.includes(o.status)) return {code: 200, body: {ok: true, duplicate: true, status: o.status}}; // idempotency
  if (String(body.status || 'SUCCESS').toUpperCase() !== 'SUCCESS') return {code: 200, body: {ok: true, ignored: true}};
  const amt = Math.round(parseFloat(body.amount) * 100);
  if (amt !== o.total_paise) return {code: 400, body: {ok: false, error: `Amount mismatch: got ₹${(amt / 100).toFixed(2)}, expected ₹${(o.total_paise / 100).toFixed(2)}.`}};
  const utr = body.utr && UTR_RE.test(String(body.utr)) ? String(body.utr) : o.utr || simUtr();
  const r = await confirmPayment(o.id, {utr, method: signed ? 'UPI_WEBHOOK' : 'UPI_WEBHOOK_DEMO'});
  return {code: 200, body: {ok: true, ...r}};
}
const simUtr = () => { let u; do { u = String(4 + crypto.randomInt(5)) + String(crypto.randomInt(1e11)).padStart(11, '0'); } while (get('SELECT 1 AS x FROM orders WHERE utr = ?', u)); return u; };

/* ---------- staff actions ---------- */
async function approve(id, utr) {
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  if (!o) bad('Order not found.');
  return confirmPayment(id, {utr: utr || o.utr, method: o.utr || utr ? 'UPI_UTR_STAFF_APPROVED' : 'UPI_STAFF_APPROVED'});
}
function reject(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  if (!o || o.status !== 'VERIFYING_PAYMENT') bad('Only payments being verified can be rejected.');
  run("UPDATE orders SET status = 'PENDING_PAYMENT', utr = NULL, expires_at = MAX(expires_at, ?) WHERE id = ?", Date.now() + 5 * 60000, id);
}
async function resendBill(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', id), bill = get('SELECT * FROM bills WHERE order_id = ?', id);
  if (!o || !bill) bad('No bill for that order yet.');
  const mail = await sendInvoice({to: o.customer_email, subject: `Official Tax Invoice #${bill.bill_no} | ${C.RESTAURANT_NAME}`, html: bill.html, billNo: bill.bill_no});
  run('UPDATE orders SET bill_status = ?, bill_sent = ?, bill_sent_at = ?, bill_error = ? WHERE id = ?', mail.status, mail.status === 'SENT' ? 1 : 0, Date.now(), mail.error || null, id);
  return mail;
}

/** Mark checkouts whose timer ran out. Returns true if anything changed. */
function expireOld(now = Date.now()) {
  return run("UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING_PAYMENT' AND expires_at < ?", now).changes > 0;
}

/** Seed helper: a fully paid historical order (no email sent, invoice archived). */
function seedPaid({gid = null, name, email, items, table, status, minutesAgo, served}) {
  const now = Date.now() - minutesAgo * 60000;
  const c = customer(email);
  if (!c) run('INSERT INTO customers (email, name, visit_count, created) VALUES (?, ?, 0, ?)', email, name, now);
  const visits = customer(email).visit_count, b = NV.bill(items, visits, null);
  const id = run(`INSERT INTO orders (guest, table_no, items, total, status, created, customer_name, customer_email, visit_no, loyalty_tier, loyalty_pct,
                  subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, total_paise, expires_at, utr, pay_method, paid_at)
                  VALUES (?, ?, ?, ?, 'PAID', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPI_UTR_STAFF_APPROVED', ?)`,
    gid, table, JSON.stringify(items), Math.round(b.totalPayable / 100), now, name, email, visits + 1, b.tier.n, b.pct,
    b.subtotal, b.loyaltyDiscount, b.taxableAmount, b.cgst, b.sgst, b.totalPayable, now + 6e5, simUtr(), now).lastInsertRowid;
  run('UPDATE customers SET visit_count = visit_count + 1, last_visit = ? WHERE email = ?', now, email);
  const cogs = inv.consumeForOrder(Number(id), items, now);
  run('UPDATE orders SET cogs_paise = ?, bill_no = ?, upi_uri = ?, bill_status = ?, bill_sent = 1, bill_sent_at = ?, status = ?, dispatched_at = ?, served_at = ? WHERE id = ?',
    cogs, B.billNo(id), B.upiUri(get('SELECT * FROM orders WHERE id = ?', id)), 'SENT', now, status, now, served ? now + 30 * 60000 : null, id);
  run('UPDATE orders SET stations = ? WHERE id = ?', JSON.stringify(stations.plan(items, now, null, status)), id);
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  ledger.recordSale(o, B.billNo(id), now);
  run('INSERT INTO bills (order_id, bill_no, html, created) VALUES (?, ?, ?, ?)', id, B.billNo(id), B.invoiceHtml(o), now);
}

module.exports = {init, Bad, bad, createOrder, checkout, submitUtr, claimPaid, confirmPayment, webhook, approve, reject, resendBill, expireOld, resumeStuck, seedPaid, DONE};
