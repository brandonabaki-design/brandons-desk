'use strict';
/**
 * Test runner: loads every apps-script/*.gs into a node:vm sandbox with the Apps Script
 * mock, then runs tests/*.test.js. Each test file exports `async function (t)`; it calls
 * `t.test(name, fn)` for its cases. Prints ok/FAIL per case; exit code 1 on any failure.
 *
 * Usage: node tests/run.js [filter]
 * Also exports createSandbox() for tests/e2e.js (nothing runs on require).
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const strictAssert = require('node:assert/strict');
const { createMock } = require('./gas-mock');

/**
 * Deep-clones a value into host-realm plain arrays/objects so deepEqual does not fail on
 * prototype identity when one side was built inside the vm sandbox.
 */
function normalise(value, seen) {
  const visited = seen || new Map();
  if (value === null || typeof value !== 'object') return value;
  if (visited.has(value)) return visited.get(value);
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Date]') return new Date(value.getTime());
  if (tag === '[object RegExp]') return value;
  if (tag === '[object Set]') { const s = new Set(); visited.set(value, s); value.forEach((v) => s.add(normalise(v, visited))); return s; }
  if (tag === '[object Map]') { const m = new Map(); visited.set(value, m); value.forEach((v, k) => m.set(normalise(k, visited), normalise(v, visited))); return m; }
  if (Array.isArray(value)) {
    const out = [];
    visited.set(value, out);
    value.forEach((v) => out.push(normalise(v, visited)));
    return out;
  }
  if (tag === '[object Object]' || tag === '[object Error]') {
    const out = {};
    visited.set(value, out);
    Object.keys(value).forEach((k) => { out[k] = normalise(value[k], visited); });
    return out;
  }
  return value;
}

const assert = function (value, message) { return strictAssert(value, message); };
Object.keys(strictAssert).forEach((k) => { assert[k] = strictAssert[k]; });
assert.deepEqual = (a, b, message) => strictAssert.deepEqual(normalise(a), normalise(b), message);
assert.deepStrictEqual = assert.deepEqual;
assert.notDeepEqual = (a, b, message) => strictAssert.notDeepEqual(normalise(a), normalise(b), message);
assert.notDeepStrictEqual = assert.notDeepEqual;

const ROOT = path.join(__dirname, '..');
const GS_DIR = path.join(ROOT, 'apps-script');
const TESTS_DIR = __dirname;

function listGsFiles() {
  return fs.readdirSync(GS_DIR).filter((f) => f.endsWith('.gs')).sort((a, b) => {
    // Mirror .clasp.json filePushOrder: Config.gs then Util.gs, then the rest by name.
    const order = ['Config.gs', 'Util.gs'];
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia >= 0 ? ia : 99) - (ib >= 0 ? ib : 99);
    return a.localeCompare(b);
  });
}

/** A Date class whose no-argument constructor and now() return a fixed instant. */
function fixedClock(nowValue) {
  const fixed = new Date(nowValue).getTime();
  if (isNaN(fixed)) throw new Error('Bad fixed clock: ' + nowValue);
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  }
  return FakeDate;
}

/**
 * Builds a fresh sandbox with every .gs loaded. Throws loudly on a syntax error.
 * options.now (ISO string or Date) pins `new Date()` / `Date.now()` inside the sandbox.
 */
function createSandbox(options) {
  const opts = options || {};
  const mock = createMock(opts);
  const DateClass = opts.now ? fixedClock(opts.now) : Date;
  // Share the host realm's Set/Map/Error so `instanceof` checks agree between the mock (host)
  // and the .gs code (sandbox), as in the single-realm Apps Script runtime. Date checks in the
  // .gs code are tag-based (isDateValue), so a fixed-clock Date subclass is safe here.
  const sandbox = Object.assign({ console: console, Date: DateClass, Set: Set, Map: Map, Error: Error }, mock.globals);
  const ctx = vm.createContext(sandbox);
  listGsFiles().forEach((file) => {
    const code = fs.readFileSync(path.join(GS_DIR, file), 'utf8');
    let script;
    try {
      script = new vm.Script(code, { filename: 'apps-script/' + file });
    } catch (e) {
      const err = new Error('Syntax error in apps-script/' + file + ': ' + e.message);
      err.file = file;
      throw err;
    }
    try {
      script.runInContext(ctx);
    } catch (e) {
      const err = new Error('Load-time error in apps-script/' + file + ': ' + e.message + '\n' + (e.stack || ''));
      err.file = file;
      throw err;
    }
  });
  const evalIn = (expr) => vm.runInContext(expr, ctx);
  return { gs: ctx, mock: mock.state, globals: mock.globals, eval: evalIn };
}

