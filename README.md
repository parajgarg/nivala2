# Nivala · निवाला

*Nivala* means a morsel: the bite someone feeds you with their own hand.
A restaurant web app where nothing stands between a guest and that bite: order from the table or for takeaway, pay by UPI, get an emailed GST invoice, and watch a multi-station kitchen finish every part of the order together.

**Stack:** Node.js 22.13+ · Express 5 · Socket.IO (live updates) · SQLite built into Node (`node:sqlite`) · Nodemailer · one-page HTML/CSS/JS front end. No paid services.

---

## What it does

**Guests**
- Menu with real photos, a swipeable "Loved dishes" showcase, cuisine filters
- Dine-in (pick a table) or **Takeaway** (pick ASAP / 15 / 30 / 45 min pickup, get a token)
- One cart, one **UPI** payment (QR + "Open UPI app"), optional tip
- Payment confirmed by forwarded bank SMS (automatic), "I've paid" + staff check, UTR, or the demo button
- **Official GST tax invoice** emailed before the food is cooked; viewable and printable any time
- Live order tracker showing each kitchen station's progress
- Virtual queue with live wait estimate, loyalty tiers by visit count, points and rewards
- Accounts: sign up, sign in, forgot password by emailed 6-digit code, welcome email, invoice history
- Nivala Stars crowd ratings, friends circle, cozy photo wall, mock-menu price wishes
- Colour-blind-safe palette switch; floating "Donate to feed hunger" link (Lagos Food Bank, Nigeria)

**Kitchen: one order, many stations**
1. **One customer experience.** One cart, one payment, one token or tracker.
2. **Automatic station routing.** Each dish goes to its station: Tandoor & Handi, Dosa Tawa, Wok, Chaat Counter, Sweets & Drinks.
3. **A display per station.** Each station's screen shows only its own items, with Start and Ready buttons.
4. **Synchronised completion.** The slowest station fires first and quicker ones hold, so every part is ready at the same moment (or exactly at the takeaway pickup time). The **Pass & pickup** screen only allows hand-over when every station is ✓.

**Staff portal** (individual name + PIN logins)
- Orders (all, per station, pass), UPI approvals, queue, reviews and price wishes
- FEFO stock with wastage write-offs; Team management (managers)
- **Accounts Directory** behind a second PIN: sales, discounts, GST, tips, COGS, wastage, true net profit, searchable ledger, every bill archived, CSV export
- Auto-verify tab for the bank-SMS forwarding link

---

## Run it on a laptop

Needs **Node.js 22.13 or newer** (https://nodejs.org).

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env   (then fill it in, see Settings)
npm start                 # open http://localhost:3000
```

Windows PowerShell blocking `npm`? Use `npm.cmd install` and `npm.cmd start`.
The first start creates `data/` with demo data (menu, orders, reviews, stock, staff). Nothing else to set up.

Phones on the same Wi-Fi can open the "On the same Wi-Fi" address printed at start-up.

---

## Deploy: GitHub + Render

1. **Push to GitHub.** Unzip, then in the folder:
   ```bash
   git init
   git add .
   git commit -m "Nivala"
   git branch -M main
   git remote add origin https://github.com/<you>/nivala.git
   git push -u origin main
   ```
   `.gitignore` keeps `.env` (your passwords), `data/` and `node_modules/` out of GitHub.

2. **Create the service on Render.** https://render.com → **New → Blueprint** → choose the repo. Render reads `render.yaml`, then asks for the secret values:
   - `MERCHANT_UPI_ID`, `MERCHANT_NAME`: your UPI ID and the name on it
   - `STAFF_PIN`, `ACCOUNTS_PIN`: pick your own
   - `SMTP_USER`, `SMTP_PASS`: Gmail address and App Password (optional)

   (Or **New → Web Service**: Build `npm ci`, Start `npm start`, and add the same environment variables.)

3. Open `https://<your-service>.onrender.com`. Check `/api/health` says `"ok": true`.

**Good to know on Render's free plan**
- The service **sleeps after ~15 minutes** with no visitors; the first visit then takes about a minute to wake.
- Its disk is **reset on every restart or redeploy**, so orders, accounts and pinned photos go back to the demo data. For a demo that's fine (it's always clean). To keep data, use a paid instance with a persistent disk and set `DATA_DIR` (see `render.yaml`).
- Render may block outgoing email on free services. If so, invoices are still created and viewable in the app ("bill saved"); only the email step is skipped.

---

## Before the judges (checklist)

