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
  agendaChecks(p, agenda);
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
  deskChecks(p);
  console.log('pure-check: ok (' + Object.keys(p).filter((k) => typeof p[k] === 'function').length + ' helpers)');
}

/* The Agenda page helpers of docs/AGENDA.md section 2: generated kept and sent back, the stamp, the conflict error, and the
   "Window: …" line only for an unsaved draft. */
function agendaChecks(p, draft) {
  // the window line: a draft has it, a saved agenda (which may cover two weeks) does not
  assert.equal(p.agendaShowsWindow(draft), true);
  const saved = Object.assign({}, draft, { saved: true });
  assert.equal(p.agendaShowsWindow(saved), false);
  assert.equal(p.agendaShowsWindow({ saved: false }), false);
  assert.equal(p.agendaShowsWindow(null), false);
  const wbSaved = p.buildAgendaWorkbookRows(saved, { directorName: 'Dr X' });
  eq(wbSaved.rows.slice(0, 4), [['Director meeting agenda — Tuesday 13 October 2026'], ['Director: Dr X'], [], ['Section', 'Item', 'Detail', 'Link']]);
  eq(wbSaved.links, [{ r: 4, c: 3, url: 'https://x.test/1' }]);
  assert.equal(wbSaved.fileName, 'agenda-2026-10-13');
  const textSaved = p.agendaToText(saved, {});
  assert.ok(textSaved.indexOf('Window') < 0 && textSaved.indexOf('Director meeting agenda — Tuesday 13 October 2026\n\nDONE\n') === 0, textSaved);
  // normaliseAgenda: generated and the stamp kept, wrong types tolerated
  const n = p.normaliseAgenda({ meetingDate: '2026-10-20', weekOf: '2026-10-19', window: { from: '2026-10-13', to: '2026-10-19' }, saved: true, stamp: '0123456789abcdef',
    sections: { Done: [{ order: 2, item: 'A', detail: 'd', link: 'https://x.test/a', taskId: 'W-1', generated: '2026-10-19 06:45 claude-desk' }, 'bad', null, { item: 7 }],
      Questions: 'not a list', Extra: [{ item: 'ignored' }] } });
  eq(Object.keys(n.sections), ['Done', 'In progress', 'Questions', 'Documents', 'Notes']);
  eq(n.sections.Done, [{ order: 2, item: 'A', detail: 'd', link: 'https://x.test/a', taskId: 'W-1', generated: '2026-10-19 06:45 claude-desk' },
    { order: 0, item: '7', detail: '', link: '', taskId: '', generated: '' }]);
  eq([n.sections.Questions, n.saved, n.stamp, n.meetingDate, n.window], [[], true, '0123456789abcdef', '2026-10-20', { from: '2026-10-13', to: '2026-10-19' }]);
  const n2 = p.normaliseAgenda({ saved: 'yes', stamp: 42, window: 'x' });
  eq([n2.saved, n2.stamp, n2.window, n2.meetingDate], [false, '', null, '']);
  eq(p.normaliseAgenda(null).sections.Notes, []);
  // agendaSectionsForSave: rows without an Item dropped (a bare link names a document; in the other sections a cleared row with
  // a task link is dropped, not saved as its URL), renumbered, generated sent as loaded
  const out = p.agendaSectionsForSave({
    Done: [{ item: '  Kept  as  is ', detail: ' d ', link: 'https://x.test/1', taskId: 'W-1', generated: '2026-10-19 06:45 claude-desk' }, { item: '   ', generated: 'web-draft' },
      { item: '  ', link: 'https://x.test/y', generated: '2026-10-19 06:45 claude-desk' }, { item: 'Edited', generated: '' }],
    'In progress': [{ item: '', detail: 'only a detail', link: 'https://mail.google.com/mail/u/0/#all/18f3', taskId: 'W-2', generated: '' }],
    Questions: [{ item: 'Draft question', generated: 'web-draft' }, { item: 'Odd', generated: 42 }, { item: ' ', link: 'https://x.test/q' }],
    Documents: [{ item: '', link: 'https://docs.example/d', generated: '' }, { item: 'No link', link: 'javascript:alert(1)' }]
  });
  eq(out.Done, [{ order: 1, item: 'Kept as is', detail: 'd', link: 'https://x.test/1', taskId: 'W-1', generated: '2026-10-19 06:45 claude-desk' },
    { order: 2, item: 'Edited', detail: '', link: '', taskId: '', generated: '' }]);
  eq(out.Questions.map((r) => [r.order, r.item, r.generated]), [[1, 'Draft question', 'web-draft'], [2, 'Odd', '']]);
  eq(out.Documents.map((r) => [r.item, r.link]), [['https://docs.example/d', 'https://docs.example/d'], ['No link', '']]);
  eq([out['In progress'], out.Notes], [[], []]);
  // the conflict error from saveAgenda (Agenda.gs AGENDA_CONFLICT_MESSAGE), also through the ScriptError prefix
  assert.equal(p.isAgendaConflict("This agenda changed since you opened it (Claude's weekly review or another tab saved it). Copy any edits you want to keep, then reload the agenda."), true);
  assert.equal(p.isAgendaConflict('Sheet is locked, try again'), false);
  assert.equal(p.isAgendaConflict(null), false);
}

