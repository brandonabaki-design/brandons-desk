#!/usr/bin/env node
/*
 * Render check for the web UI. Assembles Index.html, opens it in headless Chromium with the mock
 * google.script.run shim injected first, visits every page at 390x844 and 1280x900 (plus a dark-mode
 * and a "SheetJS missing" pass), clicks through the main flows, and saves screenshots.
 * Fails (exit 1) on any console error, uncaught exception, unexpected network request, horizontal
 * page overflow, or a failed step.
 *
 *   node tests/ui/render.js            (npm run ui; needs `npm install` and, once, `npx playwright install chromium`)
 *   CHROMIUM_PATH=... UI_OUT=... node tests/ui/render.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assemble, DEFAULT_OUT_DIR } = require('./assemble');
const pure = require('./pure-check');

let playwright;
try { playwright = require('playwright'); } catch (e) {
  console.error('Playwright is not installed. Run `npm install`, then `npx playwright install chromium` once (see README).');
  process.exit(2);
}

// Browser: CHROMIUM_PATH if set, else a pre-installed Chromium at /opt/pw-browsers/chromium when that exists,
// else Playwright's own download (`npx playwright install chromium`).
const PREINSTALLED_CHROME = '/opt/pw-browsers/chromium';
const CHROME = process.env.CHROMIUM_PATH || (fs.existsSync(PREINSTALLED_CHROME) ? PREINSTALLED_CHROME : '');
function launchBrowser() {
  const opts = { headless: true };
  if (CHROME) opts.executablePath = CHROME;
  return playwright.chromium.launch(opts).catch((e) => {
    console.error('Could not start Chromium: ' + String(e && e.message ? e.message : e).split('\n')[0]);
    console.error('Run `npx playwright install chromium` once, or set CHROMIUM_PATH to a Chrome/Chromium binary.');
    process.exit(2);
  });
}
const OUT = process.env.UI_OUT || DEFAULT_OUT_DIR;
const SHOTS = path.join(OUT, 'screenshots');
const DOWNLOADS = path.join(OUT, 'downloads');
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const XLSX_LOCAL = path.join(__dirname, '..', '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
const XLSX_SHA384 = 'vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-server.js'), 'utf8');
const PAGES = ['today', 'inbox', 'import', 'agenda', 'newsletter', 'history'];

const failures = [];
const shots = [];
function fail(msg) { failures.push(msg); console.error('FAIL ' + msg); }
function ok(msg) { console.log('ok   ' + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); return !!cond; }
function sha384(file) { return crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64'); }

const SAMPLE_HTML = `<!doctype html><html><head><title>To-do export</title>
<style>.done{text-decoration:line-through}</style><script>document.title='must never run'</script></head>
<body><h1>My tasks</h1>
<h2>Work</h2>
<h3>AI Learning Hub</h3>
<ul class="todo-list">
 <li><input type="checkbox" checked> Publish the Hub mentor rota <a href="https://docs.google.com/document/d/1Rota/edit">rota doc</a></li>
 <li><input type="checkbox"> Email parents about the AI club trial @2026-10-16 !</li>
 <li class="done">Order lanyards for mentors &amp; helpers</li>
</ul>
<h2>Personal</h2>
<ol><li>Book the car service</li><li><span style="text-decoration: line-through">Pay school fees</span></li>
<li>Nested parent<ul><li>Nested child</li></ul></li></ol>
<p>Paragraph with a <a href="javascript:alert(1)">bad link</a> that is not a task.</p>
</body></html>`;

async function openPage(browser, vp, opts) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: vp.dark ? 'dark' : 'light', acceptDownloads: true, deviceScaleFactor: 1 });
  await context.addInitScript(MOCK);
  await context.addInitScript(() => {
    // slow the first calls so the loading state is observable; the test lowers it once ready
    window.__mock.latency = 250;
    // ?failboot=1 makes the first getBootstrap fail (the page reloads the shim, so the flag must come from the URL)
    if (/failboot/.test(location.search)) window.__mock.failNext('getBootstrap', 'Not allowed');
    // record clipboard writes so the test can read what was copied
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); } catch (e) { /* ignore */ }
  });
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
      if (opts.xlsx) return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(XLSX_LOCAL) });
      return route.abort('failed');
    }
    unexpected.push(u);
    return route.abort('blockedbyclient');
  });
  return { context, page, errors, unexpected };
}

