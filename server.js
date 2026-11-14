'use strict';
// Nivala server: Express (API + static files), Socket.IO (live sync), SQLite (storage).
// Run with:  npm start      Settings: .env (see .env.example)      Staff PIN: STAFF_PIN (default 1234)
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http');
const express = require('express');
const {Server} = require('socket.io');
const C = require('./lib/config');
const {db, all, get, run, tx, DATA} = require('./lib/db');
const {NV} = require('./public/shared.js');
const pay = require('./lib/payments');
const inv = require('./lib/inventory');
const ledger = require('./lib/ledger');
const B = require('./lib/billing');
const {mailConfigured, verifyMail, sendEmail} = require('./lib/mailer');
const emails = require('./lib/emails');
const bank = require('./lib/bankalerts');
const auth = require('./lib/auth');
const stations = require('./lib/stations');
auth.seedStaff();
const {CU, MENU, TIERS, REW, DK} = NV;
const {Bad, bad} = pay;

const PORT = C.PORT, STAFF_PIN = String(C.STAFF_PIN);
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, {recursive: true});

const meta = k => get('SELECT v FROM meta WHERE k = ?', k)?.v ?? 0;
const bump = (k, n) => run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = v + excluded.v', k, n);

const DISH = Object.fromEntries(MENU.map(d => [d.id, d]));
const d6 = a => Object.fromEntries(DK.map((k, i) => [k, a[i]]));
const CUC = {'North Indian': ['#E6A341', '#B14A36'], 'South Indian': ['#FECE79', '#E6A341'], 'Indo-Chinese': ['#B14A36', '#8C0902'], 'Street Food': ['#E6A341', '#8C0902'], 'Dessert': ['#FECE79', '#B14A36']};

/* Cozy wall demo photos (Pexels, free licence; credits in public/img/wall/credits.json). [file, aspect ratio, caption, by, likes, fallback emoji, cuisine] */
const WALL = [
  ['diwali-dinner.jpg', 1.5, 'Diwali dinner with the whole gang', 'Paraj', 24, '🪔', 0],
  ['one-nivala.jpg', 1.78, 'one nivala for you, one for me', 'Meera', 31, '🍛', 0],
  ['family-celebration.jpg', 1.5, "Nani's 80th. Everyone came.", 'Neha', 40, '🎂', 4],
  ['yellow-sweater.jpg', 0.67, 'ordered everything. no regrets.', 'Kabir', 12, '🍽️', 0],
  ['sunday-thali.jpg', 1.5, 'Sunday thali with Amma', 'Isha', 22, '🥘', 1],
  ['festive-table.jpg', 1.5, 'first dinner in our new city', 'Zoya', 18, '🕯️', 0],
  ['naan-share.jpg', 0.67, 'garlic naan, shared fairly-ish', 'Dev', 9, '🫓', 0],
];
function seedWall() {
  for (const [file, ar, cap, by, likes, em, c] of [...WALL].reverse())
    run('INSERT INTO photos (guest, by, cap, em, c1, c2, src, ar, likes) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)', by, cap, em, CUC[CU[c]][0], CUC[CU[c]][1], '/img/wall/' + file, ar, likes);
}
/** Width/height of a JPEG from its header (for uploaded photos). */
function jpegRatio(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) { const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7); return h ? +(w / h).toFixed(3) : null; }
    i += 2 + len;
  }
  return null;
}

