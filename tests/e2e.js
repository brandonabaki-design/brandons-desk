#!/usr/bin/env node
/*
 * End-to-end check: the real client (apps-script/Index.html + Styles.html + App.html, assembled exactly as
 * doGet() serves it) runs in headless Chromium and talks to the REAL server code — every apps-script/*.gs
 * loaded into the node:vm sandbox over tests/gas-mock.js — through a google.script.run shim whose calls go
 * via page.exposeFunction('__gasCall', …) straight into the entry points of Api.gs (guard(), validation,
 * jsonSafe() and all). The mock sheet is seeded with 17 tasks and 4 inbox items; the scenarios below assert
 * on the DOM and on the sheet state after each flow, at desktop and phone widths and once more with the
 * SheetJS CDN blocked (CSV fallback). Fails (exit 1) on any console error, uncaught page error, unexpected
 * network request, Date/undefined leaking out of a server function, or a failed step.
 *
 *   node tests/e2e.js            (npm test runs it after the unit tests)
 *   CHROMIUM_PATH=... UI_OUT=... node tests/e2e.js
 * Needs a Chromium: `npx playwright install chromium` once after `npm install` (or CHROMIUM_PATH).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSandbox } = require('./run');
const { assemble, DEFAULT_OUT_DIR } = require('./ui/assemble');
const { findUnsafe } = require('./fixtures/helpers');
const { buildChatFixture } = require('./fixtures/chat-api');

let playwright;
try { playwright = require('playwright'); } catch (e) {
  console.error('Playwright is not installed. Run `npm install`, then `npx playwright install chromium` once (see README).');
  process.exit(2);
}

// Browser: CHROMIUM_PATH if set, else a pre-installed Chromium at /opt/pw-browsers/chromium when that exists,
// else Playwright's own download (`npx playwright install chromium`, a one-time step after `npm install`).
const PREINSTALLED_CHROME = '/opt/pw-browsers/chromium';
const CHROME = process.env.CHROMIUM_PATH || (fs.existsSync(PREINSTALLED_CHROME) ? PREINSTALLED_CHROME : '');
const OUT = process.env.UI_OUT || DEFAULT_OUT_DIR;
const SHOTS = path.join(OUT, 'e2e-screenshots');
const DOWNLOADS = path.join(OUT, 'e2e-downloads');

/** Starts headless Chromium, or explains how to get one. */
function launchBrowser() {
  const opts = { headless: true };
  if (CHROME) opts.executablePath = CHROME;
  return playwright.chromium.launch(opts).catch((e) => {
    console.error('Could not start Chromium: ' + String(e && e.message ? e.message : e).split('\n')[0]);
    console.error('Run `npx playwright install chromium` once, or set CHROMIUM_PATH to a Chrome/Chromium binary.');
    process.exit(2);
  });
}
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const XLSX_LOCAL = path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
const XLSX_SHA384 = 'vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';

// Fixed clock: Saturday 2026-10-10 09:30 in Dubai (05:30Z). Next Tuesday = 2026-10-13, weekOf = 2026-10-12,
// agenda window = 2026-10-06 .. 2026-10-12, newsletter default range = 2026-09-12 .. 2026-10-10.
const NOW = '2026-10-10T05:30:00Z';
const TODAY = '2026-10-10';
const API = ['getBootstrap', 'listTasks', 'addTask', 'updateTask', 'completeTask', 'reopenTask', 'dropTask', 'moveTask',
  'importText', 'importHtml', 'listInbox', 'promoteInbox', 'ignoreInbox', 'getAgenda', 'saveAgenda', 'regenerateAgenda',
  'getNewsletter', 'runCaptureNow', 'getLog'];
const PAGES = ['today', 'inbox', 'import', 'agenda', 'newsletter', 'history'];

const failures = [];
const shots = [];
function fail(msg) { failures.push(msg); console.error('FAIL ' + msg); }
function ok(msg) { console.log('ok   ' + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); return !!cond; }
function sha384(file) { return crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(fn, label, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 5000)) {
    let v = null;
    try { v = fn(); } catch (e) { v = null; }
    if (v) { ok(label); return v; }
    await sleep(40);
  }
  fail(label + ' (timed out)');
  return null;
}

// ---------------------------------------------------------------------------
// google.script.run shim → window.__gasCall(name, payload) → sandbox entry point
// ---------------------------------------------------------------------------
const SHIM = '(function () {\n' +
  '  var NAMES = ' + JSON.stringify(API) + ';\n' +
  '  function runner(success, failure) {\n' +
  '    var r = { withSuccessHandler: function (fn) { return runner(fn, failure); },\n' +
  '              withFailureHandler: function (fn) { return runner(success, fn); },\n' +
  '              withUserObject: function () { return r; } };\n' +
  '    NAMES.forEach(function (name) {\n' +
  '      r[name] = function (payload) {\n' +
  '        var input = payload === undefined ? {} : JSON.parse(JSON.stringify(payload));\n' +
  '        window.__gasCall(name, input).then(function (res) {\n' +
  '          if (res && res.__error) { if (failure) failure(new Error(res.__error)); return; }\n' +
  '          if (success) success(res ? res.__result : null);\n' +
  '        }, function (e) { if (failure) failure(e); });\n' +
  '      };\n' +
  '    });\n' +
  '    return r;\n' +
  '  }\n' +
  '  window.google = { script: {\n' +
  '    run: runner(null, null),\n' +
  '    host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, editor: {} },\n' +
  '    url: { getLocation: function (cb) { cb({ hash: location.hash.replace(/^#/, ""), parameter: {}, parameters: {} }); } },\n' +
  '    history: {\n' +
  '      push: function (s, q, hash) { if (hash !== undefined) location.hash = hash; },\n' +
  '      replace: function (s, q, hash) { if (hash !== undefined && location.hash.replace(/^#/, "") !== hash) location.replace("#" + hash); },\n' +
  '      setChangeHandler: function (cb) { window.addEventListener("hashchange", function () { cb({ state: null, location: { hash: location.hash.replace(/^#/, ""), parameter: {}, parameters: {} } }); }); }\n' +
  '    }\n' +
  '  } };\n' +
  '  try { Object.defineProperty(navigator, "clipboard", { value: { writeText: function (t) { window.__copied = t; return Promise.resolve(); } }, configurable: true }); } catch (e) {}\n' +
  '})();';

