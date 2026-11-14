'use strict';
// Logins for frequent customers (email + password) and staff (name + personal PIN), plus the
// separate Accounts-Directory PIN. Passwords/PINs are scrypt-hashed; session tokens are stored hashed,
// so sessions survive a server restart and a leaked database does not reveal live tokens.
const crypto = require('node:crypto');
const C = require('./config');
const {all, get, run} = require('./db');

/* ---------- hashing ---------- */
function hash(secret) {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('hex') + '$' + crypto.scryptSync(String(secret), salt, 64).toString('hex');
}
function verify(secret, stored) {
  const [v, salt, h] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !h) return false;
  const a = crypto.scryptSync(String(secret), Buffer.from(salt, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

/* ---------- wrong-guess limits (per key, e.g. IP + account) ---------- */
const tries = new Map();
function limited(key, max = 8, windowMs = 5 * 60000) {
  const t = tries.get(key), now = Date.now();
  return !!(t && t.until > now && t.n >= max);
}
function fail(key, windowMs = 5 * 60000) {
  const t = tries.get(key), now = Date.now();
  tries.set(key, {n: t && t.until > now ? t.n + 1 : 1, until: now + windowMs});
}
const clear = key => tries.delete(key);

/* ---------- sessions ---------- */
const DAY = 864e5, TTL = {staff: 12 * 3600e3, customer: 30 * DAY};
const tokHash = t => sha(t).toString('hex');
function createSession(kind, subject) {
  const token = crypto.randomBytes(24).toString('hex'), now = Date.now();
  run('DELETE FROM sessions WHERE expires < ?', now);
  run('INSERT INTO sessions (token, kind, subject, created, expires) VALUES (?, ?, ?, ?, ?)', tokHash(token), kind, String(subject), now, now + TTL[kind]);
  return token;
}
const getSession = (kind, token) => token ? get('SELECT * FROM sessions WHERE token = ? AND kind = ? AND expires > ?', tokHash(token), kind, Date.now()) : null;
const endSession = token => token && run('DELETE FROM sessions WHERE token = ?', tokHash(token));

/* ---------- staff ---------- */
function seedStaff() {
  if (get('SELECT 1 AS x FROM staff_users LIMIT 1')) return;
  const now = Date.now();
  // Manager gets STAFF_PIN; two demo team members show how individual logins look
  for (const [name, role, pin] of [['Manager', 'manager', C.STAFF_PIN], ['Chef Ravi', 'staff', '1111'], ['Anita (floor)', 'staff', '2222']])
    run('INSERT INTO staff_users (name, role, pin, created) VALUES (?, ?, ?, ?)', name, role, hash(pin), now);
}
const staffList = () => all("SELECT id, name, role FROM staff_users WHERE active = 1 ORDER BY role = 'manager' DESC, name");
const teamList = () => all("SELECT id, name, role, active, created FROM staff_users ORDER BY active DESC, role = 'manager' DESC, name");
/** @returns staff user (with session fields) for a cookie token, or null */
function staffFromToken(token) {
  const s = getSession('staff', token); if (!s) return null;
  const u = get('SELECT id, name, role FROM staff_users WHERE id = ? AND active = 1', +s.subject);
  return u ? {...u, token, accountsUntil: s.accounts_until || 0} : null;
}
function staffLogin(id, pin) {
  const u = get('SELECT * FROM staff_users WHERE id = ? AND active = 1', +id);
  return u && verify(pin, u.pin) ? {id: u.id, name: u.name, role: u.role} : null;
}
/** Accounts Directory unlock: separate PIN, valid 30 minutes, sliding while used. */
const ACC_MS = 30 * 60000;
function unlockAccounts(token, pin) {
  if (!safeEq(String(pin), C.ACCOUNTS_PIN)) return false;
  run('UPDATE sessions SET accounts_until = ? WHERE token = ?', Date.now() + ACC_MS, tokHash(token));
  return true;
}
const lockAccounts = token => run('UPDATE sessions SET accounts_until = NULL WHERE token = ?', tokHash(token));
const touchAccounts = token => run('UPDATE sessions SET accounts_until = ? WHERE token = ? AND accounts_until > ?', Date.now() + ACC_MS, tokHash(token), Date.now());

/* ---------- customers ---------- */
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const account = email => get('SELECT * FROM customer_accounts WHERE email = ?', String(email || '').toLowerCase());
const accountByGid = gid => get('SELECT * FROM customer_accounts WHERE gid = ?', gid);
const customerFromToken = token => { const s = getSession('customer', token); return s ? account(s.subject) : null; };

module.exports = {hash, verify, limited, fail, clear, createSession, getSession, endSession,
  seedStaff, staffList, teamList, staffFromToken, staffLogin, unlockAccounts, lockAccounts, touchAccounts,
  EMAIL_RE, account, accountByGid, customerFromToken};
