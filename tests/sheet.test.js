'use strict';
const { HEADERS, TAB_ORDER } = require('./gas-mock');

module.exports = async function (t) {
  await t.test('healSheet fills blank ID/Created/Status/Priority/Updated, trims, converts types and logs', (sb, assert) => {
    sb.mock.seed('Work', [
      ['', '', '  Title with spaces  ', 'details', 'Claude', 'https://x', '', '', '', ' AI Learning Hub ', 'TRUE', 'FALSE', '2026-10-14', '', 'cal:abc', ''],
      ['W-existing', '2026-10-01', 'Already fine', '', 'Manual', '', 'Open', '', '', '', false, false, '', 'Normal', '', '2026-10-01 08:00']
    ]);
    // Row 4 is left blank on purpose; row 5 is written explicitly.
    sb.mock.sheet('Work').getRange(5, 1, 1, 16).setValues([
      ['', '2026-10-02', 'Second blank id', '', '', '', 'Done', '2026-10-03', '', '', '', '', '', 'High', '', '']
    ]);
    const writesBefore = sb.mock.writes;
    sb.mock.cellWrites.length = 0;
    const result = sb.gs.healSheet('Work');
    assert.equal(result.fixed, 3, 'three content rows changed');
    // Only the cells that changed are written, one setValues() per run of consecutive changed columns:
    // row 2: ID..Title, Status, Project..Priority, Updated (4); row 3: Created, Updated (2); row 5: ID..Created, Done,
    // Newsletter..Discuss, Updated (4); plus the Log row. A whole-row rewrite would strip rich text from untouched cells.
    assert.equal(sb.mock.writes - writesBefore, 11, 'per-cell runs: 4 + 2 + 4 writes, plus the Log row');
    const C = sb.eval('COLUMN.TASK');
    const touched = sb.mock.cellWrites.filter((w) => w.sheet === 'Work').map((w) => w.row + ':' + (w.col - 1));
    [C.details, C.source, C.link, C.note, C.sourceKey].forEach((c) => assert.ok(touched.indexOf('2:' + c) < 0, 'unchanged row-2 cell ' + c + ' is not written'));
    [C.id, C.title, C.status, C.project, C.done, C.note].forEach((c) => assert.ok(touched.indexOf('3:' + c) < 0, 'unchanged row-3 cell ' + c + ' is not written'));
    assert.ok(touched.indexOf('3:' + C.created) >= 0 && touched.indexOf('2:' + C.title) >= 0, 'changed cells are written');
    const rows = sb.mock.rows('Work');
    assert.equal(rows.length, 4, 'blank row 4 is preserved, not filled');
    assert.ok(rows[2].every((v) => v === ''), 'blank row stays blank');
    // Row 1
    assert.match(rows[0][C.id], /^W-[a-z0-9]{8}$/);
    assert.equal(Object.prototype.toString.call(rows[0][C.created]), '[object Date]');
    assert.equal(sb.gs.formatDate(rows[0][C.created]), '2026-10-08', 'Created = today (fixed clock)');
    assert.equal(rows[0][C.title], 'Title with spaces');
    assert.equal(rows[0][C.status], 'Open');
    assert.equal(rows[0][C.priority], 'Normal');
    assert.equal(rows[0][C.project], 'AI Learning Hub');
    assert.equal(rows[0][C.newsletter], true);
    assert.equal(rows[0][C.discuss], false);
    assert.equal(Object.prototype.toString.call(rows[0][C.due]), '[object Date]');
    assert.equal(sb.gs.formatDate(rows[0][C.due]), '2026-10-14');
    assert.equal(Object.prototype.toString.call(rows[0][C.updated]), '[object Date]');
    // Row 2: string dates become Dates, nothing else changes
    assert.equal(rows[1][C.id], 'W-existing');
    assert.equal(sb.gs.formatDate(rows[1][C.created]), '2026-10-01');
    assert.equal(sb.gs.formatDateTime(rows[1][C.updated]), '2026-10-01T08:00:00+04:00');
    // Row 4
    assert.match(rows[3][C.id], /^W-[a-z0-9]{8}$/);
    assert.notEqual(rows[3][C.id], rows[0][C.id]);
    assert.equal(rows[3][C.status], 'Done');
    assert.equal(sb.gs.formatDate(rows[3][C.done]), '2026-10-03');
    assert.equal(rows[3][C.priority], 'High');
    const logs = sb.mock.logRows().filter((r) => r.fn === 'healSheet');
    assert.equal(logs.length, 1);
    assert.match(logs[0].message, /Work: fixed 3 row/);
    assert.match(logs[0].message, /id 2/);
    // Idempotent
    assert.equal(sb.gs.healSheet('Work').fixed, 0);
    assert.equal(sb.gs.healSheet('Personal').fixed, 0);
    assert.throws(() => sb.gs.healSheet('Inbox'), /Category must be Work or Personal/);
  }, { now: '2026-10-08T06:00:00Z' });

  await t.test('healSheet leaves a rich-text hyperlink alone in a cell it did not change (only changed cells are written)', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    // A routine row without an ID; Brandon added a sheet hyperlink (Insert → Link) in Link and a trailing space in Title.
    sb.mock.seed('Work', [['', '2026-10-01', 'Routine row with a sheet link ', '', 'Claude', '', 'Open', '', '', '', '', '', '', 'Normal', '', '2026-10-01 08:00']]);
    sb.mock.setRichText('Work', 2, C.link + 1, 'Unit plan', 'https://docs.google.com/document/d/1/edit');
    assert.equal(sb.mock.rows('Work')[0][C.link], 'Unit plan', 'getValues() shows the label, as in Sheets');
    const r = sb.gs.healSheet('Work');
    assert.equal(r.details.id, 1);
    assert.equal(r.details.whitespace, 1);
    assert.equal(r.details.checkbox, 2);
    assert.equal(sb.mock.richText('Work', 2, C.link + 1), 'https://docs.google.com/document/d/1/edit', 'the hyperlink survives the heal');
    assert.equal(sb.mock.rows('Work')[0][C.link], 'Unit plan');
    assert.equal(sb.mock.rows('Work')[0][C.title], 'Routine row with a sheet link');
    assert.match(sb.mock.rows('Work')[0][C.id], /^W-[a-z0-9]{8}$/);
    assert.equal(sb.gs.healSheet('Work').fixed, 0);
    // The same for a task-save path: ticking the task writes Status/Done/Updated only
    const task = sb.gs.readTasks('Work')[0];
    sb.gs.completeTask_({ category: 'Work', id: task.id });
    assert.equal(sb.mock.richText('Work', 2, C.link + 1), 'https://docs.google.com/document/d/1/edit');
    // An explicit Link edit does replace it (a plain write drops rich text, as in Sheets)
    sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { link: 'https://new.example/' } });
    assert.equal(sb.mock.richText('Work', 2, C.link + 1), '');
  });

  await t.test('healSheet does not guess a year: a Due such as "Oct 14" is cleared with a WARN, never written as 2001', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    sb.mock.seed('Work', [
      ['W-ny1', '2026-10-01', 'Routine row', '', 'Claude', '', 'Open', '', '', '', false, false, 'Oct 14', 'Normal', '', '2026-10-01 08:00'],
      ['W-ny2', '2026-10-01', 'Routine row 2', '', 'Claude', '', 'Open', '', '', '', false, false, '14 Oct 2026', 'Normal', '', '2026-10-01 08:00']
    ]);
    const r = sb.gs.healSheet('Work');
    assert.equal(r.details.badDate, 1);
    const rows = sb.mock.rows('Work');
    assert.equal(rows[0][C.due], '', 'no-year text is cleared');
    assert.equal(sb.gs.formatDate(rows[1][C.due]), '2026-10-14', 'a date with an explicit year still converts');
    const warn = sb.mock.logRows().find((row) => row.fn === 'healSheet' && row.level === 'WARN');
    assert.match(warn.message, /Work row 2 \(W-ny1\): Due "Oct 14" is not a date, cleared/);
    const q = sb.gs.buildQuestions(sb.gs.readTasks('Work'), sb.gs.agendaWindow('2026-10-13'), '2026-10-08');
    assert.ok(!q.some((x) => /2001/.test(x.text)), 'no "overdue (due 2001-…)" question');
  }, { now: '2026-10-08T06:00:00Z' });

  await t.test('healSheet fills a blank Done date when Status is Done, from Updated else today', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    sb.mock.seed('Work', [
      ['W-x1', '2026-10-01', 'Hand-set Done with Updated', '', 'Manual', '', 'Done', '', '', 'Hub', false, false, '', 'Normal', '', '2026-10-07 14:30'],
      ['W-x2', '2026-10-01', 'Hand-set Done, nothing else', '', 'Manual', '', 'Done', '', '', '', false, false, '', 'Normal', '', ''],
      ['W-x3', '2026-10-01', 'Open stays without Done', '', 'Manual', '', 'Open', '', '', '', false, false, '', 'Normal', '', '2026-10-05 14:30']
    ]);
    const r = sb.gs.healSheet('Work');
    assert.equal(r.details.done, 2);
    const rows = sb.mock.rows('Work');
    assert.equal(sb.gs.formatDate(rows[0][C.done]), '2026-10-07', "the Updated cell's date");
    assert.equal(sb.gs.formatDate(rows[1][C.done]), '2026-10-08', 'today when Updated is blank too');
    assert.equal(rows[2][C.done], '');
    assert.equal(sb.gs.healSheet('Work').fixed, 0);
    // Downstream: the agenda Done section and the newsletter now see the task
    const win = sb.gs.agendaWindow('2026-10-13');
    const draft = sb.gs.buildAgendaDraft(sb.gs.readTasks('Work'), win, '2026-10-08');
    assert.deepEqual(draft.Done.map((x) => x.item), ['Hand-set Done with Updated', 'Hand-set Done, nothing else']);
  }, { now: '2026-10-08T06:00:00Z' });

  await t.test('healSheet clears unparseable text in date columns (Created → today) and names the row in a WARN', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    sb.mock.seed('Work', [
      ['W-bad1', 'TBD', 'Bad created', '', 'Claude', '', 'Open', '', '', '', false, false, 'next week', 'Normal', '', 'now'],
      ['W-bad2', '2026-10-01', 'Bad done', '', 'Claude', '', 'Done', 'yesterday', '', '', false, false, '', 'Normal', '', '2026-10-02 09:00']
    ]);
    const r = sb.gs.healSheet('Work');
    assert.equal(r.details.badDate, 4);
    const rows = sb.mock.rows('Work');
    assert.equal(sb.gs.formatDate(rows[0][C.created]), '2026-10-08', 'unparseable Created becomes today');
    assert.equal(rows[0][C.due], '', 'unparseable Due is cleared');
    assert.equal(Object.prototype.toString.call(rows[0][C.updated]), '[object Date]', '"now" in Updated is replaced by the real time');
    assert.equal(sb.gs.formatDateTime(rows[0][C.updated]), '2026-10-08T10:00:00+04:00');
    assert.equal(sb.gs.formatDate(rows[1][C.done]), '2026-10-02', 'unparseable Done is cleared, then filled from Updated because Status is Done');
    const warn = sb.mock.logRows().find((row) => row.fn === 'healSheet' && row.level === 'WARN');
    assert.ok(warn, 'WARN logged');
    assert.match(warn.message, /Work row 2 \(W-bad1\): Created "TBD" is not a date, set to today/);
    assert.match(warn.message, /Work row 2 \(W-bad1\): Due "next week" is not a date, cleared/);
    assert.match(warn.message, /Work row 2 \(W-bad1\): Updated "now" is not a date, set to now/);
    assert.match(warn.message, /Work row 3 \(W-bad2\): Done "yesterday" is not a date, cleared/);
    assert.equal(sb.gs.healSheet('Work').fixed, 0, 'idempotent');
    assert.equal(sb.gs.readTasks('Work')[0].created, '2026-10-08');
  }, { now: '2026-10-08T06:00:00Z' });

  await t.test('healSheet writes a formula cell back as its formula, never as its display value', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    // A routine row without an ID whose Link holds =HYPERLINK (getValues() shows the label).
    sb.mock.seed('Work', [['', '2026-10-01', 'Routine row with a hyperlink', '', 'Claude', '', 'Open', '', '', '', false, false, '', 'Normal', '', '2026-10-01 08:00']]);
    sb.mock.setFormula('Work', 2, C.link + 1, '=HYPERLINK("https://docs.google.com/d/1","Doc")', 'Doc');
    const r = sb.gs.healSheet('Work');
    assert.equal(r.details.id, 1);
    assert.equal(sb.mock.sheet('Work').getRange(2, C.link + 1).getFormula(), '=HYPERLINK("https://docs.google.com/d/1","Doc")', 'formula preserved');
    assert.equal(sb.mock.rows('Work')[0][C.link], 'Doc');
    assert.match(sb.mock.rows('Work')[0][C.id], /^W-[a-z0-9]{8}$/);
    assert.equal(sb.gs.healSheet('Work').fixed, 0);
  });

  await t.test('every write path guards a leading "=" (appendRows, writeRow, writeCells, log, saveAgenda)', (sb, assert) => {
    sb.gs.appendRows('Inbox', [['I-1', new Date(), 'Gmail', '=A', '=B', '=C', '', 'gmail:1', 'New', '', 'Work']]);
    sb.gs.writeRow('Inbox', 3, ['I-2', new Date(), 'Gmail', '=A2', '', '', '', 'gmail:2', 'New', '', 'Work']);
    sb.gs.writeCells('Inbox', 2, { 9: '=W-1' });
    sb.gs.writeRowChanges('Inbox', 3, ['I-2', sb.mock.rows('Inbox')[1][1], 'Gmail', '=A2', '=changed', '', '', 'gmail:2', 'New', '', 'Work']);
    sb.gs.log('unit', 'INFO', '=IMPORTXML("x","y")');
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: '=HYPERLINK("x")', detail: '=1' }] } });
    ['Inbox', 'Log', 'Agenda'].forEach((tab) => assert.deepEqual(sb.mock.formulas(tab), [], tab + ' holds no formula'));
    const inbox = sb.mock.rows('Inbox');
    assert.equal(inbox[0][3], ' =A');
    assert.equal(inbox[0][9], ' =W-1');
    assert.equal(inbox[1][3], ' =A2');
    assert.equal(inbox[1][4], ' =changed');
    assert.equal(sb.mock.logRows().find((row) => row.fn === 'unit').message, ' =IMPORTXML("x","y")');
    assert.equal(sb.gs.getLog({}).rows.find((row) => row.fn === 'unit').message, '=IMPORTXML("x","y")', 'read back without the guard space');
    const CA = sb.eval('COLUMN.AGENDA');
    assert.equal(sb.mock.rows('Agenda')[0][CA.item], ' =HYPERLINK("x")');
    assert.equal(sb.gs.getAgenda_({ meetingDate: '2026-10-13' }).sections.Notes[0].item, '=HYPERLINK("x")');
    assert.equal(sb.gs.listInbox_({}).items.find((i) => i.id === 'I-1').from, '=A');
  });

  await t.test('readRows maps columns, skips blank rows and keeps row numbers', (sb, assert) => {
    sb.mock.seed('Inbox', [
      ['I-1', new Date('2026-10-09T02:00:00Z'), 'Gmail', 'A <a@x>', 'Subj', 'snip', 'https://l', 'gmail:1', 'New', '', 'Work']
    ]);
    // Row 3 stays blank; row 4 is written explicitly.
    sb.mock.sheet('Inbox').getRange(4, 1, 1, 11).setValues([
      ['I-2', new Date('2026-10-09T03:00:00Z'), 'Chat', 'B', 'Space', 'snip2', '', 'chat:2', 'Ignored', '', 'Work']
    ]);
    const rows = sb.gs.readRows('Inbox');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].row, 2);
    assert.equal(rows[0].id, 'I-1');
    assert.equal(rows[0].sourceKey, 'gmail:1');
    assert.equal(rows[0].categoryHint, 'Work');
    assert.equal(rows[1].row, 4);
    assert.equal(rows[1].status, 'Ignored');
    assert.deepEqual(sb.gs.readRows('Agenda'), []);
    assert.throws(() => sb.gs.readRows('Nope'), /Unknown tab/);
  });

  await t.test('healSheet re-reads under the lock: an ID written by a concurrent execution is kept', (sb, assert) => {
    sb.mock.seed('Work', [['', '', 'Routine row', '', 'Claude', '', '', '', '', '', '', '', '', '', '', '']]);
    let fired = false;
    // Another execution fills the ID while this one waits for the lock (getBootstrap and listTasks race on every boot).
    sb.mock.locks.onWait = () => { if (!fired) { fired = true; sb.mock.setCell('Work', 2, 1, 'W-other001'); } };
    const r = sb.gs.healSheet('Work');
    assert.equal(fired, true, 'the heal took the lock before writing');
    assert.equal(sb.mock.rows('Work')[0][0], 'W-other001', "the other execution's ID survives");
    assert.equal(r.fixed, 1, 'the row still needed Created/Status/Priority/Updated');
    assert.equal(r.details.id, undefined, 'no second ID was invented');
    assert.equal(sb.gs.healSheet('Work').fixed, 0);
  });

  await t.test('writes take the script lock (wait ≤ 10 s); withLock is re-entrant and releases after a throw', (sb, assert) => {
    const locks = sb.mock.locks;
    const before = locks.waits;
    sb.gs.appendRows('Log', [[new Date(), 'x', 'INFO', 'y']]);
    assert.equal(locks.waits, before + 1);
    assert.equal(locks.releases, before + 1);
    assert.equal(locks.held, 0);
    assert.equal(locks.lastWaitMs, 10000, 'SPEC 6: wait at most 10 s');
    const expectLocks = (label, n, fn) => {
      const w = locks.waits;
      fn();
      assert.equal(locks.waits, w + n, label + ' takes the lock ' + n + ' time(s)');
      assert.equal(locks.held, 0, label + ' releases the lock');
    };
    expectLocks('writeRow', 1, () => sb.gs.writeRow('Log', 2, [new Date(), 'x', 'WARN', 'z']));
    expectLocks('writeRowChanges', 1, () => sb.gs.writeRowChanges('Log', 2, [sb.mock.rows('Log')[0][0], 'x', 'WARN', 'z2']));
    expectLocks('writeCells', 1, () => sb.gs.writeCells('Log', 2, { 2: 'ERROR' }));
    expectLocks('deleteRowNumber', 1, () => sb.gs.deleteRowNumber('Log', 2));
    sb.mock.seed('Work', [['', '', 'Blank id row', '', 'Claude', '', '', '', '', '', '', '', '', '', '', '']]);
    expectLocks('healSheet with a fix to write (its Log row is written inside the same lock)', 1, () => { assert.equal(sb.gs.healSheet('Work').fixed, 1); });
    expectLocks('healSheet with nothing to fix', 0, () => { assert.equal(sb.gs.healSheet('Work').fixed, 0); });
    // saveAgenda_ writes the Agenda rows under one lock and then its Log row under another.
    expectLocks('saveAgenda_', 2, () => sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: 'n' }] } }));
    // A throw inside withLock releases the lock and resets the re-entrancy depth.
    assert.throws(() => sb.gs.withLock(() => { throw new Error('inner'); }), /inner/);
    assert.equal(locks.held, 0, 'lock released after the throw');
    const w = locks.waits;
    sb.gs.appendRows('Log', [[new Date(), 'x', 'INFO', 'after']]);
    assert.equal(locks.waits, w + 1, 'lock is taken again after the failure');
    let inner = 0;
    sb.gs.withLock(() => {
      sb.gs.withLock(() => { inner++; });
      sb.gs.log('nested', 'INFO', 'logging inside a lock does not deadlock');
    });
    assert.equal(inner, 1);
    assert.equal(sb.mock.locks.maxHeld, 1);
    assert.equal(sb.mock.locks.held, 0);
    sb.mock.locks.failWait = true;
    assert.throws(() => sb.gs.appendRows('Work', [['W-1']]), /Lock timeout/);
    sb.mock.locks.failWait = false;
    // Reads do not lock
    const waits = sb.mock.locks.waits;
    sb.gs.readRows('Work');
    sb.gs.readTasks('Work');
    assert.equal(sb.mock.locks.waits, waits);
  });

  await t.test('appendRows grows the grid, writeRow/writeCells update in place', (sb, assert) => {
    const sheet = sb.mock.sheet('Log');
    sheet.maxRows = 3;
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push([new Date(), 'grow', 'INFO', 'r' + i]);
    const start = sb.gs.appendRows('Log', rows);
    assert.equal(start, 2);
    assert.equal(sheet.getLastRow(), 6);
    assert.ok(sheet.getMaxRows() >= 6);
    sb.gs.writeRow('Log', 3, [new Date(), 'grow', 'WARN', 'replaced']);
    assert.equal(sb.mock.rows('Log')[1][3], 'replaced');
    sb.gs.writeCells('Log', 3, { 2: 'ERROR' });
    assert.equal(sb.mock.rows('Log')[1][2], 'ERROR');
    assert.equal(sb.mock.rows('Log')[1][3], 'replaced');
    assert.equal(sb.gs.appendRows('Log', []), 0);
    // writeRowChanges: only differing cells, one setValues per run, nothing when equal
    const current = sb.mock.rows('Log')[1];
    const writes = sb.mock.writes;
    assert.equal(sb.gs.writeRowChanges('Log', 3, current.slice()), 0, 'identical row → no write');
    assert.equal(sb.mock.writes, writes);
    assert.equal(sb.gs.writeRowChanges('Log', 3, [current[0], 'grow2', 'ERROR', 'again']), 2, 'cells 1 and 3 differ');
    assert.equal(sb.mock.writes, writes + 2, 'two runs → two setValues calls');
    assert.deepEqual(sb.mock.rows('Log')[1].slice(1), ['grow2', 'ERROR', 'again']);
    assert.equal(sb.gs.writeRowChanges('Log', 3, [current[0], 'a', 'b', 'c']), 3);
    assert.equal(sb.mock.writes, writes + 3, 'one contiguous run → one call');
  });

  await t.test('appendRows ignores pre-filled checkbox rows when choosing where to append', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    const sheet = sb.mock.sheet('Work');
    sb.gs.addTask_({ category: 'Work', title: 'First' });
    sb.gs.addTask_({ category: 'Work', title: 'Second' });
    // "Insert > Checkbox" over the Newsletter/Discuss columns writes FALSE into every empty cell below the data.
    sheet.getRange(2, C.newsletter + 1, 200, 2).insertCheckboxes();
    assert.equal(sheet.getLastRow(), 201, 'getLastRow() now points at the last checkbox');
    const start = sb.gs.appendRows('Work', [sb.gs.taskToRow({ id: 'W-third001', title: 'Third', created: '2026-10-08' })]);
    assert.equal(start, 4, 'appended right after the last real task, not after the checkboxes');
    assert.deepEqual(sb.gs.readTasks('Work').map((x) => x.title), ['First', 'Second', 'Third']);
    const fourth = sb.gs.addTask_({ category: 'Work', title: 'Fourth' }).task;
    assert.equal(fourth.row, 5);
    assert.equal(sb.gs.healSheet('Work').fixed, 0, 'checkbox-only rows are not healed into tasks');
  });

  await t.test('ensureSchema builds every tab on a fresh spreadsheet (renaming Sheet1) with validations and formats', (sb, assert) => {
    const ss = sb.globals.SpreadsheetApp.create('Fresh');
    const result = sb.gs.ensureSchema(ss);
    assert.deepEqual(result.created, TAB_ORDER);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(ss.getSheets().map((s) => s.getName()), TAB_ORDER, 'Sheet1 was renamed, not left behind');
    TAB_ORDER.forEach((tab) => {
      const sheet = ss.getSheetByName(tab);
      assert.deepEqual(sheet.getRange(1, 1, 1, HEADERS[tab].length).getValues()[0], HEADERS[tab], tab + ' headers');
      assert.equal(sheet.getFrozenRows(), 1, tab + ' frozen header');
      assert.equal(sheet.getLastRow(), 1, tab + ' has only the header row');
      assert.equal(sheet.getRange(1, 1).getDataValidation(), null);
    });
    const work = ss.getSheetByName('Work');
    const C = sb.eval('COLUMN.TASK');
    const status = work.getRange(2, C.status + 1).getDataValidation();
    assert.equal(status.getCriteriaType(), 'VALUE_IN_LIST');
    assert.deepEqual(status.getCriteriaValues()[0], ['Open', 'Done', 'Dropped']);
    assert.equal(status.getAllowInvalid(), false, 'Status is strict');
    const source = work.getRange(500, C.source + 1).getDataValidation();
    assert.deepEqual(source.getCriteriaValues()[0], ['Gmail', 'Chat', 'Calendar', 'Manual', 'Import', 'Claude']);
    assert.equal(source.getAllowInvalid(), true, 'Source is non-strict');
    assert.equal(work.getRange(2, C.priority + 1).getDataValidation().getAllowInvalid(), false);
    assert.equal(work.getRange(2, C.newsletter + 1).getDataValidation().getCriteriaType(), 'CHECKBOX');
    assert.equal(work.getRange(2, C.discuss + 1).getDataValidation().getCriteriaType(), 'CHECKBOX');
    assert.equal(work.getRange(2, C.created + 1).getNumberFormat(), 'yyyy-mm-dd');
    assert.equal(work.getRange(2, C.due + 1).getNumberFormat(), 'yyyy-mm-dd');
    assert.equal(work.getRange(2, C.done + 1).getNumberFormat(), 'yyyy-mm-dd');
    assert.equal(work.getRange(2, C.updated + 1).getNumberFormat(), 'yyyy-mm-dd hh:mm:ss');
    // Plain-text format on the free-text columns, so "007", "10/12" or "+9715…" are stored as typed (never parsed)
    [C.title, C.details, C.source, C.link, C.note, C.project, C.sourceKey].forEach((c) => assert.equal(work.getRange(500, c + 1).getNumberFormat(), '@', 'Work text column ' + c));
    [C.id, C.status, C.priority, C.newsletter, C.discuss].forEach((c) => assert.notEqual(work.getRange(2, c + 1).getNumberFormat(), '@', 'enum/checkbox column ' + c));
    assert.equal(work.getRange(1, C.title + 1).getNumberFormat(), null, 'header row untouched');
    assert.equal(work.getRange(1, 1).getValue(), 'ID');
    assert.equal(work.metaGet_('backgrounds', 1, 1), '#21076C');
    assert.equal(work.metaGet_('fontWeights', 1, 1), 'bold');
    assert.equal(work.getConditionalFormatRules().length, 3);
    const inbox = ss.getSheetByName('Inbox');
    const CI = sb.eval('COLUMN.INBOX');
    assert.deepEqual(inbox.getRange(2, CI.status + 1).getDataValidation().getCriteriaValues()[0], ['New', 'Promoted', 'Ignored']);
    assert.equal(inbox.getRange(2, CI.captured + 1).getNumberFormat(), 'yyyy-mm-dd hh:mm:ss');
    const agenda = ss.getSheetByName('Agenda');
    const CA = sb.eval('COLUMN.AGENDA');
    assert.deepEqual(agenda.getRange(2, CA.section + 1).getDataValidation().getCriteriaValues()[0], ['Done', 'In progress', 'Questions', 'Documents', 'Notes']);
    assert.equal(agenda.getRange(2, CA.weekOf + 1).getNumberFormat(), 'yyyy-mm-dd');
    [CI.from, CI.subject, CI.snippet, CI.link, CI.sourceKey, CI.taskId].forEach((c) => assert.equal(inbox.getRange(2, c + 1).getNumberFormat(), '@', 'Inbox text column ' + c));
    [CA.item, CA.detail, CA.link, CA.taskId].forEach((c) => assert.equal(agenda.getRange(2, c + 1).getNumberFormat(), '@', 'Agenda text column ' + c));
    assert.notEqual(agenda.getRange(2, CA.order + 1).getNumberFormat(), '@', 'Order stays numeric');
    assert.equal(ss.getSheetByName('Config').getRange(2, 2).getNumberFormat(), '@', 'Config Value');
    assert.equal(ss.getSheetByName('Log').getRange(2, 4).getNumberFormat(), '@', 'Log Message');
    assert.equal(ss.getSheetByName('Log').getRange(2, 1).getNumberFormat(), 'yyyy-mm-dd hh:mm:ss');
    // Idempotent on a complete sheet
    const again = sb.gs.ensureSchema(ss);
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.warnings, []);
  });

  await t.test('ensureSchema keeps existing tabs, adds missing ones and warns on a header mismatch', (sb, assert) => {
    const ss = sb.mock.defaultSpreadsheet;
    ss.deleteSheet(ss.getSheetByName('Log'));
    ss.getSheetByName('Agenda').getRange(1, 2).setValue('Sektion');
    sb.mock.seed('Work', [['W-keep', new Date(), 'Keep me']]);
    const C = sb.eval('COLUMN.TASK');
    assert.equal(ss.getSheetByName('Work').getRange(2, C.title + 1).getNumberFormat(), null, 'the live sheet pre-dates setup(): no text format yet');
    const result = sb.gs.ensureSchema(ss);
    assert.deepEqual(result.created, ['Log']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^Agenda: header row differs/);
    assert.equal(sb.mock.rows('Work').length, 1, 'existing data untouched');
    assert.ok(ss.getSheetByName('Log'));
    // Existing tabs get the plain-text format on their text columns too (idempotent), without any data write
    [C.title, C.details, C.link, C.note, C.project, C.sourceKey].forEach((c) => assert.equal(ss.getSheetByName('Work').getRange(2, c + 1).getNumberFormat(), '@', 'existing Work column ' + c));
    assert.equal(ss.getSheetByName('Inbox').getRange(2, 5).getNumberFormat(), '@', 'existing Inbox Subject');
    assert.equal(sb.mock.rows('Work')[0][2], 'Keep me');
    assert.deepEqual(sb.gs.ensureSchema(ss).created, []);
  });

  await t.test('getTab creates a missing tab on demand; openSpreadsheet honours SHEET_ID', (sb, assert) => {
    const ss = sb.mock.defaultSpreadsheet;
    ss.deleteSheet(ss.getSheetByName('Inbox'));
    const tab = sb.gs.getTab('Inbox');
    assert.equal(tab.getName(), 'Inbox');
    assert.deepEqual(tab.getRange(1, 1, 1, 11).getValues()[0], HEADERS.Inbox);
    assert.throws(() => sb.gs.getTab('Nope'), /Unknown tab/);
    const other = sb.mock.buildSpreadsheet('other-id', 'Other', true);
    sb.mock.properties.SHEET_ID = 'other-id';
    sb.gs.resetMemos();
    assert.equal(sb.gs.getSheetId(), 'other-id');
    assert.equal(sb.gs.openSpreadsheet(), other);
    sb.mock.properties.SHEET_ID = '   ';
    sb.gs.resetMemos();
    assert.equal(sb.gs.getSheetId(), '1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w', 'blank property falls back');
  });

  await t.test('readConfig: typed values, defaults for missing keys, memo cleared on write', (sb, assert) => {
    let c = sb.gs.readConfig();
    assert.deepEqual(c.ALLOWED_EMAILS, ['bbaki@aisa.sch.ae', 'brandon.abaki@gmail.com']);
    assert.equal(c.CHAT_ENABLED, true);
    assert.equal(c.GMAIL_LOOKBACK_DAYS, 2);
    assert.equal(c.MEETING_DAY, 'Tuesday');
    assert.equal(c.DIRECTOR_NAME, '');
    assert.ok(Array.isArray(c.PROJECTS) && c.PROJECTS.length > 0);
    sb.mock.seed('Config', [
      ['ALLOWED_EMAILS', ' a@x.com ,B@y.com,, ', ''],
      ['chat_enabled', 'FALSE', 'lower-case key'],
      ['GMAIL_LOOKBACK_DAYS', '5', ''],
      ['CHAT_LOOKBACK_DAYS', 'abc', 'bad number → default'],
      ['NEWSLETTER_KEYWORDS', 'AI, hub ', ''],
      ['DEFAULT_QUICKADD_CATEGORY', 'Bogus', '→ Work'],
      ['DIRECTOR_NAME', 'Dr. Lee', ''],
      ['TIMEZONE', '', 'blank → default'],
      ['UNKNOWN_KEY', 'ignored', '']
    ]);
    c = sb.gs.readConfig();
    assert.deepEqual(c.ALLOWED_EMAILS, ['bbaki@aisa.sch.ae', 'brandon.abaki@gmail.com'], 'memoised within an execution');
    sb.gs.clearConfigMemo();
    c = sb.gs.readConfig();
    assert.deepEqual(c.ALLOWED_EMAILS, ['a@x.com', 'B@y.com']);
    assert.equal(c.CHAT_ENABLED, false);
    assert.equal(c.GMAIL_LOOKBACK_DAYS, 5);
    assert.equal(c.CHAT_LOOKBACK_DAYS, 2);
    assert.deepEqual(c.NEWSLETTER_KEYWORDS, ['AI', 'hub']);
    assert.equal(c.DEFAULT_QUICKADD_CATEGORY, 'Work');
    assert.equal(c.DIRECTOR_NAME, 'Dr. Lee');
    assert.equal(c.TIMEZONE, 'Asia/Dubai');
    assert.equal(c.UNKNOWN_KEY, undefined);
    // Boolean cell values and numbers as numbers
    sb.mock.sheet('Config').clearContents();
    sb.mock.sheet('Config').appendRow(['Key', 'Value', 'Notes']);
    sb.mock.seed('Config', [['CHAT_ENABLED', true, ''], ['GMAIL_LOOKBACK_DAYS', 3, '']]);
    sb.gs.clearConfigMemo();
    c = sb.gs.readConfig();
    assert.equal(c.CHAT_ENABLED, true);
    assert.equal(c.GMAIL_LOOKBACK_DAYS, 3);
    // writeConfigDefaults only fills an empty tab
    assert.equal(sb.gs.writeConfigDefaults(), false);
    sb.mock.sheet('Config').clearContents();
    sb.mock.sheet('Config').appendRow(['Key', 'Value', 'Notes']);
    assert.equal(sb.gs.writeConfigDefaults(), true);
    const keys = sb.mock.rows('Config').map((r) => r[0]);
    assert.deepEqual(keys, ['ALLOWED_EMAILS', 'TIMEZONE', 'MEETING_DAY', 'GMAIL_QUERY', 'GMAIL_LOOKBACK_DAYS', 'CHAT_ENABLED',
      'CHAT_LOOKBACK_DAYS', 'NEWSLETTER_KEYWORDS', 'DEFAULT_QUICKADD_CATEGORY', 'PROJECTS', 'DIRECTOR_NAME']);
    assert.deepEqual(sb.gs.readConfig(), sb.gs.configDefaults());
    // TIMEZONE must be an IANA id: Java maps "Dubai"/"GST" to GMT silently, so they fall back with a WARN.
    const setTz = (tz) => {
      sb.mock.sheet('Config').clearContents();
      sb.mock.sheet('Config').appendRow(['Key', 'Value', 'Notes']);
      sb.mock.seed('Config', [['TIMEZONE', tz, '']]);
      sb.gs.clearConfigMemo();
      return sb.gs.readConfig().TIMEZONE;
    };
    assert.equal(setTz('Dubai'), 'Asia/Dubai');
    assert.ok(sb.mock.logRows().some((r) => r.level === 'WARN' && /TIMEZONE "Dubai"/.test(r.message)), 'bad zone logged');
    assert.equal(setTz('GST'), 'Asia/Dubai');
    assert.equal(setTz('Asia/Nowhere'), 'Asia/Dubai', 'unknown id rejected by the runtime');
    // The mock, like Java, maps an unknown id to GMT instead of throwing: the code's own detection is what rejects it.
    assert.equal(setTz('Asia/Dubay'), 'Asia/Dubai', 'a typo in an otherwise well-formed id must not silently become GMT');
    assert.ok(require('./gas-mock').unknownZones.has('Asia/Dubay'), 'the mock formatted the typo in GMT rather than throwing');
    assert.equal(sb.globals.Utilities.formatDate(new Date('2026-10-08T06:00:00Z'), 'Asia/Dubay', 'HH:mm Z'), '06:00 +0000', 'Java semantics: unknown zone → GMT');
    assert.ok(sb.mock.logRows().some((r) => r.level === 'WARN' && /TIMEZONE "Asia\/Dubay"/.test(r.message)), 'typo logged');
    assert.equal(setTz('Africa/Abidjan'), 'Africa/Abidjan', 'a real GMT zone is kept');
    assert.equal(setTz('Europe/London'), 'Europe/London', '+0000 in winter only is not GMT');
    assert.equal(setTz('America/New_York'), 'America/New_York');
    assert.equal(setTz('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
    assert.equal(setTz('Etc/GMT+4'), 'Etc/GMT+4');
    assert.equal(setTz('UTC'), 'UTC');
    assert.equal(sb.gs.getTimeZone(), 'UTC');
  });
};
