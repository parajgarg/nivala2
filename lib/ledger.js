'use strict';
// Accounts Directory: every money event becomes ledger rows. profit_paise is each row's effect on profit,
// so Net Profit is simply SUM(profit_paise). GST is a liability (owed to the government), never profit.
const {all, get, run} = require('./db');

const TYPE_FILTER = { // UI filter name -> account
  SALES: 'SALES_REVENUE', DISCOUNT: 'LOYALTY_DISCOUNT', GST: 'GST_COLLECTED', COGS: 'COGS', WASTAGE: 'WASTAGE_LOSS', TIPS: 'TIPS_PAYABLE',
};

function add(e) {
  run(`INSERT INTO accounts_ledger (created, entry_type, account, contra, amount_paise, profit_paise, order_id, bill_no, utr, customer_email, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.created, e.type, e.account, e.contra, e.amount, e.profit, e.orderId ?? null, e.billNo ?? null, e.utr ?? null, e.email ?? null, e.memo ?? null);
}

/** Four entries for a paid order. Runs inside the payment transaction. */
function recordSale(o, billNo, now) {
  const base = {created: now, orderId: o.id, billNo, utr: o.utr, email: o.customer_email};
  const ro = o.roundoff_paise || 0, gross = o.subtotal_paise + ro, net = gross - o.discount_paise;
  add({...base, type: 'CREDIT', account: 'SALES_REVENUE', contra: 'UPI Bank A/c', amount: gross, profit: gross,
    memo: `Gross sales ₹${(gross / 100).toFixed(2)}${ro ? ` (incl. ₹${(ro / 100).toFixed(2)} round off)` : ''} · Net revenue ex-GST ₹${(net / 100).toFixed(2)}`});
  if (o.discount_paise) add({...base, type: 'DEBIT', account: 'LOYALTY_DISCOUNT', contra: 'Sales Revenue', amount: o.discount_paise, profit: -o.discount_paise,
    memo: `${o.loyalty_tier} tier ${o.loyalty_pct}%${o.reward ? ' + reward ' + o.reward : ''} · visit #${o.visit_no}`});
  add({...base, type: 'LIABILITY', account: 'GST_COLLECTED', contra: 'UPI Bank A/c', amount: o.cgst_paise + o.sgst_paise, profit: 0,
    memo: `CGST ₹${(o.cgst_paise / 100).toFixed(2)} + SGST ₹${(o.sgst_paise / 100).toFixed(2)} payable to Govt`});
  if (o.tip_paise) add({...base, type: 'LIABILITY', account: 'TIPS_PAYABLE', contra: 'UPI Bank A/c', amount: o.tip_paise, profit: 0,
    memo: 'Customer tip, payable to staff (not revenue, not taxed)'});
  add({...base, type: 'DEBIT', account: 'COGS', contra: 'Inventory', amount: o.cogs_paise, profit: -o.cogs_paise,
    memo: 'Ingredients consumed (FEFO, frozen at batch cost)'});
}

function recordWastage(w, now) {
  add({created: now, type: 'DEBIT', account: 'WASTAGE_LOSS', contra: 'Inventory', amount: w.lossPaise, profit: -w.lossPaise,
    memo: `${w.reason}: ${w.qty} ${w.unit} ${w.name} (batch #${w.batch} @ ₹${(w.cost / 100).toFixed(3)}/${w.unit})${w.note ? ' · ' + w.note : ''}`});
}

/** Build WHERE from {from, to, type, q}. from/to are YYYY-MM-DD in the server's local time. */
function where(f, {withType = true} = {}) {
  const w = [], p = [];
  const day = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(s + 'T00:00:00').getTime() : null;
  const from = day(f.from), to = day(f.to);
  if (from != null) { w.push('created >= ?'); p.push(from); }
  if (to != null) { w.push('created < ?'); p.push(to + 864e5); }
  if (withType && TYPE_FILTER[f.type]) { w.push('account = ?'); p.push(TYPE_FILTER[f.type]); }
  const q = String(f.q || '').trim().slice(0, 40);
  if (q) { w.push("(bill_no LIKE ? OR ('ORD' || (1000 + order_id)) LIKE ? OR utr LIKE ? OR customer_email LIKE ?)"); const like = '%' + q.replace(/[%_]/g, '') + '%'; p.push(like, like, like, like); }
  return {sql: w.length ? 'WHERE ' + w.join(' AND ') : '', p};
}

function kpis(f = {}) {
  const {sql, p} = where({from: f.from, to: f.to}, {withType: false});
  const s = Object.fromEntries(all(`SELECT account, SUM(amount_paise) AS a FROM accounts_ledger ${sql} GROUP BY account`, ...p).map(r => [r.account, r.a]));
  const gross = s.SALES_REVENUE || 0, disc = s.LOYALTY_DISCOUNT || 0, gst = s.GST_COLLECTED || 0, cogs = s.COGS || 0, waste = s.WASTAGE_LOSS || 0, tips = s.TIPS_PAYABLE || 0;
  const net = gross - disc, profit = net - cogs - waste;
  const orders = get(`SELECT COUNT(DISTINCT order_id) AS n FROM accounts_ledger ${sql ? sql + ' AND' : 'WHERE'} account = 'SALES_REVENUE'`, ...p).n;
  return {gross, discounts: disc, netRevenue: net, gst, tips, cogs, wastage: waste, profit, margin: net ? +(profit / net * 100).toFixed(1) : 0, orders};
}

function list(f = {}, limit = 500) {
  const {sql, p} = where(f);
  return all(`SELECT * FROM accounts_ledger ${sql} ORDER BY created DESC, id DESC LIMIT ?`, ...p, limit);
}

const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function csv(f = {}) {
  const head = ['Date', 'Time', 'Entry ID', 'Entry Type', 'Account', 'Contra Account', 'Amount (INR)', 'Profit Impact (INR)', 'Order #', 'Bill #', 'UPI UTR Ref', 'Customer Email', 'Memo'];
  const rows = list(f, 100000).map(r => { const d = new Date(r.created);
    return [d.toLocaleDateString('en-CA'), d.toLocaleTimeString('en-GB'), r.id, r.entry_type, r.account, r.contra, (r.amount_paise / 100).toFixed(2), (r.profit_paise / 100).toFixed(2),
      r.order_id ? 'ORD' + (1000 + r.order_id) : '', r.bill_no, r.utr, r.customer_email, r.memo]; });
  return '﻿' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {recordSale, recordWastage, kpis, list, csv, TYPE_FILTER};
