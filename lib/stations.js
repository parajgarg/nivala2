'use strict';
// Multi-station kitchen: one guest order is split into one ticket per kitchen station.
// Each station gets a staggered start time (fireAt) so every part is ready at the same moment
// (dueAt). For a takeaway with a later pickup time, dueAt is the pickup time.
const {NV} = require('../public/shared.js');
const BY_ID = Object.fromEntries(NV.STATIONS.map(s => [s.id, s]));

/**
 * @param items    {dishId: qty}
 * @param now      ms when the order reaches the kitchen
 * @param pickupAt ms pickup time for takeaway (optional)
 * @param status   order status, so seeded/legacy orders get a matching plan
 */
function plan(items, now, pickupAt = null, status = 'RECEIVED_BY_STAFF') {
  const parts = {};
  for (const [id, q] of Object.entries(items)) (parts[NV.stationOf(id)] ||= []).push([id, q]);
  const ids = Object.keys(parts);
  if (!ids.length) return {};
  const longest = Math.max(...ids.map(i => BY_ID[i].prep));
  const dueAt = Math.max(now + longest * 60000, pickupAt || 0);
  const st = status === 'ready' || status === 'served' ? 'ready' : status === 'cooking' ? 'cooking' : 'queued';
  return Object.fromEntries(NV.STATIONS.filter(s => parts[s.id]).map(s => [s.id, {
    items: parts[s.id], status: st, fireAt: dueAt - s.prep * 60000, dueAt,
    startedAt: st === 'queued' ? null : now, readyAt: st === 'ready' ? now : null,
  }]));
}

/** Order status implied by its station tickets. */
function statusOf(sts) {
  const all = Object.values(sts);
  return all.length && all.every(p => p.status === 'ready') ? 'ready' : all.some(p => p.status !== 'queued') ? 'cooking' : 'RECEIVED_BY_STAFF';
}

module.exports = {plan, statusOf};
