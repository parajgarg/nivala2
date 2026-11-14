'use strict';
// SQLite storage (built into Node). Creates tables, and migrates older databases in place.
const path = require('node:path'), fs = require('node:fs');
const {DatabaseSync} = require('node:sqlite');

const C = require('./config'); // loads .env first
const DATA = C.DATA_DIR ? path.resolve(C.DATA_DIR) : path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, {recursive: true});

// The project used to be called "nirvana": carry the old database file over once.
const FILE = path.join(DATA, 'nivala.db'), OLD = path.join(DATA, 'nirvana.db');
if (!fs.existsSync(FILE) && fs.existsSync(OLD)) {
  const tmp = new DatabaseSync(OLD); tmp.exec('PRAGMA wal_checkpoint(TRUNCATE)'); tmp.close();
  fs.renameSync(OLD, FILE);
  for (const s of ['-wal', '-shm']) fs.rmSync(OLD + s, {force: true});
}

const db = new DatabaseSync(FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS orders      (id INTEGER PRIMARY KEY, guest TEXT, table_no TEXT NOT NULL, items TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS queue       (id INTEGER PRIMARY KEY, guest TEXT, name TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reviews     (id INTEGER PRIMARY KEY, guest TEXT, who TEXT NOT NULL, scores TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, reply TEXT);
  CREATE TABLE IF NOT EXISTS photos      (id INTEGER PRIMARY KEY, guest TEXT, by TEXT NOT NULL, cap TEXT NOT NULL, em TEXT, c1 TEXT, c2 TEXT, src TEXT, likes INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, dims TEXT NOT NULL, n INTEGER NOT NULL, home INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS ratings     (guest TEXT NOT NULL, rest TEXT NOT NULL, scores TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (guest, rest));
  CREATE TABLE IF NOT EXISTS guests      (id TEXT PRIMARY KEY, points INTEGER NOT NULL, life INTEGER NOT NULL, hist TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wishes      (guest TEXT PRIMARY KEY, board TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta        (k TEXT PRIMARY KEY, v INTEGER NOT NULL);

  -- customers are identified by email; visit_count drives the loyalty discount
  CREATE TABLE IF NOT EXISTS customers   (email TEXT PRIMARY KEY, name TEXT NOT NULL, visit_count INTEGER NOT NULL DEFAULT 0, last_gid TEXT, created INTEGER NOT NULL, last_visit INTEGER);

  -- inventory: FEFO batches + recipes
  CREATE TABLE IF NOT EXISTS ingredients (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, std_cost REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS batches     (id INTEGER PRIMARY KEY, ingredient TEXT NOT NULL REFERENCES ingredients(id), qty_received REAL NOT NULL, qty_left REAL NOT NULL, cost_per_unit REAL NOT NULL, received INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS recipes     (dish TEXT NOT NULL, ingredient TEXT NOT NULL REFERENCES ingredients(id), qty REAL NOT NULL, PRIMARY KEY (dish, ingredient));
  CREATE TABLE IF NOT EXISTS stock_moves (id INTEGER PRIMARY KEY, batch INTEGER NOT NULL, ingredient TEXT NOT NULL, order_id INTEGER, qty REAL NOT NULL, cost_paise INTEGER NOT NULL, kind TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL);

  -- accounts directory
  CREATE TABLE IF NOT EXISTS accounts_ledger (
    id INTEGER PRIMARY KEY, created INTEGER NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('CREDIT','DEBIT','LIABILITY')),
    account TEXT NOT NULL CHECK (account IN ('SALES_REVENUE','LOYALTY_DISCOUNT','GST_COLLECTED','COGS','WASTAGE_LOSS','TIPS_PAYABLE')),
    contra TEXT NOT NULL, amount_paise INTEGER NOT NULL, profit_paise INTEGER NOT NULL,
    order_id INTEGER, bill_no TEXT, utr TEXT, customer_email TEXT, memo TEXT);
  CREATE INDEX IF NOT EXISTS ledger_created ON accounts_ledger (created);
  CREATE INDEX IF NOT EXISTS ledger_order ON accounts_ledger (order_id);

  -- every forwarded bank SMS / UPI notification, and what it matched
  CREATE TABLE IF NOT EXISTS bank_alerts (id INTEGER PRIMARY KEY, received INTEGER NOT NULL, source TEXT, raw TEXT NOT NULL,
    kind TEXT NOT NULL, amount_paise INTEGER, ref TEXT, payer TEXT, status TEXT NOT NULL, order_id INTEGER, note TEXT);
  CREATE INDEX IF NOT EXISTS bank_alerts_ref ON bank_alerts (ref);

  -- logins: frequent-customer accounts, individual staff, and sessions for both (token stored hashed)
  CREATE TABLE IF NOT EXISTS customer_accounts (email TEXT PRIMARY KEY, name TEXT NOT NULL, pass TEXT NOT NULL, gid TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, last_login INTEGER);
  CREATE TABLE IF NOT EXISTS staff_users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL CHECK (role IN ('manager','staff')), pin TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('staff','customer')), subject TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, accounts_until INTEGER);

  -- emailed one-time codes for "forgot password" (code stored hashed; only the newest unused one works)
  CREATE TABLE IF NOT EXISTS password_resets (id INTEGER PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS password_resets_email ON password_resets (email, id);

  -- exact HTML of every invoice that was emailed (audit archive)
  CREATE TABLE IF NOT EXISTS bills (order_id INTEGER PRIMARY KEY, bill_no TEXT NOT NULL UNIQUE, html TEXT NOT NULL, created INTEGER NOT NULL);
`);

// Columns added to orders for payments. ALTER only what is missing, so old databases upgrade in place.
const ORDER_COLS = {
  customer_name: 'TEXT', customer_email: 'TEXT', reward: 'TEXT',
  visit_no: 'INTEGER', loyalty_tier: 'TEXT', loyalty_pct: 'REAL',
  subtotal_paise: 'INTEGER', discount_paise: 'INTEGER', taxable_paise: 'INTEGER',
  cgst_paise: 'INTEGER', sgst_paise: 'INTEGER', roundoff_paise: 'INTEGER NOT NULL DEFAULT 0', tip_paise: 'INTEGER NOT NULL DEFAULT 0', total_paise: 'INTEGER',
  upi_uri: 'TEXT', expires_at: 'INTEGER', utr: 'TEXT', pay_method: 'TEXT', paid_at: 'INTEGER',
  cogs_paise: 'INTEGER', bill_no: 'TEXT', bill_status: 'TEXT', bill_sent: 'INTEGER NOT NULL DEFAULT 0', bill_sent_at: 'INTEGER', bill_error: 'TEXT',
  dispatched_at: 'INTEGER', ready_at: 'INTEGER', served_at: 'INTEGER', approved_by: 'TEXT', stations: 'TEXT', pickup_at: 'INTEGER',
};
const have = new Set(db.prepare('PRAGMA table_info(orders)').all().map(c => c.name));
for (const [c, t] of Object.entries(ORDER_COLS)) if (!have.has(c)) db.exec(`ALTER TABLE orders ADD COLUMN ${c} ${t}`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_utr ON orders (utr) WHERE utr IS NOT NULL");

// Older ledgers only allowed five accounts. SQLite cannot edit a CHECK, so rebuild the table once, keeping every row.
const ledgerSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts_ledger'").get()?.sql || '';
if (ledgerSql && !ledgerSql.includes('TIPS_PAYABLE')) {
  db.exec(`BEGIN;
    ALTER TABLE accounts_ledger RENAME TO accounts_ledger_old;
    CREATE TABLE accounts_ledger (
      id INTEGER PRIMARY KEY, created INTEGER NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('CREDIT','DEBIT','LIABILITY')),
      account TEXT NOT NULL CHECK (account IN ('SALES_REVENUE','LOYALTY_DISCOUNT','GST_COLLECTED','COGS','WASTAGE_LOSS','TIPS_PAYABLE')),
      contra TEXT NOT NULL, amount_paise INTEGER NOT NULL, profit_paise INTEGER NOT NULL,
      order_id INTEGER, bill_no TEXT, utr TEXT, customer_email TEXT, memo TEXT);
    INSERT INTO accounts_ledger SELECT * FROM accounts_ledger_old;
    DROP TABLE accounts_ledger_old;
    CREATE INDEX IF NOT EXISTS ledger_created ON accounts_ledger (created);
    CREATE INDEX IF NOT EXISTS ledger_order ON accounts_ledger (order_id);
  COMMIT;`);
  console.log('[db] accounts_ledger upgraded for tips');
}

// Photo wall: remember each photo's shape so polaroids never crop it.
if (!db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === 'ar')) db.exec('ALTER TABLE photos ADD COLUMN ar REAL');

// Each guest's friends circle lives on the server, so it follows their account across devices.
if (!db.prepare('PRAGMA table_info(guests)').all().some(c => c.name === 'circle')) db.exec('ALTER TABLE guests ADD COLUMN circle TEXT');

// Old rows: kitchen status 'new' is now RECEIVED_BY_STAFF; home restaurant id renamed.
db.exec("UPDATE orders SET status = 'RECEIVED_BY_STAFF' WHERE status = 'new'");
db.exec("UPDATE restaurants SET id = 'nivala' WHERE id = 'nirvana'");
db.exec("UPDATE ratings SET rest = 'nivala' WHERE rest = 'nirvana'");

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
let depth = 0;
/** Run fn in one transaction (nested calls join the outer one). */
const tx = fn => {
  if (depth) return fn();
  db.exec('BEGIN IMMEDIATE'); depth++;
  try { const r = fn(); depth--; db.exec('COMMIT'); return r; } catch (e) { depth--; db.exec('ROLLBACK'); throw e; }
};

module.exports = {db, all, get, run, tx, DATA};