- [ ] Open the site **2-3 minutes early** (wakes the free server) and keep the tab open.
- [ ] Staff → **Reset demo** for a clean board (optional).
- [ ] Two windows side by side: **guest** (normal tab) and **staff** (private/incognito tab, so the two logins don't mix).
- [ ] Phone ready with a UPI app if you want to scan the real QR.
- [ ] `DEMO_MODE=true` so the "Simulate Instant UPI Webhook" button is available.

## 5-minute demo script

1. **The idea (20 s).** "Nivala means the bite fed by hand. We remove the counter, the queue and the bill wait."
2. **Order (60 s).** Guest window: menu → add Butter Chicken, Masala Dosa, Gulab Jamun → cart → **Takeaway, ASAP** → name + email → **Pay via UPI**. Show the QR with the exact amount. (With "In 30 min", every station would hold until its slot so all finish at pickup; ASAP shows the staggering live.)
3. **Pay (30 s).** Tap **Simulate Instant UPI Webhook** (or pay ₹ for real and let the SMS forwarder confirm it). The tracker turns to "with the kitchen"; the tax invoice is emailed and opens with **View / download invoice**.
4. **Kitchen (90 s).** Staff window (Chef Ravi · 1111) → Orders → **🔥 Tandoor**: only the curry, *FIRE NOW*. **🍨 Sweets**: only the dessert, *HOLD · start in 9:00*, because it's quicker. Press Start / Ready on each. Open **🧺 Pass & pickup**: hand-over unlocks only when every station is ✓. Guest window shows each station ticking off, then "ready for pickup".
5. **Money (45 s).** Manager (1234) → **Accounts** → PIN 2468: sales, GST kept separate, tip as staff liability, COGS from FEFO stock, true profit; click a row to open the exact bill; Export CSV.
6. **Close (15 s).** Colour-safe switch, Donate pop-up (*annadānam mahādānam*). "All free to run: Node, SQLite, UPI, Gmail."

Default logins: Manager **1234**, Chef Ravi **1111**, Anita **2222**, Accounts PIN **2468** (change them before going public).

---

## Settings (`.env` locally, Environment on Render)

| Setting | What it does |
|---|---|
| `MERCHANT_UPI_ID`, `MERCHANT_NAME` | UPI ID and name the checkout QR pays |
| `SMTP_USER`, `SMTP_PASS` | Gmail + 16-letter App Password for invoices and account emails (empty = saved as previews in `data/outbox/`) |
| `BANK_ALERT_TOKEN` | Secret for auto-verifying payments from forwarded bank SMS (empty = off) |
| `DEMO_MODE` | `true` shows "Simulate Instant UPI Webhook" |
| `UTR_AUTO_CONFIRM` | `true` = a valid 12-digit UTR confirms instantly |
| `STAFF_PIN` / `ACCOUNTS_PIN` | First Manager PIN / Accounts Directory PIN |
| `PUBLIC_URL` | Public address for the bank-alert link (automatic on Render) |
| `DATA_DIR` | Where the database and uploads live (default `./data`) |
| `TRUST_PROXY` | Behind a proxy host (automatic on Render) |
| `PORT` | Server port (Render sets it) |

Test email locally: `npm run test-mail -- you@example.com`

## How a payment flows

1. Guest pays by UPI QR (amount unique to the paisa among open orders, so a bank credit identifies exactly one order).
2. Confirmed by forwarded bank SMS, "I've paid" / UTR + staff approval, or the demo webhook.
3. In one go: order PAID → visit count +1 → stock deducted FEFO, COGS fixed → ledger entries → GST invoice emailed → order split into station tickets and sent to the kitchen.

## Files

- `server.js`: routes, live updates, demo data, housekeeping
- `lib/payments.js`: UPI checkout and the confirmation pipeline · `lib/stations.js`: station routing and timed firing
- `lib/bankalerts.js`: bank SMS parser and matching · `lib/billing.js`: invoice HTML, UPI link
- `lib/mailer.js` + `lib/emails.js`: Gmail sending, welcome and reset-code emails
- `lib/inventory.js`: recipes, FEFO stock, wastage · `lib/ledger.js`: accounts and CSV
- `lib/auth.js`: customer accounts, staff logins, Accounts PIN, sessions
- `lib/db.js`: SQLite tables and in-place upgrades · `lib/config.js`: settings
- `public/index.html`: the whole front end · `public/shared.js`: menu, tiers, bill maths, stations
- `render.yaml`, `.node-version`: deployment · `scripts/test-mail.js`: email check

**Credits:** Teko font (SIL Open Font License). Menu photos from Unsplash and Pexels, cozy-wall photos from Pexels (Yan Krukau, Ketut Subiyanto, Anna Pou, Golboo Maghooli), donate photo by John Onaeko on Unsplash; details in each `credits.json`. Donations go directly to Lagos Food Bank Initiative; Nivala never handles them.
