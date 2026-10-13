#!/usr/bin/env node
/*
 * End-to-end check: the real client (apps-script/Index.html + Styles.html + App.html, assembled exactly as
 * doGet() serves it) runs in headless Chromium and talks to the REAL server code — every apps-script/*.gs
 * loaded into the node:vm sandbox over tests/gas-mock.js — through a google.script.run shim whose calls go
 * via page.exposeFunction('__gasCall', …) straight into the entry points of Api.gs (guard(), validation,
 * jsonSafe() and all). The mock sheet is seeded with 17 tasks and 4 inbox items; the scenarios below assert
 * on the DOM and on the sheet state after each flow, at desktop and phone widths and once more with the
 * SheetJS CDN blocked (CSV fallback). A second scenario covers the Desk home page (docs/DESK.md): a fictional
 * desk-data written into the Desk tab as the routine writes it (meta/strip/items/items2/… rows), then landing,
 * lanes and counts, ticks of an item with a row, one with only a desk:<id> row and one with no row (created on
 * tick), unticks, the add box, the agenda block (the saved agenda of agenda.meeting with its copy and download, Full
 * agenda, then the Desk JSON once the week has no rows), the stale, invalid and empty states, and the Tasks tab alongside.
 * The agenda flow covers docs/AGENDA.md: the draft saved as "web-draft", the weekly review written into the sheet while
 * the page is open, a stale save refused with Reload agenda, untouched review lines keeping their tag through a save.
 * Fails (exit 1) on any console error, uncaught page error, unexpected network request, Date/undefined leaking out of a
 * server function, or a failed step.
 *
 *   node tests/e2e.js            (npm test runs it after the unit tests)
 *   E2E_ONLY=desk node tests/e2e.js   (only the Desk scenario; E2E_ONLY=tasks for the other one)
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
const { DESK_BUILT, deskData, deskRows } = require('./fixtures/desk-rows');

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
  'getNewsletter', 'runCaptureNow', 'getLog', 'getDesk', 'setDeskItemDone'];
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

/**
 * What a Claude routine does to the Agenda tab through the Sheets API (docs/AGENDA.md section 3): the week's old rows go
 * (bottom-up), then the new rows are written below the last filled row, Week of as yyyy-MM-dd text, Generated as tag text.
 */
function routineWritesWeek(sb, weekOf, rows, keep) {
  const sheet = sb.mock.sheet('Agenda');
  const last = sheet.getLastRow();
  for (let r = last; r >= 2; r--) {
    const cells = sheet.getRange(r, 1, 1, 8).getValues()[0];
    if (sb.gs.toDateString(cells[0]) === weekOf && !(keep && keep(cells))) sheet.deleteRows(r, 1);
  }
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows.map((r) => [weekOf].concat(r)));
}

