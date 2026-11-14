'use strict';
// Order numbers, UPI deep links and the official GST tax-invoice HTML (used for the email AND the archive).
const C = require('./config');
const {NV} = require('../public/shared.js');
const {MENU, VTIERS} = NV;
const DISH = Object.fromEntries(MENU.map(d => [d.id, d]));

const orderNo = id => String(1000 + id);           // ORD1042 / BILL-1042
const billNo = id => 'BILL-' + orderNo(id);
const inr = p => '₹' + (p / 100).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** Standard NPCI UPI intent URI. Every UPI app (GPay, PhonePe, Paytm, BHIM) understands it. */
function upiUri(o) {
  const enc = v => encodeURIComponent(v).replace(/%40/g, '@'); // keep the VPA's "@" literal: some UPI apps reject %40
  const q = {pa: C.MERCHANT_UPI_ID, pn: C.MERCHANT_NAME, am: (o.total_paise / 100).toFixed(2), cu: 'INR', tn: 'ORD' + orderNo(o.id)};
  return 'upi://pay?' + Object.entries(q).map(([k, v]) => k + '=' + enc(v)).join('&');
}

const tierLabel = (tier, pct) => pct ? `${tier} Member - ${pct}% Off` : `${tier} Member`;
function nextTierNote(visitsAfter) {
  const nx = VTIERS.find(t => t.min > visitsAfter);
  if (!nx) return 'You are at our top loyalty tier. Thank you for being family.';
  const left = nx.min - visitsAfter;
  return `${left} more visit${left > 1 ? 's' : ''} to unlock ${nx.n} (${nx.off}% off every bill).`;
}

/** Full HTML invoice. Inline styles only, so it renders the same in Gmail, Outlook and the browser. */
function invoiceHtml(o) {
  const items = JSON.parse(o.items), dt = new Date(o.paid_at || Date.now());
  const date = dt.toLocaleDateString('en-IN', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'});
  const time = dt.toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'});
  const td = 'padding:8px 10px;border-bottom:1px solid #f0e2c8;font-size:14px;color:#210100';
  const tr = (l, v, s = '') => `<tr><td style="padding:5px 10px;font-size:14px;color:#5a2a1a;${s}">${l}</td><td style="padding:5px 10px;font-size:14px;text-align:right;color:#210100;${s}">${v}</td></tr>`;
  const rows = Object.entries(items).map(([id, q]) => { const d = DISH[id], unit = d.price * 100;
    return `<tr><td style="${td}">${esc(d.name)}</td><td style="${td};text-align:center">${q}</td><td style="${td};text-align:right">${inr(unit)}</td><td style="${td};text-align:right">${inr(unit * q)}</td></tr>`; }).join('');
  const visitsAfter = o.visit_no; // this order is visit #visit_no
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tax Invoice ${esc(billNo(o.id))}</title></head>
<body style="margin:0;padding:24px 12px;background:#f7efe0;font-family:Arial,Helvetica,sans-serif;color:#210100">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #ead9b8">
<tr><td style="background:#8C0902;padding:22px 24px;color:#FECE79">
  <div style="font-family:Georgia,serif;font-size:30px;font-weight:bold;letter-spacing:-.5px">${esc(C.RESTAURANT_NAME)}</div>
  <div style="font-size:13px;margin-top:4px;color:#ffe9c2">${esc(C.RESTAURANT_ADDRESS)} · ${esc(C.RESTAURANT_PHONE)}</div>
  <div style="font-size:12px;margin-top:2px;color:#ffe9c2">GSTIN: ${esc(C.RESTAURANT_GSTIN)}</div>
</td></tr>
<tr><td style="padding:18px 24px 6px">
  <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8C0902;font-weight:bold">Tax Invoice</div>
  <table role="presentation" width="100%" style="margin-top:8px;font-size:14px"><tr>
    <td valign="top" style="padding:0 0 8px"><b>Bill No:</b> ${esc(billNo(o.id))}<br><b>Order:</b> ORD${esc(orderNo(o.id))}<br><b>Date:</b> ${date}<br><b>Time:</b> ${time} IST<br><b>Table:</b> ${esc(o.table_no)}</td>
    <td valign="top" style="padding:0 0 8px;text-align:right"><b>Billed to:</b> ${esc(o.customer_name)}<br>${esc(o.customer_email)}<br><b>Visit No:</b> ${o.visit_no}<br><b>Loyalty:</b> ${esc(tierLabel(o.loyalty_tier, o.loyalty_pct))}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 24px">
  <table role="presentation" width="100%" style="background:#fff7e6;border:1px solid #f0d9a8;border-radius:10px;font-size:14px"><tr>
    <td style="padding:10px 12px"><b>Payment:</b> Paid via UPI<br><b>UPI Ref / UTR ID:</b> ${esc(o.utr || '—')}</td>
    <td style="padding:10px 12px;text-align:right"><span style="display:inline-block;background:#1f7a3a;color:#fff;border-radius:99px;padding:4px 12px;font-size:12px;font-weight:bold">Payment Status: CONFIRMED</span></td>
  </tr></table>
</td></tr>
<tr><td style="padding:16px 24px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr style="background:#210100;color:#FECE79"><th align="left" style="padding:8px 10px;font-size:12px">Item Name</th><th style="padding:8px 10px;font-size:12px">Qty</th><th align="right" style="padding:8px 10px;font-size:12px">Unit Rate</th><th align="right" style="padding:8px 10px;font-size:12px">Line Total</th></tr>
    ${rows}
  </table>
</td></tr>
<tr><td style="padding:10px 24px 0">
  <table role="presentation" width="100%" style="border-collapse:collapse">
    ${tr('Subtotal', inr(o.subtotal_paise))}
    ${tr(`Loyalty Discount${o.loyalty_pct ? ` (${o.loyalty_pct}%${o.reward ? ' incl. reward' : ''})` : o.reward ? ' (reward)' : ''}`, '-' + inr(o.discount_paise))}
    ${tr('Taxable Value', inr(o.taxable_paise), 'border-top:1px dashed #d9bf8c')}
    ${tr('CGST (2.5%)', inr(o.cgst_paise))}
    ${tr('SGST (2.5%)', inr(o.sgst_paise))}
    ${o.roundoff_paise ? tr('Round off', '+' + inr(o.roundoff_paise)) : ''}
    ${o.tip_paise ? tr('Tip for the team <span style="font-size:12px;color:#8a6a55">(not taxed, goes to staff)</span>', '+' + inr(o.tip_paise)) : ''}
    ${tr('<b>Grand Total Paid</b>', `<b>${inr(o.total_paise)}</b>`, 'border-top:2px solid #210100;font-size:17px;padding-top:9px')}
  </table>
</td></tr>
<tr><td style="padding:18px 24px 22px">
  <div style="background:#210100;color:#FECE79;border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.5">
    Thank you for dining with us, ${esc(String(o.customer_name).split(' ')[0])}! This was your visit #${o.visit_no}.<br>${esc(nextTierNote(visitsAfter))}
  </div>
  <div style="font-size:11px;color:#8a6a55;margin-top:12px;line-height:1.5">This is a computer-generated invoice and needs no signature. Prices include no service charge. GST: CGST 2.5% + SGST 2.5% under restaurant services (SAC 996331). College project – demo GSTIN.</div>
</td></tr>
</table></body></html>`;
}

module.exports = {orderNo, billNo, inr, esc, upiUri, invoiceHtml, tierLabel, nextTierNote};