function seed() {
  tx(() => {
    for (const t of ['bank_alerts', 'accounts_ledger', 'bills', 'orders', 'customers', 'queue', 'reviews', 'photos', 'restaurants', 'ratings', 'guests', 'wishes', 'meta']) run('DELETE FROM ' + t);
    inv.seedInventory();
    const n = Date.now(), m = 60000, day = 864e5;
    // paid history (fills the Accounts Directory) + three orders already in the kitchen
    const H = [['Aarav Mehta', 'aarav.demo@example.com'], ['Meera Iyer', 'meera.demo@example.com'], ['Zoya Khan', 'zoya.demo@example.com']];
    [[0, {bc: 1, gn: 2, dm: 1}, '3', 3 * day], [1, {md: 2, fc: 2}, '5', 3 * day - 90 * m], [0, {bi: 2, rm: 2}, '8', 2 * day], [2, {pt: 1, hk: 1, mo: 2}, '1', 2 * day - 3 * 60 * m],
     [1, {is: 2, mv: 1, fc: 2}, 'Takeaway', day], [0, {rj: 1, gn: 3}, '6', day - 60 * m], [2, {pb: 2, ch: 1, ku: 2}, '10', 20 * 60 * m], [0, {bc: 2, gn: 4, gj: 2}, '2', 9 * 60 * m]]
      .forEach(([c, items, table, ago]) => pay.seedPaid({name: H[c][0], email: H[c][1], items, table, status: 'served', minutesAgo: ago / m, served: true}));
    pay.seedPaid({name: 'Rohit Sharma', email: 'rohit.demo@example.com', items: {bc: 1, gn: 2}, table: '4', status: 'cooking', minutesAgo: 7});
    pay.seedPaid({name: 'Isha Rao', email: 'isha.demo@example.com', items: {md: 2, fc: 2}, table: '7', status: 'RECEIVED_BY_STAFF', minutesAgo: 2});
    pay.seedPaid({name: 'Kabir Das', email: 'kabir.demo@example.com', items: {pt: 1, dm: 1}, table: '2', status: 'ready', minutesAgo: 12});
    // one expired-stock write-off already on the books
    const w = inv.writeOff(get("SELECT id FROM batches WHERE ingredient = 'cream' AND expires < ?", n).id, 200, 'EXPIRED', n - day);
    ledger.recordWastage({...w, reason: 'EXPIRED', note: 'Morning stock check'}, n - day);

    [['Anita', 2, 9], ['Farhan', 4, 5], ['Sneha', 3, 2]].forEach(([name, size, ago]) => run('INSERT INTO queue (guest, name, size, status, created) VALUES (NULL, ?, ?, ?, ?)', name, size, 'waiting', n - ago * m));
    [['Zoya', 7 * day, [5, 5, 5, 4.5, 5, 5], 'Fastest dinner we have had in this city.'],
     ['Meera', 6 * day, [4, 4.5, 4, 4, 4.5, 4], 'Cozy corner seats. Dal makhani is a hug.'],
     ['Paraj', 2 * day, [4.5, 4.5, 4.5, 4.5, 5, 4.5], 'Ordered from the table, food came in 9 minutes.'],
     ['Aarav', 5 * 60 * m, [5, 4.5, 4.5, 4, 5, 4.5], 'Dosa was crisp, coffee was perfect.'],
     ['Rohit', 3 * 60 * m, [4.5, 4, 4, 3, 4.5, 4], 'Biryani portion felt small for the price.'],
     ['Neha', 40 * m, [4, 4, 2.5, 3.5, 4.5, 2], 'Food was lovely but we waited 25 minutes for the bill.'],
    ].forEach(([who, ago, s, text]) => run('INSERT INTO reviews (guest, who, scores, text, created) VALUES (NULL, ?, ?, ?, ?)', who, JSON.stringify(d6(s)), text, n - ago));
    seedWall();
    [['nivala', 'Nivala', ['North Indian', 'South Indian'], [4.7, 4.5, 4.4, 4.3, 4.8, 4.6], 1284, 1],
     ['sweet', 'Sweet Tooth Dairy', ['Dessert'], [4.9, 4.8, 4.8, 4.5, 4.9, 4.7], 640, 0],
     ['udupi', 'Udupi Sunrise', ['South Indian'], [4.9, 4.2, 4.7, 4.9, 4.6, 4.8], 1530, 0],
     ['tandoor', 'Tandoor Tales', ['North Indian'], [4.8, 4.6, 4.6, 4.4, 4.7, 4.3], 912, 0],
     ['chowk', 'Chowk Chaat House', ['Street Food'], [4.6, 3.9, 4.2, 4.9, 3.9, 4.7], 760, 0],
     ['dragon', 'Dragon Lane', ['Indo-Chinese'], [4.3, 4.4, 4.0, 4.1, 4.3, 4.2], 402, 0],
    ].forEach(([id, name, tags, d, cnt, home], i) => run('INSERT INTO restaurants (id, name, tags, dims, n, home, pos) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, JSON.stringify(tags), JSON.stringify(d6(d)), cnt, home, i));
    bump('saved', 48210); bump('served', 37);
  });
  for (const f of fs.readdirSync(UPLOADS)) fs.rmSync(path.join(UPLOADS, f), {force: true});
}
// first run, or a database from before payments existed
if (!get('SELECT 1 AS x FROM restaurants LIMIT 1') || !get('SELECT 1 AS x FROM ingredients LIMIT 1')) seed();
// existing databases: swap the old emoji placeholder polaroids for the real photos once
// orders already in the kitchen from before stations existed get a station plan once
for (const o of all("SELECT id, items, status, dispatched_at, created, pickup_at FROM orders WHERE stations IS NULL AND status IN ('RECEIVED_BY_STAFF', 'cooking', 'ready')"))
  run('UPDATE orders SET stations = ? WHERE id = ?', JSON.stringify(stations.plan(JSON.parse(o.items), o.dispatched_at || o.created, o.pickup_at, o.status)), o.id);
if (!get("SELECT 1 AS x FROM photos WHERE src LIKE '/img/wall/%' LIMIT 1")) tx(() => { run('DELETE FROM photos WHERE guest IS NULL AND src IS NULL'); seedWall(); });

/* ---------------- domain helpers ---------------- */
const tierOf = life => [...TIERS].reverse().find(t => life >= t.min);
function guest(gid) {
  let g = get('SELECT * FROM guests WHERE id = ?', gid);
  if (!g) { run('INSERT INTO guests (id, points, life, hist) VALUES (?, 260, 260, ?)', gid, JSON.stringify([{d: 'Dinner for two', p: 160}, {d: 'Welcome gift', p: 100}])); g = get('SELECT * FROM guests WHERE id = ?', gid); }
  return g;
}
function addPts(gid, p, d) {
  const g = guest(gid), hist = [{d, p}, ...JSON.parse(g.hist)].slice(0, 7);
  run('UPDATE guests SET points = points + ?, life = life + ?, hist = ? WHERE id = ?', p, Math.max(0, p), JSON.stringify(hist), gid);
}
const rowId = (v, prefix) => { const m = new RegExp('^' + prefix + '(\\d+)$').exec(String(v)); if (!m) bad('Unknown item.'); return +m[1]; };
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

const KITCHEN = ['RECEIVED_BY_STAFF', 'cooking', 'ready'];

/* "Seconds saved" grows live: every party in the virtual queue and every order cooking is a guest
   not standing at a counter, so each saves one second per second (minimum 1/s). */
let savedAt = Date.now();
const saveRate = () => Math.max(1, get("SELECT COUNT(*) AS c FROM queue WHERE status = 'waiting'").c
  + get(`SELECT COUNT(*) AS c FROM orders WHERE status IN (${KITCHEN.map(() => '?').join()})`, ...KITCHEN).c);
function accrueSaved() {
  const secs = Math.floor((Date.now() - savedAt) / 1000);
  if (secs > 0) { bump('saved', secs * saveRate()); savedAt += secs * 1000; }
}
setInterval(accrueSaved, 5000);
const setMeta = (k, v) => run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, Math.round(v));
/* Queue estimate: minutes per party = how fast tables have actually been turning (smoothed gap between seatings). */
const waitPer = () => Math.min(15, Math.max(1, Math.round((meta('seat_gap') || 240) / 60)));
/* Kitchen estimate: average minutes from "received" to "ready" over the last 20 orders. */
const prepMin = () => {
  const a = get('SELECT AVG(ready_at - dispatched_at) AS a FROM (SELECT ready_at, dispatched_at FROM orders WHERE ready_at IS NOT NULL AND dispatched_at IS NOT NULL ORDER BY ready_at DESC LIMIT 20)').a;
  return a ? Math.min(45, Math.max(3, Math.round(a / 60000))) : 12;
};
const servedToday = () => get("SELECT COUNT(*) AS c FROM orders WHERE status = 'served' AND served_at >= ?", new Date().setHours(0, 0, 0, 0)).c;
/* Dishes the kitchen cannot cook right now (not enough unexpired stock). Recomputed at most once per broadcast. */
let soMemo = {t: 0, v: []};
const soldOut = () => { if (Date.now() - soMemo.t > 2000) soMemo = {t: Date.now(), v: MENU.filter(d => inv.shortages({[d.id]: 1}).length).map(d => d.id)}; return soMemo.v; };
/* Friends circle (demo people) and where they ate. [days ago, rating, dish] */
const CIRCLE = {
  people: {Paraj: 'gold', Meera: 'cream', Kabir: 'ember', Isha: 'gold', Dev: 'cream'},
  visits: {nivala: {Paraj: [2, 4.5, 'Masala Dosa'], Meera: [7, 4, 'Dal Makhani']}, tandoor: {Paraj: [5, 5, 'Paneer Tikka'], Kabir: [3, 4.5, 'Rogan Josh']},
    udupi: {Isha: [1, 5, 'Filter Coffee'], Meera: [14, 4.5, 'Idli Sambar']}, dragon: {Kabir: [7, 3.5, 'Manchurian'], Dev: [4, 4, 'Momos']},
    chowk: {Paraj: [21, 4.5, 'Pav Bhaji'], Dev: [0, 5, 'Chaat']}, sweet: {Isha: [2, 5, 'Rasmalai']}},
};
const ago = d => d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? d + ' days ago' : d < 14 ? 'last week' : Math.round(d / 7) + ' weeks ago';
const circleOut = {people: CIRCLE.people, visits: Object.fromEntries(Object.entries(CIRCLE.visits).map(([r, v]) => [r, Object.fromEntries(Object.entries(v).map(([n, [d, s, dish]]) => [n, [ago(d), s, dish]]))]))};
const friendsOf = g => { try { const f = JSON.parse(g.circle || 'null'); return Array.isArray(f) ? f.filter(n => CIRCLE.people[n]) : ['Paraj', 'Meera']; } catch (e) { return ['Paraj', 'Meera']; } };
/* What guests wished for in the mock-menu studio, per dish (staff only). */
function wishStats() {
  const boards = all('SELECT board FROM wishes'), by = {};
  for (const b of boards) for (const w of JSON.parse(b.board)) if (DISH[w.id]) { (by[w.id] ||= {n: 0, sum: 0}).n++; by[w.id].sum += w.wish; }
  return {boards: boards.length, dishes: Object.entries(by).map(([id, x]) => ({id, n: x.n, avg: Math.round(x.sum / x.n)})).sort((a, b) => b.n - a.n)};
}
const PAYING = ['PENDING_PAYMENT', 'VERIFYING_PAYMENT', 'PAID'];
const orderOut = (o, gid, staff) => ({
  id: 'o' + o.id, items: JSON.parse(o.items), table: o.table_no, status: o.status, t: o.dispatched_at || o.created, total: o.total, mine: o.guest === gid,
  orderNo: B.orderNo(o.id), billNo: o.bill_no, totalPaise: o.total_paise, expiresAt: o.expires_at, utr: o.utr, billStatus: o.bill_status, billSentAt: o.bill_sent_at,
  name: staff || o.guest === gid ? o.customer_name : '', email: staff || o.guest === gid ? o.customer_email : '',
  stations: o.stations ? JSON.parse(o.stations) : null, pickupAt: o.pickup_at || null,
});

/** What one client is allowed to see. Guests get only their own orders and no review list. */
function view({gid, staff}) {
  accrueSaved();
  const g = guest(gid);
  const orders = all(`SELECT * FROM orders WHERE status IN (${[...KITCHEN, ...PAYING].map(() => '?').join()}) ORDER BY created`, ...KITCHEN, ...PAYING).map(o => orderOut(o, gid, staff));
  const queue = all('SELECT * FROM queue ORDER BY created').map(q => ({id: 'q' + q.id, name: staff || q.guest === gid ? q.name : '', size: q.size, t: q.created, status: q.status, app: !!q.guest, mine: q.guest === gid}));
  const acct = auth.accountByGid(gid);
  const cust = acct ? get('SELECT * FROM customers WHERE email = ?', acct.email) || {email: acct.email, name: acct.name, visit_count: 0}
    : get('SELECT * FROM customers WHERE last_gid = ? ORDER BY COALESCE(last_visit, created) DESC LIMIT 1', gid);
  const live = staff ? auth.staffFromToken(staff.token) : null;
  return {
    now: Date.now(),
    orders: staff ? orders : orders.filter(o => o.mine),
    queue, myQ: queue.find(q => q.mine)?.id ?? null,
    reviews: staff ? all('SELECT * FROM reviews ORDER BY created DESC LIMIT 40').map(r => ({id: 'v' + r.id, who: r.who, t: r.created, s: JSON.parse(r.scores), text: r.text, done: r.done, reply: r.reply})) : [],
    photos: all('SELECT * FROM photos ORDER BY (src IS NULL), CASE WHEN src IS NULL THEN id ELSE -id END').map(p => ({id: 'p' + p.id, em: p.em, c: p.c1 ? [p.c1, p.c2] : null, src: p.src, ar: p.ar, cap: p.cap, by: p.by, likes: p.likes})),
    net: all('SELECT * FROM restaurants ORDER BY pos').map(r => ({id: r.id, name: r.name, tags: JSON.parse(r.tags), d: JSON.parse(r.dims), n: r.n, home: r.home})),
    served: servedToday(), saved: meta('saved'), saveRate: saveRate(), waitPer: waitPer(), prepMin: prepMin(), soldOut: soldOut(),
    friends: friendsOf(g), circle: circleOut, donateClicks: meta('donate_clicks'),
    me: {points: g.points, life: g.life, hist: JSON.parse(g.hist), email: cust?.email || null, name: cust?.name || null, visits: cust?.visit_count || 0, account: acct ? {name: acct.name, email: acct.email} : null},
    rated: all('SELECT rest FROM ratings WHERE guest = ?', gid).map(r => r.rest),
    mockSent: !!get('SELECT 1 AS x FROM wishes WHERE guest = ?', gid),
    demo: C.DEMO_MODE, autoVerify: !!C.BANK_ALERT_TOKEN,
    ...(staff ? {wishStats: wishStats(), staffMe: live ? {name: live.name, role: live.role} : null, accountsOpen: !!live && live.accountsUntil > Date.now(), team: live?.role === 'manager' ? auth.teamList() : null, stock: inv.stockView(), ingredients: inv.ingredientList(), mail: mailConfigured, utrAuto: C.UTR_AUTO_CONFIRM, alerts: bank.recent(), alertUrls: alertUrls()} : {}),
  };
}

/* ---------------- actions ---------------- */
const guestActs = {
  join(d, {gid}) {
    const name = text(d.name, 20), size = +d.size;
    if (!name) bad('Tell us your name so we can call you.');
    if (!Number.isInteger(size) || size < 1 || size > 12) bad('Party size must be between 1 and 12.');
    if (get('SELECT 1 AS x FROM queue WHERE guest = ?', gid)) bad('You are already in the queue.');
    run('INSERT INTO queue (guest, name, size, status, created) VALUES (?, ?, ?, ?, ?)', gid, name, size, 'waiting', Date.now());
    bump('saved', 180);
  },
  leave(d, {gid}) { run('DELETE FROM queue WHERE guest = ?', gid); },
  jump(d, {gid}) {
    const rw = REW.find(r => r.jump), q = get("SELECT * FROM queue WHERE guest = ? AND status = 'waiting'", gid);
    if (!q) bad('Join the queue first, then jump it.');
    if (guest(gid).points < rw.cost) bad('Not enough points for a queue jump.');
    run('UPDATE queue SET created = created - ? WHERE id = ?', 8 * 60000, q.id);
    addPts(gid, -rw.cost, 'Queue jump');
  },
  rate(d, {gid}) {
    const r = get('SELECT * FROM restaurants WHERE id = ?', String(d.id));
    if (!r) bad('Unknown restaurant.');
    const s = {};
    for (const k of DK) { const v = +d.scores?.[k]; if (!(v >= 1 && v <= 5) || (v * 2) % 1) bad('Each score must be between 1 and 5.'); s[k] = v; }
    if (get('SELECT 1 AS x FROM ratings WHERE guest = ? AND rest = ?', gid, r.id)) bad('You have already rated ' + r.name + '. One vote per diner keeps the Stars fair.');
    const w = tierOf(guest(gid).life).w, dims = JSON.parse(r.dims);
    for (const k of DK) dims[k] = (dims[k] * r.n + s[k] * w) / (r.n + w);
    run('UPDATE restaurants SET dims = ?, n = n + 1 WHERE id = ?', JSON.stringify(dims), r.id);
    run('INSERT INTO ratings (guest, rest, scores, created) VALUES (?, ?, ?, ?)', gid, r.id, JSON.stringify(s), Date.now());
    if (r.home) run('INSERT INTO reviews (guest, who, scores, text, created) VALUES (?, ?, ?, ?, ?)', gid, 'Guest ' + gid.slice(0, 4), JSON.stringify(s), text(d.text, 160) || 'No comment left.', Date.now());
    addPts(gid, 30, 'Rated ' + r.name);
  },
  like(d) { if (!run('UPDATE photos SET likes = likes + 1 WHERE id = ?', rowId(d.id, 'p')).changes) bad('That photo is gone.'); },
  photo(d, {gid}) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(d.data || ''));
    if (!m || m[1].length > 400000) bad('That photo could not be used. Try a smaller one.');
    if (get('SELECT COUNT(*) AS c FROM photos WHERE guest = ?', gid).c >= 6) bad('You have pinned six photos already. Leave some wall for others.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf[0] !== 0xff || buf[1] !== 0xd8) bad('That file is not a JPEG photo.');
    const name = crypto.randomBytes(9).toString('hex') + '.jpg';
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    run('INSERT INTO photos (guest, by, cap, src, ar) VALUES (?, ?, ?, ?, ?)', gid, 'Guest ' + gid.slice(0, 4), text(d.cap, 40) || 'my Nivala moment', '/uploads/' + name, jpegRatio(buf));
    addPts(gid, 15, 'Pinned a photo');
  },
  circle(d, {gid}) {
    const n = String(d.name); if (!CIRCLE.people[n]) bad('Unknown friend.');
    const f = friendsOf(guest(gid)), i = f.indexOf(n); i < 0 ? f.push(n) : f.splice(i, 1);
    run('UPDATE guests SET circle = ? WHERE id = ?', JSON.stringify(f), gid);
  },
  cancelPay(d, {gid}) {
    if (!run("UPDATE orders SET status = 'CANCELLED' WHERE id = ? AND guest = ? AND status = 'PENDING_PAYMENT'", rowId(d.id, 'o'), gid).changes) bad('That order can no longer be cancelled. If you have paid, staff will confirm it.');
  },
  mockSend(d, {gid}) {
    const sel = Array.isArray(d.sel) ? [...new Set(d.sel)].filter(id => DISH[id]) : [];
    if (!sel.length) bad('Chalk up at least one dish first.');
    const board = sel.map(id => { const p = +d.price?.[id]; return {id, wish: p >= DISH[id].price * .4 && p <= DISH[id].price * 1.5 ? Math.round(p) : DISH[id].price}; });
    const first = !get('SELECT 1 AS x FROM wishes WHERE guest = ?', gid);
    run('INSERT INTO wishes (guest, board, created) VALUES (?, ?, ?) ON CONFLICT (guest) DO UPDATE SET board = excluded.board, created = excluded.created', gid, JSON.stringify(board), Date.now());
    if (first) addPts(gid, 20, 'Shared price wishes');
  },
};
let ledgerTouched = false;
const staffActs = {
  adv(d) {
    const o = get('SELECT * FROM orders WHERE id = ?', rowId(d.id, 'o'));
    if (!o || !KITCHEN.includes(o.status)) bad('That order is already closed.');
    if (o.status !== 'ready') {
      const next = o.status === 'RECEIVED_BY_STAFF' ? 'cooking' : 'ready', now = Date.now(), sts = o.stations ? JSON.parse(o.stations) : null;
      if (sts) for (const p of Object.values(sts)) { if (next === 'ready') { p.status = 'ready'; p.startedAt ||= now; p.readyAt ||= now; } else if (p.status === 'queued') { p.status = 'cooking'; p.startedAt = now; } }
      return void run('UPDATE orders SET status = ?, ready_at = ?, stations = ? WHERE id = ?', next, next === 'ready' ? now : null, sts ? JSON.stringify(sts) : null, o.id);
    }
    run("UPDATE orders SET status = 'served', served_at = ? WHERE id = ?", Date.now(), o.id); bump('served', 1);
    if (o.guest) addPts(o.guest, Math.floor(o.total / 10), 'Order · table ' + o.table_no);
  },
  /* one station starts or finishes its part; the order is "ready" only when every station is */
  station(d) {
    const o = get('SELECT * FROM orders WHERE id = ?', rowId(d.id, 'o'));
    if (!o || !KITCHEN.includes(o.status)) bad('That order is no longer in the kitchen.');
    const sts = JSON.parse(o.stations || '{}'), p = sts[d.st], now = Date.now();
    if (!p) bad('That station has nothing on this order.');
    if (d.do === 'start') { if (p.status === 'queued') { p.status = 'cooking'; p.startedAt = now; } }
    else if (d.do === 'ready') { p.status = 'ready'; p.startedAt ||= now; p.readyAt = now; }
    else if (d.do === 'undo') { p.status = 'cooking'; p.readyAt = null; }
    else bad('Unknown station action.');
    const status = stations.statusOf(sts);
    run('UPDATE orders SET stations = ?, status = ?, ready_at = ? WHERE id = ?', JSON.stringify(sts), status, status === 'ready' ? (o.ready_at || now) : null, o.id);
  },
  rejectUpi(d) { pay.reject(rowId(d.id, 'o')); },
  waste(d) {
    const qty = +d.qty, reason = String(d.reason);
    if (!(qty > 0 && qty < 1e6)) bad('Enter how much was wasted.');
    if (!inv.REASONS.includes(reason)) bad('Pick a reason: expired, spoiled or damaged.');
    const b = get('SELECT * FROM batches WHERE id = ?', +d.id);
    if (!b || b.qty_left <= 0) bad('That batch is empty.');
    if (qty > b.qty_left + 1e-9) bad(`Only ${+b.qty_left.toFixed(1)} left in that batch.`);
    const w = inv.writeOff(b.id, qty, reason), now = Date.now();
    ledger.recordWastage({...w, reason, note: text(d.note, 80)}, now); ledgerTouched = true;
  },
  expireAll() {
    const now = Date.now(), list = all('SELECT id, qty_left FROM batches WHERE qty_left > 0 AND expires <= ?', now);
    if (!list.length) bad('No expired stock right now.');
    for (const b of list) { const w = inv.writeOff(b.id, b.qty_left, 'EXPIRED', now); ledger.recordWastage({...w, reason: 'EXPIRED', note: 'Bulk expired write-off'}, now); }
    ledgerTouched = true;
  },
  receive(d) {
    const ing = get('SELECT * FROM ingredients WHERE id = ?', String(d.ing));
    const qty = +d.qty, cost = +d.cost, days = +d.days;
    if (!ing) bad('Pick an ingredient.');
    if (!(qty > 0 && qty <= 1e6)) bad('Enter the quantity received.');
    if (!(cost > 0 && cost < 1e5)) bad('Enter the purchase cost per ' + ing.unit + ' in rupees.');
    if (!(Number.isInteger(days) && days >= 1 && days <= 365)) bad('Shelf life must be 1 to 365 days.');
    inv.addBatch(ing.id, qty, Math.round(cost * 100 * 1000) / 1000, Date.now() + days * 864e5);
  },
  walkin(d) { const name = text(d.name, 20); if (!name) bad('Enter a name.'); run('INSERT INTO queue (guest, name, size, status, created) VALUES (NULL, ?, 2, ?, ?)', name, 'waiting', Date.now()); },
  call(d) { run("UPDATE queue SET status = 'called' WHERE id = ?", rowId(d.id, 'q')); },
  seat(d) {
    if (!run('DELETE FROM queue WHERE id = ?', rowId(d.id, 'q')).changes) return;
    const now = Date.now(), last = meta('seat_last'), gap = Math.round((now - last) / 1000);
    if (last && gap >= 60 && gap <= 1800) setMeta('seat_gap', .7 * (meta('seat_gap') || 240) + .3 * gap); // ignore double-taps and idle stretches
    setMeta('seat_last', now);
  },
  sorry(d) { run('UPDATE reviews SET done = 1, reply = ? WHERE id = ?', 'Sorry about that. 10% off your next visit is on us.', rowId(d.id, 'v')); },
  thank(d) { run('UPDATE reviews SET done = 1, reply = ? WHERE id = ?', 'Thank you for telling us.', rowId(d.id, 'v')); },
};