/** Sheet readers (through the server's own row mapping, so dates come back as strings). */
function sheetView(sb) {
  const tasks = (tab) => sb.mock.rows(tab).map((r, i) => sb.gs.rowToTask(r, tab, i + 2));
  const inbox = () => sb.gs.readRows('Inbox').map((r) => sb.gs.rowToInboxItem_(r));
  // generated: a tag ("… claude-review", "… web-draft") as the text it is, a Date (Brandon's line) as an ISO date-time
  const agenda = () => sb.gs.readRows('Agenda').map((r) => ({ weekOf: sb.gs.toDateString(r.weekOf), section: String(r.section), order: Number(r.order), item: String(r.item),
    detail: String(r.detail), link: String(r.link), taskId: String(r.taskId), generated: typeof r.generated === 'string' ? r.generated : sb.gs.toDateTimeString(r.generated) }));
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

    // ---- agenda: draft, questions in rule order, save (every line "web-draft"), then the weekly review and Brandon's edits ----
    const agendaValues = (section, sel) => page.locator('[data-section="' + section + '"] .arow ' + (sel || 'textarea')).evaluateAll((els) => els.map((e) => e.value));
    await gotoPage(page, 'agenda');
    check((await page.inputValue('#agenda-date')) === '2026-10-13', tag + ': meeting date defaults to the next Tuesday');
    check(/Tue 6 Oct – Mon 12 Oct/.test(await page.textContent('#agenda-window')), tag + ': window shown on the draft ' + (await page.textContent('#agenda-window')));
    check((await page.textContent('#agenda-state')).trim() === 'Draft', tag + ': no saved rows → Draft');
    check(/With Dr Sarah Mitchell/.test(await page.textContent('#agenda-director')), tag + ': director name from Config');
    const draftCall = calls.filter((c) => c.name === 'getAgenda').slice(-1)[0].result;
    check(/^[0-9a-f]{16}$/.test(draftCall.stamp) && ['Done', 'In progress', 'Questions', 'Documents'].every((sec) => draftCall.sections[sec].every((r) => r.generated === 'web-draft')),
      tag + ': getAgenda answers with the week\'s stamp, every draft row generated "web-draft"');
    const doneItems = await agendaValues('Done');
    check(JSON.stringify(doneItems) === JSON.stringify(['Share workshop photos with comms team', 'Set up Chat space for Hub mentors', 'Test AI tutor pilot with Grade 8']), tag + ': Done section: Done-in-window Work tasks by project then date ' + JSON.stringify(doneItems));
    const doneDetail = (await agendaValues('Done', 'input[aria-label="Detail"]'))[0];
    check(doneDetail === 'AI Learning Hub · Sent 12 photos', tag + ': Done detail = "Project · note"');
    check(await page.locator('[data-section="Done"] .arow a', { hasText: 'Open ↗' }).count() === 3 && await page.locator('[data-section="Done"] .arow textarea[aria-label="Done item"]').count() === 3,
      tag + ': Done rows are editable and keep their Open ↗ links');
    const progress = await agendaValues('In progress');
    check(progress.length >= 5 && progress[0] === 'Review Grade 10 Design unit plan draft' && progress[1] === 'Coordinate single sign-on for the Hub portal' && progress.indexOf('Order replacement micro:bits') >= 0 && progress.indexOf('Send Hub numbers to Sarah before Tuesday') >= 0 && progress.indexOf('Update the department website links') < 0,
      tag + ': In progress: High first (due before undated), then Discuss / created-in-window; stale task excluded ' + JSON.stringify(progress));
    const questions = await agendaValues('Questions');
    check(JSON.stringify(questions) === JSON.stringify(EXPECTED_QUESTIONS), tag + ': the 8 rule-based questions fire in rule order\n  got: ' + JSON.stringify(questions));
    const docs = await agendaValues('Documents', 'input[type="text"]');
    const docLinks = await agendaValues('Documents', 'input[type="url"]');
    check(JSON.stringify(docs) === JSON.stringify(['Share workshop photos with comms team', 'Set up Chat space for Hub mentors', 'Test AI tutor pilot with Grade 8']) && docLinks[1] === 'https://chat.google.com/room/AAAAmentors',
      tag + ': Documents: distinct links of Discuss/Done-in-window tasks ' + JSON.stringify(docs));
    check(await page.locator('[data-section="Notes"] .arow').count() === 0, tag + ': Notes empty in the draft');
    await noOverflow(page, tag + ' agenda');
    await shot(page, tag + '-agenda');
    const n1 = await page.locator('#agenda-sections .arow').count(); // 3 Done + In progress + 8 Questions + 3 Documents
    check(n1 === 14 + progress.length, tag + ': draft has ' + n1 + ' rows');
    await page.click('#agenda-save');
    check(await waitToast(page, 'Agenda saved (' + n1 + ' rows)'), tag + ': save toast with the row count');
    check((await page.textContent('#agenda-state')).trim() === 'Saved' && (await page.textContent('#agenda-window')) === '', tag + ': badge flips to Saved; the window line goes');
    let saved = S.agenda();
    check(saved.length === n1 && saved.every((r) => r.weekOf === '2026-10-12' && r.generated === '2026-10-10 09:30 web-draft'),
      tag + ': Agenda tab holds ' + n1 + ' rows for week of 2026-10-12, each Generated "2026-10-10 09:30 web-draft" (the draft saved unchanged)');
    const saveCall = calls.filter((c) => c.name === 'saveAgenda').slice(-1)[0];
    check(saveCall.payload.stamp === draftCall.stamp && /^[0-9a-f]{16}$/.test(saveCall.result.stamp) && saveCall.result.stamp !== draftCall.stamp, tag + ': save sent the draft\'s stamp and got the new one');
    check(JSON.stringify(saved.filter((r) => r.section === 'Questions').map((r) => r.item)) === JSON.stringify(EXPECTED_QUESTIONS) && saved.filter((r) => r.section === 'Questions').map((r) => r.order).join() === '1,2,3,4,5,6,7,8',
      tag + ': Questions rows saved in order 1..8');
    check(saved.filter((r) => r.section === 'Done')[0].taskId === 'W-e2e00004' && saved.filter((r) => r.section === 'Documents')[1].link === 'https://chat.google.com/room/AAAAmentors', tag + ': Task ID and Link columns saved');
    await clearToasts(page);
    // reload the page (a query string forces a real load; a fragment-only change would be same-document): saved rows win over the draft
    await page.goto(url + '?reload=1#agenda');
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-section="Questions"] .arow').length > 0);
    const reloadCall = calls.filter((c) => c.name === 'getAgenda').slice(-1)[0].result;
    check((await page.textContent('#agenda-state')).trim() === 'Saved' && reloadCall.saved === true && reloadCall.stamp === saveCall.result.stamp &&
      reloadCall.sections.Done.every((r) => r.generated === '2026-10-10 09:30 web-draft'), tag + ': getAgenda returns the saved rows (saved:true, generated read back, the save\'s stamp) after reload');

    // ---- the weekly review rewrites the week while the page is open: entering the page reads it again ----
    const REVIEW = '2026-10-10 09:31 claude-review';
    const reviewRows = [
      ['Done', 1, 'Hub mentors on board', 'Eight mentors in the Chat space', 'https://chat.google.com/room/AAAAmentors', 'W-e2e00005', REVIEW],
      ['Done', 2, 'AI tutor pilot run with Grade 8', '22 of 24 students used the hints mode', '', 'W-e2e00006', REVIEW],
      ['In progress', 1, 'Grade 10 Design unit plan', 'Rubric with Lina by Tuesday', 'https://docs.google.com/document/d/1AbCdEf/edit', 'W-e2e00009', REVIEW],
      ['In progress', 2, 'Single sign-on for the Hub portal', 'Waiting on IT for a date', '', 'W-e2e00008', REVIEW],
      ['Questions', 1, 'Can we fund twelve replacement micro:bits from the club budget?', 'Finance needs the code by Thursday', '', 'W-e2e00003', REVIEW],
      ['Questions', 2, 'Should the Hub numbers go to the board on Wednesday?', '', '', '', REVIEW],
      ['Questions', 3, 'Anything from your side for my list next week?', '', '', '', REVIEW],
      ['Documents', 1, 'Unit plan draft', 'The rubric to agree', 'https://docs.google.com/document/d/1AbCdEf/edit', 'W-e2e00009', REVIEW]
    ];
    routineWritesWeek(sb, '2026-10-12', reviewRows);
    await gotoPage(page, 'today');
    await gotoPage(page, 'agenda');
    check(JSON.stringify(await agendaValues('Done')) === JSON.stringify(['Hub mentors on board', 'AI tutor pilot run with Grade 8']) && (await agendaValues('Questions')).length === 3,
      tag + ': opening the Agenda page re-reads it and shows the review\'s rows');

    // ---- a save on a page opened before the sheet changed is refused; Reload agenda shows the new rows ----
    routineWritesWeek(sb, '2026-10-12', reviewRows.slice(0, 6).concat([['Questions', 3, 'Is the PD day on 2 November still on?', '', '', '', REVIEW],
      ['Questions', 4, 'Anything from your side for my list next week?', '', '', '', REVIEW], reviewRows[7]]));
    const beforeConflict = JSON.stringify(S.agenda());
    await page.locator('[data-section="Questions"] .arow').first().locator('textarea').fill('An edit on an agenda that changed');
    await page.click('#agenda-save');
    check(await waitToast(page, "This agenda changed since you opened it (Claude's weekly review or another tab saved it). Copy any edits you want to keep, then reload the agenda."),
      tag + ': the stale save is refused with the server\'s message');
    check(JSON.stringify(S.agenda()) === beforeConflict && calls.filter((c) => c.name === 'saveAgenda').slice(-1)[0].error, tag + ': nothing was written to the Agenda tab');
    check((await agendaValues('Questions'))[0] === 'An edit on an agenda that changed', tag + ': the edits stay on the page to copy');
    await page.waitForTimeout(300); // the toast's rise animation
    await shot(page, tag + '-agenda-conflict');
    await page.locator('.toast .act', { hasText: 'Reload agenda' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-section="Questions"] .arow').length === 4);
    const reloadedQ = await agendaValues('Questions');
    check(reloadedQ[2] === 'Is the PD day on 2 November still on?' && reloadedQ.indexOf('An edit on an agenda that changed') < 0 && (await page.textContent('#agenda-state')).trim() === 'Saved',
      tag + ': Reload agenda drops the edits and shows the rows now in the sheet');
    await clearToasts(page);

    // ---- generated round trip: untouched review lines keep their tag; an edited (text or only Detail) or added line is Brandon's ----
    await page.locator('[data-section="Done"] .arow').nth(1).locator('textarea').fill('AI tutor pilot finished with Grade 8');
    await page.locator('[data-section="In progress"] .arow').nth(1).locator('input[aria-label="Detail"]').fill('IT gave 4 November as the date');
    await page.locator('[data-section="Questions"] button.add').click();
    await page.locator('[data-section="Questions"] .arow').last().locator('textarea').fill('Can I present the pilot at the next staff meeting?');
    await page.click('#agenda-save');
    check(await waitToast(page, 'Agenda saved (10 rows)'), tag + ': the edited agenda saves (10 rows)');
    saved = S.agenda();
    const gen = (item) => (saved.find((r) => r.item === item) || {}).generated;
    check(gen('Hub mentors on board') === REVIEW && gen('Grade 10 Design unit plan') === REVIEW && gen('Is the PD day on 2 November still on?') === REVIEW && gen('Unit plan draft') === REVIEW,
      tag + ': untouched review lines keep "' + REVIEW + '"');
    check(gen('AI tutor pilot finished with Grade 8') === '2026-10-10T09:30:00+04:00' && gen('Can I present the pilot at the next staff meeting?') === '2026-10-10T09:30:00+04:00',
      tag + ': the edited and the added line are Brandon\'s (the save time as a date-time) ' + JSON.stringify([gen('AI tutor pilot finished with Grade 8')]));
    check(gen('Single sign-on for the Hub portal') === '2026-10-10T09:30:00+04:00' && saved.find((r) => r.item === 'Single sign-on for the Hub portal').detail === 'IT gave 4 November as the date',
      tag + ': a review line whose Detail alone was edited is Brandon\'s too ' + JSON.stringify([gen('Single sign-on for the Hub portal')]));
    check(saved.find((r) => r.item === 'Hub mentors on board').link === 'https://chat.google.com/room/AAAAmentors' && saved.find((r) => r.item === 'Hub mentors on board').taskId === 'W-e2e00005', tag + ': the review line\'s link and Task ID survive the round trip');
    check(await page.locator('[data-section="Done"] .arow a', { hasText: 'Open ↗' }).count() === 1, tag + ': the review\'s Done link shows as Open ↗');
    await clearToasts(page);

    // ---- another tab saves a Note; coming back to the page shows it ----
    routineWritesWeek(sb, '2026-10-12', [['Notes', 1, 'Andy asked for the pilot numbers', '', '', '', sb.gs.parseDate('2026-10-10T09:30:00+04:00')]], () => true);
    await gotoPage(page, 'today');
    await gotoPage(page, 'agenda');
    check(JSON.stringify(await agendaValues('Notes')) === JSON.stringify(['Andy asked for the pilot numbers']), tag + ': the page re-read the week on entry');

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
    const nq = await page.locator('[data-section="Questions"] .arow').count(); // 4 from the review, Brandon's, the new one
    await page.locator('[data-section="Questions"] .arow').last().locator('button[aria-label="Move up"]').click();
    let fa = await focusedAgenda();
    check(fa.label === 'Move up' && fa.section === 'Questions' && fa.index === nq - 2, tag + ': Move up keeps focus on the moved row ' + JSON.stringify(fa));
    await page.keyboard.press('Enter'); // the same (focused) Move up: the row climbs again
    fa = await focusedAgenda();
    check(fa.label === 'Move up' && fa.index === nq - 3, tag + ': pressing Enter on the refocused button moves the row again ' + JSON.stringify(fa));
    await page.locator('[data-section="Questions"] .arow').nth(nq - 3).locator('button[aria-label="Move down"]').click();
    await page.locator('[data-section="Questions"] .arow').nth(nq - 2).locator('button[aria-label="Move down"]').click();
    fa = await focusedAgenda();
    check(fa.label === 'Move up' && fa.index === nq - 1, tag + ': Move down onto the last row (its Move down is disabled) focuses that row\'s Move up ' + JSON.stringify(fa));
    await page.locator('[data-section="Done"] .arow').first().locator('button[aria-label="Remove"]').click();
    fa = await focusedAgenda();
    check(fa.label === 'Remove' && fa.section === 'Done' && fa.index === 0, tag + ': Remove focuses the Remove button of the row that took its place ' + JSON.stringify(fa));
    await page.locator('[data-section="Notes"] button.add').click();
    await page.locator('[data-section="Notes"] .arow').last().locator('textarea').fill('Sarah wants the Hub numbers before the board meeting.');
    await shot(page, tag + '-agenda-edited');
    const n2 = await page.locator('#agenda-sections .arow').count();
    await page.click('#agenda-save');
    check(await waitToast(page, 'Agenda saved (' + n2 + ' rows)'), tag + ': second save (one Done row removed, a question and a note added)');
    saved = S.agenda();
    const savedQ = saved.filter((r) => r.section === 'Questions').map((r) => r.item);
    check(savedQ.length === nq && savedQ[0] === 'Launch note: can we send it Monday instead?' && savedQ[nq - 1] === 'Can we fund two more micro:bit kits this term?' && saved.filter((r) => r.section === 'Done').length === 1 && saved.filter((r) => r.section === 'Notes').length === 2,
      tag + ': edited/added Questions, removed Done item and the Note are in the sheet');
    check(saved.find((r) => r.item === 'Andy asked for the pilot numbers').generated === '2026-10-10T09:30:00+04:00', tag + ': the other tab\'s Note stays Brandon\'s');
    await clearToasts(page);
    await page.click('#agenda-regenerate');
    check(await waitToast(page, 'Draft regenerated'), tag + ': regenerate toast');
    const regenQ = await agendaValues('Questions');
    const regenDone = await page.locator('[data-section="Done"] .arow').count();
    const regenNotes = await agendaValues('Notes');
    check(JSON.stringify(regenQ) === JSON.stringify(savedQ) && regenDone === 3 && regenNotes[1] === 'Sarah wants the Hub numbers before the board meeting.' && (await page.textContent('#agenda-state')).trim() === 'Draft',
      tag + ': regenerate rebuilds Done (3 again) but keeps the saved Questions and Notes; flagged Draft');
    const regenCall = calls.filter((c) => c.name === 'regenerateAgenda').slice(-1)[0].result;
    check(regenCall.sections.Done.every((r) => r.generated === 'web-draft') && regenCall.sections.Questions[1].generated === REVIEW && regenCall.stamp === calls.filter((c) => c.name === 'saveAgenda').slice(-1)[0].result.stamp,
      tag + ': regenerated rows are "web-draft", kept Questions keep their generated, and the stamp is the sheet\'s');
    check(S.agenda().length === n2, tag + ': regenerate does not write to the Agenda tab');
    const readsBefore = calls.filter((c) => c.name === 'getAgenda').length;
    await gotoPage(page, 'today');
    await gotoPage(page, 'agenda');
    check(calls.filter((c) => c.name === 'getAgenda').length === readsBefore && (await page.textContent('#agenda-state')).trim() === 'Draft' && await page.locator('[data-section="Done"] .arow').count() === 3,
      tag + ': a regenerated draft counts as unsaved: coming back to the page keeps it');
    await clearToasts(page);
    // SPEC 8: one sheet "Agenda", title rows, Section/Item/Detail/Link header on row 5 (a draft has its window row), real hyperlinks, column widths.
    await downloadCheck(page, '#agenda-download', 'agenda-2026-10-13', xlsxOk, tag, 'Agenda', (ws) =>
      ws.A5 && ws.A5.v === 'Section' && /^Window: /.test(ws.A2.v) && Object.keys(ws).some((k) => /^D\d+$/.test(k) && ws[k].l && ws[k].l.Target === 'https://chat.google.com/room/AAAAmentors'));
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
    // "Not allowed" (the guard step) and the agenda conflict (the stale-save step) are expected refusals
    const errCalls = calls.filter((c) => c.error && c.error !== 'Not allowed' && !(c.name === 'saveAgenda' && /^This agenda changed since you opened it/.test(c.error)));
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

// ---------------------------------------------------------------------------
// The Desk home page (docs/DESK.md) against the real getDesk / setDeskItemDone / addTask
// ---------------------------------------------------------------------------

// Fixed clock: Tuesday 2026-10-13 10:00 in Dubai (06:00Z), the morning of the fixture build (DESK_BUILT 2026-10-13 06:45).
const DESK_NOW = '2026-10-13T06:00:00Z';
const DESK_TODAY = '2026-10-13';
const DESK_STALE_BUILT = '2026-10-12 06:45';
const AISA_MAIL = 'https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#';
const PERSONAL_THREAD = 'https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:';
const DESK_DIRECTOR = 'Dr Sam Example';

/**
 * Writes `rows` ([Key, JSON, Built]) into the Desk tab the way the routine does (DESK.md section 4): clear Desk!A2:C,
 * then write every row in one call. The rows are written in reverse key order, since row order must not matter.
 */
function writeDeskTab(sb, rows) {
  const sheet = sb.mock.sheet('Desk');
  const last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, 3).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 3).setValues(rows.slice().reverse());
}