// ---------------------------------------------------------------------------
// Seed: 17 tasks (13 Work, 4 Personal) and 4 inbox items, written as real sheet rows (Dates, booleans)
// ---------------------------------------------------------------------------
function seedSheet(sb) {
  const gs = sb.gs;
  const DOCS = 'https://docs.google.com/document/d/';
  const task = (o) => Object.assign({
    id: '', category: 'Work', created: '2026-10-01', title: '', details: '', source: 'Manual', link: '', status: 'Open', done: '',
    note: '', project: '', newsletter: false, discuss: false, due: '', priority: 'Normal', sourceKey: '', updated: '2026-10-02T09:00:00+04:00'
  }, o);
  const work = [
    task({ id: 'W-e2e00001', title: 'Send AI Learning Hub launch note to staff', project: 'AI Learning Hub', due: '2026-10-07', created: '2026-10-01',
      updated: '2026-10-02T09:00:00+04:00', source: 'Gmail', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3a1b2c3d4e5f6', sourceKey: 'gmail:18f3a1b2c3d4e5f6',
      details: 'Sarah asked for the numbers before Tuesday.', newsletter: true }),
    task({ id: 'W-e2e00002', title: 'Update the department website links', created: '2026-09-15', updated: '2026-09-20T10:00:00+04:00', details: 'Three broken links reported by the comms team.' }),
    task({ id: 'W-e2e00003', title: 'Order replacement micro:bits', project: 'Robotics Club', discuss: true, details: 'Twelve units are dead; budget code needed.', created: '2026-10-08', updated: '2026-10-08T11:00:00+04:00' }),
    task({ id: 'W-e2e00004', title: 'Share workshop photos with comms team', project: 'AI Learning Hub', newsletter: true, status: 'Done', done: '2026-10-07', note: 'Sent 12 photos',
      link: DOCS + '1Photos/edit', created: '2026-10-03', updated: '2026-10-07T15:00:00+04:00' }),
    task({ id: 'W-e2e00005', title: 'Set up Chat space for Hub mentors', project: 'AI Learning Hub', discuss: true, status: 'Done', done: '2026-10-08', note: 'Eight mentors joined',
      link: 'https://chat.google.com/room/AAAAmentors', source: 'Chat', sourceKey: 'chat:spaces/AAAAmentors/messages/1.1', created: '2026-10-02', updated: '2026-10-08T15:00:00+04:00' }),
    task({ id: 'W-e2e00006', title: 'Test AI tutor pilot with Grade 8', project: 'AI Learning Hub', newsletter: true, status: 'Done', done: '2026-10-09', note: 'Students liked the hints mode; 2 of 24 opted out.',
      link: DOCS + '1PilotNotes/edit', created: '2026-09-25', updated: '2026-10-09T15:00:00+04:00' }),
    task({ id: 'W-e2e00007', title: 'Prepare for PD session on AI tools', project: 'PD', due: '2026-10-14', newsletter: true, source: 'Calendar',
      link: 'https://www.google.com/calendar/event?eid=abc123', sourceKey: 'cal:abc123', created: '2026-10-02', updated: '2026-10-02T09:00:00+04:00' }),
    task({ id: 'W-e2e00008', title: 'Coordinate single sign-on for the Hub portal', project: 'AI Learning Hub', priority: 'High', created: '2026-10-04', updated: '2026-10-04T09:00:00+04:00' }),
    task({ id: 'W-e2e00009', title: 'Review Grade 10 Design unit plan draft', project: 'Grade 10 Design', due: TODAY, priority: 'High', link: DOCS + '1AbCdEf/edit',
      details: 'Lina shared the draft rubric on Thursday.', created: '2026-10-06', updated: '2026-10-06T09:00:00+04:00' }),
    task({ id: 'W-e2e00010', title: 'Draft newsletter section on student AI projects', project: 'AI Learning Hub', newsletter: true, priority: 'Low', created: '2026-10-03', updated: '2026-10-03T09:00:00+04:00' }),
    task({ id: 'W-e2e00011', title: 'Migrate shared drive folders', status: 'Dropped', note: 'Superseded by the IT migration plan', created: '2026-09-10', updated: '2026-09-28T09:00:00+04:00' }),
    task({ id: 'W-e2e00012', title: 'Write Hub workshop recap for newsletter', project: 'AI Learning Hub', newsletter: true, status: 'Done', done: '2026-09-01', note: 'Published in the September issue',
      created: '2026-08-20', updated: '2026-09-01T09:00:00+04:00' }),
    // A Link another tool wrote into the sheet: the server returns it as-is, the client must never render it as an anchor.
    task({ id: 'W-e2e00017', title: 'Check projector in room 204', link: 'javascript:alert(1)', details: 'Reported by Daniel; flickers after 10 minutes.',
      created: '2026-10-09', updated: '2026-10-09T09:00:00+04:00' })
  ];
  const personal = [
    task({ id: 'P-e2e00013', category: 'Personal', title: 'Call the dentist to reschedule', due: TODAY, created: '2026-10-07', updated: '2026-10-07T09:00:00+04:00' }),
    task({ id: 'P-e2e00014', category: 'Personal', title: 'Renew car registration', project: 'Home', due: '2026-10-04', priority: 'High', note: 'Plates expire end of month', created: '2026-09-26', updated: '2026-09-26T09:00:00+04:00' }),
    task({ id: 'P-e2e00015', category: 'Personal', title: 'Plan the weekend hike', priority: 'Low', created: '2026-09-30', updated: '2026-09-30T09:00:00+04:00' }),
    task({ id: 'P-e2e00016', category: 'Personal', title: 'Sort out gym membership', status: 'Done', done: TODAY, created: '2026-10-06', updated: TODAY + 'T08:05:00+04:00' })
  ];
  // Config first: parseDate() below reads the time zone through readConfig(), which memoises per execution.
  sb.mock.seed('Config', [['DIRECTOR_NAME', 'Dr Sarah Mitchell', '']]);
  sb.mock.seed('Work', work.map((t) => gs.taskToRow(t, gs.parseDate(t.updated))));
  sb.mock.seed('Personal', personal.map((t) => gs.taskToRow(t, gs.parseDate(t.updated))));
  const GM = 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/';
  const inbox = (id, captured, source, from, subject, snippet, link, key) =>
    [id, gs.parseDate(captured), source, from, subject, snippet, link, key, 'New', '', 'Work'];
  sb.mock.seed('Inbox', [
    inbox('I-e2e00001', TODAY + 'T06:15:01+04:00', 'Gmail', 'Sarah Mitchell <smitchell@aisa.sch.ae>', 'Agenda for Tuesday?',
      'Hi Brandon, could you send me the Hub numbers before our meeting? I would like to share them with the board on Wednesday.', GM + '18f3b0c1d2e3f4a5', 'gmail:18f3b0c1d2e3f4a5'),
    inbox('I-e2e00002', TODAY + 'T06:15:02+04:00', 'Chat', 'Lina Park (lpark@aisa.sch.ae)', 'Grade 10 Design team',
      '@Brandon can you share the rubric by Thursday? The students start the project on Sunday.', 'https://chat.google.com/room/AAAAdesign10', 'chat:spaces/AAAAdesign10/messages/1.1'),
    inbox('I-e2e00003', TODAY + 'T06:15:03+04:00', 'Gmail', 'Fatima Al Ali <fatima.alali@example.com>', 'Question about the AI club',
      'My daughter Noor would like to join the AI club on Wednesdays. Is there still space, and what does she need to bring?', GM + '18f3b0c1d2e3f4c7', 'gmail:18f3b0c1d2e3f4c7'),
    inbox('I-e2e00004', TODAY + 'T06:15:04+04:00', 'Gmail', 'Omar Haddad <ohaddad@aisa.sch.ae>', 'Robotics kit inventory',
      'Can you confirm how many micro:bit kits are still working? Finance needs the count by Thursday for the reorder.', GM + '18f3b0c1d2e3f4b6', 'gmail:18f3b0c1d2e3f4b6')
  ]);
  gs.resetMemos();
  // "Run capture now": one fresh Gmail thread, Chat API answers with no spaces.
  sb.mock.gmail.setThreads([{ id: 'thr-e2e-1', subject: 'Hub mentor schedule', messages: [
    { id: 'msg-e2e-1', from: 'Priya Nair <pnair@aisa.sch.ae>', subject: 'Hub mentor schedule', body: 'Could you confirm the mentor rota for next week? Two mentors asked to swap.' }
  ] }]);
  sb.mock.urlFetch.handler = () => ({ code: 200, body: {} });
}

/** Sheet readers (through the server's own row mapping, so dates come back as strings). */
function sheetView(sb) {
  const tasks = (tab) => sb.mock.rows(tab).map((r, i) => sb.gs.rowToTask(r, tab, i + 2));
  const inbox = () => sb.gs.readRows('Inbox').map((r) => sb.gs.rowToInboxItem_(r));
  const agenda = () => sb.gs.readRows('Agenda').map((r) => ({ weekOf: sb.gs.toDateString(r.weekOf), section: String(r.section), order: Number(r.order), item: String(r.item),
    detail: String(r.detail), link: String(r.link), taskId: String(r.taskId), generated: sb.gs.toDateTimeString(r.generated) }));
  return { tasks, inbox, agenda, find: (tab, title) => tasks(tab).find((t) => t.title === title) || null };
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
async function openPage(browser, sb, vp, calls, xlsxOk) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, acceptDownloads: true, deviceScaleFactor: 1 });
  const unsafe = [];
  await context.exposeFunction('__gasCall', (name, payload) => {
    const call = { name: name, payload: payload };
    calls.push(call);
    try {
      const fn = sb.gs[name];
      if (typeof fn !== 'function') return { __error: 'Unknown server function: ' + name };
      sb.gs.resetMemos(); // every google.script.run call is a fresh Apps Script execution: no memo survives
      const out = fn(payload);
      const bad = findUnsafe(out);
      if (bad) unsafe.push(name + ': ' + bad);
      call.result = JSON.parse(JSON.stringify(out === undefined ? null : out));
      return { __result: call.result };
    } catch (e) {
      call.error = (e && e.message) || String(e);
      return { __error: call.error };
    }
  });
  await context.addInitScript(SHIM);
  const page = await context.newPage();
  const errors = [];
  const unexpected = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text() + ' @ ' + ((m.location() && m.location().url) || '')); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.route(/^https?:\/\//, async (route) => {
    const u = route.request().url();
    if (u.indexOf('https://fonts.googleapis.com/') === 0) return route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts stubbed offline */' });
    if (u.indexOf('https://fonts.gstatic.com/') === 0) return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' });
    if (u === XLSX_URL) {
      if (xlsxOk) return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(XLSX_LOCAL) });
      return route.abort('failed');
    }
    unexpected.push(u);
    return route.abort('blockedbyclient');
  });
  return { context, page, errors, unexpected, unsafe };
}