/* ---------------- http ---------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {maxHttpBufferSize: 1e5});
app.disable('x-powered-by');
if (C.BEHIND_PROXY) app.set('trust proxy', 1); // real visitor IPs and HTTPS behind Render's proxy
app.use((req, res, next) => { res.set({'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN'}); next(); });
app.use(express.json({limit: '600kb', verify: (req, res, buf) => { req.rawBody = buf; }}));

const cookies = h => Object.fromEntries(String(h || '').split(';').map(s => s.trim().split('=')).filter(a => a[0] && a[1]));
const staffOf = h => auth.staffFromToken(cookies(h).nv_staff);   // {id, name, role, token, accountsUntil} | null
const isStaff = h => !!staffOf(h);
const custOf = h => auth.customerFromToken(cookies(h).nv_cust);  // customer account | null
const setCookie = (res, name, val, maxAge) => res.append('Set-Cookie', `${name}=${val}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${res.req?.secure ? '; Secure' : ''}`);
const validGid = g => typeof g === 'string' && /^[a-z0-9]{10,40}$/.test(g);
const sha = s => crypto.createHash('sha256').update(s).digest();
const needStaff = (req, res, next) => isStaff(req.headers.cookie) ? next() : res.status(401).json({ok: false, error: 'Staff login needed.'});
/** Wrap an async route: Bad -> 400 with its message, anything else -> 500. */
const h = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ok: false, error: e.message});
    console.error(e); res.status(500).json({ok: false, error: 'Server error. Try again.'});
  }
};