async function shot(page, name) {
  const file = path.join(SHOTS, name + '.png');
  await page.evaluate(() => window.scrollTo(0, 0)); // keep the sticky header at the top of full-page captures
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
  await page.waitForTimeout(80);
}
async function toastText(page) { return page.evaluate(() => Array.from(document.querySelectorAll('.toast .msg')).map((e) => e.textContent).join(' | ')); }
async function waitToast(page, text) {
  try { await page.waitForFunction((t) => Array.from(document.querySelectorAll('.toast .msg')).some((e) => e.textContent.indexOf(t) >= 0), text, { timeout: 4000 }); return true; }
  catch (e) { return false; }
}
async function clearToasts(page) { await page.evaluate(() => document.querySelectorAll('.toast .x').forEach((b) => b.click())); }
/** Elements matching `sel` whose rendered height (or width, when `both`) is under `min` px: [] means every one is a big enough tap target. */
async function tooSmall(page, sel, min, both) {
  return page.evaluate(([s, m, b]) => Array.from(document.querySelectorAll(s))
    .map((el) => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), text: (el.getAttribute('aria-label') || el.textContent).trim().slice(0, 24) }; })
    .filter((x) => x.h > 0 && (x.h < m || (b && x.w < m))), [sel, min, !!both]);
}
/** data-id of the task row that holds the focused element when it matches `sel`, else ''. */
function focusedTaskId(page, sel) {
  return page.evaluate((s) => { const a = document.activeElement; return a && a.matches(s) && a.closest('.task') ? a.closest('.task').getAttribute('data-id') : ''; }, sel);
}