/* The Desk helpers (docs/DESK.md). Fixture text is fictional. */
function deskChecks(p) {
  const AW = 'https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#';
  const PT = 'https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:';
  // link targets: the same rules as the server (DESK.md section 1), then the http/https sanitiser
  assert.equal(p.expandDeskLink('wt:18f3a1b2c3d4e5f6'), AW + 'all/18f3a1b2c3d4e5f6');
  assert.equal(p.expandDeskLink('  wt:abc  '), AW + 'all/abc');
  assert.equal(p.expandDeskLink('w:subject:(mentor rota) newer_than:7d'), AW + 'search/subject%3A(mentor+rota)+newer_than%3A7d');
  assert.equal(p.expandDeskLink('w:a+b & c/d'), AW + 'search/a%2Bb+%26+c%2Fd'); // a literal "+" stays encoded, spaces become "+"
  assert.equal(p.expandDeskLink('p:1812345678901234567'), PT + '1812345678901234567');
  assert.equal(p.expandDeskLink(' https://docs.example.com/d/1 '), 'https://docs.example.com/d/1');
  assert.equal(p.expandDeskLink(null), '');
  assert.equal(p.expandDeskLink(undefined), '');
  assert.equal(p.expandDeskLink('W:upper case is not a prefix'), ''); // not a prefix, and not a URL either: sanitised away, as on the server
  assert.equal(p.expandDeskLink(' https://docs.example.com/a b"c<d> '), 'https://docs.example.com/abcd'); // the server's sanitiseLink rule
  assert.equal(p.expandDeskLink('w:\ud800'), ''); // a lone surrogate cannot be encoded: no link (and no exception)
  assert.equal(p.sanitiseStoredLink(' https://x.example/a\u0001 b '), 'https://x.example/ab');
  assert.equal(p.sanitiseStoredLink('javascript:alert(1)'), '');
  assert.equal(p.deskHref('wt:abc'), AW + 'all/abc');
  assert.equal(p.deskHref('p:42'), PT + '42');
  assert.equal(p.deskHref('http://example.com'), 'http://example.com');
  ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'ftp://x.example', 'W:abc', 'mailto:a@b.c', '', null, 42, {}].forEach((bad) =>
    assert.equal(p.deskHref(bad), '', 'deskHref(' + JSON.stringify(bad) + ')'));
  // categories as the server decides them
  assert.equal(p.deskCategoryOf({ task: 'W-abc12345', tags: [['home', 'Personal']] }), 'Work');
  assert.equal(p.deskCategoryOf({ task: 'P-abc12345' }), 'Personal');
  assert.equal(p.deskCategoryOf({ tags: [['due', 'Today'], ['home', 'Personal']] }), 'Personal');
  assert.equal(p.deskCategoryOf({ tags: 'not a list' }), 'Work');
  assert.equal(p.deskCategoryOf(null), 'Work');
  // normaliseDesk: everything missing
  const empty = p.normaliseDesk(undefined);
  eq(empty.lanes, [{ key: 'now', title: 'Do today' }, { key: 'reply', title: 'Reply & follow up' }, { key: 'later', title: 'This week' }]);
  eq([empty.strip, empty.items, empty.cleared, empty.priorities, empty.coming, empty.quick, empty.agenda, empty.llt, empty.built], [[], [], [], [], [], [], null, null, '']);
  // normaliseDesk: wrong types everywhere are tolerated
  const n = p.normaliseDesk({
    built: 'Mon 12 Oct, 6:45am', eyebrow: 7, sources: null, lanes: [{ key: '' }, 'x', { key: 'now', title: '' }, { key: 'later', title: 'Later' }],
    strip: [{ cls: 'now', d: 'Mon 12', t: 'A', s: 'B', href: 'https://cal.example/1' }, { cls: 'evil" onclick="x', d: 'Tue 13' }, 'no'],
    items: [{ id: 'a1', lane: 'now', title: 'One', why: 'Why', tags: [['late', 'Since Fri 9'], ['solo'], 'x', ['', 'Email', 'extra']], links: [['Doc', 'wt:1'], ['label only']], task: 'P-x', done: 'yes' },
      'not an object', null, { title: 'No id', lane: 'nowhere', tags: 'nope', links: {}, done: true, category: 'Martian' }],
    cleared: ['Sent it', '', '   ', null, 3],
    priorities: [{ title: 'Hub', tag: ['due', 'Tue 13'], points: ['a', ''], links: [['Plan', 'https://x.example']] }, { title: 'Club', tag: 'bad', points: 'bad' }],
    coming: [{ when: 'Tue 13', hl: 1, title: 'Meet', detail: '', href: 'javascript:alert(1)' }, { when: 'Wed 14', hl: true, title: 'PD' }],
    agenda: { title: '', open: 'true', sections: [{ name: 'Done', items: [{ t: 'X', d: 'Y' }, 'bad'] }, 'bad'] },
    llt: { padlet: 'https://padlet.example/x', working: ['a', ''], great: 'bad', raise: [{ t: 'R', d: 'D' }, 'bad'] },
    quick: [['Sheet', 'Tracker', 'https://docs.example/s'], 'bad', ['Only title']]
  });
  eq(n.lanes, [{ key: 'now', title: 'now' }, { key: 'later', title: 'Later' }]);
  eq(n.strip.map((s) => s.cls), ['now', '']);
  assert.equal(n.eyebrow, '7'); assert.equal(n.sources, '');
  assert.equal(n.items.length, 2);
  eq(n.items[0], { id: 'a1', lane: 'now', title: 'One', why: 'Why', tags: [['late', 'Since Fri 9'], ['', 'Email']], links: [['Doc', 'wt:1']], task: 'P-x', category: 'Personal', taskId: '', status: '', done: false });
  eq([n.items[1].id, n.items[1].tags, n.items[1].links, n.items[1].done, n.items[1].category], ['', [], [], true, 'Work']);
  eq(n.cleared, ['Sent it', '3']);
  eq(n.priorities, [{ title: 'Hub', tag: ['due', 'Tue 13'], points: ['a'], links: [['Plan', 'https://x.example']] }, { title: 'Club', tag: null, points: [], links: [] }]);
  eq(n.coming.map((c) => [c.title, c.hl, c.href]), [['Meet', false, 'javascript:alert(1)'], ['PD', true, '']]);
  eq(n.agenda, { title: 'Director agenda', open: false, meeting: '', sections: [{ name: 'Done', items: [{ t: 'X', d: 'Y' }] }] });
  // agenda.meeting (docs/AGENDA.md section 2): kept when it is a real yyyy-MM-dd date, else ''
  const meeting = (m) => p.normaliseDesk({ agenda: { title: 'T', meeting: m, sections: [] } }).agenda.meeting;
  assert.equal(meeting('2026-10-20'), '2026-10-20');
  assert.equal(meeting(' 2026-10-20 '), '2026-10-20');
  ['2026-02-30', '2026-13-01', '20 Oct', '2026-10-20T10:00', '2026-1-20', 20261020, null, undefined, {}, ['2026-10-20']].forEach((bad) => assert.equal(meeting(bad), '', JSON.stringify(bad)));
  // the Desk's agenda block from a saved agenda: Done, In progress, Decisions & questions, Documents (with links) when any; no Notes
  const savedAgenda = p.normaliseAgenda({ meetingDate: '2026-10-20', saved: true, stamp: 'ab', sections: {
    Done: [{ item: ' Kits  ordered ', detail: 'Arrived', link: 'https://x.test/k' }], 'In progress': [], Questions: [{ item: 'Budget?', detail: '' }],
    Documents: [{ item: 'Unit plan', detail: 'For the rubric', link: 'https://docs.example/plan' }, { item: 'Bad link', link: 'javascript:alert(1)' }],
    Notes: [{ item: 'Private note' }] } });
  eq(p.deskSavedAgendaSections(savedAgenda), [
    { name: 'Done', items: [{ t: 'Kits ordered', d: 'Arrived', link: 'https://x.test/k' }] },
    { name: 'In progress', items: [] },
    { name: 'Decisions & questions', items: [{ t: 'Budget?', d: '', link: '' }] },
    { name: 'Documents', items: [{ t: 'Unit plan', d: 'For the rubric', link: 'https://docs.example/plan' }, { t: 'Bad link', d: '', link: '' }], docs: true }]);
  savedAgenda.sections.Documents = [];
  eq(p.deskSavedAgendaSections(savedAgenda).map((s) => s.name), ['Done', 'In progress', 'Decisions & questions'], 'no Documents section when there are none');
  eq(p.deskSavedAgendaSections(null).map((s) => s.items.length), [0, 0, 0]);
  eq(n.llt, { title: 'LLT', padlet: 'https://padlet.example/x', working: ['a'], great: [], night: [], raise: [{ t: 'R', d: 'D' }] });
  eq(n.quick, [['Sheet', 'Tracker', 'https://docs.example/s'], ['Only title', '', '']]);
  // lanes and counts: an item in an unknown lane counts (and shows) in the first lane; added tasks count in the first lane
  const lanes = [{ key: 'now' }, { key: 'reply' }, { key: 'later' }];
  assert.equal(p.deskLaneKey('reply', lanes), 'reply');
  assert.equal(p.deskLaneKey('nowhere', lanes), 'now');
  assert.equal(p.deskLaneKey('x', []), '');
  eq(p.deskCounts(lanes, [{ lane: 'now', done: false }, { lane: 'now', done: true }, { lane: 'nowhere', done: false }, { lane: 'later', done: true }, { lane: 'reply', done: false }],
    [{ done: false }, { done: true }]), { done: 3, total: 7, open: { now: 3, reply: 1, later: 0 }, pct: 42.9 });
  eq(p.deskCounts(lanes, [], []), { done: 0, total: 0, open: { now: 0, reply: 0, later: 0 }, pct: 0 });
  // tag classes are whitelisted (the kind is sheet data)
  assert.equal(p.deskTagClass('late'), 'dk-tag dk-tag-late');
  assert.equal(p.deskTagClass('gh'), 'dk-tag dk-tag-gh');
  assert.equal(p.deskTagClass(''), 'dk-tag');
  assert.equal(p.deskTagClass('x" onclick="alert(1)'), 'dk-tag');
  // footer lines
  assert.equal(p.deskBuiltLine({ built: 'Mon 12 Oct, 6:45am Gulf time', sources: 'your calendar and Gmail.' }), 'Built Mon 12 Oct, 6:45am Gulf time from your calendar and Gmail.');
  assert.equal(p.deskBuiltLine({ built: 'Mon 12 Oct', sources: '' }), 'Built Mon 12 Oct.');
  assert.equal(p.deskBuiltLine({ built: '', sources: '' }), '');
  assert.equal(p.deskStaleNote('2026-10-09'), 'This Desk is from Friday 9 Oct; the next build is at 6:45 on school days.');
  assert.equal(p.deskStaleNote('2026-12-31'), 'This Desk is from Thursday 31 Dec; the next build is at 6:45 on school days.');
  assert.equal(p.deskStaleNote(''), 'This Desk is from an earlier day; the next build is at 6:45 on school days.');
  // agenda: copy as text (the routine page's format) and the workbook rows
  const agenda = { title: 'Tue 13 Oct · Director', open: true, sections: [
    { name: 'Done', items: [{ t: 'Mentors on board', d: 'Eight in the space' }, { t: 'Calendar sent', d: '' }] },
    { name: 'Decisions & questions', items: [{ t: '=Still mine?', d: '+18 sign-ups' }, { t: 'Anything  from\nyour side?', d: '' }] },
    { name: 'Empty', items: [] }] };
  assert.equal(p.deskAgendaToText(agenda), 'Tue 13 Oct · Director\n\nDONE\n1. Mentors on board (Eight in the space)\n2. Calendar sent\n\nDECISIONS & QUESTIONS\n1. =Still mine? (+18 sign-ups)\n2. Anything from your side?\n\nEMPTY');
  assert.equal(p.deskAgendaToText(null), '');
  const wb = p.deskAgendaWorkbookRows(agenda, { directorName: 'Dr Sam Example', builtDate: '2026-10-12' });
  assert.equal(wb.sheetName, 'Agenda');
  assert.equal(wb.fileName, 'desk-agenda-2026-10-12');
  eq(wb.rows, [['Tue 13 Oct · Director'], ['Director: Dr Sam Example'], [], ['Section', 'Item', 'Detail'],
    ['Done', 'Mentors on board', 'Eight in the space'], ['Done', 'Calendar sent', ''], ['Decisions & questions', ' =Still mine?', ' +18 sign-ups'], ['Decisions & questions', 'Anything from your side?', '']]);
  eq(wb.links, []);
  assert.equal(wb.cols.length, 3);
  const wb2 = p.deskAgendaWorkbookRows({ title: '@title', sections: [] }, {});
  eq(wb2.rows, [[' @title'], [], ['Section', 'Item', 'Detail']]);
  assert.equal(wb2.fileName, 'desk-agenda-draft');
  assert.equal(p.csvFromRows(wb.rows).split('\r\n')[6], 'Decisions & questions, =Still mine?, +18 sign-ups'); // the CSV fallback stays guarded
  // LLT paste text
  assert.equal(p.deskLltText({ working: ['Hub launch', 'PD  day'], great: ['Mentors'], night: [] }), 'Working On:\n* Hub launch\n* PD day\n\nGoing Great:\n* Mentors\n\nKeeping me up at night:\n');
  assert.equal(p.deskLltText(null), '');
  // a note after a tick joins the existing note as the server's appendNote_ does
  assert.equal(p.joinNote('', ' Sent  it '), 'Sent it');
  assert.equal(p.joinNote('Called', 'Booked Tue'), 'Called · Booked Tue');
  assert.equal(p.joinNote('Called · Booked Tue', 'Booked Tue'), 'Called · Booked Tue');
  assert.equal(p.joinNote('Booked Tue', 'Booked Tue'), 'Booked Tue');
  assert.equal(p.joinNote('Called', '   '), 'Called');
  assert.equal(p.DESK_URL, 'https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr');
}

if (require.main === module) {
  try { run(); } catch (e) { console.error('pure-check: FAIL\n' + (e.stack || e)); process.exit(1); }
}
module.exports = { run, loadPure };