app.get('/api/me', (req, res) => { const s = staffOf(req.headers.cookie); res.json({staff: !!s, name: s?.name, role: s?.role}); });

/* ----- staff: each person signs in with their name + own PIN ----- */
app.get('/api/staff/users', (req, res) => res.json({ok: true, users: auth.staffList(), demo: C.DEMO_MODE}));
app.post('/api/staff/login', (req, res) => {
  const id = +req.body?.user, pin = String(req.body?.pin ?? ''), key = req.ip + '|staff|' + id;
  if (auth.limited(key) || auth.limited(req.ip + '|staff', 20)) return res.status(429).json({ok: false, error: 'Too many tries. Wait a few minutes.'});
  const u = auth.staffLogin(id, pin);
  if (!u) { auth.fail(key); auth.fail(req.ip + '|staff'); return res.status(401).json({ok: false, error: 'Wrong PIN.'}); }
  auth.clear(key);
  setCookie(res, 'nv_staff', auth.createSession('staff', u.id), 43200);
  res.json({ok: true, name: u.name, role: u.role});
});
app.post('/api/staff/logout', (req, res) => {
  auth.endSession(cookies(req.headers.cookie).nv_staff);
  setCookie(res, 'nv_staff', '', 0);
  res.json({ok: true});
});
const needManager = (req, res, next) => staffOf(req.headers.cookie)?.role === 'manager' ? next() : res.status(403).json({ok: false, error: 'Only a manager can do that.'});
/** Accounts Directory needs the separate Accounts PIN on top of a staff login. */
const needAccounts = (req, res, next) => {
  const s = staffOf(req.headers.cookie);
  if (!s) return res.status(401).json({ok: false, error: 'Staff login needed.'});
  if (!(s.accountsUntil > Date.now())) return res.status(403).json({ok: false, locked: true, error: 'Enter the Accounts PIN to open the Accounts Directory.'});
  auth.touchAccounts(s.token); next();
};
app.post('/api/staff/accounts/unlock', needStaff, (req, res) => {
  const s = staffOf(req.headers.cookie), key = req.ip + '|acc|' + s.id;
  if (auth.limited(key, 5)) return res.status(429).json({ok: false, error: 'Too many wrong PINs. Wait a few minutes.'});
  if (!auth.unlockAccounts(s.token, req.body?.pin)) { auth.fail(key); return res.status(401).json({ok: false, error: 'Wrong Accounts PIN.'}); }
  auth.clear(key); console.log(`[auth] Accounts unlocked by ${s.name}`);
  res.json({ok: true});
});
app.post('/api/staff/accounts/lock', needStaff, (req, res) => { auth.lockAccounts(staffOf(req.headers.cookie).token); res.json({ok: true}); });

