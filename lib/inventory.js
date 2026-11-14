'use strict';
// Ingredient stock in batches. Orders consume stock FEFO (First Expired, First Out) and the order's
// COGS is frozen at each batch's purchase cost. Staff write-offs are costed the same way.
const {all, get, run, tx} = require('./db');

// id: [name, unit, standard cost in paise per unit]
const INGREDIENTS = {
  chicken: ['Chicken', 'g', 28], paneer: ['Paneer', 'g', 36], butter: ['Butter', 'g', 55], cream: ['Fresh cream', 'ml', 20],
  lentils: ['Lentils', 'g', 12], flour: ['Flour (maida/atta)', 'g', 4], rice: ['Basmati rice', 'g', 9], mutton: ['Mutton', 'g', 60],
  potato: ['Potato', 'g', 3], milk: ['Milk', 'ml', 6], sugar: ['Sugar', 'g', 4.5], spices: ['Spice mix', 'g', 60],
  oil: ['Cooking oil', 'ml', 14], veg: ['Mixed vegetables', 'g', 5], coffee: ['Coffee powder', 'g', 100], curd: ['Curd', 'g', 8],
  batter: ['Dosa/idli batter', 'g', 6], noodles: ['Noodles', 'g', 10],
};
// dish id -> {ingredient: qty per plate}
const RECIPES = {
  bc: {chicken: 200, butter: 30, cream: 40, spices: 10}, pt: {paneer: 180, curd: 40, spices: 8, oil: 15},
  dm: {lentils: 120, butter: 20, cream: 30, spices: 6}, gn: {flour: 90, butter: 10}, rj: {mutton: 220, curd: 50, spices: 12, oil: 20},
  md: {batter: 200, potato: 120, oil: 15}, is: {batter: 160, lentils: 40, veg: 50}, mv: {lentils: 120, oil: 30},
  fc: {coffee: 12, milk: 120, sugar: 10}, bi: {rice: 180, chicken: 160, spices: 12, oil: 20},
  hk: {noodles: 150, veg: 120, oil: 20}, mn: {veg: 180, flour: 40, oil: 30}, mo: {flour: 100, veg: 100},
  pb: {potato: 150, veg: 120, butter: 25, flour: 80}, ch: {flour: 50, curd: 80, potato: 60},
  gj: {milk: 150, sugar: 50, oil: 20}, ku: {milk: 250, sugar: 30}, rm: {milk: 300, sugar: 40},
};
const REASONS = ['EXPIRED', 'SPOILED', 'DAMAGED'];
const DAY = 864e5;

function seedInventory(now = Date.now()) {
  for (const t of ['stock_moves', 'batches', 'recipes', 'ingredients']) run('DELETE FROM ' + t);
  for (const [id, [name, unit, cost]] of Object.entries(INGREDIENTS)) {
    run('INSERT INTO ingredients (id, name, unit, std_cost) VALUES (?, ?, ?, ?)', id, name, unit, cost);
    // older, cheaper batch that expires soon + newer, pricier batch -> FEFO uses the old one first
    addBatch(id, 6000, +(cost * 0.95).toFixed(2), now + 2 * DAY, now - 3 * DAY);
    addBatch(id, 8000, +(cost * 1.05).toFixed(2), now + 10 * DAY, now - DAY);
  }
  // already-expired stock so "Write off expired" has something real to do in the demo
  addBatch('cream', 800, 19, now - DAY, now - 6 * DAY);
  addBatch('paneer', 600, 34, now - 2 * DAY, now - 7 * DAY);
  for (const [dish, r] of Object.entries(RECIPES)) for (const [ing, q] of Object.entries(r)) run('INSERT INTO recipes (dish, ingredient, qty) VALUES (?, ?, ?)', dish, ing, q);
}
function addBatch(ingredient, qty, cost, expires, received = Date.now()) {
  return run('INSERT INTO batches (ingredient, qty_received, qty_left, cost_per_unit, received, expires) VALUES (?, ?, ?, ?, ?, ?)', ingredient, qty, qty, cost, received, expires).lastInsertRowid;
}

