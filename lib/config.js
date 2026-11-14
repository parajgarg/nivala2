'use strict';
// All settings come from environment variables (or a .env file next to server.js). See .env.example.
const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { /* no .env file: use real env vars / defaults */ }

const env = (k, d) => (process.env[k] ?? '').trim() || d;
const flag = (k, d) => /^(1|true|yes|on)$/i.test(env(k, d ? 'true' : 'false'));

module.exports = {
  PORT: +env('PORT', '3000'),
  // Hosting. Render sets RENDER=true automatically; TRUST_PROXY=true does the same on other hosts.
  BEHIND_PROXY: flag('TRUST_PROXY', !!process.env.RENDER),
  PUBLIC_URL: env('PUBLIC_URL', process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''), // e.g. https://nivala.onrender.com
  DATA_DIR: env('DATA_DIR', ''),                                                         // e.g. /var/data on a persistent disk
  STAFF_PIN: env('STAFF_PIN', '1234'),        // first Manager's PIN when the staff list is created
  ACCOUNTS_PIN: env('ACCOUNTS_PIN', '2468'),  // second PIN that unlocks the Accounts Directory
  DEMO_MODE: flag('DEMO_MODE', true),

  // UPI (NPCI deep link). Any personal/merchant VPA works; no gateway or KYC needed.
  MERCHANT_UPI_ID: env('MERCHANT_UPI_ID', 'mycollegeproject@okicici'),
  MERCHANT_NAME: env('MERCHANT_NAME', 'Nivala'),
  PAYMENT_WINDOW_MIN: +env('PAYMENT_WINDOW_MIN', '10'),
  UTR_AUTO_CONFIRM: flag('UTR_AUTO_CONFIRM', false), // true: a well-formed 12-digit UTR confirms at once
  WEBHOOK_SECRET: env('WEBHOOK_SECRET', ''),          // set it to require HMAC-signed webhooks
  // Auto-verify: your phone forwards "credited" bank SMS / UPI notifications to /api/payments/bank-alert?token=...
  BANK_ALERT_TOKEN: env('BANK_ALERT_TOKEN', ''),      // empty = endpoint switched off
  BANK_MATCH_WINDOW_MIN: +env('BANK_MATCH_WINDOW_MIN', '90'), // how old an order can be and still match a credit

  // Invoice header
  RESTAURANT_NAME: env('RESTAURANT_NAME', 'Nivala'),
  RESTAURANT_ADDRESS: env('RESTAURANT_ADDRESS', '12, Lake Road · Open 8 am – 11 pm'),
  RESTAURANT_GSTIN: env('RESTAURANT_GSTIN', '07AABCN1234D1Z5 (demo)'),
  RESTAURANT_PHONE: env('RESTAURANT_PHONE', '+91 98765 43210'),

  // Email (Gmail SMTP + App Password is free). Missing -> invoices are saved as HTML previews instead.
  SMTP_HOST: env('SMTP_HOST', 'smtp.gmail.com'),
  SMTP_PORT: +env('SMTP_PORT', '465'),
  SMTP_USER: env('SMTP_USER', ''),
  SMTP_PASS: env('SMTP_PASS', '').replace(/\s+/g, ''), // Gmail shows app passwords with spaces
  MAIL_FROM_NAME: env('MAIL_FROM_NAME', 'Nivala Billing'),
};
