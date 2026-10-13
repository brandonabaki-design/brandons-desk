'use strict';
/**
 * The Desk page server side (docs/DESK.md sections 1 and 2): the Desk tab, getDesk and
 * setDeskItemDone, expandDeskLink and the due-tag resolution. Fixtures are fictional
 * (tests/fixtures/desk-data.json, built on Tue 2026-10-13).
 */
const { findUnsafe } = require('./fixtures/helpers');
const { DESK_BUILT, deskData, deskRows, splitItems, seedDesk } = require('./fixtures/desk-rows');
const { loadPure } = require('./ui/pure-check');

const NOW = '2026-10-13T06:00:00Z'; // Tue 13 Oct 2026, 10:00 in Dubai
const TODAY = '2026-10-13';
const DESK_URL = 'https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr';
const AISA = 'https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#';
const PERSONAL = 'https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:';
const DESK_FIELDS = ['built', 'eyebrow', 'sources', 'lanes', 'strip', 'items', 'cleared', 'priorities', 'coming', 'agenda', 'llt', 'quick'];

/** Appends one task row with the given fields (16-column row, Dates in date cells). */
function seedTask(sb, tab, fields) {
  const task = Object.assign({
    id: '', created: '2026-10-01', title: 'A task', details: '', source: 'Claude', link: '', status: 'Open', done: '',
    note: '', project: '', newsletter: false, discuss: false, due: '', priority: 'Normal', sourceKey: ''
  }, fields);
  sb.mock.seed(tab, [sb.gs.taskToRow(task, new Date('2026-10-01T05:00:00Z'))]);
}

function byId(desk) {
  const out = {};
  desk.items.forEach((it) => { out[it.id] = it; });
  return out;
}

/** The Work/Personal rows as Task objects. */
function tasks(sb, tab) {
  return sb.gs.readTasks(tab);
}