/**
 * Seed for the Desk scenario (all fictional): the fixture desk-data with `items` split into several rows, and tracker
 * rows that cover the three ways an item meets the tracker: "slides" has a row by its `task` ID (W-fx000001), "receipts"
 * only a row with Source key desk:receipts, "plumber" and "budget" no row at all (the tick creates it). "dentist"
 * (P-fx000002) is already Done, so it renders ticked. Two Open Manual tasks are "Added by you"; one Import task is not.
 */
function seedDeskSheet(sb) {
  const gs = sb.gs;
  const task = (o) => Object.assign({
    id: '', category: 'Work', created: '2026-10-12', title: '', details: '', source: 'Claude', link: '', status: 'Open', done: '',
    note: '', project: '', newsletter: false, discuss: false, due: '', priority: 'Normal', sourceKey: '', updated: '2026-10-12T07:00:00+04:00'
  }, o);
  sb.mock.seed('Config', [['DIRECTOR_NAME', DESK_DIRECTOR, '']]);
  const work = [
    task({ id: 'W-fx000001', title: 'Finish the Year 8 slides', details: 'Before Thursday.', link: 'https://docs.example.org/slides/y8', note: 'Outline done' }),
    task({ id: 'W-dk000002', title: 'Forward the conference receipts', sourceKey: 'desk:receipts' }),
    task({ id: 'W-dk000003', title: 'Mark the Year 9 essays', source: 'Import', sourceKey: 'import:0000000000000000000000000000000000000001', created: '2026-10-09' }),
    task({ id: 'W-dk000004', title: 'Print the club certificates', source: 'Manual', created: '2026-10-12' })
  ];
  const personal = [
    task({ id: 'P-fx000002', category: 'Personal', title: 'Book the dentist', status: 'Done', done: '2026-10-12', updated: '2026-10-12T18:00:00+04:00' }),
    task({ id: 'P-dk000005', category: 'Personal', title: 'Collect the dry cleaning', source: 'Manual', created: DESK_TODAY, updated: DESK_TODAY + 'T08:00:00+04:00' })
  ];
  sb.mock.seed('Work', work.map((t) => gs.taskToRow(t, gs.parseDate(t.updated))));
  sb.mock.seed('Personal', personal.map((t) => gs.taskToRow(t, gs.parseDate(t.updated))));
  // The agenda for the Desk's meeting (Tue 20 Oct, Week of 2026-10-19) as the live sheet holds it: the morning build's lines
  // (claude-desk), plus a Documents row and a Note Brandon saved (a date-time in Generated).
  const MORNING = '2026-10-13 06:45 claude-desk';
  const mine = gs.parseDate('2026-10-12T17:20:00+04:00');
  sb.mock.seed('Agenda', [
    ['2026-10-19', 'Done', 1, 'Robotics kits ordered', 'Arrived on Monday', '', '', MORNING],
    ['2026-10-19', 'Done', 2, 'Reading week plan shared', 'Book list sent to staff', '', '', MORNING],
    ['2026-10-19', 'In progress', 1, 'Year 8 slides', 'Due Thursday', 'https://docs.example.org/slides/y8', 'W-fx000001', MORNING],
    ['2026-10-19', 'Questions', 1, 'Can the club budget move to next term?', '', '', '', MORNING],
    ['2026-10-19', 'Questions', 2, 'Anything from your side for my list next week?', '', '', '', MORNING],
    ['2026-10-19', 'Documents', 1, 'Club budget form', 'To sign', 'https://forms.example.org/club-budget', '', mine],
    ['2026-10-19', 'Notes', 1, 'Ask about the reading week', '', '', '', mine]
  ]);
  // 900 characters per JSON cell instead of 45 000, so the nine fixture items need items, items2, items3, …
  const rows = deskRows(deskData(), DESK_BUILT, { maxChars: 900 });
  writeDeskTab(sb, rows);
  gs.resetMemos();
  return rows;
}

