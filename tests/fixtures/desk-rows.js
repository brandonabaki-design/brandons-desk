'use strict';
/**
 * Desk tab fixtures (docs/DESK.md section 1). All content is fictional.
 *
 * deskData()                 a fresh copy of tests/fixtures/desk-data.json (a full `desk-data` object
 *                            as the morning build publishes it; "today" in it is Tue 2026-10-13).
 * deskRows(data, built, o)   the [Key, JSON, Built] rows the routine writes for `data`: `meta` first,
 *                            then strip, items (split by whole items into items, items2, … so that no
 *                            JSON cell reaches o.maxChars, default 45 000), cleared, priorities, coming,
 *                            agenda, llt, quick. Built defaults to DESK_BUILT.
 * splitItems(items, max)     the item arrays deskRows writes, one per row.
 * seedDesk(sb, data, built, o)  appends those rows to the mock's Desk tab.
 */
const fs = require('node:fs');
const path = require('node:path');

const DESK_BUILT = '2026-10-13 06:45';
const META_KEYS = ['built', 'eyebrow', 'sources', 'lanes', 'rebuild'];
const FIELDS = ['strip', 'items', 'cleared', 'priorities', 'coming', 'agenda', 'llt', 'quick'];
const MAX_CHARS = 45000;

function deskData() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'desk-data.json'), 'utf8'));
}

function splitItems(items, maxChars) {
  const limit = maxChars || MAX_CHARS;
  const parts = [];
  let current = [];
  (items || []).forEach((item) => {
    const next = current.concat([item]);
    if (current.length && JSON.stringify(next).length >= limit) {
      parts.push(current);
      current = [item];
    } else {
      current = next;
    }
  });
  parts.push(current);
  return parts;
}

function deskRows(data, built, options) {
  const opts = options || {};
  const stamp = built === undefined ? DESK_BUILT : built;
  const meta = {};
  META_KEYS.forEach((k) => { if (Object.prototype.hasOwnProperty.call(data, k)) meta[k] = data[k]; });
  const rows = [['meta', JSON.stringify(meta), stamp]];
  FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(data, field)) return;
    if (field === 'items') {
      splitItems(data.items, opts.maxChars).forEach((part, i) => {
        rows.push([i === 0 ? 'items' : 'items' + (i + 1), JSON.stringify(part), stamp]);
      });
    } else {
      rows.push([field, JSON.stringify(data[field] === undefined ? null : data[field]), stamp]);
    }
  });
  return rows;
}

function seedDesk(sb, data, built, options) {
  const rows = deskRows(data || deskData(), built, options);
  sb.mock.seed('Desk', rows);
  return rows;
}

module.exports = { DESK_BUILT, deskData, deskRows, splitItems, seedDesk };