/* ----- team management (managers only) ----- */
app.post('/api/staff/team', needStaff, needManager, h(async (req, res) => {
  const me = staffOf(req.headers.cookie), d = req.body || {}, pinOk = p => /^\d{4}$/.test(String(p || ''));
  if (d.action === 'add') {
    const name = text(d.name, 30), role = d.role === 'manager' ? 'manager' : 'staff';
    if (!name) bad('Enter a name.');
    if (!pinOk(d.pin)) bad('PIN must be exactly 4 digits.');
    if (get('SELECT 1 AS x FROM staff_users WHERE name = ?', name)) bad('Someone already has that name.');
    run('INSERT INTO staff_users (name, role, pin, created) VALUES (?, ?, ?, ?)', name, role, auth.hash(d.pin), Date.now());
  } else if (d.action === 'pin') {
    if (!pinOk(d.pin)) bad('PIN must be exactly 4 digits.');
    if (!run('UPDATE staff_users SET pin = ? WHERE id = ?', auth.hash(d.pin), +d.id).changes) bad('Unknown staff member.');
    run("DELETE FROM sessions WHERE kind = 'staff' AND subject = ? AND ? != ?", String(+d.id), +d.id, me.id); // sign them out everywhere
  } else if (d.action === 'remove' || d.action === 'restore') {
    if (+d.id === me.id) bad('You cannot remove yourself.');
    if (d.action === 'remove' && get("SELECT COUNT(*) AS c FROM staff_users WHERE role = 'manager' AND active = 1 AND id != ?", +d.id).c === 0) bad('Keep at least one manager.');
    run('UPDATE staff_users SET active = ? WHERE id = ?', d.action === 'restore' ? 1 : 0, +d.id);
    if (d.action === 'remove') run("DELETE FROM sessions WHERE kind = 'staff' AND subject = ?", String(+d.id));
  } else bad('Unknown action.');
  broadcast(); res.json({ok: true});
}));