async function runViewport(browser, url, vp, opts) {
  const tag = vp.name;
  const { context, page, errors, unexpected } = await openPage(browser, vp, opts);
  try {
    // loading state on first paint, then ready
    await page.goto(url + '#today');
    const loadingShown = await page.isVisible('#loading');
    await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
    check(loadingShown, tag + ': loading state shown before first data');
    await page.evaluate(() => { window.__mock.latency = 30; });
    check(await page.isHidden('#loading'), tag + ': loading hidden after bootstrap');
    check((await page.textContent('[data-count="today"]')).trim() === '17', tag + ': Today tab count shows 17 open tasks');
    const tabs = await page.evaluate(() => { const s = document.getElementById('tabs'); return { sw: s.scrollWidth, cw: s.clientWidth }; });
    check(tabs.sw <= tabs.cw, tag + ': all six tabs fit without scrolling (' + tabs.sw + ' <= ' + tabs.cw + ')');
    check((await page.textContent('[data-count="inbox"]')).trim() === '6', tag + ': Inbox tab count shows 6 new items');

    for (const name of PAGES) {
      await gotoPage(page, name);
      await noOverflow(page, tag + ' ' + name);
      await shot(page, tag + '-' + name);
    }
    if (opts.screenshotsOnly) return;

    // ---- Today: quick-add, duplicate, failure ----
    await gotoPage(page, 'today');
    check(await page.locator('#col-work .group.overdue .task').count() === 2, tag + ': Work has 2 overdue tasks');
    check(await page.locator('#col-work .group.due-today .task').count() === 2, tag + ': Work has 2 due today');
    check(await page.locator('#col-work details.done-group .task').count() === 2, tag + ': Work has 2 done today (collapsed)');
    check(await page.locator('#col-personal .group.overdue .task').count() === 1, tag + ': Personal has 1 overdue');
    check(await page.locator('.task', { hasText: 'Check projector in room 204' }).locator('a.task-link').count() === 0, tag + ': javascript: link is not rendered');
    check(await page.locator('.task', { hasText: 'Send AI Learning Hub launch note' }).locator('a.task-link[target="_blank"][rel="noopener"]').count() === 1, tag + ': https link rendered with target/rel');
    await page.fill('#qa-title', 'Email parents about the trip');
    await page.press('#qa-title', 'Enter');
    check(await waitToast(page, 'Added to Work: Email parents about the trip'), tag + ': quick-add toast');
    check(await page.locator('#col-work .task', { hasText: 'Email parents about the trip' }).count() === 1, tag + ': quick-add row rendered');
    check((await page.inputValue('#qa-title')) === '', tag + ': quick-add input cleared');
    await page.click('#qa-category [data-value="Personal"]');
    await page.fill('#qa-title', 'Email parents about the trip');
    await page.press('#qa-title', 'Enter');
    await waitToast(page, 'Added to Personal');
    await page.fill('#qa-title', 'email parents about the trip');
    await page.press('#qa-title', 'Enter');
    check(await waitToast(page, 'Already on your list'), tag + ': duplicate title reported, nothing added');
    check(await page.locator('#col-personal .task', { hasText: 'Email parents about the trip' }).count() === 1, tag + ': duplicate not duplicated in the list');
    await page.evaluate(() => window.__mock.failNext('addTask', 'Sheet is locked, try again'));
    await page.fill('#qa-title', 'This one fails');
    await page.press('#qa-title', 'Enter');
    check(await waitToast(page, 'Sheet is locked, try again'), tag + ': server error text shown in a toast');
    await page.waitForTimeout(100);
    check(await page.locator('.task', { hasText: 'This one fails' }).count() === 0, tag + ': failed add rolled back');
    check((await page.inputValue('#qa-title')) === 'This one fails', tag + ': failed add restores the title for retry');
    await page.fill('#qa-title', '');
    await page.click('#qa-category [data-value="Work"]');
    await clearToasts(page);

    // ---- Today: tick with note, undo, untick ----
    const dentist = page.locator('.task', { hasText: 'Call the dentist to reschedule' });
    await dentist.locator('.task-check').click();
    check(await dentist.locator('.note-box').count() === 1, tag + ': note box opens on tick');
    const shortTargets = await page.evaluate(() => Array.from(document.querySelectorAll('.btn.small, details.done-group > summary'))
      .map((el) => ({ h: Math.round(el.getBoundingClientRect().height), text: (el.getAttribute('aria-label') || el.textContent).trim().slice(0, 24) }))
      .filter((x) => x.h > 0 && x.h < 40));
    check(shortTargets.length === 0, tag + ': every small button and the Done today toggle is at least 40 px tall' + (shortTargets.length ? ' ' + JSON.stringify(shortTargets) : ''));
    const segShort = await tooSmall(page, '.seg-btn, #tabs a', 40);
    check(segShort.length === 0, tag + ': the quick-add Work/Personal toggle and the tab links are at least 40 px tall' + (segShort.length ? ' ' + JSON.stringify(segShort) : ''));
    const titleShort = await tooSmall(page, '.task-title', 32);
    check(titleShort.length === 0, tag + ': every task title button is at least 32 px tall to tap' + (titleShort.length ? ' ' + JSON.stringify(titleShort) : ''));
    await shot(page, tag + '-today-note');
    await dentist.locator('.note-box input').fill('Moved to Monday');
    await dentist.locator('.note-box button', { hasText: /^Done$/ }).click();
    check(await page.locator('#col-personal details.done-group .task', { hasText: 'Call the dentist' }).count() === 1, tag + ': ticked task moves to Done today (optimistic)');
    check(await waitToast(page, 'Done: Call the dentist'), tag + ': done toast with undo');
    const actShort = await tooSmall(page, '.toast .act', 40);
    check(actShort.length === 0, tag + ': the Undo toast button is at least 40 px tall' + (actShort.length ? ' ' + JSON.stringify(actShort) : ''));
    check((await page.evaluate(() => document.activeElement && document.activeElement.tagName)) !== 'BODY', tag + ': completing a task does not drop focus to <body>');
    await shot(page, tag + '-today-undo-toast');
    await page.waitForTimeout(120);
    let m = await page.evaluate(() => window.__mock.state.tasks.filter((t) => t.title === 'Call the dentist to reschedule')[0]);
    check(m.status === 'Done' && m.note === 'Moved to Monday', tag + ': completeTask reached the server with the note');
    await page.locator('.toast .act', { hasText: 'Undo' }).click();
    check(await waitToast(page, 'Reopened: Call the dentist'), tag + ': undo toast');
    check(await page.locator('#col-personal .group.due-today .task', { hasText: 'Call the dentist' }).count() === 1, tag + ': undo puts the task back under Due today');
    await page.waitForTimeout(120);
    m = await page.evaluate(() => window.__mock.state.tasks.filter((t) => t.title === 'Call the dentist to reschedule')[0]);
    check(m.status === 'Open' && m.done === '', tag + ': reopenTask reached the server');
    check((await focusedTaskId(page, '.task-check')) === 'P-fx2abcde', tag + ': Undo puts keyboard focus on the reopened row\'s checkbox (after the server reply too)');
    await clearToasts(page);
    const gym = page.locator('#col-personal details.done-group .task', { hasText: 'Sort out gym membership' });
    await page.locator('#col-personal details.done-group summary').click();
    await gym.locator('.task-check').click();
    check(await page.locator('#col-personal .group.open .task', { hasText: 'Sort out gym membership' }).count() === 1, tag + ': unticking a done task reopens it');
    await page.waitForTimeout(120);
    check((await focusedTaskId(page, '.task-check')) === 'P-fx7abcde', tag + ': unticking keeps focus on that row\'s checkbox in its new group');
    // Ticking again while Done today is open: focus stays on the row's checkbox there (Space is the keyboard undo)
    await page.locator('#col-personal .group.open .task', { hasText: 'Sort out gym membership' }).locator('.task-check').click();
    await page.locator('.note-box button', { hasText: 'Done, no note' }).click();
    await page.waitForTimeout(120);
    check((await focusedTaskId(page, '.task-check')) === 'P-fx7abcde' && await page.locator('#col-personal details.done-group[open] .task', { hasText: 'Sort out gym membership' }).count() === 1,
      tag + ': completing with Done today open focuses the ticked row\'s checkbox');
    await page.keyboard.press('Space');
    check(await waitToast(page, 'Reopened: Sort out gym membership'), tag + ': Space on that checkbox is the keyboard undo');
    await clearToasts(page);
    // A rejected completeTask withdraws the optimistic "Done:" toast (and its dead Undo) and rolls the row back.
    await page.evaluate(() => window.__mock.failNext('completeTask', 'Sheet is locked, try again'));
    const bill = page.locator('.task', { hasText: 'Pay the electricity bill' });
    await bill.locator('.task-check').click();
    await bill.locator('.note-box button', { hasText: 'Done, no note' }).click();
    check(await waitToast(page, 'Sheet is locked, try again'), tag + ': failed tick shows the server error');
    await page.waitForTimeout(80);
    check(!/Done: Pay the electricity/.test(await toastText(page)), tag + ': the optimistic Done toast is withdrawn on failure');
    check(await page.locator('#col-personal .group.open .task', { hasText: 'Pay the electricity bill' }).count() === 1, tag + ': failed tick rolled back to Open');
    await clearToasts(page);
    // Five quick "Done … Undo" toasts: the 4-toast cap evicts plain toasts first, never a live Undo.
    const stack = await page.evaluate(() => {
      for (let i = 0; i < 5; i++) toast('Done: task ' + i, { type: 'ok', timeout: 10000, action: { label: 'Undo', fn: function () {} } });
      toast('plain one'); toast('plain two');
      const out = { undo: document.querySelectorAll('#toasts .toast .act').length, total: document.querySelectorAll('#toasts .toast').length,
        plain: Array.from(document.querySelectorAll('#toasts .toast')).filter((t) => !t.querySelector('.act')).map((t) => t.querySelector('.msg').textContent) };
      document.querySelectorAll('#toasts .toast .x').forEach((b) => b.click());
      return out;
    });
    check(stack.undo === 5 && stack.total === 6 && stack.plain.join() === 'plain two', tag + ': all five undoable toasts survive the cap; the older plain toast is the one evicted ' + JSON.stringify(stack));

    // ---- Today: inline editor, search ----
    const micro = page.locator('.task', { hasText: 'Order replacement micro:bits' });
    await micro.locator('.task-title').click();
    check(await micro.locator('.editor').count() === 1, tag + ': inline editor opens');
    await micro.locator('.editor input[type="date"]').fill('2026-10-15');
    await micro.locator('.editor label.check', { hasText: 'Newsletter' }).locator('input').check();
    await shot(page, tag + '-today-editor');
    await micro.locator('.editor button', { hasText: /^Save$/ }).click();
    check(await waitToast(page, 'Saved: Order replacement micro:bits'), tag + ': editor save toast');
    check(await micro.locator('.chip.due', { hasText: 'Thu 15 Oct' }).count() === 1 && await micro.locator('.chip.newsletter').count() === 1, tag + ': saved patch reflected in chips');
    const calls = await page.evaluate(() => window.__mock.calls.filter((c) => c.name === 'updateTask').slice(-1)[0]);
    check(JSON.stringify(calls.payload.patch) === JSON.stringify({ due: '2026-10-15', newsletter: true }), tag + ': updateTask patch holds only changed fields');
    await clearToasts(page);
    await page.fill('#today-search', 'robot');
    await page.waitForTimeout(60);
    check(await page.locator('#col-work .task').count() === 2 && await page.locator('#col-personal .task').count() === 0, tag + ': search filters both columns');
    await page.fill('#today-search', '');
    await page.waitForTimeout(60);
    // move + drop + undo drop
    const hike = page.locator('.task', { hasText: 'Plan the weekend hike' });
    await hike.locator('.task-title').click();
    await hike.locator('.editor button', { hasText: 'Move to Work' }).click();
    check(await waitToast(page, 'Moved to Work: Plan the weekend hike'), tag + ': move toast');
    check(await page.locator('#col-work .task', { hasText: 'Plan the weekend hike' }).count() === 1 && await page.locator('#col-personal .task', { hasText: 'Plan the weekend hike' }).count() === 0, tag + ': moved task changes column');
    await clearToasts(page);
    const book = page.locator('.task', { hasText: "Read 'The Alignment Problem'" });
    await book.locator('.task-title').click();
    await book.locator('.editor button', { hasText: 'Drop' }).click();
    check(await waitToast(page, "Dropped: Read 'The Alignment Problem'"), tag + ': drop toast');
    check(await page.locator('.task', { hasText: 'Alignment Problem' }).count() === 0, tag + ': dropped task removed');
    await page.locator('.toast .act', { hasText: 'Undo' }).click();
    check(await waitToast(page, 'Restored'), tag + ': undo drop restores');
    check(await page.locator('#col-personal .task', { hasText: 'Alignment Problem' }).count() === 1, tag + ': restored task is back');
    await clearToasts(page);

    // ---- Inbox: promote, ignore, capture ----
    await gotoPage(page, 'inbox');
    check(await page.locator('#inbox-list .item').count() === 6, tag + ': inbox lists 6 new items');
    await page.locator('#inbox-list .item', { hasText: 'Agenda for Tuesday?' }).locator('button', { hasText: 'Promote' }).click();
    const pf = page.locator('.promote-form');
    check(await pf.count() === 1, tag + ': promote form opens');
    await pf.locator('input[aria-label="Task title"]').fill('Send Hub numbers to Sarah before Tuesday');
    await pf.locator('input[aria-label="Project"]').fill('AI Learning Hub');
    await shot(page, tag + '-inbox-promote');
    await pf.locator('button', { hasText: 'Add task' }).click();
    check(await waitToast(page, 'Added to Work: Send Hub numbers to Sarah before Tuesday'), tag + ': promote toast');
    check(await page.locator('#inbox-list .item').count() === 5, tag + ': promoted item leaves the list');
    check((await page.textContent('[data-count="inbox"]')).trim() === '5', tag + ': inbox count updates');
    const promoted = await page.evaluate(() => window.__mock.state.inbox.filter((i) => i.subject === 'Agenda for Tuesday?')[0]);
    check(promoted.status === 'Promoted' && /^W-/.test(promoted.taskId), tag + ': promoteInbox reached the server');
    await page.locator('#inbox-list .item', { hasText: 'New arrivals' }).count(); // none expected (ignored)
    await page.locator('#inbox-list .item', { hasText: 'Newsletter deadline Friday' }).locator('button', { hasText: 'Ignore' }).click();
    check(await waitToast(page, 'Ignored: Newsletter deadline Friday'), tag + ': ignore toast');
    check(await page.locator('#inbox-list .item').count() === 4, tag + ': ignored item leaves the list');
    const afterIgnore = await page.evaluate(() => { const a = document.activeElement; return { text: a ? a.textContent.trim() : '', item: a && a.closest('.item') ? a.closest('.item').textContent : '', id: a ? a.id : '' }; });
    check(afterIgnore.text === 'Promote' && /Direct message|Question about the AI club/.test(afterIgnore.item), tag + ': Ignore moves focus to the next item\'s Promote button ' + JSON.stringify([afterIgnore.text, afterIgnore.id]));
    await clearToasts(page);
    await page.click('#inbox-capture');
    check(await waitToast(page, 'Captured: Gmail 1 · Chat 0 conversations (Chat mode: api)'), tag + ': capture toast with counts (Chat counted in conversations) and chatMode');
    await page.waitForFunction(() => document.querySelectorAll('#inbox-list .item').length === 5);
    ok(tag + ': capture refreshes the list');
    await clearToasts(page);
    await page.evaluate(() => { window.__mock.chatMode = 'email'; });
    await page.click('#inbox-capture');
    await waitToast(page, 'Chat mode: email');
    await page.waitForSelector('#inbox-chatmode:not([hidden])');
    check(/email mode/.test(await page.textContent('#inbox-chatmode')), tag + ': email chat mode labelled as delayed and partial');
    await clearToasts(page);
    await page.selectOption('#inbox-status', 'Promoted');
    await page.waitForFunction(() => document.querySelectorAll('#inbox-list .item .badge').length >= 2);
    ok(tag + ': promoted filter shows promoted rows');
    await gotoPage(page, 'today');
    check(await page.locator('#col-work .task', { hasText: 'Send Hub numbers to Sarah' }).count() === 1, tag + ': promoted task appears on Today without reload');

    // ---- Import: preview from text and file, edit, import ----
    await gotoPage(page, 'import');
    await page.fill('#import-text', '# Grade 10 Design\n- Share the rubric with the team @2026-10-16\n- [x] Print the exemplars\n[Personal] Buy running shoes !\nok\n');
    await page.waitForFunction(() => document.querySelectorAll('.prow').length === 3);
    ok(tag + ': text preview shows 3 rows (2-char line skipped)');
    check((await page.textContent('#import-preview-count')).trim() === '(3 of 3 selected)', tag + ': preview count');
    await page.setInputFiles('#import-file', { name: 'todo-export.html', mimeType: 'text/html', buffer: Buffer.from(SAMPLE_HTML) });
    await page.waitForFunction(() => document.querySelectorAll('.prow').length === 10);
    ok(tag + ': html file adds 7 preview rows');
    check((await page.title()) === "Brandon's Desk", tag + ': html import did not run the sample script');
    check(/todo-export\.html: 7 items/.test(await page.textContent('#import-file-info')), tag + ': file info line');
    const preview = await page.evaluate(() => Array.from(document.querySelectorAll('.prow')).map((r) => ({
      title: r.querySelector('.pr-title').value, cat: r.querySelector('select').value, project: r.querySelector('input[aria-label="Project"]').value,
      done: r.querySelector('label.check input').checked, extra: r.querySelector('.pr-extra').textContent })));
    const exp = [
      ['Share the rubric with the team', 'Work', 'Grade 10 Design', false, 'due 2026-10-16'], ['Print the exemplars', 'Work', 'Grade 10 Design', true, ''], ['Buy running shoes', 'Personal', 'Grade 10 Design', false, 'High'],
      ['Publish the Hub mentor rota rota doc', 'Work', 'AI Learning Hub', true, 'link'], ['Email parents about the AI club trial', 'Work', 'AI Learning Hub', false, 'due 2026-10-16 · High'],
      ['Order lanyards for mentors & helpers', 'Work', 'AI Learning Hub', true, ''], ['Book the car service', 'Personal', '', false, ''], ['Pay school fees', 'Personal', '', true, ''],
      ['Nested parent', 'Personal', '', false, ''], ['Nested child', 'Personal', '', false, '']];
    check(JSON.stringify(preview.map((p) => [p.title, p.cat, p.project, p.done, p.extra])) === JSON.stringify(exp), tag + ': preview rows parsed as expected ' + JSON.stringify(preview));
    await page.locator('.prow').nth(1).locator('input[type="checkbox"]').first().uncheck();
    await page.locator('.prow').nth(2).locator('.pr-title').fill('Buy new running shoes');
    await page.locator('.prow').nth(6).locator('select').selectOption('Work');
    check((await page.textContent('#import-preview-count')).trim() === '(9 of 10 selected)', tag + ': preview count after edits');
    const checkShort = await tooSmall(page, '.prow .pr-check-wrap', 40, true);
    check(checkShort.length === 0 && await page.locator('.prow .pr-check-wrap input[type="checkbox"]').count() === 10, tag + ': every Include checkbox sits in a 40 x 40 label' + (checkShort.length ? ' ' + JSON.stringify(checkShort) : ''));
    await noOverflow(page, tag + ' import preview');
    await shot(page, tag + '-import-preview');
    await page.click('#import-go');
    await page.waitForSelector('#import-result:not([hidden])');
    check(/Imported 9 tasks/.test(await page.textContent('#import-result h2')), tag + ': import result summary');
    check(await waitToast(page, 'Imported 9 tasks'), tag + ': import toast');
    const sent = await page.evaluate(() => window.__mock.calls.filter((c) => c.name === 'importText').slice(-1)[0].payload);
    // preview order is kept: text rows (Grade 10 Design), then the html rows (AI Learning Hub, then "#" clears the project)
    const expectedText = ['# Grade 10 Design', '[Work] Share the rubric with the team @2026-10-16', '[Personal] Buy new running shoes !',
      '# AI Learning Hub', '[Work] [x] Publish the Hub mentor rota rota doc', '[Work] Email parents about the AI club trial @2026-10-16 !', '[Work] [x] Order lanyards for mentors & helpers',
      '#', '[Work] Book the car service', '[Personal] [x] Pay school fees', '[Personal] Nested parent', '[Personal] Nested child'].join('\n');
    check(sent.text === expectedText && sent.created === '2026-10-10', tag + ': importText receives regenerated lines\n' + sent.text);
    const linked = await page.evaluate(() => window.__mock.state.tasks.filter((t) => t.title === 'Publish the Hub mentor rota rota doc')[0]);
    check(linked && linked.link === 'https://docs.google.com/document/d/1Rota/edit' && linked.status === 'Done', tag + ': html link attached to the imported task via updateTask');
    check(/1 link attached/.test(await page.textContent('#import-result h2')), tag + ': result mentions the attached link');
    await shot(page, tag + '-import-result');
    await clearToasts(page);
    await gotoPage(page, 'today');
    check(await page.locator('#col-work .task', { hasText: 'Share the rubric with the team' }).count() === 1, tag + ': imported task appears on Today');

    // ---- Agenda: saved week, edit, save, regenerate, copy, download ----
    await gotoPage(page, 'agenda');
    check((await page.inputValue('#agenda-date')) === '2026-10-13', tag + ': agenda defaults to next Tuesday');
    check((await page.textContent('#agenda-state')).trim() === 'Saved', tag + ': saved agenda flagged');
    check(/With Dr Sarah Mitchell/.test(await page.textContent('#agenda-director')), tag + ': director name shown');
    check(await page.locator('[data-section="Questions"] .arow').count() === 4, tag + ': 4 saved questions');
    await page.locator('[data-section="Questions"] button.add').click();
    await page.locator('[data-section="Questions"] .arow').last().locator('textarea').first().fill('Can we fund two more micro:bit kits this term?');
    await page.locator('[data-section="Done"] .arow').first().locator('button[aria-label="Remove"]').click();
    await page.locator('[data-section="Questions"] .arow').last().locator('button[aria-label="Move up"]').click();
    await shot(page, tag + '-agenda-edited');
    await page.click('#agenda-save');
    check(await waitToast(page, 'Agenda saved (13 rows)'), tag + ': save toast with row count');
    const saved = await page.evaluate(() => window.__mock.state.agendaStore['2026-10-12']);
    check(saved.Done.length === 2 && saved.Questions.length === 5 && saved.Questions[3].item === 'Can we fund two more micro:bit kits this term?' && saved.Questions[3].order === 4, tag + ': saveAgenda payload has the edited rows in order');
    await clearToasts(page);
    await page.click('#agenda-copy');
    check(await waitToast(page, 'Agenda copied as text'), tag + ': copy-as-text toast');
    const copied = await page.evaluate(() => window.__copied || '');
    check(/^Director meeting agenda — Tuesday 13 October 2026\nWindow: Tuesday 6 October 2026 to Monday 12 October 2026\nDirector: Dr Sarah Mitchell\n\nDONE\n1\. /.test(copied), tag + ': copied agenda text');
    await clearToasts(page);
    await downloadCheck(page, '#agenda-download', 'agenda-2026-10-13', opts.xlsx, tag, 'Agenda', (ws) =>
      ws.A5 && ws.A5.v === 'Section' && Object.keys(ws).some((k) => /^D\d+$/.test(k) && ws[k].l && ws[k].l.Target === 'https://docs.google.com/document/d/1AbCdEf/edit'));
    await page.click('#agenda-regenerate');
    check(await waitToast(page, 'Draft regenerated'), tag + ': regenerate toast');
    check((await page.textContent('#agenda-state')).trim() === 'Draft' && await page.locator('[data-section="Questions"] .arow').count() === 5, tag + ': regenerate keeps saved questions, flags draft');
    await clearToasts(page);
    // Unsaved edits are guarded: changing the week first asks, then loads once the edits are discarded.
    await page.locator('[data-section="Questions"] .arow').first().locator('textarea').fill('An unsaved edit');
    await page.fill('#agenda-date', '2026-10-20');
    await page.dispatchEvent('#agenda-date', 'change');
    check(await waitToast(page, 'unsaved agenda edits'), tag + ': changing the week with unsaved edits asks first');
    check((await page.inputValue('#agenda-date')) === '2026-10-13' && (await page.locator('[data-section="Questions"] .arow').first().locator('textarea').inputValue()) === 'An unsaved edit',
      tag + ': the edited week stays until the edits are discarded');
    await page.locator('.toast .act', { hasText: 'Discard edits' }).click();
    await page.waitForFunction(() => document.querySelector('#agenda-window').textContent.indexOf('Tue 13 Oct') === 0);
    check((await page.textContent('#agenda-state')).trim() === 'Draft' && (await page.inputValue('#agenda-date')) === '2026-10-20', tag + ': another week loads a draft with its window after discarding');
    await clearToasts(page);

    // ---- Newsletter ----
    await gotoPage(page, 'newsletter');
    check((await page.inputValue('#nl-from')) === '2026-09-12' && (await page.inputValue('#nl-to')) === '2026-10-10', tag + ': newsletter defaults to the last 28 days');
    check(await page.locator('#nl-list .item').count() >= 5, tag + ': newsletter lists items');
    await page.click('#nl-copy');
    check(await waitToast(page, 'Newsletter copied as Markdown'), tag + ': newsletter copy toast');
    check(/^# AI Learning Hub — newsletter notes\n/.test(await page.evaluate(() => window.__copied || '')), tag + ': copied markdown from the server (Newsletter.gs heading)');
    await clearToasts(page);
    await downloadCheck(page, '#nl-download', 'newsletter-2026-10-10', opts.xlsx, tag, 'Newsletter', (ws) => ws.A3 && ws.A3.v === 'Project');
    await page.fill('#nl-from', '2026-10-01');
    await page.click('#nl-apply');
    await page.waitForTimeout(150);
    check((await page.evaluate(() => window.__mock.calls.filter((c) => c.name === 'getNewsletter').slice(-1)[0].payload.from)) === '2026-10-01', tag + ': newsletter range applied');

    // ---- History ----
    await gotoPage(page, 'history');
    const histCount = await page.locator('#history-list .item').count();
    check(histCount >= 6, tag + ': history lists done tasks (' + histCount + ')');
    await page.locator('#history-list .item', { hasText: 'Return library books' }).locator('button', { hasText: 'Reopen' }).click();
    check(await waitToast(page, 'Reopened: Return library books'), tag + ': history reopen toast');
    check(await page.locator('#history-list .item', { hasText: 'Return library books' }).count() === 0, tag + ': reopened task leaves history');
    const afterReopen = await page.evaluate(() => { const a = document.activeElement; return { text: a ? a.textContent.trim() : '', inList: !!(a && a.closest('#history-list')), submit: !!(a && a.closest('#history-filters') && a.type === 'submit') }; });
    check((afterReopen.text === 'Reopen' && afterReopen.inList) || afterReopen.submit, tag + ': Reopen moves focus to the next item\'s Reopen button (else Apply) ' + JSON.stringify(afterReopen));
    await page.selectOption('#h-status', 'Dropped');
    await page.fill('#h-from', '');
    await page.click('#history-filters button[type="submit"]');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#history-list .item')).some((e) => /Dropped/.test(e.textContent)));
    ok(tag + ': history filter switches to dropped');
    await shot(page, tag + '-history-dropped');
    await gotoPage(page, 'today');
    check(await page.locator('#col-personal .task', { hasText: 'Return library books' }).count() === 1, tag + ': reopened task appears on Today');

    // ---- hash navigation on a fresh load + boot failure/retry ----
    await page.goto(url + '#newsletter');
    await page.waitForSelector('body[data-ready="1"]');
    check(await page.isVisible('#page-newsletter') && /active/.test(await page.getAttribute('#tabs a[data-page="newsletter"]', 'class')), tag + ': URL hash selects the page on load');
    await page.goto(url + '?failboot=1#today');
    await page.waitForSelector('#boot-error:not([hidden])');
    check((await page.textContent('#boot-error-text')).trim() === 'Not allowed', tag + ': boot error shows the server message');
    await shot(page, tag + '-boot-error');
    await page.click('#boot-retry');
    await page.waitForSelector('body[data-ready="1"]');
    ok(tag + ': retry after boot error recovers');
  } catch (e) {
    fail(tag + ': step threw: ' + (e.stack || e));
    try { await shot(page, tag + '-FAILED'); } catch (e2) { /* ignore */ }
  } finally {
    const allowed = (t) => !opts.xlsx && /Failed to load resource/.test(t) && /xlsx\.full\.min\.js/.test(t); // the deliberately blocked SheetJS load
    const bad = errors.filter((t) => !allowed(t));
    check(bad.length === 0, tag + ': no console errors or uncaught exceptions' + (bad.length ? '\n  ' + bad.join('\n  ') : ''));
    check(unexpected.length === 0, tag + ': no unexpected network requests' + (unexpected.length ? ' ' + unexpected.join(', ') : ''));
    await context.close();
  }
}

async function downloadCheck(page, selector, baseName, xlsx, tag, sheetName, cellCheck) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click(selector)]);
  const name = dl.suggestedFilename();
  const dest = path.join(DOWNLOADS, tag + '-' + name);
  await dl.saveAs(dest);
  const buf = fs.readFileSync(dest);
  if (xlsx) {
    check(name === baseName + '.xlsx' && buf.slice(0, 2).toString() === 'PK', tag + ': ' + selector + ' downloads ' + name + ' (zip)');
    check(await waitToast(page, 'Downloaded ' + name), tag + ': xlsx toast');
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true }); // cellStyles is needed to read !cols back
      const ws = wb.Sheets[wb.SheetNames[0]];
      check(wb.SheetNames.length === 1 && wb.SheetNames[0] === sheetName, tag + ': workbook has one sheet "' + sheetName + '"');
      check(Array.isArray(ws['!cols']) && ws['!cols'].length >= 4, tag + ': column widths set');
      check(!!cellCheck(ws), tag + ': hyperlink / header cell present in ' + name);
    } catch (e) { fail(tag + ': could not read back ' + name + ': ' + e.message); }
  } else {
    check(name === baseName + '.csv' && buf.toString('utf8').indexOf('﻿') === 0, tag + ': falls back to ' + name + ' when SheetJS is missing');
    check(await waitToast(page, 'did not load, so this is a .csv'), tag + ': CSV fallback explained in a toast');
  }
  await clearToasts(page);
  return dest;
}