/** Ingredient quantities an order needs. */
function needs(items) {
  const need = {};
  for (const [dish, q] of Object.entries(items)) for (const r of all('SELECT ingredient, qty FROM recipes WHERE dish = ?', dish)) need[r.ingredient] = (need[r.ingredient] || 0) + r.qty * q;
  return need;
}
const usable = (ing, now) => all('SELECT * FROM batches WHERE ingredient = ? AND qty_left > 0 AND expires > ? ORDER BY expires, id', ing, now);

/** Dishes we cannot cook right now (not enough unexpired stock). */
function shortages(items, now = Date.now()) {
  const out = [];
  for (const [ing, q] of Object.entries(needs(items))) {
    const have = usable(ing, now).reduce((a, b) => a + b.qty_left, 0);
    if (have < q) out.push(get('SELECT name FROM ingredients WHERE id = ?', ing)?.name || ing);
  }
  return out;
}

/** Deduct stock FEFO for a paid order. Returns frozen COGS in paise. Must run inside the payment transaction. */
function consumeForOrder(orderId, items, now = Date.now()) {
  let cogs = 0;
  for (const [ing, want] of Object.entries(needs(items))) {
    let left = want;
    for (const b of usable(ing, now)) {
      if (left <= 0) break;
      const take = Math.min(left, b.qty_left), cost = take * b.cost_per_unit;
      run('UPDATE batches SET qty_left = qty_left - ? WHERE id = ?', take, b.id);
      run('INSERT INTO stock_moves (batch, ingredient, order_id, qty, cost_paise, kind, created) VALUES (?, ?, ?, ?, ?, ?, ?)', b.id, ing, orderId, take, Math.round(cost), 'CONSUME', now);
      cogs += cost; left -= take;
    }
    if (left > 0) { // paid already, so we still cook; cost the shortfall at standard cost and flag it
      const std = get('SELECT std_cost FROM ingredients WHERE id = ?', ing).std_cost;
      run('INSERT INTO stock_moves (batch, ingredient, order_id, qty, cost_paise, kind, reason, created) VALUES (0, ?, ?, ?, ?, ?, ?, ?)', ing, orderId, left, Math.round(left * std), 'CONSUME', 'SHORTFALL_AT_STD_COST', now);
      cogs += left * std;
    }
  }
  return Math.round(cogs);
}

/** Write off part of a batch. Returns {lossPaise, ingredient, name, qty}. */
function writeOff(batchId, qty, reason, now = Date.now()) {
  const b = get('SELECT b.*, i.name, i.unit FROM batches b JOIN ingredients i ON i.id = b.ingredient WHERE b.id = ?', batchId);
  if (!b) throw new Error('NO_BATCH');
  const q = Math.min(qty, b.qty_left), loss = Math.round(q * b.cost_per_unit);
  run('UPDATE batches SET qty_left = qty_left - ? WHERE id = ?', q, b.id);
  run('INSERT INTO stock_moves (batch, ingredient, qty, cost_paise, kind, reason, created) VALUES (?, ?, ?, ?, ?, ?, ?)', b.id, b.ingredient, q, loss, 'WASTAGE', reason, now);
  return {lossPaise: loss, batch: b.id, ingredient: b.ingredient, name: b.name, unit: b.unit, qty: q, cost: b.cost_per_unit};
}

function stockView(now = Date.now()) {
  return all('SELECT b.*, i.name, i.unit FROM batches b JOIN ingredients i ON i.id = b.ingredient WHERE b.qty_left > 0 ORDER BY i.name, b.expires')
    .map(b => ({id: b.id, ing: b.ingredient, name: b.name, unit: b.unit, left: Math.round(b.qty_left * 10) / 10, recv: b.qty_received, cost: b.cost_per_unit, expires: b.expires, expired: b.expires <= now}));
}
const ingredientList = () => all('SELECT id, name, unit, std_cost FROM ingredients ORDER BY name');

module.exports = {seedInventory, addBatch, shortages, consumeForOrder, writeOff, stockView, ingredientList, REASONS, INGREDIENTS};