/* ----- frequent-customer accounts ----- */
const profile = a => {
  const c = get('SELECT * FROM customers WHERE email = ?', a.email), g = guest(a.gid), visits = c?.visit_count || 0;
  const vt = NV.vtierOf(visits), nx = NV.VTIERS.find(t => t.min > visits);
  return {name: a.name, email: a.email, gid: a.gid, since: a.created, visits, tier: vt.n, off: vt.off, next: nx ? {name: nx.n, off: nx.off, left: nx.min - visits} : null, points: g.points,
    bills: all("SELECT o.id, o.bill_no, o.paid_at, o.total_paise, o.table_no, o.items FROM orders o JOIN bills b ON b.order_id = o.id WHERE o.customer_email = ? ORDER BY o.paid_at DESC LIMIT 30", a.email)
      .map(o => ({billNo: o.bill_no, paidAt: o.paid_at, total: o.total_paise, table: o.table_no, items: Object.entries(JSON.parse(o.items)).map(([id, q]) => q + '× ' + DISH[id].name).join(', ')}))};
};
app.post('/api/account/signup', h(async (req, res) => {
  const d = req.body || {}, name = text(d.name, 40), email = text(d.email, 120).toLowerCase(), pw = String(d.password || '');
  if (auth.limited(req.ip + '|signup', 10, 3600e3)) bad('Too many sign-ups from here. Try again later.');
  if (!name) bad('Enter your name.');
  if (!auth.EMAIL_RE.test(email)) bad('Enter a valid email.');
  if (pw.length < 8) bad('Use a password of at least 8 characters.');
  if (auth.account(email)) bad('There is already an account for this email. Sign in instead.');
  auth.fail(req.ip + '|signup', 3600e3);
  // keep this device's points & history unless the device id already belongs to another account
  let gid = validGid(d.gid) && !auth.accountByGid(d.gid) ? d.gid : crypto.randomBytes(10).toString('hex');
  guest(gid);
  run('INSERT INTO customer_accounts (email, name, pass, gid, created, last_login) VALUES (?, ?, ?, ?, ?, ?)', email, name, auth.hash(pw), gid, Date.now(), Date.now());
  run('INSERT INTO customers (email, name, visit_count, last_gid, created) VALUES (?, ?, 0, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name, last_gid = excluded.last_gid', email, name, gid, Date.now());
  setCookie(res, 'nv_cust', auth.createSession('customer', email), 30 * 86400);
  // welcome email goes out in the background; sign-up never waits on (or fails because of) email
  sendEmail({to: email, ...emails.welcome(name), tag: 'welcome-' + email}).then(r => console.log(`[mail] welcome email for ${email}: ${r.status}`));
  res.json({ok: true, profile: profile(auth.account(email))});
}));

/* ----- forgot password: emailed 6-digit code ----- */
const OTP_MIN = 10, OTP_TRIES = 5, OTP_GAP_MS = 60000;
app.post('/api/account/forgot', h(async (req, res) => {
  const email = text(req.body?.email, 120).toLowerCase(), now = Date.now();
  if (!auth.EMAIL_RE.test(email)) bad('Enter a valid email.');
  if (auth.limited(req.ip + '|forgot', 10)) return res.status(429).json({ok: false, error: 'Too many code requests from here. Try again in an hour.'});
  auth.fail(req.ip + '|forgot', 3600e3);
  // Same answer whether or not the email has an account, so this can't be used to discover customers.
  const reply = (cooldown = 60) => res.json({ok: true, cooldown, message: 'If that email has an account, a 6-digit code is on its way. Check Spam too.'});
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), codeHash = auth.hash(code); // hash first: similar timing either way
  const a = auth.account(email);
  if (!a) return reply();
  const last = get('SELECT created FROM password_resets WHERE email = ? ORDER BY id DESC LIMIT 1', email);
  if (last && now - last.created < OTP_GAP_MS) return reply(Math.ceil((OTP_GAP_MS - (now - last.created)) / 1000));
  if (get('SELECT COUNT(*) AS c FROM password_resets WHERE email = ? AND created > ?', email, now - 3600e3).c >= 5) return reply();
  run('UPDATE password_resets SET used = 1 WHERE email = ? AND used = 0', email); // only the newest code works
  run('INSERT INTO password_resets (email, code, created, expires) VALUES (?, ?, ?, ?)', email, codeHash, now, now + OTP_MIN * 60000);
  sendEmail({to: email, ...emails.resetCode(a.name, code, OTP_MIN), tag: 'reset-code-' + email}).then(r => console.log(`[auth] reset code email for ${email}: ${r.status}`));
  reply();
}));
app.post('/api/account/reset', h(async (req, res) => {
  const email = text(req.body?.email, 120).toLowerCase(), code = String(req.body?.code || '').replace(/\D/g, ''), pw = String(req.body?.password || '');
  if (auth.limited(req.ip + '|reset', 20)) return res.status(429).json({ok: false, error: 'Too many tries. Wait a few minutes.'});
  if (!/^\d{6}$/.test(code)) bad('Enter the 6-digit code from the email.');
  if (pw.length < 8) bad('New password needs at least 8 characters.');
  const expired = 'That code is wrong or has expired. Request a new one.';
  const r = get('SELECT * FROM password_resets WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1', email);
  if (!r || r.expires < Date.now() || r.attempts >= OTP_TRIES) { auth.fail(req.ip + '|reset'); bad(expired); }
  if (!auth.verify(code, r.code)) {
    run('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?', r.id); auth.fail(req.ip + '|reset');
    const left = OTP_TRIES - r.attempts - 1;
    bad(left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : expired);
  }
  const a = auth.account(email); if (!a) bad(expired);
  run('UPDATE password_resets SET used = 1 WHERE email = ?', email);
  run('UPDATE customer_accounts SET pass = ?, last_login = ? WHERE email = ?', auth.hash(pw), Date.now(), email);
  run("DELETE FROM sessions WHERE kind = 'customer' AND subject = ?", email); // sign out every other device
  setCookie(res, 'nv_cust', auth.createSession('customer', email), 30 * 86400);
  console.log(`[auth] password reset for ${email}`);
  res.json({ok: true, profile: profile(a)});
}));
app.post('/api/account/login', h(async (req, res) => {
  const email = text(req.body?.email, 120).toLowerCase(), key = req.ip + '|cust|' + email;
  if (auth.limited(key) || auth.limited(req.ip + '|cust', 30)) return res.status(429).json({ok: false, error: 'Too many tries. Wait a few minutes.'});
  const a = auth.account(email);
  if (!a || !auth.verify(String(req.body?.password || ''), a.pass)) { auth.fail(key); auth.fail(req.ip + '|cust'); return res.status(401).json({ok: false, error: 'Email or password is wrong.'}); }
  auth.clear(key);
  run('UPDATE customer_accounts SET last_login = ? WHERE email = ?', Date.now(), email);
  run('UPDATE customers SET last_gid = ? WHERE email = ?', a.gid, email);
  setCookie(res, 'nv_cust', auth.createSession('customer', email), 30 * 86400);
  res.json({ok: true, profile: profile(a)});
}));
app.post('/api/account/logout', (req, res) => { auth.endSession(cookies(req.headers.cookie).nv_cust); setCookie(res, 'nv_cust', '', 0); res.json({ok: true}); });
app.get('/api/account/me', (req, res) => { const a = custOf(req.headers.cookie); res.json(a ? {ok: true, profile: profile(a)} : {ok: false}); });
app.post('/api/account/password', h(async (req, res) => {
  const a = custOf(req.headers.cookie); if (!a) return res.status(401).json({ok: false, error: 'Sign in first.'});
  if (!auth.verify(String(req.body?.current || ''), a.pass)) bad('Current password is wrong.');
  if (String(req.body?.next || '').length < 8) bad('New password needs at least 8 characters.');
  run('UPDATE customer_accounts SET pass = ? WHERE email = ?', auth.hash(req.body.next), a.email);
  res.json({ok: true});
}));
app.post('/api/act', (req, res) => {
  const {type, data, gid} = req.body || {};
  if (!validGid(gid)) return res.status(400).json({ok: false, error: 'Missing guest id. Reload the page.'});
  const ctx = {gid, staff: staffOf(req.headers.cookie)};
  const isStaffAct = Object.hasOwn(staffActs, type) || type === 'reset';
  if (isStaffAct && !ctx.staff) return res.status(401).json({ok: false, error: 'Staff login needed.'});
  if (!isStaffAct && !Object.hasOwn(guestActs, type)) return res.status(400).json({ok: false, error: 'Unknown action.'});
  try {
    if (type === 'reset') { seed(); ledgerTouched = true; } else tx(() => (staffActs[type] || guestActs[type])(data && typeof data === 'object' ? data : {}, ctx));
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ok: false, error: e.message});
    console.error(e); return res.status(500).json({ok: false, error: 'Server error. Try again.'});
  }
  broadcast();
  res.json({ok: true, state: view(ctx)});
});