async function main() {
  pure.run();
  const file = assemble({});
  const url = 'file://' + file;
  const xlsxAvailable = fs.existsSync(XLSX_LOCAL) && sha384(XLSX_LOCAL) === XLSX_SHA384;
  console.log('assembled ' + file + (xlsxAvailable ? ' (SheetJS served from node_modules, hash verified)' : ' (SheetJS not available locally: xlsx path skipped)'));
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const browser = await launchBrowser();
  try {
    await runViewport(browser, url, { name: 'mobile', width: 390, height: 844 }, { xlsx: xlsxAvailable });
    await runViewport(browser, url, { name: 'desktop', width: 1280, height: 900 }, { xlsx: xlsxAvailable });
    await runViewport(browser, url, { name: 'mobile-dark', width: 390, height: 844, dark: true }, { xlsx: xlsxAvailable, screenshotsOnly: true });
    await runViewport(browser, url, { name: 'desktop-noxlsx', width: 1280, height: 900 }, { xlsx: false });
  } finally {
    await browser.close();
  }
  console.log('\nScreenshots:');
  shots.forEach((s) => console.log('  ' + s));
  console.log('Downloads: ' + DOWNLOADS);
  if (failures.length) { console.error('\n' + failures.length + ' failure(s):\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('\nrender check: all steps passed');
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