module.exports = async function (t) {
  // -------------------------------------------------------------------------
  // Sheet: the Desk tab
  // -------------------------------------------------------------------------

  await t.test('ensureSchema creates the Desk tab: Key / JSON / Built, column B (and C) as plain text', (sb, assert) => {
    const ss = sb.globals.SpreadsheetApp.create('Fresh');
    const r = sb.gs.ensureSchema(ss);
    assert.ok(r.created.includes('Desk'));
    assert.equal(r.created[r.created.length - 1], 'Desk', 'created after Log (sheetId 6)');
    const desk = ss.getSheetByName('Desk');
    assert.deepEqual(desk.getRange(1, 1, 1, 3).getValues()[0], ['Key', 'JSON', 'Built']);
    assert.equal(desk.getFrozenRows(), 1);
    assert.equal(desk.getRange(2, 2).getNumberFormat(), '@', 'JSON column is text');
    assert.equal(desk.getRange(900, 2).getNumberFormat(), '@', 'down the whole column');
    assert.equal(desk.getRange(2, 3).getNumberFormat(), '@', 'Built stays the text the routine wrote');
    assert.equal(desk.getRange(1, 2).getNumberFormat(), null, 'header row untouched');
    assert.equal(desk.metaGet_('backgrounds', 1, 1), '#21076C');

    // The live sheet pre-dates the Desk: ensureSchema adds just that tab, without warnings.
    const live = sb.mock.defaultSpreadsheet;
    live.deleteSheet(live.getSheetByName('Desk'));
    const again = sb.gs.ensureSchema();
    assert.deepEqual(again.created, ['Desk']);
    assert.deepEqual(again.warnings, []);
    assert.deepEqual(sb.mock.sheet('Desk').getRange(1, 1, 1, 3).getValues()[0], ['Key', 'JSON', 'Built']);
    assert.equal(sb.mock.sheet('Desk').getRange(2, 2).getNumberFormat(), '@');
    // With Sheets' input parsing modelled, text in B and C is stored as written.
    sb.mock.coerceStrings = true;
    sb.mock.sheet('Desk').appendRow(['cleared', '42', '2026-10-13']);
    assert.deepEqual(sb.mock.rows('Desk')[0], ['cleared', '42', '2026-10-13']);
  }, { now: NOW });

  await t.test('healSheet never touches the Desk tab', (sb, assert) => {
    seedDesk(sb, deskData());
    seedTask(sb, 'Work', { id: '', title: 'Routine row with blanks', status: '' });
    const before = JSON.stringify(sb.mock.rows('Desk'));
    const writes = sb.mock.cellWrites.length;
    assert.throws(() => sb.gs.healSheet('Desk'), /Category must be Work or Personal/);
    assert.equal(sb.gs.healSheet('Work').fixed, 1);
    sb.gs.healSheet('Personal');
    assert.equal(JSON.stringify(sb.mock.rows('Desk')), before);
    assert.ok(!sb.mock.cellWrites.slice(writes).some((w) => w.sheet === 'Desk'), 'no Desk cell written');
    sb.gs.getDesk({});
    assert.equal(JSON.stringify(sb.mock.rows('Desk')), before, 'getDesk only reads the tab');
  }, { now: NOW });

  // -------------------------------------------------------------------------
  // getDesk
  // -------------------------------------------------------------------------

  await t.test('getDesk on an empty Desk tab: reason "empty" with the Desk link; a missing tab is created', (sb, assert) => {
    seedTask(sb, 'Work', { id: 'W-manual01', title: 'Typed on the Desk', source: 'Manual', created: '2026-10-13' });
    const r = sb.gs.getDesk({});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
    assert.equal(r.deskUrl, DESK_URL);
    assert.deepEqual(r.added.map((x) => x.id), ['W-manual01'], 'Manual tasks still listed for the add box');
    assert.equal(findUnsafe(r), '');
    // Rows with unknown keys or blank JSON cells are not Desk data
    sb.mock.seed('Desk', [['notes', '{"a":1}', DESK_BUILT], ['items', '', DESK_BUILT], ['', '[1]', DESK_BUILT]]);
    assert.equal(sb.gs.getDesk({}).reason, 'empty');
    // No Desk tab at all (an older sheet): created with its header row, still "empty"
    const ss = sb.mock.defaultSpreadsheet;
    ss.deleteSheet(ss.getSheetByName('Desk'));
    assert.equal(sb.gs.getDesk({}).reason, 'empty');
    assert.deepEqual(sb.mock.sheet('Desk').getRange(1, 1, 1, 3).getValues()[0], ['Key', 'JSON', 'Built']);
  }, { now: NOW });

  await t.test('getDesk assembles the Desk from the tab: meta fields, every section, rebuild left out', (sb, assert) => {
    const data = deskData();
    seedDesk(sb, data);
    const r = sb.gs.getDesk({});
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r).sort(), ['added', 'builtAt', 'builtDate', 'desk', 'deskUrl', 'ok', 'stale']);
    assert.deepEqual(Object.keys(r.desk).sort(), DESK_FIELDS.slice().sort());
    assert.equal(r.desk.built, data.built);
    assert.equal(r.desk.eyebrow, data.eyebrow);
    assert.equal(r.desk.sources, data.sources);
    assert.deepEqual(r.desk.lanes, data.lanes);
    ['strip', 'cleared', 'priorities', 'coming', 'agenda', 'llt', 'quick'].forEach((k) => {
      assert.deepEqual(r.desk[k], data[k], k);
    });
    assert.equal(r.desk.rebuild, undefined, 'meta.rebuild is not passed on');
    assert.deepEqual(r.desk.items.map((it) => it.id), data.items.map((it) => it.id), 'items in order');
    const first = r.desk.items[0];
    assert.deepEqual(Object.keys(first).sort(), ['category', 'done', 'id', 'lane', 'links', 'status', 'tags', 'task', 'taskId', 'title', 'why']);
    assert.equal(first.title, data.items[0].title);
    assert.deepEqual(first.tags, data.items[0].tags);
    assert.deepEqual(first.links, data.items[0].links, 'link targets are passed raw; the client expands them');
    assert.equal(r.desk.items[1].task, '', 'a missing task is ""');
    assert.equal(r.builtAt, '2026-10-13 06:45');
    assert.equal(r.builtDate, '2026-10-13');
    assert.equal(r.stale, false);
    assert.equal(r.deskUrl, DESK_URL);
    assert.deepEqual(r.added, []);
    assert.equal(findUnsafe(r), '');
    JSON.stringify(r);
    // Row order in the tab does not matter
    const rows = deskRows(data).reverse();
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built']].concat(rows));
    const again = sb.gs.getDesk({});
    assert.deepEqual(again.desk, r.desk);
  }, { now: NOW });

  await t.test('getDesk joins items, items2, items3, … in numeric order (items10 after items9)', (sb, assert) => {
    const data = deskData();
    data.items = [];
    for (let i = 0; i < 60; i++) {
      data.items.push({ id: 'it' + i, lane: ['now', 'reply', 'later'][i % 3], title: 'Item ' + i, why: 'Why ' + 'x'.repeat(80), tags: [], links: [] });
    }
    const rows = deskRows(data, DESK_BUILT, { maxChars: 700 });
    const itemRows = rows.filter((row) => /^items\d*$/.test(row[0]));
    assert.ok(itemRows.length >= 11, 'the fixture splits into ' + itemRows.length + ' rows');
    itemRows.forEach((row) => assert.ok(row[1].length < 700, row[0] + ' stays under the limit'));
    // Write them shuffled: items10 and items11 before items2, items last
    const shuffled = rows.slice().sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
    sb.mock.seed('Desk', shuffled);
    const r = sb.gs.getDesk({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.desk.items.map((it) => it.id), data.items.map((it) => it.id));
  }, { now: NOW });

  await t.test('items split at the 45 000-character limit by whole items round-trip unchanged', (sb, assert) => {
    const data = deskData();
    data.items = [];
    for (let i = 0; i < 120; i++) {
      data.items.push({ id: 'big' + i, lane: 'later', title: 'Big item ' + i, why: 'w'.repeat(1000), tags: [['', 'Email']], links: [['Mail', 'wt:abc' + i]] });
    }
    assert.ok(JSON.stringify(data.items).length > 100000);
    const parts = splitItems(data.items);
    assert.ok(parts.length >= 3);
    parts.forEach((p) => assert.ok(JSON.stringify(p).length < 45000));
    seedDesk(sb, data);
    assert.ok(sb.mock.rows('Desk').every((row) => String(row[1]).length < 45000), 'every JSON cell under 45 000');
    const r = sb.gs.getDesk({});
    assert.equal(r.desk.items.length, 120);
    assert.deepEqual(r.desk.items.map((it) => it.id), data.items.map((it) => it.id));
  }, { now: NOW });

  await t.test('getDesk fills defaults for missing keys and tolerates wrong types', (sb, assert) => {
    sb.mock.seed('Desk', [
      ['items', JSON.stringify([{ id: 'a', title: 'Only item' }, 'not an item', { id: ' b ', lane: 'reply', title: 7, why: null, tags: [['due', 'Today'], 'Email', 5], links: 'nope', task: null }]), DESK_BUILT],
      [' STRIP ', '{"not":"a list"}', DESK_BUILT],
      ['agenda', '[1,2]', DESK_BUILT],
      ['llt', 'null', DESK_BUILT],
      ['items2', '{"not":"a list"}', DESK_BUILT],
      ['extra', '{"ignored":true}', DESK_BUILT]
    ]);
    const r = sb.gs.getDesk({});
    assert.equal(r.ok, true);
    assert.equal(r.desk.built, '');
    assert.equal(r.desk.eyebrow, '');
    assert.equal(r.desk.sources, '');
    assert.deepEqual(r.desk.lanes, [{ key: 'now', title: 'Do today' }, { key: 'reply', title: 'Reply & follow up' }, { key: 'later', title: 'This week' }]);
    ['strip', 'cleared', 'priorities', 'coming', 'quick'].forEach((k) => assert.deepEqual(r.desk[k], [], k));
    assert.equal(r.desk.agenda, null);
    assert.equal(r.desk.llt, null);
    assert.equal(r.desk.items.length, 2);
    assert.deepEqual(r.desk.items[0], { id: 'a', lane: '', title: 'Only item', why: '', tags: [], links: [], task: '', category: 'Work', taskId: '', status: '', done: false });
    assert.deepEqual(r.desk.items[1], { id: 'b', lane: 'reply', title: '7', why: '', tags: [['due', 'Today'], ['', 'Email']], links: [], task: '', category: 'Work', taskId: '', status: '', done: false });
    const warn = sb.mock.logRows().find((row) => row.fn === 'getDesk' && row.level === 'WARN');
    assert.ok(warn && /items2/.test(warn.message), 'a non-list items row is logged and skipped');
    assert.equal(findUnsafe(r), '');
    // meta of the wrong type, lanes with blanks and duplicates
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built'], ['meta', '{"built":5,"eyebrow":["x"],"lanes":[{"key":"now"},{"key":"now","title":"Again"},{"title":"No key"},"x",{"key":"soon","title":"Soon"}]}', DESK_BUILT], ['cleared', '["a"]', DESK_BUILT]]);
    const m = sb.gs.getDesk({});
    assert.equal(m.desk.built, '5');
    assert.equal(m.desk.eyebrow, '');
    assert.deepEqual(m.desk.lanes, [{ key: 'now', title: 'now' }, { key: 'soon', title: 'Soon' }]);
    assert.deepEqual(m.desk.items, []);
    assert.deepEqual(m.desk.cleared, ['a']);
  }, { now: NOW });

  await t.test('getDesk with a JSON cell that does not parse: reason "invalid" naming the key, logged', (sb, assert) => {
    const rows = deskRows(deskData(), DESK_BUILT, { maxChars: 900 });
    const i2 = rows.findIndex((row) => row[0] === 'items2');
    assert.ok(i2 > 0, 'the fixture has an items2 row');
    rows[i2][1] = rows[i2][1].slice(0, -7);
    seedTask(sb, 'Personal', { id: 'P-manual01', title: 'Mine', source: 'Manual' });
    sb.mock.seed('Desk', rows);
    const r = sb.gs.getDesk({});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
    assert.match(r.message, /"items2"/);
    assert.equal(r.deskUrl, DESK_URL);
    assert.deepEqual(r.added.map((x) => x.id), ['P-manual01']);
    assert.equal(findUnsafe(r), '');
    const err = sb.mock.logRows().filter((row) => row.fn === 'getDesk');
    assert.equal(err.length, 1);
    assert.equal(err[0].level, 'ERROR');
    assert.match(err[0].message, /row \d+ \(items2\) is not valid JSON \(\d+ characters/);
    assert.ok(!/Year|slides|plumber|"/.test(err[0].message), 'no cell text in the Log: ' + err[0].message);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides', done: true }), /"items2"/);
    assert.equal(tasks(sb, 'Work').length, 0, 'no row created from an unreadable Desk');
  }, { now: NOW });

  await t.test('a cell that is not JSON at all: the Log names the row and length, never the cell text', (sb, assert) => {
    const rows = deskRows(deskData());
    rows.find((row) => row[0] === 'items')[1] = 'Call the plumber about the leak, then the dentist';
    sb.mock.seed('Desk', rows);
    assert.equal(sb.gs.getDesk({}).reason, 'invalid');
    const err = sb.mock.logRows().find((row) => row.fn === 'getDesk' && row.level === 'ERROR');
    assert.match(err.message, /\(items\) is not valid JSON \(\d+ characters/);
    assert.ok(!/Call|plumber|dentist/.test(err.message), err.message);
  }, { now: NOW });

  await t.test('rows left from an earlier build are not mixed in; a repeated key keeps its first row', (sb, assert) => {
    const data = deskData();
    data.items = [{ id: 'today1', lane: 'now', title: 'From today', tags: [], links: [] }];
    seedDesk(sb, data);
    // The routine's clear did not run: yesterday's items2 and cleared rows are still below
    sb.mock.seed('Desk', [
      ['items2', JSON.stringify([{ id: 'yesterday9', lane: 'now', title: 'From yesterday', tags: [], links: [] }]), '2026-10-12 06:45'],
      ['cleared', '["Old chip"]', '2026-10-12 06:45']
    ]);
    const r = sb.gs.getDesk({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.desk.items.map((it) => it.id), ['today1']);
    assert.deepEqual(r.desk.cleared, data.cleared, 'today\'s cleared row wins over the older one');
    assert.equal(r.builtAt, '2026-10-13 06:45');
    assert.equal(r.stale, false);
    const warn = sb.mock.logRows().find((row) => row.fn === 'getDesk' && row.level === 'WARN');
    assert.ok(warn && /items2/.test(warn.message) && /2026-10-12 06:45/.test(warn.message), 'the skipped rows are logged');
    assert.ok(!/From yesterday|Old chip/.test(warn.message), 'by key and row, without their text');
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'yesterday9', done: true }), /no longer on the Desk/);

    // Same build, a key written twice (and items + items1, the same slot): the first row is used, once
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built'],
      ['items', JSON.stringify([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]), DESK_BUILT],
      ['quick', '[["First","",""]]', DESK_BUILT],
      ['items', JSON.stringify([{ id: 'a', title: 'A again' }]), DESK_BUILT],
      ['Items1', JSON.stringify([{ id: 'z', title: 'Z' }]), DESK_BUILT],
      ['quick', '[["Second","",""]]', DESK_BUILT],
      ['items2', JSON.stringify([{ id: 'c', title: 'C' }, { id: 'a', title: 'A in items2' }]), DESK_BUILT]
    ]);
    const d = sb.gs.getDesk({}).desk;
    assert.deepEqual(d.items.map((it) => it.id + ':' + it.title), ['a:A', 'b:B', 'c:C'], 'one card per id');
    assert.deepEqual(d.quick, [['First', '', '']]);

    // Built blank on every row: every row is used, as before
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built']].concat(deskRows(deskData(), '')));
    assert.equal(sb.gs.getDesk({}).desk.items.length, deskData().items.length);
  }, { now: NOW });

  await t.test('lanes are de-duplicated by key, "__proto__" included', (sb, assert) => {
    sb.mock.seed('Desk', [['meta', JSON.stringify({ lanes: [{ key: '__proto__', title: 'A' }, { key: '__proto__', title: 'B' }, { key: 'now', title: 'Now' }] }), DESK_BUILT],
      ['items', JSON.stringify([{ id: 'x', lane: '__proto__', title: 'X' }]), DESK_BUILT]]);
    const r = sb.gs.getDesk({});
    assert.deepEqual(r.desk.lanes, [{ key: '__proto__', title: 'A' }, { key: 'now', title: 'Now' }]);
    assert.equal(Object.getPrototypeOf({}).title, undefined, 'nothing leaked onto Object.prototype');
  }, { now: NOW });

  await t.test('items match a row by task ID first, then by Source key desk:<id> in either tab', (sb, assert) => {
    seedTask(sb, 'Work', { id: 'W-aaaaaaa1', title: 'Row A' });
    seedTask(sb, 'Personal', { id: 'P-bbbbbbb2', title: 'Row B', sourceKey: 'desk:keyed' });
    seedTask(sb, 'Work', { id: 'W-ccccccc3', title: 'Row C', sourceKey: 'desk:both' });
    seedTask(sb, 'Work', { id: 'W-ddddddd4', title: 'Row D', status: 'Done', done: '2026-10-12' });
    seedTask(sb, 'Work', { id: 'W-eeeeeee5', title: 'Row E', sourceKey: 'desk:gone', status: 'Dropped' });
    seedTask(sb, 'Personal', { id: 'P-fffffff6', title: 'Row F', sourceKey: 'desk:homekey' });
    seedTask(sb, 'Work', { id: 'W-ggggggg7', title: 'Row G', sourceKey: 'desk:homekey' });
    const data = deskData();
    data.items = [
      { id: 'bytask', lane: 'now', title: 'By task', tags: [], links: [], task: 'W-aaaaaaa1' },
      { id: 'keyed', lane: 'now', title: 'Keyed in Personal', tags: [['', 'Email']], links: [] },
      { id: 'both', lane: 'now', title: 'Task wins over key', tags: [], links: [], task: 'W-ddddddd4' },
      { id: 'gone', lane: 'reply', title: 'Task row missing', tags: [], links: [], task: 'W-zzzzzzz9' },
      { id: 'wrongtab', lane: 'reply', title: 'P- id that lives nowhere', tags: [], links: [], task: 'P-aaaaaaa1' },
      { id: 'homekey', lane: 'later', title: 'Home item, keys in both tabs', tags: [['home', 'Personal']], links: [] },
      { id: 'nothing', lane: 'later', title: 'No row', tags: [['home', 'Personal']], links: [] }
    ];
    seedDesk(sb, data);
    const items = byId(sb.gs.getDesk({}).desk);
    const pick = (it) => [it.category, it.taskId, it.status, it.done];
    assert.deepEqual(pick(items.bytask), ['Work', 'W-aaaaaaa1', 'Open', false]);
    assert.deepEqual(pick(items.keyed), ['Personal', 'P-bbbbbbb2', 'Open', false], 'desk key found in the other tab; category is where the row lives');
    assert.deepEqual(pick(items.both), ['Work', 'W-ddddddd4', 'Done', true], 'the task ID wins over a desk key');
    assert.deepEqual(pick(items.gone), ['Work', 'W-eeeeeee5', 'Dropped', true], 'falls back to the desk key; Dropped reads as done');
    assert.deepEqual(pick(items.wrongtab), ['Personal', '', '', false], 'category from the P- prefix, no row');
    assert.deepEqual(pick(items.homekey), ['Personal', 'P-fffffff6', 'Open', false], 'the item\'s own tab is searched first');
    assert.deepEqual(pick(items.nothing), ['Personal', '', '', false]);
  }, { now: NOW });

  await t.test('a task ID written with a lower-case prefix still finds its row', (sb, assert) => {
    seedTask(sb, 'Personal', { id: 'P-abcdef12', title: 'Renew the parking permit' });
    const data = deskData();
    data.items = [{ id: 'lower', lane: 'later', title: 'Renew the parking permit', tags: [], links: [], task: 'p-abcdef12' }];
    seedDesk(sb, data);
    const it = sb.gs.getDesk({}).desk.items[0];
    assert.deepEqual([it.task, it.category, it.taskId, it.done], ['P-abcdef12', 'Personal', 'P-abcdef12', false]);
    const r = sb.gs.setDeskItemDone({ itemId: 'lower', done: true });
    assert.equal(r.task.id, 'P-abcdef12');
    assert.equal(tasks(sb, 'Personal').length, 1, 'no second row');
  }, { now: NOW });

  await t.test('an item whose task was moved to the other list follows it', (sb, assert) => {
    seedTask(sb, 'Work', { id: 'W-moved001', title: 'Moved task', source: 'Manual', sourceKey: 'desk:mv' });
    sb.gs.moveTask_({ category: 'Work', id: 'W-moved001', toCategory: 'Personal' });
    const copy = tasks(sb, 'Personal')[0];
    const data = deskData();
    data.items = [{ id: 'mv', lane: 'now', title: 'Moved task', tags: [], links: [], task: 'W-moved001' }];
    seedDesk(sb, data);
    const r = sb.gs.getDesk({});
    const it = r.desk.items[0];
    assert.deepEqual([it.category, it.taskId, it.status, it.done], ['Personal', copy.id, 'Open', false]);
    assert.deepEqual(r.added, [], 'the copy is the item\'s row, so it is not listed as added');
    const done = sb.gs.setDeskItemDone({ itemId: 'mv', done: true }).task;
    assert.equal(done.id, copy.id);
    assert.equal(done.status, 'Done');
    assert.equal(tasks(sb, 'Work')[0].status, 'Dropped', 'the moved-away row is left alone');
  }, { now: NOW });

  await t.test('added = Open Manual tasks in either tab that are not on the Desk, newest Created first, at most 20', (sb, assert) => {
    for (let i = 0; i < 22; i++) {
      const day = String(1 + i).padStart(2, '0');
      seedTask(sb, 'Work', { id: 'W-man' + String(i).padStart(5, '0'), title: 'Manual work ' + i, source: 'Manual', created: '2026-09-' + day });
    }
    seedTask(sb, 'Personal', { id: 'P-newest01', title: 'Newest personal', source: 'Manual', created: '2026-10-12' });
    seedTask(sb, 'Personal', { id: 'P-donemanu', title: 'Done manual', source: 'Manual', status: 'Done', done: '2026-10-12', created: '2026-10-13' });
    seedTask(sb, 'Work', { id: 'W-dropmanu', title: 'Dropped manual', source: 'Manual', status: 'Dropped', created: '2026-10-13' });
    seedTask(sb, 'Work', { id: 'W-claude01', title: 'From Claude', source: 'Claude', created: '2026-10-13' });
    seedTask(sb, 'Work', { id: 'W-ondesk01', title: 'Folded onto the Desk', source: 'Manual', created: '2026-10-13' });
    seedTask(sb, 'Work', { id: 'W-ondesk02', title: 'Ticked on the Desk', source: 'Manual', created: '2026-10-13', sourceKey: 'desk:viakey' });
    const data = deskData();
    data.items = [
      { id: 'folded', lane: 'now', title: 'Folded onto the Desk', tags: [['list', 'Added by you']], links: [], task: 'W-ondesk01' },
      { id: 'viakey', lane: 'now', title: 'Ticked on the Desk', tags: [['list', 'Added by you']], links: [] }
    ];
    seedDesk(sb, data);
    const r = sb.gs.getDesk({});
    assert.equal(r.added.length, 20);
    assert.equal(r.added[0].id, 'P-newest01');
    assert.equal(r.added[0].category, 'Personal');
    const created = r.added.map((x) => x.created);
    assert.deepEqual(created, created.slice().sort().reverse(), 'newest Created first');
    const ids = r.added.map((x) => x.id);
    ['P-donemanu', 'W-dropmanu', 'W-claude01', 'W-ondesk01', 'W-ondesk02', 'W-man00000', 'W-man00001'].forEach((id) => {
      assert.ok(!ids.includes(id), id + ' is not listed');
    });
    assert.equal(findUnsafe(r.added), '');
    // A task typed in the Desk's add box (addTask, Source Manual) shows up straight away
    sb.gs.addTask({ category: 'Work', title: 'Typed into the Desk add box' });
    assert.equal(sb.gs.getDesk({}).added[0].title, 'Typed into the Desk add box');
  }, { now: NOW });

  await t.test('stale: builtDate (Dubai) is not today; Built may be text, a date-time cell or blank', (sb, assert) => {
    seedDesk(sb, deskData(), '2026-10-12 06:45');
    let r = sb.gs.getDesk({});
    assert.equal(r.builtAt, '2026-10-12 06:45');
    assert.equal(r.builtDate, '2026-10-12');
    assert.equal(r.stale, true);
    // A Built cell Sheets turned into a date-time
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built']].concat(deskRows(deskData(), new Date('2026-10-13T02:45:00Z'))));
    r = sb.gs.getDesk({});
    assert.equal(r.builtAt, '2026-10-13 06:45');
    assert.equal(r.stale, false);
    // Blank Built: unknown build time counts as stale
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built']].concat(deskRows(deskData(), '')));
    r = sb.gs.getDesk({});
    assert.equal(r.builtAt, '');
    assert.equal(r.builtDate, '');
    assert.equal(r.stale, true);
    // Mixed values: the latest wins; single-digit hours and ISO text are normalised
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built'], ['meta', '{}', '2026-10-13 6:45'], ['cleared', '[]', '2026-10-13T03:10:00Z'], ['quick', '[]', 'soon']]);
    r = sb.gs.getDesk({});
    assert.equal(r.builtAt, '2026-10-13 07:10');
    assert.equal(r.stale, false);
  }, { now: NOW });

  await t.test('stale uses the Dubai date across the UTC midnight boundary', (sb, assert) => {
    // 20:30 UTC on the 12th is 00:30 on the 13th in Dubai
    seedDesk(sb, deskData(), '2026-10-13 00:15');
    assert.equal(sb.gs.getDesk({}).stale, false);
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built']].concat(deskRows(deskData(), '2026-10-12 23:50')));
    assert.equal(sb.gs.getDesk({}).stale, true);
  }, { now: '2026-10-12T20:30:00Z' });

  // -------------------------------------------------------------------------
  // expandDeskLink and the due tags
  // -------------------------------------------------------------------------

  await t.test('expandDeskLink: wt:, w:, p: and https expand; javascript:, data: and the rest are rejected', (sb, assert) => {
    const x = (v) => sb.gs.expandDeskLink(v);
    assert.equal(x('wt:18f2a0c3d4e5f601'), AISA + 'all/18f2a0c3d4e5f601');
    assert.equal(x('w:from:office receipts'), AISA + 'search/from%3Aoffice+receipts');
    assert.equal(x('w:subject:"trip form" & more/later'), AISA + 'search/subject%3A%22trip+form%22+%26+more%2Flater');
    assert.equal(x('w:javascript:alert(1)'), AISA + 'search/javascript%3Aalert(1)', 'a search is only ever a search');
    assert.equal(x('p:1790000000000000001'), PERSONAL + '1790000000000000001');
    assert.equal(x('https://docs.example.org/d/abc?x=1#y'), 'https://docs.example.org/d/abc?x=1#y');
    assert.equal(x('  http://example.org/page  '), 'http://example.org/page');
    assert.equal(x(' wt:abc123 '), AISA + 'all/abc123', 'trimmed first');
    ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'DATA:image/png;base64,AAAA',
      'vbscript:msgbox(1)', '//evil.example.org/x', 'ftp://files.example.org', 'mailto:someone@example.org', 'WT:abc', 'x:abc', '', '   ', null, undefined, 42, {}]
      .forEach((v) => assert.equal(x(v), '', JSON.stringify(v === undefined ? 'undefined' : v) + ' is rejected'));
  }, { now: NOW });

  await t.test('the client\'s expandDeskLink, deskHref and deskCategoryOf (App.html pure block) return exactly what the server\'s rules do', (sb, assert) => {
    const pure = loadPure();
    const inputs = [
      'wt:18f2a0c3d4e5f601', ' wt:abc ', 'wt:', 'wt: spaced id ', 'w:from:office receipts', 'w:subject:"trip form" & more/later', 'w:a+b%20c',
      'w:', 'w: ', 'w:café ✓ 😀', 'w:\ud800 lone', 'w:\u0001ctl', 'p:1790000000000000001', 'p:', 'p:<script>', 'p: 42 ',
      'https://docs.example.org/d/abc?x=1#y', '  http://example.org/page  ', 'HTTPS://EXAMPLE.ORG/X', 'https://x.example/a b"c\'d<e>f',
      'https://x.example/\u0001\u001f\u007f\u00a0\u2028tab\there', 'https://x.example/\nline', ' \t https://x.example/ \n',
      'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.example.org/x',
      'ftp://files.example.org', 'mailto:someone@example.org', 'WT:abc', 'W:abc', 'P:1', 'x:abc', 'wt', 'w', 'p', 'https:/x', 'http//x',
      '', '   ', null, undefined, 42, 0, true, false, {}, [], ['https://x.example/arr'], ['wt:a', 'b']
    ];
    // every link target in the fixture desk-data, as the routine writes them
    const data = deskData();
    data.items.forEach((it) => (it.links || []).forEach((l) => inputs.push(l[1])));
    data.priorities.forEach((p) => (p.links || []).forEach((l) => inputs.push(l[1])));
    data.strip.forEach((s) => inputs.push(s.href));
    data.coming.forEach((c) => inputs.push(c.href));
    data.quick.forEach((q) => inputs.push(q[2]));
    inputs.push(data.llt.padlet);
    // and a deterministic fuzz over the characters that matter: prefixes, case, spaces, quotes, brackets, %, +, &, control and
    // non-ASCII characters (incl. lone surrogates)
    const parts = ['wt:', 'w:', 'p:', 'WT:', 'https://', 'http://', 'HTTP://', 'javascript:', '//', ' ', '\t', '\n', '"', "'", '<', '>', '%', '%20',
      '+', '&', '#', '?', '=', '/', ':', 'a', 'Z', '0', '9', 'é', '😀', '\ud83d', '\u0000', '\u0007', '\u007f', '\u00a0', '\u2028', '\ufeff'];
    let seed = 20261013;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 3000; i++) {
      let s = '';
      const len = 1 + rand(7);
      for (let j = 0; j < len; j++) s += parts[rand(parts.length)];
      inputs.push(s);
    }
    let compared = 0;
    inputs.forEach((v) => {
      const server = sb.gs.expandDeskLink(v);
      const label = JSON.stringify(v === undefined ? 'undefined' : v);
      assert.equal(pure.expandDeskLink(v), server, 'expandDeskLink(' + label + ')');
      assert.equal(pure.deskHref(v), server, 'deskHref(' + label + ')');
      assert.equal(pure.sanitiseLink(server), server, 'the client sanitiser keeps what the server returns: ' + label);
      compared++;
    });
    assert.ok(compared > 3000);
    assert.ok(inputs.some((v) => sb.gs.expandDeskLink(v) !== '') && inputs.some((v) => typeof v === 'string' && v.indexOf('w:') === 0 && sb.gs.expandDeskLink(v) !== ''),
      'the fuzz reaches real URLs, not only rejections');
    // the stored-link sanitiser alone agrees with the server's sanitiseLink too
    inputs.forEach((v) => assert.equal(pure.sanitiseStoredLink(v), sb.gs.sanitiseLink(v), 'sanitiseStoredLink(' + JSON.stringify(v === undefined ? 'undefined' : v) + ')'));
    // and the client's category rule (used only when getDesk sends none) is the server's
    const items = deskData().items.concat([
      { task: ' w-abc12345 ' }, { task: 'p-x' }, { task: 'X-1', tags: [[' HOME ', 'Family']] }, { tags: [['home']] }, { tags: [['due', 'Today'], ['Home', 'x']] },
      { task: 'Wx', tags: [['home', 'y']] }, { tags: 'nope' }, { task: 42 }, {}
    ]);
    items.forEach((it) => assert.equal(pure.deskCategoryOf(it), sb.gs.deskItemCategory_(sb.gs.deskItem_(it)), 'deskCategoryOf(' + JSON.stringify(it) + ')'));
  }, { now: NOW });

  await t.test('due tags resolve against today (Dubai) within ±7 days', (sb, assert) => {
    const d = (text, kind, today) => sb.gs.deskTagDate_(text, kind || 'due', today || TODAY);
    // Tue 2026-10-13
    assert.equal(d('Today'), '2026-10-13');
    assert.equal(d('Today 9:00'), '2026-10-13');
    assert.equal(d('today', 'late'), '2026-10-13');
    assert.equal(d('Tue 20'), '2026-10-20', '+7 is inside the window');
    assert.equal(d('By Thu 15'), '2026-10-15');
    assert.equal(d('Before Wed 14'), '2026-10-14');
    assert.equal(d('Wed 14'), '2026-10-14');
    assert.equal(d('Since Mon 12', 'late'), '2026-10-12');
    assert.equal(d('Mon 12'), '2026-10-12', 'a past due date still resolves');
    assert.equal(d('Tue 6', 'late'), '2026-10-06', '-7 is inside the window');
    assert.equal(d('Thu 15, 2:30pm'), '2026-10-15', 'times are not days');
    assert.equal(d('Fri 16 Oct'), '2026-10-16');
    assert.equal(d('Thursday 15th'), '2026-10-15');
    assert.equal(d('14'), '2026-10-14', 'day of the month alone');
    assert.equal(d('Tomorrow'), '2026-10-14');
    assert.equal(d('Yesterday', 'late'), '2026-10-12');
    assert.equal(d('2026-10-30'), '2026-10-30', 'an ISO date is read as it is');
    // Weekday alone: due looks ahead, late looks back
    assert.equal(d('Fri'), '2026-10-16');
    assert.equal(d('Fri', 'late'), '2026-10-09');
    assert.equal(d('Wed 9am'), '2026-10-14');
    assert.equal(d('Tue'), '2026-10-13');
    // Not resolvable
    ['Overdue', 'Wed 21', 'Mon 5', 'Thu 14', 'Fri 16 Nov', 'Due in 3 days', 'Soon', '', '2026-02-30'].forEach((text) => {
      assert.equal(d(text), '', JSON.stringify(text));
    });
    // Numbers that count something else are not the day of the month: the weekday alone decides
    assert.equal(d('Thu P3'), '2026-10-15', 'a period glued to P');
    assert.equal(d('Fri period 2'), '2026-10-16');
    assert.equal(d('Grade 7 reports Thu'), '2026-10-15');
    assert.equal(d('Year 9 trip, Wed 14'), '2026-10-14', 'the day after the weekday still counts');
    assert.equal(d('Room 12'), '', 'a room number alone names no date');
    // Across a month boundary (Thu 2026-10-29)
    assert.equal(d('Mon 2', 'due', '2026-10-29'), '2026-11-02');
    assert.equal(d('Since Mon 26', 'late', '2026-10-29'), '2026-10-26');
    assert.equal(d('By Sun 1', 'due', '2026-10-29'), '2026-11-01');
  }, { now: NOW });

  // -------------------------------------------------------------------------
  // setDeskItemDone
  // -------------------------------------------------------------------------

  await t.test('setDeskItemDone on an item with a row: completes it (note appended), unticking reopens it', (sb, assert) => {
    seedTask(sb, 'Work', { id: 'W-fx000001', title: 'Finish the slides (sheet title)', note: 'Started', source: 'Gmail', sourceKey: 'gmail:abc' });
    seedDesk(sb, deskData());
    const r = sb.gs.setDeskItemDone({ itemId: 'slides', done: true, note: 'Sent to the team' });
    assert.deepEqual(Object.keys(r), ['task']);
    assert.equal(r.task.id, 'W-fx000001');
    assert.equal(r.task.status, 'Done');
    assert.equal(r.task.done, TODAY);
    assert.equal(r.task.note, 'Started · Sent to the team');
    assert.equal(r.task.title, 'Finish the slides (sheet title)', 'the row keeps its own fields');
    assert.equal(findUnsafe(r), '');
    assert.equal(tasks(sb, 'Work').length, 1, 'no row created');
    let item = byId(sb.gs.getDesk({}).desk).slides;
    assert.deepEqual([item.taskId, item.status, item.done], ['W-fx000001', 'Done', true]);
    const back = sb.gs.setDeskItemDone({ itemId: 'slides', done: false });
    assert.equal(back.task.status, 'Open');
    assert.equal(back.task.done, '');
    item = byId(sb.gs.getDesk({}).desk).slides;
    assert.deepEqual([item.status, item.done], ['Open', false]);
    // "true"/"false" strings are accepted, as everywhere else
    assert.equal(sb.gs.setDeskItemDone({ itemId: 'slides', done: 'true' }).task.status, 'Done');
    assert.equal(sb.gs.setDeskItemDone({ itemId: 'slides', done: 'false' }).task.status, 'Open');
  }, { now: NOW });

  await t.test('setDeskItemDone matches by desk:<id> in either tab before creating anything', (sb, assert) => {
    seedTask(sb, 'Personal', { id: 'P-keyed001', title: 'Club budget (moved home)', sourceKey: 'desk:budget' });
    seedDesk(sb, deskData());
    const r = sb.gs.setDeskItemDone({ itemId: 'budget', done: true });
    assert.equal(r.task.id, 'P-keyed001');
    assert.equal(r.task.category, 'Personal');
    assert.equal(r.task.status, 'Done');
    assert.equal(tasks(sb, 'Work').length, 0, 'nothing created in Work');
    assert.equal(tasks(sb, 'Personal').length, 1);
  }, { now: NOW });

  await t.test('create on tick: category, title, details, link, Source, Due, Priority and desk:<id> for each item', (sb, assert) => {
    seedDesk(sb, deskData());
    const expected = {
      // id: [category, source, due, priority, link]
      slides: ['Work', 'Gmail', '2026-10-12', 'High', AISA + 'all/18f2a0c3d4e5f601'],
      plumber: ['Personal', 'Gmail', TODAY, 'High', PERSONAL + '1790000000000000001'],
      budget: ['Work', 'Claude', '2026-10-15', 'Normal', 'https://forms.example.org/club-budget'],
      bakesale: ['Work', 'Manual', '', 'Normal', ''],
      parent: ['Work', 'Chat', '', 'Normal', 'https://chat.example.org/dm/space-1'],
      receipts: ['Work', 'Gmail', '2026-10-16', 'Normal', AISA + 'search/from%3Aoffice+receipts'],
      assembly: ['Work', 'Calendar', '2026-10-14', 'Normal', 'https://calendar.example.org/event/assembly'],
      repo: ['Work', 'Claude', '', 'Normal', 'https://git.example.org/club/robots'],
      dentist: ['Personal', 'Claude', '', 'Normal', '']
    };
    const data = deskData();
    data.items.forEach((item) => {
      const task = sb.gs.setDeskItemDone({ itemId: item.id, done: true }).task;
      const want = expected[item.id];
      assert.deepEqual([task.category, task.source, task.due, task.priority, task.link], want, item.id);
      assert.equal(task.title, item.title, item.id + ' title');
      assert.equal(task.details, item.why, item.id + ' details');
      assert.equal(task.sourceKey, 'desk:' + item.id, item.id + ' source key');
      assert.equal(task.status, 'Done', item.id + ' ticked');
      assert.equal(task.done, TODAY);
      assert.equal(task.created, TODAY);
      assert.equal(task.project, '');
      assert.equal(task.discuss, false);
      assert.match(task.id, task.category === 'Work' ? /^W-[a-z0-9]{8}$/ : /^P-[a-z0-9]{8}$/);
    });
    assert.equal(tasks(sb, 'Work').length, 7);
    assert.equal(tasks(sb, 'Personal').length, 2);
    // The rows are found again: ticking twice creates nothing, and getDesk shows them done
    const again = sb.gs.setDeskItemDone({ itemId: 'plumber', done: true });
    assert.equal(again.task.id, tasks(sb, 'Personal').find((x) => x.sourceKey === 'desk:plumber').id);
    assert.equal(tasks(sb, 'Personal').length, 2);
    const desk = sb.gs.getDesk({}).desk;
    desk.items.forEach((it) => {
      assert.equal(it.done, true, it.id);
      assert.match(it.taskId, /^[WP]-[a-z0-9]{8}$/, it.id);
    });
    assert.deepEqual(sb.gs.getDesk({}).added, [], 'the Manual "Added by you" row is the item\'s own, not listed again');
  }, { now: NOW });

  await t.test('create on tick: Priority High needs the now lane and a late tag or a due-today tag; newsletter auto-tag applies', (sb, assert) => {
    const data = deskData();
    data.items = [
      { id: 'nowlate', lane: 'now', title: 'Now and overdue', tags: [['late', 'Overdue']], links: [] },
      { id: 'nowtoday', lane: 'now', title: 'Now and due today', tags: [['due', 'Today 9:00']], links: [] },
      { id: 'nowtomorrow', lane: 'now', title: 'Now and due tomorrow', tags: [['due', 'Wed 14']], links: [] },
      { id: 'replylate', lane: 'reply', title: 'Reply and late', tags: [['late', 'Since Mon 12']], links: [] },
      { id: 'latertoday', lane: 'later', title: 'Later and due today', tags: [['due', 'Today']], links: [] },
      { id: 'nowplain', lane: 'now', title: 'Plan the AI workshop', why: 'For the PD day.', tags: [['new', 'New']], links: [] },
      { id: 'twodue', lane: 'reply', title: 'Two date tags', tags: [['due', 'Overdue-ish'], ['late', 'Since Mon 12'], ['due', 'Fri 16']], links: [['', '  ']] }
    ];
    seedDesk(sb, data);
    const got = {};
    data.items.forEach((it) => { got[it.id] = sb.gs.setDeskItemDone({ itemId: it.id, done: true }).task; });
    assert.deepEqual([got.nowlate.priority, got.nowlate.due], ['High', '']);
    assert.deepEqual([got.nowtoday.priority, got.nowtoday.due], ['High', TODAY]);
    assert.deepEqual([got.nowtomorrow.priority, got.nowtomorrow.due], ['Normal', '2026-10-14']);
    assert.deepEqual([got.replylate.priority, got.replylate.due], ['Normal', '2026-10-12']);
    assert.deepEqual([got.latertoday.priority, got.latertoday.due], ['Normal', TODAY]);
    assert.deepEqual([got.nowplain.priority, got.nowplain.due], ['Normal', '']);
    assert.equal(got.nowplain.newsletter, true, 'AI / workshop are newsletter keywords');
    assert.equal(got.nowlate.newsletter, false);
    assert.equal(got.twodue.due, '2026-10-12', 'the first tag that resolves');
    assert.equal(got.twodue.link, '');
  }, { now: NOW });

  await t.test('unticking an item with no row creates it Open; a similar Open task without a key becomes the item\'s row', (sb, assert) => {
    seedTask(sb, 'Work', { id: 'W-similar1', title: 'Send the club budget form', source: 'Manual', created: '2026-10-10' });
    seedDesk(sb, deskData());
    assert.deepEqual(sb.gs.getDesk({}).added.map((x) => x.id), ['W-similar1']);
    // createTasks' dedupe finds the similar Open task: it is completed and keyed to the item
    const r = sb.gs.setDeskItemDone({ itemId: 'budget', done: true, note: 'Sent' });
    assert.equal(r.task.id, 'W-similar1');
    assert.equal(r.task.status, 'Done');
    assert.equal(r.task.note, 'Sent');
    assert.equal(r.task.sourceKey, 'desk:budget');
    assert.equal(tasks(sb, 'Work').length, 1, 'no second row');
    const after = sb.gs.getDesk({});
    assert.deepEqual([byId(after.desk).budget.taskId, byId(after.desk).budget.done], ['W-similar1', true]);
    assert.deepEqual(after.added, []);
    // done:false on an item with no row: the row is created and left Open
    const open = sb.gs.setDeskItemDone({ itemId: 'parent', done: false });
    assert.equal(open.task.status, 'Open');
    assert.equal(open.task.done, '');
    assert.equal(open.task.sourceKey, 'desk:parent');
    assert.equal(tasks(sb, 'Work').length, 2);
  }, { now: NOW });

  await t.test('create on tick never claims a similar task that belongs to something else', (sb, assert) => {
    // A similar Open task with another Source key (capture's gmail:…): left alone, the item gets its own row
    seedTask(sb, 'Work', { id: 'W-other001', title: 'Send the club budget form', source: 'Gmail', sourceKey: 'gmail:zzz' });
    seedDesk(sb, deskData());
    const r = sb.gs.setDeskItemDone({ itemId: 'budget', done: true });
    assert.notEqual(r.task.id, 'W-other001');
    assert.equal(r.task.sourceKey, 'desk:budget');
    assert.equal(r.task.status, 'Done');
    let other = tasks(sb, 'Work').find((x) => x.id === 'W-other001');
    assert.deepEqual([other.status, other.sourceKey], ['Open', 'gmail:zzz'], 'the unrelated task is not completed');
    let item = byId(sb.gs.getDesk({}).desk).budget;
    assert.deepEqual([item.taskId, item.done], [r.task.id, true], 'the tick sticks after a reload');
    assert.equal(sb.gs.setDeskItemDone({ itemId: 'budget', done: true }).task.id, r.task.id, 'a second tick finds the same row');
    assert.equal(tasks(sb, 'Work').length, 2);
    other = tasks(sb, 'Work').find((x) => x.id === 'W-other001');
    assert.equal(other.status, 'Open');
  }, { now: NOW });

  await t.test('create on tick never claims another Desk item\'s row or desk: key; an unkeyed similar task further down still can be', (sb, assert) => {
    seedTask(sb, 'Work', { id: 'W-ccccccc1', title: 'Mark the grade 5 essays' });
    seedTask(sb, 'Work', { id: 'W-keyed002', title: 'Mark the grade 7 essays', sourceKey: 'desk:essays7' });
    const data = deskData();
    data.items = [
      { id: 'essays5', lane: 'now', title: 'Mark the grade 5 essays', tags: [], links: [], task: 'W-ccccccc1' },
      { id: 'essays6', lane: 'now', title: 'Mark the grade 6 essays', tags: [], links: [] },
      { id: 'essays8', lane: 'now', title: 'Mark the grade 8 essays', tags: [], links: [] }
    ];
    seedDesk(sb, data);
    assert.ok(sb.gs.isSimilarTitle('Mark the grade 5 essays', 'Mark the grade 6 essays'), 'the titles count as similar');
    const six = sb.gs.setDeskItemDone({ itemId: 'essays6', done: true }).task;
    assert.notEqual(six.id, 'W-ccccccc1');
    assert.equal(six.sourceKey, 'desk:essays6');
    const five = tasks(sb, 'Work').find((x) => x.id === 'W-ccccccc1');
    assert.deepEqual([five.status, five.sourceKey], ['Open', ''], 'the grade-5 task is not completed or re-keyed');
    let items = byId(sb.gs.getDesk({}).desk);
    assert.deepEqual([items.essays5.done, items.essays6.done, items.essays6.taskId], [false, true, six.id]);
    sb.gs.setDeskItemDone({ itemId: 'essays6', done: false });
    assert.equal(tasks(sb, 'Work').find((x) => x.id === 'W-ccccccc1').status, 'Open');
    // essays8: the similar tasks are another item's row (essays5, essays6) or carry a desk: key the Desk no longer
    // shows (essays7) — none of them is claimed
    const eight = sb.gs.setDeskItemDone({ itemId: 'essays8', done: true }).task;
    assert.ok(['W-ccccccc1', 'W-keyed002', six.id].indexOf(eight.id) < 0, eight.id);
    assert.equal(tasks(sb, 'Work').find((x) => x.id === 'W-keyed002').status, 'Open');
    assert.equal(tasks(sb, 'Work').length, 4);
    // A similar Open task without a key that is nobody's row is still claimed, even below one that is taken
    seedTask(sb, 'Personal', { id: 'P-gmail001', title: 'Book the dentist', sourceKey: 'gmail:d1' });
    seedTask(sb, 'Personal', { id: 'P-plain001', title: 'Book the dentist', source: 'Manual' });
    const d2 = deskData();
    d2.items = [{ id: 'dentist2', lane: 'later', title: 'Book the dentist', tags: [['home', 'Personal']], links: [] }];
    sb.mock.sheet('Desk').clearContents();
    sb.mock.seed('Desk', [['Key', 'JSON', 'Built']].concat(deskRows(d2)));
    const den = sb.gs.setDeskItemDone({ itemId: 'dentist2', done: true }).task;
    assert.equal(den.id, 'P-plain001');
    assert.equal(den.sourceKey, 'desk:dentist2');
    assert.equal(tasks(sb, 'Personal').find((x) => x.id === 'P-gmail001').status, 'Open');
    assert.equal(tasks(sb, 'Personal').length, 2);
  }, { now: NOW });

  await t.test('setDeskItemDone heals first: a routine row with a blank ID is matched, not duplicated', (sb, assert) => {
    seedTask(sb, 'Work', { id: '', title: 'Reply to Mr Okafor about the trip', status: '', priority: '', sourceKey: 'desk:parent' });
    seedDesk(sb, deskData());
    const r = sb.gs.setDeskItemDone({ itemId: 'parent', done: true });
    assert.match(r.task.id, /^W-[a-z0-9]{8}$/);
    assert.equal(r.task.status, 'Done');
    assert.equal(tasks(sb, 'Work').length, 1);
  }, { now: NOW });

  await t.test('setDeskItemDone errors: unknown item, empty Desk, missing id or done, untitled item', (sb, assert) => {
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides', done: true }), /^Error: That Desk item is no longer on the Desk$/, 'empty Desk');
    const data = deskData();
    data.items.push({ id: 'untitled', lane: 'now', title: '   ', tags: [], links: [] });
    seedDesk(sb, data);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'not-there', done: true }), /^Error: That Desk item is no longer on the Desk$/);
    assert.throws(() => sb.gs.setDeskItemDone({ done: true }), /^Error: Desk item id required$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: '  ', done: true }), /Desk item id required/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides' }), /^Error: done must be true or false$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides', done: 'maybe' }), /done must be true or false/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'untitled', done: true }), /^Error: That Desk item has no title$/);
    // Types: itemId text of a sane length, done a boolean (or its text), note text
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: ['slides'], done: true }), /^Error: Desk item id required$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 7, done: true }), /^Error: Desk item id required$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'x'.repeat(1000000), done: true }), /^Error: Desk item id is too long$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides', done: ['yes'] }), /^Error: done must be true or false$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides', done: 1 }), /^Error: done must be true or false$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides', done: true, note: { a: 1 } }), /^Error: Note must be text$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'slides', done: true, note: 5 }), /^Error: Note must be text$/);
    assert.equal(tasks(sb, 'Work').length + tasks(sb, 'Personal').length, 0, 'nothing written');
    assert.ok(!sb.mock.logRows().some((row) => row.level === 'ERROR'), 'user errors are not logged as errors');
  }, { now: NOW });

  await t.test('getDesk and setDeskItemDone enforce guard() and touch nothing for an outsider', (sb, assert) => {
    seedDesk(sb, deskData());
    sb.gs.readConfig();
    sb.mock.session.activeEmail = 'intruder@example.com';
    sb.mock.session.effectiveEmail = 'intruder@example.com';
    const writes = sb.mock.writes;
    assert.throws(() => sb.gs.getDesk({}), /^Error: Not allowed$/);
    assert.throws(() => sb.gs.setDeskItemDone({ itemId: 'plumber', done: true }), /^Error: Not allowed$/);
    assert.equal(sb.mock.writes - writes, 2, 'only the two guard WARN log rows');
    sb.mock.session.activeEmail = 'bbaki@aisa.sch.ae';
    sb.mock.session.effectiveEmail = 'bbaki@aisa.sch.ae';
    assert.equal(sb.gs.readTasks('Personal').length, 0);
    assert.equal(sb.gs.getDesk({}).ok, true);
  }, { now: NOW });
};