/** The board as the page shows it: meter, lane counts, open cards per lane, done cards. */
function deskBoard(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#desk-board .dk-item:not(.pending)'));
    const lanes = Array.from(document.querySelectorAll('#desk-board .dk-lane')).map((l) => ({ key: l.getAttribute('data-lane'), title: l.querySelector('h2').textContent,
      count: l.querySelector('.dk-count').textContent, open: l.querySelectorAll('.dk-item:not(.done):not(.pending)').length,
      keys: Array.from(l.querySelectorAll('.dk-item')).map((c) => c.getAttribute('data-key')) }));
    const meter = document.getElementById('desk-done');
    return { meter: meter ? meter.textContent : '', bar: (document.getElementById('desk-bar') || { style: {} }).style.width, total: cards.length,
      done: cards.filter((c) => c.classList.contains('done')).map((c) => c.getAttribute('data-key')), lanes: lanes };
  });
}
function boardConsistent(b) { return b.meter === b.done.length + ' / ' + b.total && b.lanes.every((l) => l.count === l.open + ' open'); }
/** Ticks or unticks a Desk card through its checkbox (a click on the 40 px label's input, as a tap does). */
async function deskTick(page, key) { await page.click('[data-key="' + key + '"] input[data-role="check"]'); }
async function deskSettled(page) {
  await page.waitForFunction(() => { const s = document.getElementById('desk-sync'); return !s || !/Saving/.test(s.textContent); }, null, { timeout: 5000 });
  await page.waitForTimeout(60);
}
/** The workbook (or CSV) rows of a download, trailing empty cells dropped. */
function downloadRows(buf, isXlsx) {
  let rows;
  if (isXlsx) {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: true, raw: false });
    rows.sheetNames = wb.SheetNames;
  } else {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    rows = text.split(/\r\n/).map((line) => {
      const out = [];
      let cur = '', quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
        else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur);
      return out;
    });
  }
  const trimmed = rows.map((r) => { const x = r.map((c) => String(c)); while (x.length && x[x.length - 1] === '') x.pop(); return x; });
  if (rows.sheetNames) trimmed.sheetNames = rows.sheetNames;
  return trimmed;
}