/* ----- UPI payment portal ----- */
const guestOrder = (gid, oid) => { const id = rowId(oid, 'o'), o = get('SELECT * FROM orders WHERE id = ?', id); if (!o || o.guest !== gid) bad('That order was not found.'); return id; };
const gidOf = req => { const g = req.body?.gid; if (!validGid(g)) bad('Missing guest id. Reload the page.'); return g; };

app.post('/api/payments/upi/create', h(async (req, res) => {
  const gid = gidOf(req), d = req.body.data || {};
  guest(gid);
  const id = pay.createOrder({gid, cart: d.cart, table: d.table, reward: d.reward, name: d.name, email: d.email, tip: d.tip || null, pickup: d.pickup ?? null});
  broadcast();
  res.json({ok: true, checkout: await pay.checkout(id)});
}));
app.post('/api/payments/upi/open', h(async (req, res) => {
  const gid = gidOf(req), id = guestOrder(gid, req.body.data?.id);
  res.json({ok: true, checkout: await pay.checkout(id)});
}));
app.post('/api/payments/upi/utr', h(async (req, res) => {
  const gid = gidOf(req), id = guestOrder(gid, req.body.data?.id);
  const r = await pay.submitUtr(gid, id, req.body.data?.utr);
  res.json({ok: true, ...r, checkout: await pay.checkout(id)});
}));
app.post('/api/payments/upi/claim', h(async (req, res) => {
  const gid = gidOf(req), id = guestOrder(gid, req.body.data?.id);
  const r = pay.claimPaid(gid, id);
  res.json({ok: true, ...r, checkout: await pay.checkout(id)});
}));
// Gateway-style webhook (Razorpay/Cashfree pattern). Signed with WEBHOOK_SECRET, or unsigned in DEMO_MODE.
app.post('/api/payments/upi-webhook', h(async (req, res) => {
  const r = await pay.webhook({body: req.body || {}, raw: req.rawBody, signature: req.get('x-nivala-signature'), gid: validGid(req.body?.gid) ? req.body.gid : null, staff: isStaff(req.headers.cookie)});
  res.status(r.code).json(r.body);
}));
app.post('/api/staff/payments/approve', needStaff, h(async (req, res) => {
  const id = rowId(req.body?.id, 'o'), utr = String(req.body?.utr || '').trim() || null;
  const r = await pay.approve(id, utr);
  if (!r.duplicate) run('UPDATE orders SET approved_by = ? WHERE id = ?', staffOf(req.headers.cookie)?.name || null, id);
  res.json({ok: true, ...r});
}));
app.post('/api/staff/bills/resend', needStaff, h(async (req, res) => {
  const r = await pay.resendBill(rowId(req.body?.id, 'o')); broadcast();
  res.json({ok: r.status !== 'FAILED', status: r.status, error: r.error});
}));

/* ----- auto-verify: forwarded bank SMS / UPI notifications ----- */
function alertUrls() {
  if (!C.BANK_ALERT_TOKEN) return [];
  if (C.PUBLIC_URL) return [`${C.PUBLIC_URL}/api/payments/bank-alert?token=${encodeURIComponent(C.BANK_ALERT_TOKEN)}`];
  const hosts = ['localhost'];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) hosts.push(a.address);
  return hosts.map(h => `http://${h}:${server.address()?.port || PORT}/api/payments/bank-alert?token=${encodeURIComponent(C.BANK_ALERT_TOKEN)}`);
}
const alertText = b => typeof b === 'string' ? b
  : b && typeof b === 'object' ? [b.title, b.text ?? b.message ?? b.msg ?? b.body ?? b.content ?? b.sms ?? b.key].filter(v => typeof v === 'string' && v.trim()).join(' ') : '';