async function shot(page, name) {
  const file = path.join(SHOTS, name + '.png');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  return file;
}
async function noOverflow(page, label) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  check(r.sw <= r.cw && r.bw <= r.cw, label + ': no horizontal overflow (' + r.sw + '/' + r.bw + ' <= ' + r.cw + ')');
}
async function gotoPage(page, name) {
  await page.click('#tabs a[data-page="' + name + '"]');
  await page.waitForSelector('#page-' + name + ':not([hidden])');
  await page.waitForFunction((n) => !Array.from(document.querySelectorAll('#page-' + n + ' .empty')).some((e) => /Loading/.test(e.textContent)), name);
  await page.waitForTimeout(60);
}
async function waitToast(page, text) {
  try { await page.waitForFunction((t) => Array.from(document.querySelectorAll('.toast .msg')).some((e) => e.textContent.indexOf(t) >= 0), text, { timeout: 5000 }); return true; }
  catch (e) { return false; }
}
async function clearToasts(page) { await page.evaluate(() => document.querySelectorAll('.toast .x').forEach((b) => b.click())); }
async function tabCount(page, name) { return (await page.textContent('[data-count="' + name + '"]')).trim(); }
/** Where keyboard focus is: tag, id, text and the data-id of the enclosing .task or .item (if any). */
function focusInfo(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const box = a && a.closest ? a.closest('.task, .item') : null;
    return { tag: a ? a.tagName : '', id: a ? a.id : '', cls: a && a.className ? String(a.className) : '', text: a ? a.textContent.trim().slice(0, 30) : '', in: box ? box.getAttribute('data-id') : '' };
  });
}

const IMPORT_TEXT = [
  '# AI Learning Hub',
  '- [x] Draft the Hub newsletter intro',
  '- Book the ICT lab for the AI workshop @2026-10-16',
  '* Order the robotics kits for Grade 7 due: 2026-10-20 !!',
  '• Call the vendor about the licence !',
  '☐ Prepare the PD session on ChatGPT',
  '[ ] Review the Gemini pilot feedback',
  '1. Collect the consent forms',
  '2) Scan the signed forms',
  '✓ Send the agenda to the director',
  '✔ Book the hall',
  '☑ Print the certificates',
  '[x] File the timetable',
  '[P] Buy a birthday gift for Mum @2026-10-18',
  '[Personal] Renew the car insurance !!',
  '[W] Email Sara about the timetable due: 2026-10-14',
  '[Work] Chase the invoice',
  'ok',
  '-',
  '# Admin',
  '- Update the staff handbook'
].join('\n');

// [title, category, project, status, due, priority, newsletterAutoTag]
const IMPORT_EXPECTED = [
  ['Draft the Hub newsletter intro', 'Work', 'AI Learning Hub', 'Done', '', 'Normal', true],
  ['Book the ICT lab for the AI workshop', 'Work', 'AI Learning Hub', 'Open', '2026-10-16', 'Normal', true],
  ['Order the robotics kits for Grade 7', 'Work', 'AI Learning Hub', 'Open', '2026-10-20', 'High', false],
  ['Call the vendor about the licence', 'Work', 'AI Learning Hub', 'Open', '', 'High', false],
  ['Prepare the PD session on ChatGPT', 'Work', 'AI Learning Hub', 'Open', '', 'Normal', true],
  ['Review the Gemini pilot feedback', 'Work', 'AI Learning Hub', 'Open', '', 'Normal', true],
  ['Collect the consent forms', 'Work', 'AI Learning Hub', 'Open', '', 'Normal', false],
  ['Scan the signed forms', 'Work', 'AI Learning Hub', 'Open', '', 'Normal', false],
  ['Send the agenda to the director', 'Work', 'AI Learning Hub', 'Done', '', 'Normal', false],
  ['Book the hall', 'Work', 'AI Learning Hub', 'Done', '', 'Normal', false],
  ['Print the certificates', 'Work', 'AI Learning Hub', 'Done', '', 'Normal', false],
  ['File the timetable', 'Work', 'AI Learning Hub', 'Done', '', 'Normal', false],
  ['Buy a birthday gift for Mum', 'Personal', 'AI Learning Hub', 'Open', '2026-10-18', 'Normal', false],
  ['Renew the car insurance', 'Personal', 'AI Learning Hub', 'Open', '', 'High', false],
  ['Email Sara about the timetable', 'Work', 'AI Learning Hub', 'Open', '2026-10-14', 'Normal', false],
  ['Chase the invoice', 'Work', 'AI Learning Hub', 'Open', '', 'Normal', false],
  ['Update the staff handbook', 'Work', 'Admin', 'Open', '', 'Normal', false]
];

const EXPECTED_QUESTIONS = [
  '«Send AI Learning Hub launch note to staff» is overdue (due 2026-10-07). Still a priority, or should the date move?',
  "«Update the department website links» has been open since 2026-09-15. What's blocking it, and is it still mine?",
  'Order replacement micro:bits: Twelve units are dead; budget code needed.',
  'AI Learning Hub: 3 items closed this week. Should this be in the Hub newsletter or shared with staff?',
  "The newsletter draft includes 2 items. Is there anything you'd like added or held back?",
  '«Prepare for PD session on AI tools» is coming up on 2026-10-14. Anything you want me to prepare?',
  '«Coordinate single sign-on for the Hub portal» is marked high priority but has no date. When do you need it by?',
  'Anything from your side that should go on my list for next week?'
];