async function runDeskScenario(browser, url, vp, xlsxOk) {
  const tag = 'desk-' + vp.name;
  const sb = createSandbox({ now: DESK_NOW });
  const deskRowsWritten = seedDeskSheet(sb);
  const S = sheetView(sb);
  const DESK_URL = sb.eval('DESK_URL');
  const calls = [];
  const lastCall = (name) => calls.filter((c) => c.name === name).slice(-1)[0] || null;
  const { context, page, errors, unexpected, unsafe } = await openPage(browser, sb, vp, calls, xlsxOk);
  try {
    // ---- the seed really is split the way the routine writes it ----
    const keys = deskRowsWritten.map((r) => r[0]);
    check(keys[0] === 'meta' && keys.indexOf('items') > 0 && keys.indexOf('items2') > 0 && keys.indexOf('items3') > 0 && deskRowsWritten.every((r) => r[2] === DESK_BUILT && /^[[{"n]/.test(r[1])),
      tag + ': the Desk tab holds meta/strip/items/items2/…/quick rows, Built ' + DESK_BUILT + ' ' + JSON.stringify(keys));
    check(sb.mock.rows('Desk')[0][0] === 'quick', tag + ': rows written in reverse key order (row order must not matter)');

    // ---- landing: no hash opens the Desk ----
    await page.goto(url);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
    await page.waitForSelector('#desk-board .dk-item');
    check(sb.gs.todayDubai() === DESK_TODAY, tag + ': server today is ' + DESK_TODAY + ' (Dubai, fixed clock)');
    const landing = await page.evaluate(() => ({
      desk: !document.getElementById('page-desk').hidden, today: !document.getElementById('page-today').hidden,
      active: Array.from(document.querySelectorAll('#tabs a.active')).map((a) => a.getAttribute('data-page')),
      labels: Array.from(document.querySelectorAll('#tabs a')).map((a) => a.childNodes[0].textContent.trim())
    }));
    check(landing.desk && !landing.today && JSON.stringify(landing.active) === '["desk"]', tag + ': with no hash the Desk is the landing page ' + JSON.stringify(landing));
    check(JSON.stringify(landing.labels) === JSON.stringify(['Desk', 'Tasks', 'Inbox', 'Import', 'Agenda', 'Newsletter', 'History']), tag + ': tabs: Desk first, Today renamed Tasks ' + JSON.stringify(landing.labels));
    const gd = lastCall('getDesk');
    const res = gd && gd.result;
    check(!!res && res.ok === true && res.builtAt === DESK_BUILT && res.builtDate === DESK_TODAY && res.stale === false && res.deskUrl === DESK_URL,
      tag + ': getDesk read the Desk tab: ok, builtAt, builtDate, not stale, deskUrl');
    if (res && res.ok) {
      check(JSON.stringify(res.desk.items.map((i) => i.id)) === JSON.stringify(deskData().items.map((i) => i.id)),
        tag + ': items, items2, items3, … joined in numeric key order (rows were written in reverse) ' + JSON.stringify(res.desk.items.map((i) => i.id)));
      const by = {}; res.desk.items.forEach((i) => { by[i.id] = i; });
      check(by.slides.taskId === 'W-fx000001' && by.slides.status === 'Open' && by.slides.done === false && by.slides.category === 'Work', tag + ': "slides" matched its row by task ID');
      check(by.receipts.taskId === 'W-dk000002' && by.receipts.category === 'Work', tag + ': "receipts" matched its row by Source key desk:receipts');
      check(by.plumber.taskId === '' && by.plumber.category === 'Personal' && by.budget.taskId === '' && by.budget.category === 'Work', tag + ': "plumber" and "budget" have no row yet (Personal by its home tag, Work)');
      check(by.dentist.taskId === 'P-fx000002' && by.dentist.status === 'Done' && by.dentist.done === true, tag + ': "dentist" row is Done');
      check(JSON.stringify(res.added.map((t) => t.id)) === JSON.stringify(['P-dk000005', 'W-dk000004']), tag + ': added = the Open Manual tasks, newest Created first ' + JSON.stringify(res.added.map((t) => t.id)));
      check(res.desk.rebuild === undefined && res.desk.agenda && res.desk.llt && res.desk.lanes.length === 3, tag + ': meta.rebuild is not passed on; agenda and llt present');
    }

    // ---- lanes, cards and counts ----
    let b = await deskBoard(page);
    check(JSON.stringify(b.lanes.map((l) => [l.key, l.title])) === JSON.stringify([['now', 'Do today'], ['reply', 'Reply & follow up'], ['later', 'This week']]), tag + ': three lanes titled from meta.lanes');
    check(JSON.stringify(b.lanes.map((l) => l.keys)) === JSON.stringify([
      ['a:P-dk000005', 'a:W-dk000004', 'i:slides', 'i:plumber', 'i:budget', 'i:bakesale'], ['i:parent', 'i:receipts'], ['i:assembly', 'i:repo', 'i:dentist']]),
      tag + ': cards in their lanes, "Added by you" at the top of the first ' + JSON.stringify(b.lanes.map((l) => l.keys)));
    check(boardConsistent(b) && b.meter === '1 / 11' && JSON.stringify(b.lanes.map((l) => l.count)) === '["6 open","2 open","2 open"]' && JSON.stringify(b.done) === '["i:dentist"]',
      tag + ': meter 1 / 11 and lane counts 6 / 2 / 2 open; the Done row renders ticked ' + JSON.stringify([b.meter, b.lanes.map((l) => l.count), b.done]));
    check(await page.locator('[data-key="i:dentist"] input[data-role="check"]:checked').count() === 1, tag + ': the ticked card\'s checkbox is checked');
    const cardInfo = await page.evaluate(() => {
      const card = (k) => document.querySelector('[data-key="' + k + '"]');
      const links = (k) => Array.from(card(k).querySelectorAll('.dk-lnk')).map((a) => [a.tagName, a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]);
      const tags = (k) => Array.from(card(k).querySelectorAll('.dk-tag')).map((t) => [t.className, t.textContent]);
      return { slides: links('i:slides'), receipts: links('i:receipts'), plumber: links('i:plumber'), repo: links('i:repo'), tagsPlumber: tags('i:plumber'), tagsAdded: tags('a:P-dk000005'),
        title: card('i:slides').querySelector('.dk-title').textContent, why: card('i:slides').querySelector('.dk-why').textContent,
        js: document.querySelectorAll('#page-desk a[href^="javascript"], #page-desk a:not([href])').length };
    });
    check(JSON.stringify(cardInfo.slides) === JSON.stringify([['A', 'Thread', AISA_MAIL + 'all/18f2a0c3d4e5f601', '_blank', 'noopener'], ['A', 'Slides', 'https://docs.example.org/slides/y8', '_blank', 'noopener']]),
      tag + ': wt: and https links ' + JSON.stringify(cardInfo.slides));
    check(cardInfo.receipts[0] && cardInfo.receipts[0][2] === AISA_MAIL + 'search/from%3Aoffice+receipts', tag + ': w: search link');
    check(cardInfo.plumber[0] && cardInfo.plumber[0][2] === PERSONAL_THREAD + '1790000000000000001', tag + ': p: personal thread link');
    check(JSON.stringify(cardInfo.repo.map((x) => [x[0], x[1], x[2]])) === JSON.stringify([['SPAN', 'Bad', null], ['A', 'Repo', 'https://git.example.org/club/robots']]) && cardInfo.js === 0,
      tag + ': a javascript: target is plain text, never a link');
    check(JSON.stringify(cardInfo.tagsPlumber) === JSON.stringify([['dk-tag dk-tag-home', 'Personal'], ['dk-tag dk-tag-due', 'Today'], ['dk-tag', 'Email']]), tag + ': tag chips keep their kinds ' + JSON.stringify(cardInfo.tagsPlumber));
    check(JSON.stringify(cardInfo.tagsAdded) === JSON.stringify([['dk-tag dk-tag-list', 'Added by you'], ['dk-tag dk-tag-home', 'Personal']]), tag + ': an added task carries the "Added by you" chip');
    check(cardInfo.title === 'Finish the Year 8 slides' && cardInfo.why === "Ms Rivera needs them before Thursday's lesson.", tag + ': card title and why from the Desk data');
    const parts = await page.evaluate(() => ({
      eyebrow: document.getElementById('desk-eyebrow').textContent, days: document.querySelectorAll('#desk-strip .dk-day').length,
      cleared: Array.from(document.querySelectorAll('#desk-cleared span')).map((e) => e.textContent), prio: document.querySelectorAll('#desk-priorities article').length,
      coming: document.querySelectorAll('#desk-coming li').length, llt: !!document.getElementById('desk-llt'), quick: document.querySelectorAll('#desk-quick > *').length,
      agendaOpen: document.getElementById('desk-agenda').open, foot: document.getElementById('desk-foot').textContent,
      open: document.getElementById('desk-open') && document.getElementById('desk-open').getAttribute('href'), stale: !!document.getElementById('desk-stale')
    }));
    check(parts.eyebrow === 'Tuesday 13 October 2026 · Week 7' && parts.days === 4 && JSON.stringify(parts.cleared) === '["Marked the Year 7 quizzes","Sent the field-trip list"]' &&
      parts.prio === 2 && parts.coming === 2 && parts.llt && parts.quick === 2, tag + ': eyebrow, strip, cleared, priorities, coming up, LLT and quick links render');
    check(parts.foot === 'Built Tue 13 Oct, 6:45am Gulf time from school mail, Chat, the calendar and personal mail. Open the Desk page' && parts.open === DESK_URL && !parts.stale,
      tag + ': footer "Built … from …." with the Desk page link, no stale note ' + JSON.stringify(parts.foot));
    check(parts.agendaOpen === false, tag + ': the agenda block starts closed (agenda.open is false)');
    await noOverflow(page, tag);
    await shot(page, tag + '-home');
    const workRows0 = S.tasks('Work').length;
    const personalRows0 = S.tasks('Personal').length;

    // ---- tick an item whose row exists by task ID → that row Done today; the note after the tick → updateTask ----
    await deskTick(page, 'i:slides');
    let row = await until(() => { const t = S.find('Work', 'Finish the Year 8 slides'); return t && t.status === 'Done' ? t : null; }, tag + ': ticking "slides" completed W-fx000001');
    if (row) check(row.id === 'W-fx000001' && row.done === DESK_TODAY && row.note === 'Outline done', tag + ': Done = today (Dubai), the row keeps its note ' + JSON.stringify([row.done, row.note]));
    check(JSON.stringify(lastCall('setDeskItemDone').payload) === JSON.stringify({ itemId: 'slides', done: true }), tag + ': setDeskItemDone({itemId, done:true})');
    check(await waitToast(page, 'Done: Finish the Year 8 slides'), tag + ': tick toast');
    await deskSettled(page);
    b = await deskBoard(page);
    check(boardConsistent(b) && b.meter === '2 / 11' && b.done.indexOf('i:slides') >= 0 && b.lanes[0].count === '5 open', tag + ': card ticked, meter 2 / 11, first lane 5 open');
    check(await page.locator('[data-key="i:slides"] .dk-note input').count() === 1, tag + ': the optional note field opens under the ticked card');
    await page.fill('[data-key="i:slides"] .dk-note input', 'Shared with the team');
    await shot(page, tag + '-note');
    await page.press('[data-key="i:slides"] .dk-note input', 'Enter');
    row = await until(() => { const t = S.find('Work', 'Finish the Year 8 slides'); return t && t.note === 'Outline done · Shared with the team' ? t : null; }, tag + ': Enter saved the note, joined to the existing one');
    check(JSON.stringify(lastCall('updateTask').payload) === JSON.stringify({ category: 'Work', id: 'W-fx000001', patch: { note: 'Outline done · Shared with the team' } }), tag + ': the note goes through updateTask patch note');
    check(await waitToast(page, 'Note saved: Finish the Year 8 slides'), tag + ': note toast');
    await clearToasts(page);

    // ---- tick an item that only has a desk:<id> row → that row Done, nothing created ----
    await deskTick(page, 'i:receipts');
    row = await until(() => { const t = S.find('Work', 'Forward the conference receipts'); return t && t.status === 'Done' ? t : null; }, tag + ': ticking "receipts" completed its desk:receipts row');
    if (row) check(row.id === 'W-dk000002' && row.done === DESK_TODAY, tag + ': the desk-key row is the one completed');
    await deskSettled(page);
    check(S.tasks('Work').length === workRows0 && S.tasks('Personal').length === personalRows0, tag + ': no row created for items that had one');
    await page.press('[data-key="i:receipts"] .dk-note input', 'Escape');
    check(await page.locator('[data-key="i:receipts"] .dk-note').count() === 0, tag + ': Escape dismisses the note field');
    await clearToasts(page);

    // ---- tick an item with no row → the row is created (createTasks semantics) and completed ----
    await deskTick(page, 'i:plumber');
    row = await until(() => { const t = S.tasks('Personal').find((x) => x.sourceKey === 'desk:plumber'); return t && t.status === 'Done' ? t : null; }, tag + ': ticking "plumber" created a Personal row and completed it');
    if (row) {
      check(/^P-[a-z0-9]{8}$/.test(row.id) && row.title === 'Call the plumber about the leak' && row.details === 'He can come today or on Monday.' && row.source === 'Gmail' &&
        row.link === PERSONAL_THREAD + '1790000000000000001' && row.created === DESK_TODAY && row.done === DESK_TODAY && row.due === DESK_TODAY && row.priority === 'High' && row.updated.indexOf(DESK_TODAY) === 0,
        tag + ': created row: P- id, Title, Details = why, Source Gmail (Email tag), Link = p: expanded, Created/Done/Due today, High (now lane, due today) ' +
        JSON.stringify([row.id, row.source, row.link, row.created, row.done, row.due, row.priority]));
    }
    await deskSettled(page);
    check(S.tasks('Personal').length === personalRows0 + 1, tag + ': exactly one row created');
    await deskTick(page, 'i:budget');
    row = await until(() => { const t = S.tasks('Work').find((x) => x.sourceKey === 'desk:budget'); return t && t.status === 'Done' ? t : null; }, tag + ': ticking "budget" created a Work row and completed it');
    if (row) {
      check(row.title === 'Send the club budget form' && row.source === 'Claude' && row.link === 'https://forms.example.org/club-budget' && row.due === '2026-10-15' && row.priority === 'Normal' && row.done === DESK_TODAY,
        tag + ': created Work row: Source Claude (no mail/chat/calendar tag), first link, Due Thu 15 resolved, Normal (due is not today) ' + JSON.stringify([row.source, row.link, row.due, row.priority]));
    }
    await deskSettled(page);
    b = await deskBoard(page);
    check(boardConsistent(b) && b.meter === '5 / 11', tag + ': meter 5 / 11 after four ticks');
    await clearToasts(page);

    // ---- untick → reopen (the created row is reused, not duplicated) ----
    await deskTick(page, 'i:plumber');
    row = await until(() => { const t = S.tasks('Personal').find((x) => x.sourceKey === 'desk:plumber'); return t && t.status === 'Open' ? t : null; }, tag + ': unticking "plumber" reopened its row');
    if (row) check(row.done === '', tag + ': Done cleared on reopen');
    check(JSON.stringify(lastCall('setDeskItemDone').payload) === JSON.stringify({ itemId: 'plumber', done: false }), tag + ': setDeskItemDone({itemId, done:false})');
    await deskSettled(page);
    check(S.tasks('Personal').filter((x) => x.sourceKey === 'desk:plumber').length === 1, tag + ': unticking did not create a second row');
    await deskTick(page, 'i:slides');
    await until(() => { const t = S.find('Work', 'Finish the Year 8 slides'); return t && t.status === 'Open' && t.done === ''; }, tag + ': unticking "slides" reopened W-fx000001');
    await deskSettled(page);
    b = await deskBoard(page);
    check(boardConsistent(b) && b.meter === '3 / 11' && b.done.indexOf('i:plumber') < 0 && b.done.indexOf('i:slides') < 0, tag + ': unticked cards and meter 3 / 11');
    await clearToasts(page);

    // ---- the add box: Work by default, then Personal; the new card heads the first lane ----
    check((await page.getAttribute('#desk-add-category [data-value="Work"]', 'aria-checked')) === 'true', tag + ': the add box defaults to Work');
    await page.fill('#desk-add-title', 'Return the library books');
    await page.press('#desk-add-title', 'Enter');
    check(await waitToast(page, 'Added to Work: Return the library books'), tag + ': add toast');
    row = await until(() => S.find('Work', 'Return the library books'), tag + ': the add box wrote a Work row');
    if (row) {
      check(row.source === 'Manual' && row.status === 'Open' && row.created === DESK_TODAY && row.sourceKey === '', tag + ': Source Manual, Open, Created today, no Source key');
      check(JSON.stringify(lastCall('addTask').payload) === JSON.stringify({ category: 'Work', title: 'Return the library books' }), tag + ': addTask({category, title})');
      await page.waitForSelector('[data-key="a:' + row.id + '"]');
      b = await deskBoard(page);
      check(b.lanes[0].keys[0] === 'a:' + row.id && (await page.locator('[data-key="a:' + row.id + '"] .dk-tag-list').textContent()) === 'Added by you', tag + ': the new task heads the first lane with "Added by you"');
      check(boardConsistent(b) && b.meter === '3 / 12', tag + ': the meter counts it (3 / 12)');
    }
    await page.click('#desk-add-category [data-value="Personal"]');
    await page.fill('#desk-add-title', 'Buy stamps for the cards');
    await page.press('#desk-add-title', 'Enter');
    row = await until(() => S.find('Personal', 'Buy stamps for the cards'), tag + ': the Personal toggle writes a Personal row');
    if (row) {
      await page.waitForSelector('[data-key="a:' + row.id + '"]');
      check((await page.locator('[data-key="a:' + row.id + '"] .dk-tag-home').textContent()) === 'Personal' && (await deskBoard(page)).lanes[0].keys[0] === 'a:' + row.id, tag + ': the Personal task shows first, with a Personal chip');
      // tick an added task: completeTask on its row
      await deskTick(page, 'a:' + row.id);
      const added = row;
      await until(() => { const t = S.find('Personal', 'Buy stamps for the cards'); return t && t.status === 'Done' && t.done === DESK_TODAY; }, tag + ': ticking an added task completes it (completeTask)');
      check(JSON.stringify(lastCall('completeTask').payload) === JSON.stringify({ category: 'Personal', id: added.id }), tag + ': through completeTask');
      await deskSettled(page);
      check(await page.locator('[data-key="a:' + added.id + '"].done').count() === 1, tag + ': it stays listed, ticked');
    }
    await page.click('#desk-add-category [data-value="Work"]');
    await clearToasts(page);

    // ---- the director agenda (docs/AGENDA.md section 2): agenda.meeting has a saved agenda, so the block shows it ----
    await page.waitForSelector('#desk-agenda-body[data-source="saved"]', { state: 'attached' });
    const agCall = calls.filter((c) => c.name === 'getAgenda').slice(-1)[0];
    check(agCall && JSON.stringify(agCall.payload) === JSON.stringify({ meetingDate: '2026-10-20' }) && agCall.result.saved === true && agCall.result.weekOf === '2026-10-19',
      tag + ': the Desk read the saved agenda of agenda.meeting (getAgenda 2026-10-20, Week of 2026-10-19)');
    const agView = () => page.evaluate(() => ({
      title: document.querySelector('#desk-agenda-summary h2').textContent, heads: Array.from(document.querySelectorAll('#desk-agenda-body h3')).map((x) => x.textContent),
      items: Array.from(document.querySelectorAll('#desk-agenda-body > div')).map((x) => Array.from(x.querySelectorAll('li > b, li .dk-lnk-t')).map((e) => e.textContent)),
      docs: Array.from(document.querySelectorAll('#desk-agenda-body a.dk-lnk')).map((x) => [x.textContent, x.getAttribute('href'), x.getAttribute('target'), x.getAttribute('rel')]),
      text: document.getElementById('desk-agenda-body').textContent, source: document.getElementById('desk-agenda-body').getAttribute('data-source')
    }));
    let ag = await agView();
    check(ag.title === 'Tue 20 Oct · Head of School' && JSON.stringify(ag.heads) === JSON.stringify(['Done', 'In progress', 'Decisions & questions', 'Documents']) &&
      JSON.stringify(ag.items) === JSON.stringify([['Robotics kits ordered', 'Reading week plan shared'], ['Year 8 slides'], ['Can the club budget move to next term?', 'Anything from your side for my list next week?'], ['Club budget form']]),
      tag + ': the block shows the saved rows (title from the Desk JSON) ' + JSON.stringify([ag.heads, ag.items]));
    check(JSON.stringify(ag.docs) === JSON.stringify([['Club budget form', 'https://forms.example.org/club-budget', '_blank', 'noopener']]) && ag.text.indexOf('Ask about the reading week') < 0,
      tag + ': Documents as link pills; Notes are not shown on the Desk');
    await page.click('#desk-agenda-summary');
    check(await page.evaluate(() => document.getElementById('desk-agenda').open), tag + ': the agenda opens on tap');
    await shot(page, tag + '-agenda-saved');
    await page.click('#desk-agenda-copy');
    check(await waitToast(page, 'Agenda copied as text'), tag + ': copy toast');
    const savedText = ['Director meeting agenda — Tuesday 20 October 2026', 'Director: ' + DESK_DIRECTOR, '', 'DONE', '1. Robotics kits ordered — Arrived on Monday', '2. Reading week plan shared — Book list sent to staff',
      '', 'IN PROGRESS', '1. Year 8 slides — Due Thursday https://docs.example.org/slides/y8', '', 'QUESTIONS', '1. Can the club budget move to next term?', '2. Anything from your side for my list next week?',
      '', 'DOCUMENTS', '1. Club budget form — To sign https://forms.example.org/club-budget', '', 'NOTES', '1. Ask about the reading week'].join('\n');
    const copiedSaved = await page.evaluate(() => window.__copied || '');
    check(copiedSaved === savedText, tag + ': Copy agenda as text uses the saved agenda, as the Agenda page does (documents, links, Notes) ' + JSON.stringify(copiedSaved));
    await clearToasts(page);
    {
      const [dlSaved] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#desk-agenda-download')]);
      const name = dlSaved.suggestedFilename();
      const file = path.join(DOWNLOADS, tag + '-saved-' + name);
      await dlSaved.saveAs(file);
      const got = downloadRows(fs.readFileSync(file), xlsxOk);
      const want = [['Director meeting agenda — Tuesday 20 October 2026'], ['Director: ' + DESK_DIRECTOR], [], ['Section', 'Item', 'Detail', 'Link'],
        ['Done', 'Robotics kits ordered', 'Arrived on Monday'], ['Done', 'Reading week plan shared', 'Book list sent to staff'], ['In progress', 'Year 8 slides', 'Due Thursday', 'https://docs.example.org/slides/y8'],
        ['Questions', 'Can the club budget move to next term?'], ['Questions', 'Anything from your side for my list next week?'], ['Documents', 'Club budget form', 'To sign', 'https://forms.example.org/club-budget'],
        ['Notes', 'Ask about the reading week']];
      check(name === 'agenda-2026-10-20.' + (xlsxOk ? 'xlsx' : 'csv') && JSON.stringify(got) === JSON.stringify(want),
        tag + ': Download gives the Agenda page\'s file for the saved agenda (' + name + ')' + (JSON.stringify(got) === JSON.stringify(want) ? '' : '\n  got: ' + JSON.stringify(got)));
      await clearToasts(page);
    }
    // ---- Full agenda: the Agenda page at the meeting date ----
    await page.click('#desk-agenda-full');
    await page.waitForSelector('#page-agenda:not([hidden])');
    await page.waitForFunction(() => document.getElementById('agenda-date').value === '2026-10-20' && document.querySelectorAll('[data-section="Done"] .arow').length === 2);
    check((await page.textContent('#agenda-state')).trim() === 'Saved' && (await page.locator('[data-section="Documents"] .arow input[type="text"]').inputValue()) === 'Club budget form',
      tag + ': Full agenda opens the Agenda page at Tue 20 Oct with the saved rows');
    // ---- the week's rows go: back on the Desk (read again on the visit) the block and its buttons use the Desk JSON ----
    routineWritesWeek(sb, '2026-10-19', []);
    await gotoPage(page, 'desk');
    await page.waitForSelector('#desk-agenda-body[data-source="desk"]', { state: 'attached' });
    ag = await agView();
    check(JSON.stringify(ag.heads) === JSON.stringify(['Done', 'In progress', 'Decisions & questions']) && ag.docs.length === 0, tag + ': not saved → the Desk JSON\'s sections');
    await page.click('#desk-agenda-copy');
    check(await waitToast(page, 'Agenda copied as text'), tag + ': copy toast');
    const copied = await page.evaluate(() => window.__copied || '');
    check(copied === 'Tue 20 Oct · Head of School\n\nDONE\n1. Robotics kits ordered (Arrived on Monday)\n\nIN PROGRESS\n1. Reading week plan (Book list shared)\n\n' +
      'DECISIONS & QUESTIONS\n1. Club budget (Can it move to next term?)\n2. Anything from your side for my list next week?', tag + ': agenda copied in the routine page\'s text format ' + JSON.stringify(copied));
    await clearToasts(page);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#desk-agenda-download')]);
    const dlName = dl.suggestedFilename();
    const dest = path.join(DOWNLOADS, tag + '-' + dlName);
    await dl.saveAs(dest);
    const buf = fs.readFileSync(dest);
    const wantRows = [['Tue 20 Oct · Head of School'], ['Director: ' + DESK_DIRECTOR], [], ['Section', 'Item', 'Detail'], ['Done', 'Robotics kits ordered', 'Arrived on Monday'],
      ['In progress', 'Reading week plan', 'Book list shared'], ['Decisions & questions', 'Club budget', 'Can it move to next term?'], ['Decisions & questions', 'Anything from your side for my list next week?']];
    if (xlsxOk) {
      check(dlName === 'desk-agenda-' + DESK_TODAY + '.xlsx' && buf.slice(0, 2).toString() === 'PK', tag + ': Download .xlsx gives ' + dlName + ' (zip)');
      check(await waitToast(page, 'Downloaded ' + dlName), tag + ': xlsx toast');
      const got = downloadRows(buf, true);
      const same = JSON.stringify(got.sheetNames) === '["Agenda"]' && JSON.stringify(got) === JSON.stringify(wantRows);
      check(same, tag + ': one sheet "Agenda": title, director, blank row, Section / Item / Detail, then every agenda item' + (same ? '' : '\n  got: ' + JSON.stringify([got.sheetNames, got])));
    } else {
      check(dlName === 'desk-agenda-' + DESK_TODAY + '.csv' && buf.toString('utf8').indexOf('﻿') === 0, tag + ': without SheetJS the agenda downloads as ' + dlName + ' (UTF-8 BOM)');
      check(await waitToast(page, 'did not load, so this is a .csv'), tag + ': CSV fallback explained in a toast');
      const got = downloadRows(buf, false);
      const same = JSON.stringify(got) === JSON.stringify(wantRows);
      check(same, tag + ': the CSV holds the same rows' + (same ? '' : '\n  got: ' + JSON.stringify(got)));
    }
    await clearToasts(page);
    await noOverflow(page, tag + ' after ticks');
    await shot(page, tag + '-ticked');

    // ---- the Tasks tab still works alongside: it shows the Desk's ticks, and its own ticks show on the Desk ----
    await gotoPage(page, 'today');
    check(await page.locator('#col-work details.done-group .task', { hasText: 'Forward the conference receipts' }).count() === 1 &&
      await page.locator('#col-work details.done-group .task', { hasText: 'Send the club budget form' }).count() === 1,
      tag + ': rows ticked on the Desk are under Done today on the Tasks page (incl. the one the tick created)');
    check(await page.locator('#col-work .group.open .task', { hasText: 'Finish the Year 8 slides' }).count() === 1 &&
      await page.locator('#col-personal .task', { hasText: 'Call the plumber about the leak' }).locator('.task-check:not(:checked)').count() === 1,
      tag + ': unticked rows are open on the Tasks page');
    const openNow = S.tasks('Work').concat(S.tasks('Personal')).filter((t) => t.status === 'Open').length;
    check(await tabCount(page, 'today') === String(openNow), tag + ': the Tasks tab count matches the open rows (' + openNow + ')');
    await page.fill('#qa-title', 'Water the classroom plants');
    await page.press('#qa-title', 'Enter');
    check(await waitToast(page, 'Added to Work: Water the classroom plants'), tag + ': quick-add on the Tasks page still works');
    row = await until(() => S.find('Work', 'Water the classroom plants'), tag + ': and writes its row');
    const certs = page.locator('.task', { hasText: 'Print the club certificates' });
    await certs.locator('.task-check').click();
    await certs.locator('.note-box button', { hasText: 'Done, no note' }).click();
    await until(() => { const t = S.find('Work', 'Print the club certificates'); return t && t.status === 'Done'; }, tag + ': ticking on the Tasks page completes the row');
    await clearToasts(page);
    await gotoPage(page, 'desk');
    check(await page.locator('[data-key="a:W-dk000004"].done').count() === 1, tag + ': a task ticked on the Tasks page shows ticked on the Desk');
    check(row && await page.locator('[data-key="a:' + row.id + '"]').count() === 1, tag + ': a task added on the Tasks page shows under "Added by you" on the Desk');
    b = await deskBoard(page);
    check(boardConsistent(b), tag + ': meter and lane counts agree after the Tasks page changes ' + JSON.stringify([b.meter, b.lanes.map((l) => l.count)]));

    // ---- reload: ticks come back from the sheet (by task ID, desk:<id>, and the created rows) ----
    await page.goto(url + '?reload=1');
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForSelector('#desk-board .dk-item');
    b = await deskBoard(page);
    check(['i:receipts', 'i:budget', 'i:dentist'].every((k) => b.done.indexOf(k) >= 0) && ['i:slides', 'i:plumber'].every((k) => b.done.indexOf(k) < 0) && boardConsistent(b),
      tag + ': after a reload the ticks come from the sheet ' + JSON.stringify(b.done));
    const res2 = lastCall('getDesk').result;
    const by2 = {}; res2.desk.items.forEach((i) => { by2[i.id] = i; });
    check(by2.plumber.taskId && by2.plumber.status === 'Open' && by2.budget.status === 'Done' && res2.added.every((t) => t.status === 'Open' && t.source === 'Manual'),
      tag + ': getDesk now links "plumber" and "budget" to the rows their ticks created');

    // ---- stale: the build is from yesterday ----
    writeDeskTab(sb, deskRows(deskData(), DESK_STALE_BUILT, { maxChars: 900 }));
    await page.goto(url + '?stale=1');
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForSelector('#desk-stale');
    const stale = await page.evaluate(() => ({ text: document.getElementById('desk-stale').textContent, href: document.querySelector('#desk-stale a').getAttribute('href'),
      visible: document.getElementById('desk-stale').getBoundingClientRect().height > 0 }));
    check(stale.text === 'This Desk is from Monday 12 Oct; the next build is at 6:45 on school days. Open the Desk page' && stale.href === DESK_URL && stale.visible,
      tag + ': stale note with the Desk page link ' + JSON.stringify(stale));
    check(lastCall('getDesk').result.stale === true && lastCall('getDesk').result.builtDate === '2026-10-12', tag + ': getDesk says stale, builtDate 2026-10-12');
    await noOverflow(page, tag + ' stale');
    await shot(page, tag + '-stale');

    // ---- invalid: a JSON cell that does not parse ----
    const bad = deskRows(deskData(), DESK_BUILT, { maxChars: 900 }).map((r) => (r[0] === 'items2' ? [r[0], '[{"id":"broken"', r[2]] : r));
    writeDeskTab(sb, bad);
    await page.goto(url + '?invalid=1');
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForSelector('#desk-empty');
    const inv = await page.evaluate(() => ({ text: document.getElementById('desk-empty').textContent, href: (document.querySelector('#desk-empty #desk-open') || {}).href, add: !!document.getElementById('desk-add-title') }));
    check(/the "items2" row is not valid JSON/.test(inv.text) && inv.href === DESK_URL && inv.add, tag + ': invalid data: the message names the key, with the Desk page link and the add box ' + JSON.stringify(inv.text));
    check(sb.mock.logRows().some((r) => r.level === 'ERROR' && /items2/.test(r.message)), tag + ': the bad cell is logged as an ERROR');

    // ---- empty: the routine has not written the tab yet ----
    writeDeskTab(sb, []);
    await page.goto(url + '?empty=1');
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForSelector('#desk-empty');
    const empty = await page.evaluate(() => ({ text: document.querySelector('#desk-empty p').textContent, href: (document.querySelector('#desk-empty #desk-open') || {}).href,
      lanes: document.querySelectorAll('#desk-board .dk-lane').length, added: Array.from(document.querySelectorAll('#desk-board .dk-item')).map((c) => c.getAttribute('data-key')) }));
    check(empty.text === 'Your Desk appears here after the next morning build (6:45 on school days), or press Rebuild now on the Desk page.' && empty.href === DESK_URL,
      tag + ': empty state: the calm panel and the Desk page link');
    check(lastCall('getDesk').result.ok === false && lastCall('getDesk').result.reason === 'empty', tag + ': getDesk answered reason "empty"');
    check(empty.lanes === 1 && empty.added.length >= 1 && empty.added.every((k) => k.indexOf('a:') === 0), tag + ': one lane with the "Added by you" tasks ' + JSON.stringify(empty.added));
    await page.fill('#desk-add-title', 'Order more whiteboard pens');
    await page.press('#desk-add-title', 'Enter');
    row = await until(() => S.find('Work', 'Order more whiteboard pens'), tag + ': the add box still works on an empty Desk');
    if (row) await page.waitForSelector('[data-key="a:' + row.id + '"]');
    await noOverflow(page, tag + ' empty');
    await shot(page, tag + '-empty');
  } catch (e) {
    fail(tag + ': step threw: ' + (e.stack || e));
    try { await shot(page, tag + '-FAILED'); } catch (e2) { /* ignore */ }
  } finally {
    const allowed = (t) => !xlsxOk && /Failed to load resource/.test(t) && /xlsx\.full\.min\.js/.test(t);
    const bad = errors.filter((t) => !allowed(t));
    check(bad.length === 0, tag + ': no console errors or uncaught exceptions' + (bad.length ? '\n  ' + bad.join('\n  ') : ''));
    check(unexpected.length === 0, tag + ': no unexpected network requests' + (unexpected.length ? ' ' + unexpected.join(', ') : ''));
    check(unsafe.length === 0, tag + ': no Date/undefined/function left a server function' + (unsafe.length ? '\n  ' + unsafe.join('\n  ') : ''));
    const errCalls = calls.filter((c) => c.error);
    check(errCalls.length === 0, tag + ': no server call failed' + (errCalls.length ? '\n  ' + errCalls.map((c) => c.name + ': ' + c.error).join('\n  ') : ''));
    await context.close();
  }
}

async function main() {
  const file = assemble({});
  const url = 'file://' + file;
  const xlsxOk = fs.existsSync(XLSX_LOCAL) && sha384(XLSX_LOCAL) === XLSX_SHA384;
  console.log('e2e: ' + file + (xlsxOk ? ' (SheetJS served from node_modules, hash verified)' : ' (SheetJS not available locally: only the CSV fallback runs)'));
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const browser = await launchBrowser();
  // E2E_ONLY=desk or E2E_ONLY=tasks runs one scenario family (handy while working on it); npm test runs both.
  const only = process.env.E2E_ONLY || '';
  try {
    if (only !== 'desk') {
      await runScenario(browser, url, { name: 'desktop', width: 1280, height: 900 }, xlsxOk);
      await runScenario(browser, url, { name: 'mobile', width: 390, height: 844 }, xlsxOk);
      // SheetJS blocked on purpose: the Agenda/Newsletter downloads must fall back to CSV and say so (SPEC 8).
      await runScenario(browser, url, { name: 'desktop-noxlsx', width: 1280, height: 900 }, false);
    }
    if (only !== 'tasks') {
      // The Desk home page against the real getDesk / setDeskItemDone (docs/DESK.md).
      await runDeskScenario(browser, url, { name: 'desktop', width: 1280, height: 900 }, xlsxOk);
      await runDeskScenario(browser, url, { name: 'mobile', width: 390, height: 844 }, xlsxOk);
      await runDeskScenario(browser, url, { name: 'desktop-noxlsx', width: 1280, height: 900 }, false);
    }
  } finally {
    await browser.close();
  }
  console.log('\nScreenshots:');
  shots.forEach((s) => console.log('  ' + s));
  if (failures.length) { console.error('\n' + failures.length + ' e2e failure(s):\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('\ne2e: all steps passed');
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
