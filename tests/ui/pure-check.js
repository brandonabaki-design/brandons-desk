#!/usr/bin/env node
/*
 * Evals the /* pure:start *\/ … /* pure:end *\/ block of apps-script/App.html in a bare node:vm context
 * (no DOM, no google.*) and checks the helpers the UI relies on. Run by tests/ui/render.js first, or alone:
 *   node tests/ui/pure-check.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const APP = path.join(__dirname, '..', '..', 'apps-script', 'App.html');

function loadPure() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.indexOf('/* pure:start */');
  const end = src.indexOf('/* pure:end */');
  if (start < 0 || end < 0 || end < start) throw new Error('pure markers missing in App.html');
  const code = src.slice(start, end);
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // bare identifiers only: `agenda.window` (a property) is fine, `window.x` is not
  if (/(^|[^.\w])(document|window|navigator|google|localStorage)\b/.test(noComments)) throw new Error('pure block references the DOM or google.*');
  if (/\?\.|\?\?/.test(src)) throw new Error('App.html uses optional chaining or nullish coalescing');
  const ctx = vm.createContext({});
  new vm.Script(code, { filename: 'App.html(pure)' }).runInContext(ctx);
  return ctx;
}

const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m); // values come from another vm realm

function run() {
  const p = loadPure();
  const today = '2026-10-10';
  // esc / sanitiseLink
  assert.equal(p.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(p.sanitiseLink(' https://example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.equal(p.sanitiseLink('HTTP://example.com'), 'HTTP://example.com');
  ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.com', 'ftp://x', '', null, undefined, ' JAVASCRIPT:alert(1)'].forEach((bad) => assert.equal(p.sanitiseLink(bad), '', String(bad)));
  // dates
  assert.equal(p.formatDateLabel(today, today), 'Today');
  assert.equal(p.formatDateLabel('2026-10-11', today), 'Tomorrow');
  assert.equal(p.formatDateLabel('2026-10-09', today), 'Yesterday');
  assert.equal(p.formatDateLabel('2026-10-14', today), 'Wed 14 Oct');
  assert.equal(p.formatDateLabel('2025-12-31', today), 'Wed 31 Dec 2025');
  assert.equal(p.formatDateLabel('', today), '');
  assert.equal(p.formatDateLabel('not a date', today), '');
  assert.equal(p.formatDateLong('2026-10-13'), 'Tuesday 13 October 2026');
  assert.equal(p.addDays('2026-10-10', -28), '2026-09-12');
  assert.equal(p.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(p.formatDateTimeLabel('2026-10-10T06:15:00+04:00', today), 'Today 06:15');
  // grouping and sort
  const tasks = [
    { id: 'a', status: 'Open', due: '2026-10-07', priority: 'Normal', created: '2026-10-01' },
    { id: 'b', status: 'Open', due: today, priority: 'Normal', created: '2026-10-02' },
    { id: 'c', status: 'Open', due: '', priority: 'High', created: '2026-10-03' },
    { id: 'd', status: 'Open', due: '2026-10-20', priority: 'Normal', created: '2026-10-09' },
    { id: 'e', status: 'Open', due: '', priority: 'Normal', created: '2026-10-04' },
    { id: 'f', status: 'Done', done: today, updated: '2026-10-10T09:00:00+04:00' },
    { id: 'g', status: 'Done', done: '2026-10-09' },
    { id: 'h', status: 'Dropped' },
    { id: 'i', status: 'Open', due: '2026-10-01', priority: 'Normal', created: '2026-10-01' }
  ];
  const g = p.groupTasks(tasks, today);
  eq(g.overdue.map((t) => t.id), ['i', 'a']);
  eq(g.dueToday.map((t) => t.id), ['b']);
  eq(g.open.map((t) => t.id), ['c', 'd', 'e']);
  eq(g.doneToday.map((t) => t.id), ['f']);
  assert.equal(p.matchesSearch({ title: 'Email Parents', note: '' }, 'parent'), true);
  assert.equal(p.matchesSearch({ title: 'Email Parents', project: 'Hub' }, 'xyz'), false);
  // formula guard and CSV
  assert.equal(p.formulaGuard('=SUM(A1)'), ' =SUM(A1)');
  assert.equal(p.formulaGuard('+1'), ' +1');
  assert.equal(p.formulaGuard('-x'), ' -x');
  assert.equal(p.formulaGuard('@me'), ' @me');
  assert.equal(p.formulaGuard('plain'), 'plain');
  assert.equal(p.csvFromRows([['a', 'b,c', 'say "hi"'], ['=1+1']]), 'a,"b,c","say ""hi"""\r\n =1+1');
  // agenda workbook rows
  const agenda = { meetingDate: '2026-10-13', window: { from: '2026-10-06', to: '2026-10-12' }, sections: {
    'Done': [{ order: 1, item: 'Did a thing', detail: 'Hub · note', link: 'https://x.test/1', taskId: 'W-1' }],
    'In progress': [{ order: 1, item: '=cmd', detail: '', link: 'javascript:alert(1)', taskId: 'W-2' }],
    'Questions': [{ order: 1, item: 'Why?', detail: '', link: '', taskId: '' }], 'Documents': [], 'Notes': [] } };
  const wb = p.buildAgendaWorkbookRows(agenda, { directorName: 'Dr X' });
  assert.equal(wb.sheetName, 'Agenda');
  assert.equal(wb.rows[0][0], 'Director meeting agenda — Tuesday 13 October 2026');
  assert.equal(wb.rows[1][0], 'Window: Tuesday 6 October 2026 to Monday 12 October 2026');
  assert.equal(wb.rows[2][0], 'Director: Dr X');
  eq(wb.rows[4], ['Section', 'Item', 'Detail', 'Link']);
  eq(wb.rows[5], ['Done', 'Did a thing', 'Hub · note', 'https://x.test/1']);
  eq(wb.rows[6], ['In progress', ' =cmd', '', '']);
  eq(wb.links, [{ r: 5, c: 3, url: 'https://x.test/1' }]);
  assert.equal(wb.cols.length, 4);
  const text = p.agendaToText(agenda, { directorName: 'Dr X' });
  assert.ok(text.indexOf('DONE\n1. Did a thing — Hub · note https://x.test/1') >= 0, text);
  assert.ok(text.indexOf('javascript:') < 0);
  const nl = p.buildNewsletterWorkbookRows([{ id: 'W-1', project: 'Hub', title: 'T', note: 'N', status: 'Done', done: '2026-10-01', link: 'https://x.test/2' }], { from: '2026-09-12', to: today });
  assert.equal(nl.sheetName, 'Newsletter');
  eq(nl.rows[2], ['Project', 'Item', 'Note', 'Status', 'Done', 'Link']);
  eq(nl.links, [{ r: 3, c: 5, url: 'https://x.test/2' }]);
  // import text parsing: every syntax in SPEC section 6
  const rows = p.parseImportText([
    '# AI Learning Hub',
    '- Email the parents about the trip @2026-10-14 !',
    '* [Personal] Buy milk due: 2026-10-15',
    '[P] Call mum !!',
    '[W] 1. Numbered item',
    '2) Another numbered',
    '• Bullet dot',
    '☐ Unchecked box',
    '[ ] Empty box',
    '- [x] Done thing',
    '[x] Also done',
    '✓ Tick done',
    '✔ Heavy tick done',
    '☑ Ballot box done',
    'ok',
    '',
    '   ',
    '# ',
    'No project after blank heading',
    '[Work] - [x] Category then done @2026-10-20'
  ].join('\n'), 'Work');
  assert.equal(rows.length, 15, JSON.stringify(rows.map((r) => r.title)));
  eq(rows[0], { include: true, category: 'Work', title: 'Email the parents about the trip', project: 'AI Learning Hub', done: false, due: '2026-10-14', priority: 'High', link: '', source: 'text', raw: '- Email the parents about the trip @2026-10-14 !' });
  assert.equal(rows[1].category, 'Personal'); assert.equal(rows[1].title, 'Buy milk'); assert.equal(rows[1].due, '2026-10-15');
  assert.equal(rows[2].category, 'Personal'); assert.equal(rows[2].title, 'Call mum'); assert.equal(rows[2].priority, 'High');
  assert.equal(rows[3].title, 'Numbered item'); assert.equal(rows[3].category, 'Work');
  assert.equal(rows[4].title, 'Another numbered');
  assert.equal(rows[5].title, 'Bullet dot');
  assert.equal(rows[6].title, 'Unchecked box'); assert.equal(rows[6].done, false);
  assert.equal(rows[7].title, 'Empty box'); assert.equal(rows[7].done, false);
  ['Done thing', 'Also done', 'Tick done', 'Heavy tick done', 'Ballot box done'].forEach((t, i) => { assert.equal(rows[8 + i].title, t); assert.equal(rows[8 + i].done, true); });
  assert.equal(rows[13].title, 'No project after blank heading'); assert.equal(rows[13].project, '');
  assert.equal(rows[14].title, 'Category then done'); assert.equal(rows[14].done, true); assert.equal(rows[14].due, '2026-10-20');
  // regenerated text round-trips through the same parser
  const text2 = p.previewRowsToText([
    { include: true, category: 'Work', title: 'Plain one', project: '', done: false, due: '', priority: 'Normal' },
    { include: false, category: 'Work', title: 'Excluded', project: '', done: false, due: '', priority: 'Normal' },
    { include: true, category: 'Personal', title: 'Hub thing', project: 'AI Learning Hub', done: true, due: '2026-10-14', priority: 'High' },
    { include: true, category: 'Work', title: 'No project but later', project: '', done: false, due: '', priority: 'Normal' },
    { include: true, category: 'Work', title: '   ', project: '', done: false, due: '', priority: 'Normal' }
  ]);
  // preview order is kept; a bare "#" clears the project again
  assert.equal(text2, '[Work] Plain one\n# AI Learning Hub\n[Personal] [x] Hub thing @2026-10-14 !\n#\n[Work] No project but later');
  const back = p.parseImportText(text2, 'Personal');
  eq(back.map((r) => [r.category, r.title, r.project, r.done, r.due, r.priority]), [
    ['Work', 'Plain one', '', false, '', 'Normal'], ['Personal', 'Hub thing', 'AI Learning Hub', true, '2026-10-14', 'High'], ['Work', 'No project but later', '', false, '', 'Normal']]);
  assert.equal(p.previewRowsToText([{ include: true, category: 'Work', title: 'Only one', project: 'X', done: false, due: '', priority: 'Normal' }]), '# X\n[Work] Only one');
  assert.equal(p.normaliseTitleKey('Re: Email the Parents!'), 'email the parents');
  // SPEC 6 "lines ≤ 2 chars are skipped" is measured after stripping, as the server does: a 2-char bulleted title is skipped too
  eq(p.parseImportText('- ab\n* [x] ok\n[W] - xy !\n- abc\n[P] ok', 'Work').map((r) => r.title), ['abc']);
  // import link matching keys on the title the server stores (cut to 140, trailing "!" marks dropped)
  assert.equal(p.importTitleKey('x'.repeat(150)), p.importTitleKey('x'.repeat(140)));
  assert.notEqual(p.importTitleKey('x'.repeat(150)), p.normaliseTitleKey('x'.repeat(150)));
  assert.equal(p.importTitleKey('  Call   mum !!'), 'call mum');
  assert.equal(p.importTitleKey('Re: Email the Parents!'), 'email the parents');
  console.log('pure-check: ok (' + Object.keys(p).filter((k) => typeof p[k] === 'function').length + ' helpers)');
}

if (require.main === module) {
  try { run(); } catch (e) { console.error('pure-check: FAIL\n' + (e.stack || e)); process.exit(1); }
}
module.exports = { run, loadPure };