// ---------------------------------------------------------------------------
// The scenario (one fresh sandbox + browser context per viewport)
// ---------------------------------------------------------------------------
async function runScenario(browser, url, vp, xlsxOk) {
  const tag = vp.name;
  const sb = createSandbox({ now: NOW });
  seedSheet(sb);
  const S = sheetView(sb);
  const calls = [];
  const { context, page, errors, unexpected, unsafe } = await openPage(browser, sb, vp, calls, xlsxOk);
  try {
    // ---- bootstrap ----
    await page.goto(url + '#today');
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
    check(sb.gs.todayDubai() === TODAY, tag + ': server today is ' + TODAY + ' (Dubai, fixed clock)');
    check(calls.some((c) => c.name === 'getBootstrap' && c.result && c.result.today === TODAY && c.result.user === 'bbaki@aisa.sch.ae'), tag + ': getBootstrap ran guard() and returned today/user');
    const boot = calls.find((c) => c.name === 'getBootstrap').result;
    check(JSON.stringify(boot.counts) === JSON.stringify({ work: { open: 8, dueToday: 1, overdue: 1 }, personal: { open: 3, dueToday: 1, overdue: 1 }, inboxNew: 4 }),
      tag + ': bootstrap counts from the sheet ' + JSON.stringify(boot.counts));
    check(await tabCount(page, 'today') === '11', tag + ': Today tab shows 11 open tasks');
    check(await tabCount(page, 'inbox') === '4', tag + ': Inbox tab shows 4 new items');
    check(/Saturday 10 October 2026/.test(await page.textContent('#today-date')), tag + ': date label comes from the server today');
    check(await page.locator('#col-work .group.overdue .task').count() === 1 && await page.locator('#col-work .group.due-today .task').count() === 1, tag + ': Work overdue/due-today groups');
    check(await page.locator('#col-personal .group.overdue .task').count() === 1 && await page.locator('#col-personal details.done-group .task').count() === 1, tag + ': Personal overdue + Done today groups');
    check(await page.locator('#col-work .task', { hasText: 'Migrate shared drive folders' }).count() === 0, tag + ': dropped task not on Today');
    check(await page.locator('.task', { hasText: 'Send AI Learning Hub launch note' }).locator('a.task-link[target="_blank"][rel="noopener"]').count() === 1, tag + ': source link rendered');
    const projector = page.locator('.task', { hasText: 'Check projector in room 204' });
    check(await projector.count() === 1 && await projector.locator('a.task-link').count() === 0 && await projector.locator('a').count() === 0,
      tag + ': a javascript: Link from the sheet is listed but never rendered as an anchor');
    check((await page.getAttribute('#qa-category [data-value="Work"]', 'aria-checked')) === 'true' && (await page.getAttribute('#qa-category [data-value="Personal"]', 'role')) === 'radio',
      tag + ': quick-add category toggle exposes radio semantics');
    await noOverflow(page, tag + ' today');
    await shot(page, tag + '-today');

    // ---- quick-add → row with Source Manual; auto-tag; duplicate ----
    await page.fill('#qa-title', 'Email parents about the trip');
    await page.press('#qa-title', 'Enter');
    check(await waitToast(page, 'Added to Work: Email parents about the trip'), tag + ': quick-add toast');
    let row = await until(() => S.find('Work', 'Email parents about the trip'), tag + ': quick-add wrote a Work row');
    if (row) {
      check(/^W-[a-z0-9]{8}$/.test(row.id) && row.source === 'Manual' && row.status === 'Open' && row.created === TODAY && row.priority === 'Normal' && row.newsletter === false && row.updated.indexOf(TODAY) === 0,
        tag + ': quick-add row: id/Source Manual/Open/Created today/Normal/no newsletter ' + JSON.stringify([row.id, row.source, row.status, row.created, row.newsletter]));
    }
    check(await page.locator('#col-work .group.open .task', { hasText: 'Email parents about the trip' }).count() === 1, tag + ': quick-add row rendered in Work › Open');
    await page.click('#qa-category [data-value="Personal"]');
    check((await page.getAttribute('#qa-category [data-value="Personal"]', 'aria-checked')) === 'true' && (await page.getAttribute('#qa-category [data-value="Work"]', 'aria-checked')) === 'false',
      tag + ': aria-checked follows the selected category');
    await page.fill('#qa-title', 'Plan the AI workshop for staff');
    await page.press('#qa-title', 'Enter');
    await waitToast(page, 'Added to Personal: Plan the AI workshop');
    row = await until(() => S.find('Personal', 'Plan the AI workshop for staff'), tag + ': quick-add to Personal wrote a Personal row');
    if (row) check(/^P-/.test(row.id) && row.newsletter === true, tag + ': Personal row has a P- id and the newsletter auto-tag (keyword "AI"/"workshop")');
    check(await page.locator('#col-personal .task', { hasText: 'Plan the AI workshop for staff' }).locator('.chip.newsletter').count() === 1, tag + ': Newsletter chip shown after auto-tag');
    await page.fill('#qa-title', 'plan the ai workshop for staff');
    await page.press('#qa-title', 'Enter');
    check(await waitToast(page, 'Already on your list'), tag + ': duplicate title reported by the server');
    check(S.tasks('Personal').filter((t) => /plan the ai workshop/i.test(t.title)).length === 1, tag + ': duplicate did not add a row');
    await page.click('#qa-category [data-value="Work"]');
    await clearToasts(page);

    // ---- tick with note → Done today + Note; undo → Open ----
    const dentist = page.locator('.task', { hasText: 'Call the dentist to reschedule' });
    await dentist.locator('.task-check').click();
    check(await dentist.locator('.note-box').count() === 1, tag + ': note box opens on tick');
    await dentist.locator('.note-box input').fill('Moved to Monday');
    await shot(page, tag + '-today-note');
    await dentist.locator('.note-box input').press('Enter'); // keyboard path: Enter in the note box completes the task
    check(await waitToast(page, 'Done: Call the dentist'), tag + ': done toast with Undo');
    let fi = await focusInfo(page);
    check(fi.id === 'qa-title', tag + ': completing the only task of its group (Done today collapsed) puts focus on quick-add, not <body> ' + JSON.stringify(fi));
    const undoSize = await page.locator('.toast .act', { hasText: 'Undo' }).boundingBox();
    check(!!undoSize && undoSize.height >= 40, tag + ': the Undo toast button is a 40 px tap target (' + (undoSize ? Math.round(undoSize.height) : '?') + ' px)');
    row = await until(() => { const t = S.find('Personal', 'Call the dentist to reschedule'); return t && t.status === 'Done' ? t : null; }, tag + ': completeTask set Status Done');
    if (row) check(row.done === TODAY && row.note === 'Moved to Monday', tag + ': Done = today (Dubai) and Note = the note ' + JSON.stringify([row.done, row.note]));
    check(await page.locator('#col-personal details.done-group .task', { hasText: 'Call the dentist' }).count() === 1, tag + ': ticked task shown under Done today');
    await page.locator('.toast .act', { hasText: 'Undo' }).click();
    check(await waitToast(page, 'Reopened: Call the dentist'), tag + ': undo toast');
    row = await until(() => { const t = S.find('Personal', 'Call the dentist to reschedule'); return t && t.status === 'Open' ? t : null; }, tag + ': reopenTask set Status Open');
    if (row) check(row.done === '', tag + ': Done cleared on reopen');
    check(await page.locator('#col-personal .group.due-today .task', { hasText: 'Call the dentist' }).count() === 1, tag + ': reopened task back under Due today');
    await page.waitForTimeout(80);
    fi = await focusInfo(page);
    check(/task-check/.test(fi.cls) && fi.in === 'P-e2e00013', tag + ': Undo leaves focus on the reopened row\'s checkbox, also after the server reply re-rendered ' + JSON.stringify(fi));
    // Space on that checkbox ticks it again; Escape closes the note box and focus stays on the checkbox
    await page.keyboard.press('Space');
    check(await dentist.locator('.note-box').count() === 1, tag + ': Space on the focused checkbox opens the note box');
    await page.keyboard.press('Escape');
    fi = await focusInfo(page);
    check(await dentist.locator('.note-box').count() === 0 && /task-check/.test(fi.cls) && fi.in === 'P-e2e00013', tag + ': Escape cancels and keeps focus on the checkbox');
    await clearToasts(page);

    // ---- inline editor → updateTask patch ----
    const hike = page.locator('.task', { hasText: 'Plan the weekend hike' });
    const focusedTaskId = (sel) => page.evaluate((s) => {
      const a = document.activeElement;
      return a && a.matches(s) && a.closest('.task') ? a.closest('.task').getAttribute('data-id') : '';
    }, sel);
    await hike.locator('.task-title').click();
    check((await focusedTaskId('.editor textarea')) === 'P-e2e00015', tag + ': opening the inline editor moves keyboard focus into it');
    const labelled = await page.evaluate(() => Array.from(document.querySelectorAll('.editor .editor-grid > .field')).map((f) => {
      const l = f.querySelector('label[for]');
      const c = l && document.getElementById(l.getAttribute('for'));
      return !!(c && f.contains(c) && /^(INPUT|TEXTAREA|SELECT)$/.test(c.tagName) && l.textContent.trim());
    }));
    check(labelled.length === 6 && labelled.every(Boolean), tag + ': the six editor fields each carry a <label for> naming their control');
    await hike.locator('.editor input[type="date"]').fill('2026-10-15');
    await hike.locator('.editor input[list="projects-list"]').fill('Home');
    await hike.locator('.editor label.check', { hasText: 'Discuss' }).locator('input').check();
    await shot(page, tag + '-today-editor');
    await hike.locator('.editor button', { hasText: /^Save$/ }).click();
    check(await waitToast(page, 'Saved: Plan the weekend hike'), tag + ': editor save toast');
    check((await focusedTaskId('.task-title')) === 'P-e2e00015', tag + ': saving returns focus to the task title');
    row = await until(() => { const t = S.find('Personal', 'Plan the weekend hike'); return t && t.due === '2026-10-15' ? t : null; }, tag + ': updateTask wrote Due');
    if (row) check(row.project === 'Home' && row.discuss === true && row.priority === 'Low', tag + ': patch applied only to project/due/discuss ' + JSON.stringify([row.project, row.discuss, row.priority]));
    const patchCall = calls.filter((c) => c.name === 'updateTask').slice(-1)[0];
    check(patchCall && JSON.stringify(patchCall.payload.patch) === JSON.stringify({ project: 'Home', due: '2026-10-15', discuss: true }), tag + ': updateTask patch holds only changed fields');
    await clearToasts(page);

    // ---- move to the other list → copy + Dropped original (unsaved editor edits are saved first, not thrown away) ----
    await hike.locator('.task-title').click();
    await hike.locator('.editor input[list="projects-list"]').fill('Trips');
    const callsBeforeMove = calls.length;
    await hike.locator('.editor button', { hasText: 'Move to Work' }).click();
    check(await waitToast(page, 'Moved to Work: Plan the weekend hike'), tag + ': move toast');
    const moveCalls = calls.slice(callsBeforeMove).map((c) => c.name);
    check(JSON.stringify(moveCalls) === JSON.stringify(['updateTask', 'moveTask']) && JSON.stringify(calls[callsBeforeMove].payload.patch) === JSON.stringify({ project: 'Trips' }),
      tag + ': Move with an unsaved edit saves the edit (updateTask {project}) before moveTask ' + JSON.stringify(moveCalls));
    const movedTo = await until(() => S.find('Work', 'Plan the weekend hike'), tag + ': moveTask copied the row to Work');
    const movedFrom = S.find('Personal', 'Plan the weekend hike');
    check(!!movedFrom && movedFrom.id === 'P-e2e00015', tag + ': the original Personal row still exists after the move');
    if (movedTo && movedFrom) check(/^W-/.test(movedTo.id) && movedTo.due === '2026-10-15' && movedTo.project === 'Trips' && movedFrom.status === 'Dropped' && movedFrom.note === 'Moved to ' + movedTo.id,
      tag + ': new W- id, fields (incl. the edited project) kept, original Dropped with "Moved to <id>" ' + JSON.stringify([movedTo.id, movedTo.project, movedFrom.status, movedFrom.note]));
    check(await page.locator('#col-work .task', { hasText: 'Plan the weekend hike' }).count() === 1 && await page.locator('#col-personal .task', { hasText: 'Plan the weekend hike' }).count() === 0, tag + ': moved task changed column');
    const focusedAfterMove = await page.evaluate(() => { const a = document.activeElement; return a && a.classList.contains('task-title') && a.closest('#col-work') ? a.textContent : ''; });
    check(focusedAfterMove === 'Plan the weekend hike', tag + ': focus follows the moved task into the Work column (' + JSON.stringify(focusedAfterMove) + ')');
    await clearToasts(page);

    // ---- drop + undo ----
    const car = page.locator('.task', { hasText: 'Renew car registration' });
    await car.locator('.task-title').click();
    await page.keyboard.press('Escape');
    check(await car.locator('.editor').count() === 0 && (await focusedTaskId('.task-title')) === 'P-e2e00014', tag + ': Escape closes the editor and focuses the title');
    await car.locator('.task-title').click();
    check((await car.locator('.editor input[type="text"][maxlength="200"]').inputValue()) === 'Plates expire end of month', tag + ': the editor shows the existing note');
    await car.locator('.editor button', { hasText: 'Drop' }).click();
    check(await waitToast(page, 'Dropped: Renew car registration'), tag + ': drop toast');
    check((await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'qa-title', tag + ': dropping the only task of its group puts focus on quick-add, not <body>');
    row = await until(() => { const t = S.find('Personal', 'Renew car registration'); return t && t.status === 'Dropped' ? t : null; }, tag + ': dropTask set Status Dropped');
    const dropCall = calls.filter((c) => c.name === 'dropTask').slice(-1)[0];
    check(row && row.note === 'Plates expire end of month' && dropCall && dropCall.payload.note === undefined,
      tag + ': dropping a task with an existing note sends no note, so the sheet Note is unchanged ' + JSON.stringify([row && row.note, dropCall && dropCall.payload]));
    await page.locator('.toast .act', { hasText: 'Undo' }).click();
    check(await waitToast(page, 'Restored: Renew car registration'), tag + ': undo-drop toast');
    await until(() => { const t = S.find('Personal', 'Renew car registration'); return t && t.status === 'Open'; }, tag + ': undo reopened the dropped task');
    check(await page.locator('#col-personal .group.overdue .task', { hasText: 'Renew car registration' }).count() === 1, tag + ': restored task back under Overdue');
    await clearToasts(page);
    await page.fill('#today-search', 'hub');
    await page.waitForTimeout(60);
    // "hub" matches title/project of W-1, W-8 (title), W-10 (project) and nothing in Personal
    check(await page.locator('#col-work .task').count() === 3 && await page.locator('#col-personal .task').count() === 0, tag + ': search filters both columns (' + await page.locator('#col-work .task').count() + ' work)');
    await page.fill('#today-search', '');
    await page.waitForTimeout(60);
    // The Done today group is rebuilt on every re-render: once opened it must stay open across a search keystroke.
    await page.locator('#col-personal details.done-group summary').click();
    check(await page.locator('#col-personal details.done-group[open]').count() === 1, tag + ': Done today opens on tap');
    await page.fill('#today-search', 'gym');
    await page.waitForTimeout(60);
    check(await page.locator('#col-personal details.done-group[open] .task', { hasText: 'Sort out gym membership' }).count() === 1, tag + ': Done today stays open across a re-render');
    await page.fill('#today-search', '');
    await page.waitForTimeout(60);
    await page.locator('#col-personal details.done-group summary').click();
    check(await page.locator('#col-personal details.done-group[open]').count() === 0, tag + ': and closes again on tap');

    // ---- inbox: promote, ignore, capture ----
    await gotoPage(page, 'inbox');
    check(await page.locator('#inbox-list .item').count() === 4, tag + ': inbox lists the 4 New rows');
    check(await page.locator('#inbox-list .item').first().textContent().then((t) => /Robotics kit inventory/.test(t)), tag + ': inbox is newest first');
    await noOverflow(page, tag + ' inbox');
    await page.locator('#inbox-list .item', { hasText: 'Agenda for Tuesday?' }).locator('button', { hasText: 'Promote' }).click();
    const pf = page.locator('.promote-form');
    await pf.locator('input[aria-label="Task title"]').fill('Send Hub numbers to Sarah before Tuesday');
    await pf.locator('input[aria-label="Project"]').fill('AI Learning Hub');
    await shot(page, tag + '-inbox-promote');
    await pf.locator('button', { hasText: 'Add task' }).click();
    check(await waitToast(page, 'Added to Work: Send Hub numbers to Sarah before Tuesday'), tag + ': promote toast');
    row = await until(() => S.find('Work', 'Send Hub numbers to Sarah before Tuesday'), tag + ': promoteInbox created the task');
    const promoted = S.inbox().find((i) => i.id === 'I-e2e00001');
    if (row) check(row.source === 'Gmail' && row.sourceKey === 'gmail:18f3b0c1d2e3f4a5' && row.link === 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3b0c1d2e3f4a5' && row.project === 'AI Learning Hub' && /^From Sarah Mitchell/.test(row.details),
      tag + ': task carries Source/Link/Source key from the inbox row ' + JSON.stringify([row.source, row.sourceKey, row.project]));
    if (row) check(promoted.status === 'Promoted' && promoted.taskId === row.id, tag + ': inbox row marked Promoted with the Task ID ' + JSON.stringify([promoted.status, promoted.taskId]));
    check(await page.locator('#inbox-list .item').count() === 3 && await tabCount(page, 'inbox') === '3', tag + ': promoted item leaves the list, count updates');
    await page.locator('#inbox-list .item', { hasText: 'Question about the AI club' }).locator('button', { hasText: 'Promote' }).click();
    await page.locator('.promote-form button', { hasText: 'Cancel' }).click();
    const cancelFocus = await page.evaluate(() => { const a = document.activeElement; return a && a.textContent === 'Promote' && a.closest('.item') ? a.closest('.item').textContent : ''; });
    check(/Question about the AI club/.test(cancelFocus), tag + ": cancelling the promote form puts focus back on that item's Promote button");
    await page.locator('#inbox-list .item', { hasText: 'Robotics kit inventory' }).locator('button', { hasText: 'Ignore' }).click();
    check(await waitToast(page, 'Ignored: Robotics kit inventory'), tag + ': ignore toast');
    await until(() => S.inbox().find((i) => i.id === 'I-e2e00004').status === 'Ignored', tag + ': ignoreInbox marked the row Ignored');
    check(await page.locator('#inbox-list .item').count() === 2, tag + ': ignored item leaves the list');
    fi = await focusInfo(page);
    check(fi.text === 'Promote' && fi.in === 'I-e2e00003', tag + ': Ignore moves focus to the next item\'s Promote button ' + JSON.stringify(fi));
    await clearToasts(page);
    await page.click('#inbox-capture');
    check(await waitToast(page, 'Captured: Gmail 1 · Chat 0 conversations (Chat mode: api)'), tag + ': capture toast with counts (Chat counted in conversations) and chatMode');
    await page.waitForFunction(() => document.querySelectorAll('#inbox-list .item').length === 3);
    const captured = S.inbox().find((i) => i.sourceKey === 'gmail:msg-e2e-1');
    check(!!captured && captured.subject === 'Hub mentor schedule' && captured.link === 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/thr-e2e-1' && captured.status === 'New',
      tag + ': runCaptureNow wrote the Gmail thread to Inbox (key = first message id, /u/<email>/#all/<threadId>)');
    check(await page.locator('#inbox-list .item', { hasText: 'Hub mentor schedule' }).count() === 1, tag + ': captured item listed');
    check(await page.isHidden('#inbox-chatmode'), tag + ': no Chat-mode banner in api mode');
    await clearToasts(page);
    // Chat API answers 403 (SERVICE_DISABLED): the real server switches to the email fallback for this run and the UI says so.
    sb.mock.urlFetch.handler = buildChatFixture({ now: NOW, mode: 'forbidden' }).handler;
    await page.click('#inbox-capture');
    check(await waitToast(page, 'Captured: Gmail 0 · Chat 0 conversations (Chat mode: email)'), tag + ': 403 from the Chat API is reported as email mode (nothing new to capture)');
    await page.waitForSelector('#inbox-chatmode:not([hidden])');
    const modeNote = await page.textContent('#inbox-chatmode');
    check(/email mode/.test(modeNote) && /delayed/i.test(modeNote) && /partial/i.test(modeNote), tag + ': email mode labelled as delayed and partial: ' + JSON.stringify(modeNote));
    check(sb.mock.logRows().some((r) => r.level === 'WARN' && /^CHAT_API_BLOCKED HTTP 403 PERMISSION_DENIED SERVICE_DISABLED/.test(r.message)), tag + ': CHAT_API_BLOCKED logged with the error status and reason');
    check(sb.mock.gmail.searches.slice(-1)[0].query.indexOf('from:(chat-noreply@google.com') === 0, tag + ': the fallback searched Gmail for Chat reminder emails');
    check(S.inbox().length === 5, tag + ': the Priya Nair thread was not mistaken for a Chat reminder email');
    sb.mock.urlFetch.handler = () => ({ code: 200, body: {} });
    await clearToasts(page);
    await page.selectOption('#inbox-status', 'Promoted');
    await page.waitForFunction(() => document.querySelectorAll('#inbox-list .item .badge').length >= 1);
    check(/Promoted · W-/.test(await page.locator('#inbox-list .item').first().textContent()), tag + ': Promoted filter shows the task id');
    await shot(page, tag + '-inbox');
    await gotoPage(page, 'today');
    check(await page.locator('#col-work .task', { hasText: 'Send Hub numbers to Sarah' }).count() === 1, tag + ': promoted task on Today without reload');

    // ---- agenda: draft, questions in rule order, save, regenerate keeps saved Questions ----
    await gotoPage(page, 'agenda');
    check((await page.inputValue('#agenda-date')) === '2026-10-13', tag + ': meeting date defaults to the next Tuesday');
    check(/Tue 6 Oct – Mon 12 Oct/.test(await page.textContent('#agenda-window')), tag + ': window shown ' + (await page.textContent('#agenda-window')));
    check((await page.textContent('#agenda-state')).trim() === 'Draft', tag + ': no saved rows → Draft');
    check(/With Dr Sarah Mitchell/.test(await page.textContent('#agenda-director')), tag + ': director name from Config');
    const doneItems = await page.locator('[data-section="Done"] .arow .text > div:first-child').allTextContents();
    check(JSON.stringify(doneItems) === JSON.stringify(['Share workshop photos with comms team', 'Set up Chat space for Hub mentors', 'Test AI tutor pilot with Grade 8']), tag + ': Done section: Done-in-window Work tasks by project then date ' + JSON.stringify(doneItems));
    const doneDetail = await page.locator('[data-section="Done"] .arow .detail').first().textContent();
    check(doneDetail === 'AI Learning Hub · Sent 12 photos', tag + ': Done detail = "Project · note"');
    const progress = await page.locator('[data-section="In progress"] .arow .text > div:first-child').allTextContents();
    check(progress.length >= 5 && progress[0] === 'Review Grade 10 Design unit plan draft' && progress[1] === 'Coordinate single sign-on for the Hub portal' && progress.indexOf('Order replacement micro:bits') >= 0 && progress.indexOf('Send Hub numbers to Sarah before Tuesday') >= 0 && progress.indexOf('Update the department website links') < 0,
      tag + ': In progress: High first (due before undated), then Discuss / created-in-window; stale task excluded ' + JSON.stringify(progress));
    const questions = await page.locator('[data-section="Questions"] .arow textarea').evaluateAll((els) => els.map((e) => e.value));
    check(JSON.stringify(questions) === JSON.stringify(EXPECTED_QUESTIONS), tag + ': the 8 rule-based questions fire in rule order\n  got: ' + JSON.stringify(questions));
    const docs = await page.locator('[data-section="Documents"] .arow input[type="text"]').evaluateAll((els) => els.map((e) => e.value));
    const docLinks = await page.locator('[data-section="Documents"] .arow input[type="url"]').evaluateAll((els) => els.map((e) => e.value));
    check(JSON.stringify(docs) === JSON.stringify(['Share workshop photos with comms team', 'Set up Chat space for Hub mentors', 'Test AI tutor pilot with Grade 8']) && docLinks[1] === 'https://chat.google.com/room/AAAAmentors',
      tag + ': Documents: distinct links of Discuss/Done-in-window tasks ' + JSON.stringify(docs));
    check(await page.locator('[data-section="Notes"] .arow').count() === 0, tag + ': Notes empty in the draft');
    await noOverflow(page, tag + ' agenda');
    await shot(page, tag + '-agenda');
    const n1 = await page.locator('#agenda-sections .arow').count(); // 3 Done + In progress + 8 Questions + 3 Documents
    check(n1 === 14 + progress.length, tag + ': draft has ' + n1 + ' rows');
    await page.click('#agenda-save');
    check(await waitToast(page, 'Agenda saved (' + n1 + ' rows)'), tag + ': save toast with the row count');
    check((await page.textContent('#agenda-state')).trim() === 'Saved', tag + ': badge flips to Saved');
    let saved = S.agenda();
    check(saved.length === n1 && saved.every((r) => r.weekOf === '2026-10-12' && r.generated.indexOf(TODAY) === 0), tag + ': Agenda tab holds ' + n1 + ' rows for week of 2026-10-12 with Generated = now');
    check(JSON.stringify(saved.filter((r) => r.section === 'Questions').map((r) => r.item)) === JSON.stringify(EXPECTED_QUESTIONS) && saved.filter((r) => r.section === 'Questions').map((r) => r.order).join() === '1,2,3,4,5,6,7,8',
      tag + ': Questions rows saved in order 1..8');
    check(saved.filter((r) => r.section === 'Done')[0].taskId === 'W-e2e00004' && saved.filter((r) => r.section === 'Documents')[1].link === 'https://chat.google.com/room/AAAAmentors', tag + ': Task ID and Link columns saved');
    await clearToasts(page);
    // reload the page (a query string forces a real load; a fragment-only change would be same-document): saved rows win over the draft
    await page.goto(url + '?reload=1#agenda');
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-section="Questions"] .arow').length > 0);
    check((await page.textContent('#agenda-state')).trim() === 'Saved' && (calls.filter((c) => c.name === 'getAgenda').slice(-1)[0].result.saved === true), tag + ': getAgenda returns the saved rows (saved:true) after reload');
    // edit a question, add one, remove a Done item, save, then regenerate: Done comes back, Questions stay
    await page.locator('[data-section="Questions"] .arow').first().locator('textarea').fill('Launch note: can we send it Monday instead?');
    await page.locator('[data-section="Questions"] button.add').click();
    await page.locator('[data-section="Questions"] .arow').last().locator('textarea').fill('Can we fund two more micro:bit kits this term?');
    // Reorder with the keyboard-reachable buttons: every re-render puts focus back on the moved row's control.
    const focusedAgenda = () => page.evaluate(() => {
      const a = document.activeElement; const row = a && a.closest('.arow');
      const rows = row ? Array.from(row.parentNode.querySelectorAll('.arow')) : [];
      return { label: a ? a.getAttribute('aria-label') : '', index: rows.indexOf(row), section: row ? row.closest('.agenda-section').getAttribute('data-section') : '' };
    });
    await page.locator('[data-section="Questions"] .arow').last().locator('button[aria-label="Move up"]').click();
    let fa = await focusedAgenda();
    check(fa.label === 'Move up' && fa.section === 'Questions' && fa.index === 7, tag + ': Move up keeps focus on the moved row ' + JSON.stringify(fa));
    await page.keyboard.press('Enter'); // the same (focused) Move up: the row climbs again
    fa = await focusedAgenda();
    check(fa.label === 'Move up' && fa.index === 6, tag + ': pressing Enter on the refocused button moves the row again ' + JSON.stringify(fa));
    await page.locator('[data-section="Questions"] .arow').nth(6).locator('button[aria-label="Move down"]').click();
    await page.locator('[data-section="Questions"] .arow').nth(7).locator('button[aria-label="Move down"]').click();
    fa = await focusedAgenda();
    check(fa.label === 'Move up' && fa.index === 8, tag + ': Move down onto the last row (its Move down is disabled) focuses that row\'s Move up ' + JSON.stringify(fa));
    await page.locator('[data-section="Done"] .arow').first().locator('button[aria-label="Remove"]').click();
    fa = await focusedAgenda();
    check(fa.label === 'Remove' && fa.section === 'Done' && fa.index === 0, tag + ': Remove focuses the Remove button of the row that took its place ' + JSON.stringify(fa));
    await page.locator('[data-section="Notes"] button.add').click();
    await page.locator('[data-section="Notes"] .arow').last().locator('textarea').fill('Sarah wants the Hub numbers before the board meeting.');
    await shot(page, tag + '-agenda-edited');
    const n2 = n1 + 1; // −1 Done, +1 Question, +1 Note
    await page.click('#agenda-save');
    check(await waitToast(page, 'Agenda saved (' + n2 + ' rows)'), tag + ': second save (one Done row removed, a question and a note added)');
    saved = S.agenda();
    const savedQ = saved.filter((r) => r.section === 'Questions').map((r) => r.item);
    check(savedQ.length === 9 && savedQ[0] === 'Launch note: can we send it Monday instead?' && savedQ[8] === 'Can we fund two more micro:bit kits this term?' && saved.filter((r) => r.section === 'Done').length === 2 && saved.filter((r) => r.section === 'Notes').length === 1,
      tag + ': edited/added Questions, removed Done item and the Note are in the sheet');
    await clearToasts(page);
    await page.click('#agenda-regenerate');
    check(await waitToast(page, 'Draft regenerated'), tag + ': regenerate toast');
    const regenQ = await page.locator('[data-section="Questions"] .arow textarea').evaluateAll((els) => els.map((e) => e.value));
    const regenDone = await page.locator('[data-section="Done"] .arow').count();
    const regenNotes = await page.locator('[data-section="Notes"] .arow textarea').evaluateAll((els) => els.map((e) => e.value));
    check(JSON.stringify(regenQ) === JSON.stringify(savedQ) && regenDone === 3 && regenNotes[0] === 'Sarah wants the Hub numbers before the board meeting.' && (await page.textContent('#agenda-state')).trim() === 'Draft',
      tag + ': regenerate rebuilds Done (3 again) but keeps the saved Questions and Notes; flagged Draft');
    check(S.agenda().length === n2, tag + ': regenerate does not write to the Agenda tab');
    await clearToasts(page);
    // SPEC 8: one sheet "Agenda", title rows, Section/Item/Detail/Link header on row 5, real hyperlinks, column widths.
    await downloadCheck(page, '#agenda-download', 'agenda-2026-10-13', xlsxOk, tag, 'Agenda', (ws) =>
      ws.A5 && ws.A5.v === 'Section' && Object.keys(ws).some((k) => /^D\d+$/.test(k) && ws[k].l && ws[k].l.Target === 'https://chat.google.com/room/AAAAmentors'));
    await page.click('#agenda-copy');
    check(await waitToast(page, 'Agenda copied as text'), tag + ': copy-as-text toast');
    const copied = await page.evaluate(() => window.__copied || '');
    check(/^Director meeting agenda — Tuesday 13 October 2026\nWindow: Tuesday 6 October 2026 to Monday 12 October 2026\nDirector: Dr Sarah Mitchell\n\nDONE\n1\. /.test(copied), tag + ': copied agenda text header');
    await clearToasts(page);

    // ---- import text with every syntax of SPEC section 6 ----
    await gotoPage(page, 'import');
    await page.fill('#import-created', '2026-10-09');
    await page.fill('#import-text', IMPORT_TEXT);
    await page.waitForFunction(() => document.querySelectorAll('.prow').length === 17);
    check((await page.textContent('#import-preview-count')).trim() === '(17 of 17 selected)', tag + ': preview shows 17 rows (headings, "ok" and "-" are not tasks)');
    await noOverflow(page, tag + ' import preview');
    await shot(page, tag + '-import-preview');
    await page.click('#import-go');
    await page.waitForSelector('#import-result:not([hidden])');
    check(/Imported 17 tasks/.test(await page.textContent('#import-result h2')), tag + ': import result summary');
    const sent = calls.filter((c) => c.name === 'importText').slice(-1)[0];
    check(sent && sent.payload.created === '2026-10-09' && sent.payload.text.split('\n')[0] === '# AI Learning Hub' && sent.payload.text.indexOf('[Personal] Renew the car insurance !') >= 0 && sent.payload.text.indexOf('# Admin\n[Work] Update the staff handbook') >= 0,
      tag + ': importText received regenerated lines with the Created date');
    const importedKeys = new Set();
    IMPORT_EXPECTED.forEach((e) => {
      const t = S.find(e[1], e[0]);
      if (!t) { fail(tag + ': imported row missing: ' + e[0]); return; }
      const good = t.project === e[2] && t.status === e[3] && t.due === e[4] && t.priority === e[5] && t.newsletter === e[6] && t.source === 'Import' && t.created === '2026-10-09' &&
        t.done === (e[3] === 'Done' ? '2026-10-09' : '') && /^import:[0-9a-f]{40}$/.test(t.sourceKey) && !importedKeys.has(t.sourceKey);
      importedKeys.add(t.sourceKey);
      check(good, tag + ': imported "' + e[0] + '" → ' + JSON.stringify([t.category, t.project, t.status, t.due, t.priority, t.newsletter, t.created, t.done]));
    });
    const lastWork = S.tasks('Work').slice(-15).map((t) => t.title);
    check(JSON.stringify(lastWork) === JSON.stringify(IMPORT_EXPECTED.filter((e) => e[1] === 'Work').map((e) => e[0])), tag + ': imported Work rows keep the document order');
    // Work: 13 seeded + quick-add + moved hike + promoted + 15 imported; Personal: 4 seeded + quick-add + 2 imported
    check(S.tasks('Work').length === 13 + 1 + 1 + 1 + 15 && S.tasks('Personal').length === 4 + 1 + 2, tag + ': row totals after import (Work ' + S.tasks('Work').length + ', Personal ' + S.tasks('Personal').length + ')');
    await shot(page, tag + '-import-result');
    // re-importing the same text: every line is a duplicate
    await page.fill('#import-text', IMPORT_TEXT);
    await page.waitForFunction(() => document.querySelectorAll('.prow').length === 17);
    await page.click('#import-go');
    await page.waitForSelector('#import-result:not([hidden])');
    check(await waitToast(page, 'Imported 0 tasks, skipped 17'), tag + ': re-import skips all 17 as duplicates');
    check(await page.locator('#import-result li', { hasText: 'duplicate' }).count() === 17, tag + ': skipped lines listed with reason "duplicate"');
    await clearToasts(page);
    await gotoPage(page, 'today');
    check(await page.locator('#col-work .task', { hasText: 'Book the ICT lab for the AI workshop' }).locator('.chip.due').count() === 1, tag + ': imported task on Today with its due chip');

    // ---- newsletter ----
    await gotoPage(page, 'newsletter');
    check((await page.inputValue('#nl-from')) === '2026-09-12' && (await page.inputValue('#nl-to')) === TODAY, tag + ': newsletter defaults to the last 28 days');
    const md = await page.textContent('#nl-markdown');
    // Done in the last 28 days with Newsletter ticked (3) plus Open ticked ones (6), Work only
    const want = ['Share workshop photos with comms team', 'Test AI tutor pilot with Grade 8', 'Draft the Hub newsletter intro',
      'Send AI Learning Hub launch note to staff', 'Prepare for PD session on AI tools', 'Draft newsletter section on student AI projects',
      'Book the ICT lab for the AI workshop', 'Prepare the PD session on ChatGPT', 'Review the Gemini pilot feedback'];
    check(want.every((t) => md.indexOf(t) >= 0), tag + ': markdown lists Done-in-range and Open newsletter tasks');
    check(md.indexOf('Write Hub workshop recap for newsletter') < 0 && md.indexOf('Set up Chat space for Hub mentors') < 0 && md.indexOf('Plan the AI workshop for staff') < 0, tag + ': markdown excludes old Done, unticked and Personal tasks');
    check(/^# AI Learning Hub — newsletter notes/.test(md) && md.indexOf('## AI Learning Hub') >= 0 && md.indexOf('## PD') >= 0 && md.indexOf('Sent 12 photos') >= 0 && md.indexOf('[link](https://docs.google.com/document/d/1Photos/edit)') >= 0, tag + ': markdown grouped by project with notes and links');
    check(await page.locator('#nl-list h3.group-title').count() >= 2 && await page.locator('#nl-list .item').count() === want.length, tag + ': newsletter list shows ' + want.length + ' items grouped by project');
    await noOverflow(page, tag + ' newsletter');
    await shot(page, tag + '-newsletter');
    await page.click('#nl-copy');
    check(await waitToast(page, 'Newsletter copied as Markdown'), tag + ': copy toast');
    check((await page.evaluate(() => window.__copied || '')) === md, tag + ': clipboard holds the server markdown');
    await clearToasts(page);
    await downloadCheck(page, '#nl-download', 'newsletter-' + TODAY, xlsxOk, tag, 'Newsletter', (ws) =>
      ws.A3 && ws.A3.v === 'Project' && Object.keys(ws).some((k) => /^F\d+$/.test(k) && ws[k].l && ws[k].l.Target === 'https://docs.google.com/document/d/1Photos/edit'));
    await page.fill('#nl-from', '2026-10-09');
    await page.click('#nl-apply');
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('#nl-list .empty')).some((e) => /Loading/.test(e.textContent)));
    await page.waitForTimeout(80);
    const nlCall = calls.filter((c) => c.name === 'getNewsletter').slice(-1)[0];
    check(nlCall.payload.from === '2026-10-09' && nlCall.result.tasks.every((t) => t.status === 'Open' || t.done >= '2026-10-09'), tag + ': narrower range applied on the server');

    // ---- history ----
    await gotoPage(page, 'history');
    const hist = await page.locator('#history-list .item .item-title').allTextContents();
    check(hist.indexOf('Sort out gym membership') >= 0 && hist.indexOf('Draft the Hub newsletter intro') >= 0 && hist.indexOf('Write Hub workshop recap for newsletter') < 0, tag + ': history lists Done tasks in the last 28 days (' + hist.length + ')');
    await noOverflow(page, tag + ' history');
    await shot(page, tag + '-history');
    await page.locator('#history-list .item', { hasText: 'Sort out gym membership' }).locator('button', { hasText: 'Reopen' }).click();
    check(await waitToast(page, 'Reopened: Sort out gym membership'), tag + ': history reopen toast');
    await until(() => { const t = S.find('Personal', 'Sort out gym membership'); return t && t.status === 'Open' && t.done === ''; }, tag + ': reopen from history cleared Done in the sheet');
    fi = await focusInfo(page);
    check(fi.text === 'Reopen' && !!fi.in && fi.in !== 'P-e2e00016', tag + ': Reopen moves focus to the next item\'s Reopen button ' + JSON.stringify(fi));
    await page.selectOption('#h-status', 'Dropped');
    await page.click('#history-filters button[type="submit"]');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#history-list .item')).some((e) => /Dropped/.test(e.textContent)));
    const dropped = await page.locator('#history-list .item .item-title').allTextContents();
    check(dropped.indexOf('Plan the weekend hike') >= 0 && dropped.indexOf('Migrate shared drive folders') < 0, tag + ': Dropped filter (from/to on Created) shows the moved original');
    await clearToasts(page);

    // ---- guard: an intruder is rejected by the server and the UI shows the error ----
    sb.mock.session.activeEmail = 'intruder@example.com';
    await page.goto(url + '?guard=1#today');
    await page.waitForSelector('#boot-error:not([hidden])');
    check((await page.textContent('#boot-error-text')).trim() === 'Not allowed', tag + ': guard() rejection surfaces as the boot error');
    check(await page.isHidden('#page-today') && await page.isHidden('#quickadd'), tag + ': the page sections stay hidden behind the boot error');
    sb.mock.session.activeEmail = 'bbaki@aisa.sch.ae';
    await page.click('#boot-retry');
    await page.waitForSelector('body[data-ready="1"]');
    ok(tag + ': retry after the guard error recovers');
    check(sb.mock.logRows().some((r) => r.fn === 'api.getBootstrap' && /guard rejected/.test(r.message)), tag + ': rejected call logged to the Log tab');
  } catch (e) {
    fail(tag + ': step threw: ' + (e.stack || e));
    try { await shot(page, tag + '-FAILED'); } catch (e2) { /* ignore */ }
  } finally {
    const allowed = (t) => !xlsxOk && /Failed to load resource/.test(t) && /xlsx\.full\.min\.js/.test(t);
    const bad = errors.filter((t) => !allowed(t));
    check(bad.length === 0, tag + ': no console errors or uncaught exceptions' + (bad.length ? '\n  ' + bad.join('\n  ') : ''));
    check(unexpected.length === 0, tag + ': no unexpected network requests' + (unexpected.length ? ' ' + unexpected.join(', ') : ''));
    check(unsafe.length === 0, tag + ': no Date/undefined/function left a server function' + (unsafe.length ? '\n  ' + unsafe.join('\n  ') : ''));
    const errCalls = calls.filter((c) => c.error && c.error !== 'Not allowed');
    check(errCalls.length === 0, tag + ': no server call failed unexpectedly' + (errCalls.length ? '\n  ' + errCalls.map((c) => c.name + ': ' + c.error).join('\n  ') : ''));
    await context.close();
  }
}