async function main() {
  const filter = process.argv[2] || '';
  // Fail loudly up front if any .gs file does not load.
  try {
    createSandbox();
  } catch (e) {
    console.error('FAIL - load apps-script/*.gs');
    console.error(e.message);
    process.exit(1);
  }

  const files = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();
  const pureOnly = !!filter && 'ui/pure-check.js'.includes(filter);
  if (!files.length && !pureOnly) {
    console.error('No test files match ' + JSON.stringify(filter));
    process.exit(1);
  }
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const file of files) {
    const mod = require(path.join(TESTS_DIR, file));
    const fn = typeof mod === 'function' ? mod : mod.default;
    if (typeof fn !== 'function') {
      failed++;
      failures.push(file + ' does not export a function');
      console.log('FAIL - ' + file + ' (no exported function)');
      continue;
    }
    const t = {
      assert: assert,
      file: file,
      createSandbox: createSandbox,
      async test(name, caseFn, options) {
        const label = file.replace(/\.test\.js$/, '') + ' › ' + name;
        try {
          const sb = createSandbox(options);
          await caseFn(sb, assert);
          passed++;
          console.log('ok   - ' + label);
        } catch (e) {
          failed++;
          failures.push(label + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n      ') : String(e)));
          console.log('FAIL - ' + label);
          console.log('       ' + (e && e.message ? e.message.split('\n').join('\n       ') : String(e)));
        }
      }
    };
    try {
      await fn(t);
    } catch (e) {
      failed++;
      failures.push(file + ' threw: ' + (e && e.stack ? e.stack : e));
      console.log('FAIL - ' + file + ' threw outside a test case: ' + (e && e.message ? e.message : e));
    }
  }
  // Client-side pure helpers (esc(), link sanitiser, …) extracted from App.html: run the UI
  // agent's dependency-free check as one more case when it is present.
  const pureCheck = path.join(TESTS_DIR, 'ui', 'pure-check.js');
  if (!filter || 'ui/pure-check.js'.includes(filter)) {
    if (fs.existsSync(pureCheck)) {
      const res = require('node:child_process').spawnSync(process.execPath, [pureCheck], { encoding: 'utf8' });
      const out = ((res.stdout || '') + (res.stderr || '')).trim();
      if (res.status === 0) {
        passed++;
        console.log('ok   - ui › pure helpers in App.html (' + out.split('\n')[0] + ')');
      } else {
        failed++;
        failures.push('ui › pure helpers in App.html\n      ' + out.split('\n').slice(0, 10).join('\n      '));
        console.log('FAIL - ui › pure helpers in App.html');
        console.log('       ' + out.split('\n').join('\n       '));
      }
    } else if (!filter) {
      // SPEC 9 requires this check in a full run: a missing file is a failure, not a silent skip.
      failed++;
      failures.push('ui › pure helpers in App.html: tests/ui/pure-check.js is missing');
      console.log('FAIL - ui › pure helpers in App.html (tests/ui/pure-check.js is missing)');
    } else {
      console.log('skip - ui › pure helpers in App.html (tests/ui/pure-check.js not present)');
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('');
    failures.forEach((f) => console.log('  ' + f));
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

// tests/e2e.js reuses the sandbox builder to run the real server code behind the real client.
module.exports = { createSandbox, listGsFiles, normalise, assert };