app.post('/api/payments/bank-alert', express.text({type: ['text/*'], limit: '20kb'}), express.urlencoded({extended: false, limit: '20kb'}), h(async (req, res) => {
  const given = String(req.query.token || req.get('x-nivala-token') || '');
  if (!C.BANK_ALERT_TOKEN) return res.status(403).json({ok: false, error: 'Bank alerts are switched off (set BANK_ALERT_TOKEN).'});
  if (!crypto.timingSafeEqual(sha(given), sha(C.BANK_ALERT_TOKEN))) return res.status(401).json({ok: false, error: 'Bad token.'});
  const r = bank.handleAlert(alertText(req.body), {source: String(req.body?.from || req.body?.sender || req.body?.app || 'sms'), confirm: (id, utr) => pay.confirmPayment(id, {utr, method: 'UPI_BANK_ALERT'})});
  console.log(`[bank-alert] ${r.status}${r.orderNo ? ' ORD' + r.orderNo : ''} ${r.parsed.amount != null ? '₹' + (r.parsed.amount / 100).toFixed(2) : ''} ${r.note || ''}`);
  broadcast();
  res.json({ok: true, status: r.status, order: r.orderNo ? 'ORD' + r.orderNo : null, note: r.note});
}));
app.post('/api/staff/bank-alert/test', needStaff, (req, res) => {
  const p = bank.parseAlert(String(req.body?.text || ''));
  const since = Date.now() - C.BANK_MATCH_WINDOW_MIN * 60000;
  const cands = p.amount ? all("SELECT id FROM orders WHERE total_paise = ? AND status IN ('PENDING_PAYMENT', 'VERIFYING_PAYMENT', 'EXPIRED') AND created > ?", p.amount, since) : [];
  res.json({ok: true, parsed: p, wouldMatch: p.kind === 'CREDIT' ? cands.map(o => 'ORD' + B.orderNo(o.id)) : []});
});

/* ----- bills (exact archived invoice HTML) ----- */
app.get('/api/bills/:billNo', (req, res) => {
  const b = get('SELECT b.*, o.guest, o.customer_email FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.bill_no = ?', String(req.params.billNo));
  if (!b || !(isStaff(req.headers.cookie) || (validGid(req.query.gid) && b.guest === req.query.gid) || custOf(req.headers.cookie)?.email === b.customer_email)) return res.status(404).send('Bill not found.');
  const bar = req.query.raw ? '' : `<div class="nvbar" style="position:sticky;top:0;z-index:5;display:flex;gap:8px;justify-content:center;padding:10px;background:#210100"><button onclick="print()" style="font:600 14px Arial;padding:10px 18px;border-radius:99px;border:0;background:#E6A341;color:#210100;cursor:pointer">Print / Save as PDF</button></div><style>@media print{.nvbar{display:none!important}}</style>`;
  res.set({'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:", 'X-Frame-Options': 'SAMEORIGIN'});
  res.send(b.html.replace(/<body([^>]*)>/, `<body$1>${bar}`));
});

/* ----- accounts directory ----- */
const filters = q => ({from: q.from, to: q.to, type: q.type, q: q.q});
app.get('/api/accounts/ledger', needAccounts, (req, res) => {
  const f = filters(req.query);
  res.json({ok: true, kpis: ledger.kpis(f), rows: ledger.list(f).map(r => ({...r, orderNo: r.order_id ? 'ORD' + B.orderNo(r.order_id) : null}))});
});
app.get('/api/accounts/ledger.csv', needAccounts, (req, res) => {
  res.set({'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="nivala-accounts-${new Date().toLocaleDateString('en-CA')}.csv"`});
  res.send(ledger.csv(filters(req.query)));
});

app.get('/api/health', (req, res) => {
  let dbOk = true; try { get('SELECT 1 AS x'); } catch (e) { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({ok: dbOk, uptime: Math.round(process.uptime()), db: dbOk, mail: mailConfigured, sockets: io.engine.clientsCount, time: new Date().toISOString()});
});
app.post('/api/donate/click', (req, res) => {
  const key = req.ip + '|donate';
  if (!auth.limited(key, 5, 3600e3)) { auth.fail(key, 3600e3); bump('donate_clicks', 1); }
  res.json({ok: true});
});
app.use('/api', (req, res) => res.status(404).json({ok: false, error: 'Not found.'}));

app.use('/uploads', express.static(UPLOADS, {maxAge: '7d'}));
app.use(express.static(path.join(__dirname, 'public'), {setHeaders(res, p) {
  if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');            // always the newest page
  else if (/[\\/](fonts|img)[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=604800'); // photos and fonts: a week
}}));
// Anything that slipped through (bad JSON, oversized body, a bug): answer in the same JSON shape the page expects.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' || err instanceof SyntaxError ? 400 : 500;
  if (code === 500) console.error(err);
  res.status(code).json({ok: false, error: code === 413 ? 'That is too large to send.' : code === 400 ? 'That request could not be read.' : 'Server error. Try again.'});
});

/* ---------------- realtime ---------------- */
io.use((socket, next) => {
  const gid = socket.handshake.auth?.gid;
  if (!validGid(gid)) return next(new Error('bad guest id'));
  socket.data.ctx = {gid, staff: staffOf(socket.handshake.headers.cookie)};
  next();
});
io.on('connection', socket => socket.emit('state', view(socket.data.ctx)));
const staffSockets = () => [...io.sockets.sockets.values()].filter(s => s.data.ctx.staff);
function broadcast() {
  soMemo.t = 0;
  for (const s of io.sockets.sockets.values()) s.emit('state', view(s.data.ctx));
  if (ledgerTouched) { ledgerTouched = false; for (const s of staffSockets()) s.emit('ledger'); }
}
pay.init({
  guest, addPts,
  broadcast: () => { ledgerTouched = true; broadcast(); },
  dispatched: o => { for (const s of staffSockets()) s.emit('order:dispatched', {id: 'o' + o.id, orderNo: B.orderNo(o.id), table: o.table_no, name: o.customer_name, billStatus: o.bill_status}); },
});
setInterval(() => { if (pay.expireOld()) broadcast(); }, 15000);
/* hourly tidy-up: expired sign-ins, used reset codes, old bank alerts, abandoned checkouts */
function tidy() {
  const now = Date.now();
  run('DELETE FROM sessions WHERE expires < ?', now);
  run('DELETE FROM password_resets WHERE created < ?', now - 864e5);
  run('DELETE FROM bank_alerts WHERE received < ?', now - 30 * 864e5);
  run("DELETE FROM orders WHERE status IN ('EXPIRED', 'CANCELLED') AND utr IS NULL AND created < ?", now - 7 * 864e5);
}
tidy(); setInterval(tidy, 3600e3).unref();
process.on('unhandledRejection', e => console.error('[server] unhandled:', e));
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Close the other Nivala window or set PORT in .env.` : e); process.exit(1); });
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (closing) return; closing = true; console.log('\nShutting down…');
  accrueSaved(); io.close(); server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(C.PUBLIC_URL ? `Nivala is running:  ${C.PUBLIC_URL}` : `Nivala is running:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`On the same Wi-Fi:    http://${a.address}:${PORT}`);
  console.log(`UPI payee: ${C.MERCHANT_UPI_ID} (${C.MERCHANT_NAME}) · demo mode ${C.DEMO_MODE ? 'ON' : 'off'} · email ${mailConfigured ? 'via ' + C.SMTP_USER : 'NOT configured (invoices saved to data/outbox)'}`);
  if (mailConfigured) verifyMail().then(r => console.log(r.ok ? `[mail] Gmail login OK. Invoices will be emailed from ${C.SMTP_USER}.` : `[mail] Gmail login FAILED: ${r.reason}${r.hint ? '\n[mail] ' + r.hint : ''}`));
  pay.resumeStuck();
});