/**
 * Clicks a download button and reads the file back: with SheetJS, a one-sheet workbook with column widths
 * and the expected header/hyperlink cells; without it, a BOM-prefixed CSV plus the toast that says so.
 */
async function downloadCheck(page, selector, baseName, xlsxOk, tag, sheetName, cellCheck) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click(selector)]);
  const name = dl.suggestedFilename();
  const dest = path.join(DOWNLOADS, tag + '-' + name);
  await dl.saveAs(dest);
  const buf = fs.readFileSync(dest);
  if (xlsxOk) {
    check(name === baseName + '.xlsx' && buf.slice(0, 2).toString() === 'PK', tag + ': ' + selector + ' downloads ' + name + ' (zip)');
    check(await waitToast(page, 'Downloaded ' + name), tag + ': xlsx toast');
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true }); // cellStyles is needed to read !cols back
      const ws = wb.Sheets[wb.SheetNames[0]];
      check(wb.SheetNames.length === 1 && wb.SheetNames[0] === sheetName, tag + ': workbook has one sheet "' + sheetName + '"');
      check(Array.isArray(ws['!cols']) && ws['!cols'].length >= 4, tag + ': column widths set in ' + name);
      check(!!cellCheck(ws), tag + ': header row and hyperlink cells present in ' + name);
    } catch (e) { fail(tag + ': could not read back ' + name + ': ' + e.message); }
  } else {
    check(name === baseName + '.csv' && buf.toString('utf8').indexOf('﻿') === 0, tag + ': falls back to ' + name + ' (UTF-8 BOM) when SheetJS is missing');
    check(await waitToast(page, 'did not load, so this is a .csv'), tag + ': CSV fallback explained in a toast');
  }
  await clearToasts(page);
  return dest;
}

async function main() {
  const file = assemble({});
  const url = 'file://' + file;
  const xlsxOk = fs.existsSync(XLSX_LOCAL) && sha384(XLSX_LOCAL) === XLSX_SHA384;
  console.log('e2e: ' + file + (xlsxOk ? ' (SheetJS served from node_modules, hash verified)' : ' (SheetJS not available locally: only the CSV fallback runs)'));
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const browser = await launchBrowser();
  try {
    await runScenario(browser, url, { name: 'desktop', width: 1280, height: 900 }, xlsxOk);
    await runScenario(browser, url, { name: 'mobile', width: 390, height: 844 }, xlsxOk);
    // SheetJS blocked on purpose: the Agenda/Newsletter downloads must fall back to CSV and say so (SPEC 8).
    await runScenario(browser, url, { name: 'desktop-noxlsx', width: 1280, height: 900 }, false);
  } finally {
    await browser.close();
  }
  console.log('\nScreenshots:');
  shots.forEach((s) => console.log('  ' + s));
  if (failures.length) { console.error('\n' + failures.length + ' e2e failure(s):\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('\ne2e: all steps passed');
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
