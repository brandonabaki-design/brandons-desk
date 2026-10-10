'use strict';
/** Shared helpers for the test files. */
const fs = require('node:fs');
const path = require('node:path');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function fixtureJson(name) {
  return JSON.parse(fixture(name));
}

/** Returns the first offending path where a value is a Date, undefined or a function. */
function findUnsafe(value, p) {
  const here = p || '$';
  if (value === undefined) return here + ' is undefined';
  if (typeof value === 'function') return here + ' is a function';
  if (Object.prototype.toString.call(value) === '[object Date]') return here + ' is a Date';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = findUnsafe(value[i], here + '[' + i + ']');
      if (r) return r;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const r = findUnsafe(value[keys[i]], here + '.' + keys[i]);
      if (r) return r;
    }
  }
  return '';
}

/** Task object factory for pure agenda/newsletter tests. */
function makeTask(overrides, today) {
  const base = {
    id: 'W-' + Math.random().toString(36).slice(2, 10),
    category: 'Work',
    created: today || '2026-10-08',
    title: 'Task ' + Math.random().toString(36).slice(2, 6),
    details: '',
    source: 'Manual',
    link: '',
    status: 'Open',
    done: '',
    note: '',
    project: '',
    newsletter: false,
    discuss: false,
    due: '',
    priority: 'Normal',
    sourceKey: '',
    updated: (today || '2026-10-08') + 'T09:00:00+04:00',
    row: Math.floor(Math.random() * 1000) + 2
  };
  return Object.assign(base, overrides || {});
}

module.exports = { fixture, fixtureJson, findUnsafe, makeTask };
