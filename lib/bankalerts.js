'use strict';
// Auto-verification without a gateway: the phone that RECEIVES the UPI money forwards each bank SMS
// (or UPI-app notification) here. We read "credited ₹X ... Ref 4312…", and because every open order has
// a unique total (to the paisa), ₹X identifies exactly one order, which we then confirm automatically.
const {all, get, run} = require('./db');
const C = require('./config');

const NUM = '([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';
const CUR = '(?:rs\\.?|inr|₹)';
const DEBIT_RE = /\b(debited|withdrawn|spent|paid to|sent to|transferred to|debit of)\b|\bdr\.?\s/i;
const CREDIT_RE = /\b(credited|received|deposited|sent you|credit of|added to your)\b|\bcr\.?\s/i;
const toPaise = s => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100);

/** Parse one SMS / notification text. Pure function (no DB), used by the live endpoint and the staff tester. */
function parseAlert(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const kind = DEBIT_RE.test(t) ? 'DEBIT' : CREDIT_RE.test(t) ? 'CREDIT' : 'UNKNOWN';

  let amount = null;
  // 1) "credited by 538.66" / "credited with Rs 538.66" / "received Rs. 538.66" / "sent you ₹538.66"
  const m1 = new RegExp(`(?:credited|received|deposited|sent you|credit of)\\s*(?:by|with|for|of)?\\s*${CUR}?\\s*${NUM}`, 'i').exec(t);
  if (m1) amount = toPaise(m1[1]);
  // 2) first currency amount that is NOT a balance ("Avl Bal Rs 12,000")
  if (amount == null) {
    const re = new RegExp(`${CUR}\\s*${NUM}`, 'gi'); let m;
    while ((m = re.exec(t))) { if (!/(bal(ance)?|avl|available)[^0-9]{0,12}$/i.test(t.slice(Math.max(0, m.index - 16), m.index))) { amount = toPaise(m[1]); break; } }
  }
  if (!(amount > 0)) amount = null;

  // UPI reference / UTR / RRN (12 digits)
  const r1 = /(?:ref(?:erence)?\.?\s*(?:no\.?|number|id)?|refno|utr|rrn|upi\s*(?:ref|txn|transaction)?\s*(?:id|no\.?)?|txn\s*id)\s*[:\-#.]?\s*(\d{12})(?!\d)/i.exec(t);
  const r2 = /(?<![\d*xX])(\d{12})(?!\d)/.exec(t);
  const ref = (r1 || r2)?.[1] || null;

  // payer (best effort, display only)
  const p = /(?:trf from|transfer from|from|by)\s+([A-Za-z][A-Za-z .']{1,40}?)(?=\s+(?:on|ref|refno|upi|via|to|a\/c|in|has)\b|[.,(]|\s*-|$)/i.exec(t);
  const g = /^([A-Za-z][A-Za-z .']{1,40}?) sent you\b/i.exec(t); // GPay-style notification
  const payer = g ? g[1].trim() : p && !/^(rs|inr|upi|a\/c|your)\b/i.test(p[1]) ? p[1].trim() : null;

  return {kind, amount, ref, payer, text: t};
}

const MATCHABLE = ['PENDING_PAYMENT', 'VERIFYING_PAYMENT', 'EXPIRED'];

/**
 * Store an incoming alert and, if it is a credit for exactly one open order, confirm that order.
 * @returns {{status, orderId?, orderNo?, parsed}}
 */
function handleAlert(raw, {source = 'sms', confirm}) {
  const parsed = parseAlert(raw), now = Date.now();
  const save = (status, orderId = null, note = null) => {
    run('INSERT INTO bank_alerts (received, source, raw, kind, amount_paise, ref, payer, status, order_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      now, String(source).slice(0, 40), parsed.text, parsed.kind, parsed.amount, parsed.ref, parsed.payer, status, orderId, note);
    return {status, orderId, orderNo: orderId ? String(1000 + orderId) : null, note, parsed};
  };

  if (!parsed.text) return save('IGNORED', null, 'Empty message');
  if (parsed.kind !== 'CREDIT') return save('IGNORED', null, parsed.kind === 'DEBIT' ? 'Debit, not a payment to you' : 'Not a credit message');
  if (!parsed.amount) return save('IGNORED', null, 'No amount found');

  // same payment forwarded twice (e.g. bank SMS + GPay notification)
  if (parsed.ref && (get('SELECT 1 AS x FROM orders WHERE utr = ? AND status NOT IN (\'PENDING_PAYMENT\', \'VERIFYING_PAYMENT\', \'EXPIRED\')', parsed.ref) ||
                     get("SELECT 1 AS x FROM bank_alerts WHERE ref = ? AND status = 'MATCHED'", parsed.ref))) return save('DUPLICATE', null, 'Reference already used');

  const since = now - C.BANK_MATCH_WINDOW_MIN * 60000;
  const cands = all(`SELECT id, utr FROM orders WHERE total_paise = ? AND status IN (${MATCHABLE.map(() => '?').join()}) AND created > ? ORDER BY created`, parsed.amount, ...MATCHABLE, since);
  let pick = parsed.ref ? cands.find(o => o.utr === parsed.ref) : null;
  if (!pick && cands.length === 1) pick = cands[0];
  if (!pick) {
    if (cands.length > 1) return save('AMBIGUOUS', null, `${cands.length} open orders for this amount. Approve the right one by hand.`);
    if (!parsed.ref && get("SELECT 1 AS x FROM bank_alerts WHERE status = 'MATCHED' AND amount_paise = ? AND received > ?", parsed.amount, now - 10 * 60000))
      return save('DUPLICATE', null, 'Same amount just matched (likely the same payment forwarded twice)');
    return save('UNMATCHED', null, 'No open order with this exact amount');
  }

  // the bank's reference is authoritative; ignore it only if another order already owns it
  const utr = parsed.ref && !get('SELECT 1 AS x FROM orders WHERE utr = ? AND id != ?', parsed.ref, pick.id) ? parsed.ref : null;
  const res = save('MATCHED', pick.id, utr ? null : 'No usable reference in the message');
  confirm(pick.id, utr).catch(e => {
    run("UPDATE bank_alerts SET status = 'ERROR', note = ? WHERE received = ? AND order_id = ?", String(e.message).slice(0, 200), now, pick.id);
    console.error('[bank-alert] confirm failed:', e.message);
  });
  return res;
}

const recent = (n = 25) => all('SELECT * FROM bank_alerts ORDER BY id DESC LIMIT ?', n)
  .map(a => ({id: a.id, t: a.received, kind: a.kind, amount: a.amount_paise, ref: a.ref, payer: a.payer, status: a.status, orderNo: a.order_id ? String(1000 + a.order_id) : null, note: a.note, text: a.raw.slice(0, 220), source: a.source}));

module.exports = {parseAlert, handleAlert, recent};
