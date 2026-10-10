'use strict';
const { findUnsafe } = require('./fixtures/helpers');

const NOW = '2026-10-08T06:00:00Z'; // Thursday 10:00 Dubai → today 2026-10-08

module.exports = async function (t) {
  await t.test('addTask writes a well-formed row and returns the Task object', (sb, assert) => {
    const r = sb.gs.addTask_({ category: 'work', title: '  Plan the   AI workshop ', details: 'for staff', project: 'AI Learning Hub',
      due: '2026-10-20', priority: 'high', link: 'https://docs.google.com/d/1', discuss: true });
    assert.equal(r.duplicate, false);
    const task = r.task;
    assert.match(task.id, /^W-[a-z0-9]{8}$/);
    assert.equal(task.category, 'Work');
    assert.equal(task.created, '2026-10-08');
    assert.equal(task.title, 'Plan the AI workshop');
    assert.equal(task.source, 'Manual');
    assert.equal(task.status, 'Open');
    assert.equal(task.done, '');
    assert.equal(task.priority, 'High');
    assert.equal(task.newsletter, true, 'auto-tagged by "AI" and "workshop"');
    assert.equal(task.discuss, true);
    assert.equal(task.due, '2026-10-20');
    assert.equal(task.sourceKey, '');
    assert.equal(task.row, 2);
    assert.match(task.updated, /^2026-10-08T10:00:00\+04:00$/);
    assert.equal(findUnsafe(r), '');
    const cells = sb.mock.rows('Work')[0];
    const C = sb.eval('COLUMN.TASK');
    assert.equal(Object.prototype.toString.call(cells[C.created]), '[object Date]');
    assert.equal(Object.prototype.toString.call(cells[C.due]), '[object Date]');
    assert.equal(Object.prototype.toString.call(cells[C.updated]), '[object Date]');
    assert.equal(cells[C.done], '');
    assert.equal(cells[C.newsletter], true);
    assert.equal(cells[C.discuss], true);
    assert.equal(cells[C.status], 'Open');
    // Validation errors
    assert.throws(() => sb.gs.addTask_({ category: 'Work', title: '   ' }), /Title is required/);
    assert.throws(() => sb.gs.addTask_({ category: 'Other', title: 'x' }), /Category must be Work or Personal/);
    assert.throws(() => sb.gs.addTask_({ category: 'Work', title: 'x', due: '14/10/2026' }), /Due must be yyyy-MM-dd/);
    assert.throws(() => sb.gs.addTask_({ category: 'Work', title: 'x', due: '2026-02-30' }), /Due must be yyyy-MM-dd/, 'impossible date is rejected, not rolled to March');
    assert.throws(() => sb.gs.addTask_({ category: 'Work', title: 'x', due: '2026-04-31' }), /Due must be yyyy-MM-dd/);
    assert.throws(() => sb.gs.addTask_({ category: 'Work', title: 'x', created: '2026-13-01' }), /Created must be yyyy-MM-dd/);
    assert.equal(sb.gs.addTask_({ category: 'Work', title: 'leap day', due: '2028-02-29' }).task.due, '2028-02-29');
    assert.throws(() => sb.gs.addTask_({ category: 'Work', title: 'x', priority: 'Urgent' }), /Priority must be/);
    assert.throws(() => sb.gs.addTask_({ category: 'Work', title: 'x', link: 'javascript:alert(1)' }), /Link must start/);
    const p = sb.gs.addTask_({ category: 'Personal', title: 'x'.repeat(200), source: 'Gmail', created: '2026-10-01', newsletter: false });
    assert.equal(p.task.title.length, 140);
    assert.equal(p.task.category, 'Personal');
    assert.match(p.task.id, /^P-/);
    assert.equal(p.task.source, 'Gmail');
    assert.equal(p.task.created, '2026-10-01');
    assert.equal(p.task.newsletter, false);
  }, { now: NOW });

  await t.test('newsletter auto-tag only when newsletter is undefined; multi-word keywords', (sb, assert) => {
    sb.mock.seed('Config', [['NEWSLETTER_KEYWORDS', 'AI Learning Hub, newsletter', '']]);
    const a = sb.gs.addTask_({ category: 'Work', title: 'Write the AI learning hub update' });
    assert.equal(a.task.newsletter, true);
    const b = sb.gs.addTask_({ category: 'Work', title: 'Plan the AI workshop' });
    assert.equal(b.task.newsletter, false, '"AI" alone is not a keyword here');
    const c = sb.gs.addTask_({ category: 'Work', title: 'Something else', details: 'draft the NEWSLETTER intro' });
    assert.equal(c.task.newsletter, true, 'details count');
    const d = sb.gs.addTask_({ category: 'Work', title: 'Newsletter but explicitly off', newsletter: false });
    assert.equal(d.task.newsletter, false);
    const e = sb.gs.addTask_({ category: 'Work', title: 'Nothing relevant', newsletter: 'true' });
    assert.equal(e.task.newsletter, true);
  });

  await t.test('addTask dedupes by sourceKey (any status) and by similar title (Open only)', (sb, assert) => {
    const first = sb.gs.addTask_({ category: 'Work', title: 'Send the lab timetable to Sara', sourceKey: 'gmail:abc' }).task;
    const byKey = sb.gs.addTask_({ category: 'Work', title: 'Completely different title here', sourceKey: 'gmail:abc' });
    assert.equal(byKey.duplicate, true);
    assert.equal(byKey.task.id, first.id);
    const byTitle = sb.gs.addTask_({ category: 'Work', title: 'Re: send the lab timetable to Sara!' });
    assert.equal(byTitle.duplicate, true);
    assert.equal(byTitle.task.id, first.id);
    const similar = sb.gs.addTask_({ category: 'Work', title: 'Send lab timetable to Sara' });
    assert.equal(similar.duplicate, true, 'Dice 2*5/11 ≥ 0.8');
    const other = sb.gs.addTask_({ category: 'Work', title: 'Send the lab keys to Omar' });
    assert.equal(other.duplicate, false);
    // Done tasks are not title-dedupe candidates, but their sourceKey still is
    sb.gs.completeTask_({ category: 'Work', id: first.id });
    const afterDone = sb.gs.addTask_({ category: 'Work', title: 'Send the lab timetable to Sara' });
    assert.equal(afterDone.duplicate, false, 'Done task no longer blocks by title');
    const keyAfterDone = sb.gs.addTask_({ category: 'Work', title: 'Brand new', sourceKey: 'gmail:abc' });
    assert.equal(keyAfterDone.duplicate, true, 'sourceKey blocks regardless of status');
    assert.equal(keyAfterDone.task.id, first.id);
    // Other tab is independent
    const personal = sb.gs.addTask_({ category: 'Personal', title: 'Send the lab keys to Omar' });
    assert.equal(personal.duplicate, false);
    assert.equal(sb.mock.rows('Work').length, 3);
  });

  await t.test('updateTask applies only whitelisted fields and handles status transitions', (sb, assert) => {
    const task = sb.gs.addTask_({ category: 'Work', title: 'Original', sourceKey: 'cal:1' }).task;
    const r = sb.gs.updateTask_({ category: 'Work', id: task.id, patch: {
      title: 'Renamed', details: 'd', project: 'Admin', due: '2026-10-30', priority: 'Low', link: 'https://x.y/z',
      newsletter: true, discuss: true, note: 'n',
      id: 'W-hacked', created: '2000-01-01', sourceKey: 'hacked', category: 'Personal', updated: 'x', row: 99
    } });
    const u = r.task;
    assert.equal(u.id, task.id);
    assert.equal(u.created, task.created);
    assert.equal(u.sourceKey, 'cal:1');
    assert.equal(u.category, 'Work');
    assert.equal(u.row, task.row);
    assert.equal(u.title, 'Renamed');
    assert.equal(u.details, 'd');
    assert.equal(u.project, 'Admin');
    assert.equal(u.due, '2026-10-30');
    assert.equal(u.priority, 'Low');
    assert.equal(u.link, 'https://x.y/z');
    assert.equal(u.newsletter, true);
    assert.equal(u.discuss, true);
    assert.equal(u.note, 'n');
    assert.equal(u.status, 'Open');
    const done = sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { status: 'Done' } }).task;
    assert.equal(done.status, 'Done');
    assert.equal(done.done, '2026-10-08', 'Done = today (fixed clock)');
    const stillDone = sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { status: 'Done', note: 'again' } }).task;
    assert.equal(stillDone.done, done.done, 'Done date kept when already set');
    const reopened = sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { status: 'Open' } }).task;
    assert.equal(reopened.done, '');
    const cleared = sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { due: '', link: '' } }).task;
    assert.equal(cleared.due, '');
    assert.equal(cleared.link, '');
    assert.throws(() => sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { title: '' } }), /Title is required/);
    assert.throws(() => sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { due: '2026-02-30' } }), /Due must be yyyy-MM-dd/);
    assert.throws(() => sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { link: 'javascript:x' } }), /Link must start/);
    assert.throws(() => sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { status: 'Finished' } }), /Status must be/);
    assert.throws(() => sb.gs.updateTask_({ category: 'Work', id: 'W-nope', patch: {} }), /Task not found/);
    assert.throws(() => sb.gs.updateTask_({ category: 'Work', patch: {} }), /Task id required/);
    assert.equal(sb.mock.rows('Work').length, 1, 'updates write in place');
  }, { now: NOW });

  await t.test('completeTask on a task that is already Done keeps its Done date and never duplicates the note', (sb, assert) => {
    const task = sb.gs.addTask_({ category: 'Work', title: 'Closed last week', status: 'Done', done: '2026-10-01', note: 'first' }).task;
    const replay = sb.gs.completeTask_({ category: 'Work', id: task.id, note: 'first' }).task;
    assert.equal(replay.done, '2026-10-01', 'Done date kept (same rule as updateTask status:Done)');
    assert.equal(replay.note, 'first', 'a note equal to the existing one is not appended again');
    const more = sb.gs.completeTask_({ category: 'Work', id: task.id, note: 'second' }).task;
    assert.equal(more.done, '2026-10-01');
    assert.equal(more.note, 'first · second');
    const retried = sb.gs.completeTask_({ category: 'Work', id: task.id, note: ' second ' }).task;
    assert.equal(retried.note, 'first · second', 'a retried call with the trailing segment is a no-op');
    assert.equal(sb.gs.completeTask_({ category: 'Work', id: task.id }).task.note, 'first · second');
    // Reopened, then completed again: a fresh Done date
    sb.gs.reopenTask_({ category: 'Work', id: task.id });
    const again = sb.gs.completeTask_({ category: 'Work', id: task.id, note: 'third' }).task;
    assert.equal(again.done, '2026-10-08');
    assert.equal(again.note, 'first · second · third');
    // The Done date is also kept when a stale client completes a task ticked from the sheet (Status Done, Done set)
    const C = sb.eval('COLUMN.TASK');
    sb.mock.seed('Work', [['W-sheet01', '2026-09-20', 'Ticked in the sheet', '', 'Manual', '', 'Done', '2026-09-30', '', '', false, false, '', 'Normal', '', '2026-09-30 10:00']]);
    assert.equal(sb.gs.completeTask_({ category: 'Work', id: 'W-sheet01' }).task.done, '2026-09-30');
    assert.equal(sb.gs.formatDate(sb.mock.rows('Work')[1][C.done]), '2026-09-30');
  }, { now: NOW });

  await t.test('reopenTask refuses the Dropped original of a move while its copy exists in the other tab', (sb, assert) => {
    const task = sb.gs.addTask_({ category: 'Work', title: 'Buy a gift', sourceKey: 'gmail:g1' }).task;
    const moved = sb.gs.moveTask_({ category: 'Work', id: task.id, toCategory: 'Personal' }).task;
    assert.throws(() => sb.gs.reopenTask_({ category: 'Work', id: task.id }), new RegExp('This task was moved to ' + moved.id + ' \\(Personal\\); reopen it there'));
    const live = sb.gs.readTasks('Work').concat(sb.gs.readTasks('Personal')).filter((x) => x.status === 'Open');
    assert.deepEqual(live.map((x) => x.id), [moved.id], 'still exactly one live row');
    assert.equal(sb.gs.findTask('Work', task.id).status, 'Dropped');
    // The copy itself can be reopened after being dropped; an ordinary Dropped task too
    sb.gs.dropTask_({ category: 'Personal', id: moved.id, note: 'later' });
    assert.equal(sb.gs.reopenTask_({ category: 'Personal', id: moved.id }).task.status, 'Open');
    const plain = sb.gs.addTask_({ category: 'Work', title: 'Plain drop' }).task;
    sb.gs.dropTask_({ category: 'Work', id: plain.id, note: 'Moved to the shed' });
    assert.equal(sb.gs.reopenTask_({ category: 'Work', id: plain.id }).task.status, 'Open', 'a note that merely starts with "Moved to" is not a move');
    // Once the copy is gone (row deleted by hand), the original may be reopened again
    sb.gs.deleteRowNumber('Personal', sb.gs.findTask('Personal', moved.id).row);
    assert.equal(sb.gs.reopenTask_({ category: 'Work', id: task.id }).task.status, 'Open');
  }, { now: NOW });

  await t.test('a Source key is unique across Work and Personal: createTasks dedupes against the other tab too', (sb, assert) => {
    const work = sb.gs.addTask_({ category: 'Work', title: 'Reply to the vendor', sourceKey: 'gmail:x1' }).task;
    const personal = sb.gs.addTask_({ category: 'Personal', title: 'Completely different wording', sourceKey: 'gmail:x1' });
    assert.equal(personal.duplicate, true, 'the key already lives in Work');
    assert.equal(personal.task.id, work.id);
    assert.equal(personal.task.category, 'Work');
    assert.equal(sb.mock.rows('Personal').length, 0);
    // Title similarity stays per tab
    assert.equal(sb.gs.addTask_({ category: 'Personal', title: 'Reply to the vendor' }).duplicate, false);
    // Import keys too: the same line on the same date into both lists is one task
    const first = sb.gs.importText_({ category: 'Work', text: '[W] Send the forms back', created: '2026-10-08' });
    const second = sb.gs.importText_({ category: 'Personal', text: '[P] Send the forms back', created: '2026-10-08' });
    assert.equal(first.added.length, 1);
    assert.deepEqual(second.skipped.map((s) => s.reason), ['duplicate']);
    assert.equal(sb.gs.readTasks('Work').concat(sb.gs.readTasks('Personal')).filter((x) => x.sourceKey === first.added[0].sourceKey).length, 1);
  }, { now: NOW });

  await t.test('text that looks like a number, boolean or date is stored as typed: the plain-text format on the text columns', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    sb.mock.coerceStrings = true; // the mock now parses typed-looking strings the way Sheets does (unless the cell format is '@')
    const raw = sb.gs.addTask_({ category: 'Work', title: '007', note: 'TRUE', project: '10/12', details: '+971501234567' }).task;
    const parsed = sb.gs.findTask('Work', raw.id);
    assert.deepEqual([parsed.title, parsed.note, parsed.details], ['7', 'true', '971501234567'], 'without the format the cells are parsed on write (as in Sheets)');
    assert.match(parsed.project, /^2026-10-12T00:00:00\+04:00$/, '"10/12" became a Date');
    sb.gs.ensureSchema(); // '@' on the text columns of the existing tabs (setup / selfTest run this)
    const typed = sb.gs.addTask_({ category: 'Personal', title: '007', note: 'TRUE', project: '10/12', details: '+971501234567' }).task;
    const back = sb.gs.findTask('Personal', typed.id);
    assert.deepEqual([back.title, back.note, back.project, back.details], ['007', 'TRUE', '10/12', '+971501234567']);
    assert.deepEqual([typeof sb.mock.rows('Personal')[0][C.title], typeof sb.mock.rows('Personal')[0][C.project]], ['string', 'string']);
    assert.equal(sb.gs.completeTask_({ category: 'Personal', id: typed.id, note: '3.50' }).task.note, 'TRUE · 3.50');
    // Inbox subject/snippet, Agenda item/detail and Log message are text columns too
    sb.gs.appendRows('Inbox', [['I-txt', new Date(), 'Chat', '1-2', '10/12', '3.50', '', 'chat:txt', 'New', '', 'Work']]);
    const item = sb.gs.listInbox_({}).items[0];
    assert.deepEqual([item.from, item.subject, item.snippet], ['1-2', '10/12', '3.50']);
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: '007', detail: '1-2' }] } });
    assert.deepEqual(sb.gs.getAgenda_({ meetingDate: '2026-10-13' }).sections.Notes.map((r) => [r.item, r.detail]), [['007', '1-2']]);
    sb.gs.log('unit', 'INFO', '007');
    assert.equal(sb.gs.getLog({}).rows.find((r) => r.fn === 'unit').message, '007');
    sb.mock.coerceStrings = false;
  }, { now: NOW });

  await t.test('completeTask / reopenTask / dropTask', (sb, assert) => {
    const task = sb.gs.addTask_({ category: 'Personal', title: 'Renew the car registration', note: 'at the RTA' }).task;
    const done = sb.gs.completeTask_({ category: 'Personal', id: task.id, note: 'done online' }).task;
    assert.equal(done.status, 'Done');
    assert.equal(done.done, '2026-10-08');
    assert.equal(done.note, 'at the RTA · done online');
    const C = sb.eval('COLUMN.TASK');
    assert.equal(Object.prototype.toString.call(sb.mock.rows('Personal')[0][C.done]), '[object Date]');
    const reopened = sb.gs.reopenTask_({ category: 'Personal', id: task.id }).task;
    assert.equal(reopened.status, 'Open');
    assert.equal(reopened.done, '');
    assert.equal(sb.mock.rows('Personal')[0][C.done], '');
    const dropped = sb.gs.dropTask_({ category: 'Personal', id: task.id, note: 'not needed' }).task;
    assert.equal(dropped.status, 'Dropped');
    assert.equal(dropped.done, '');
    assert.equal(dropped.note, 'at the RTA · done online · not needed');
    const noNote = sb.gs.completeTask_({ category: 'Personal', id: task.id }).task;
    assert.equal(noNote.note, dropped.note, 'blank note leaves the note alone');
  }, { now: NOW });

  await t.test('moveTask copies to the other tab with a new ID and drops the original', (sb, assert) => {
    const task = sb.gs.addTask_({ category: 'Work', title: 'Buy a gift for the secretary', project: 'Admin', due: '2026-10-20',
      priority: 'High', link: 'https://shop', sourceKey: 'gmail:m1', created: '2026-10-01', newsletter: false, discuss: true, note: 'call the shop first' }).task;
    const waits = sb.mock.locks.waits;
    const moved = sb.gs.moveTask_({ category: 'Work', id: task.id, toCategory: 'Personal' }).task;
    assert.equal(sb.mock.locks.waits, waits + 1, 'the copy and the Dropped write share one lock acquisition');
    assert.equal(sb.mock.locks.held, 0);
    assert.match(moved.id, /^P-[a-z0-9]{8}$/);
    assert.equal(moved.note, 'call the shop first', 'the copy keeps the note');
    assert.equal(moved.category, 'Personal');
    assert.equal(moved.title, task.title);
    assert.equal(moved.project, 'Admin');
    assert.equal(moved.due, '2026-10-20');
    assert.equal(moved.priority, 'High');
    assert.equal(moved.link, 'https://shop');
    assert.equal(moved.sourceKey, 'gmail:m1');
    assert.equal(moved.created, '2026-10-01');
    assert.equal(moved.discuss, true);
    assert.equal(moved.status, 'Open');
    const old = sb.gs.findTask('Work', task.id);
    assert.equal(old.status, 'Dropped');
    assert.equal(old.note, 'Moved to ' + moved.id, 'SPEC 5: the old row\'s Note is exactly "Moved to <newId>"');
    assert.equal(old.sourceKey, '', 'the Dropped original gives up its Source key: the key lives only on the live copy');
    assert.equal(sb.mock.rows('Personal').length, 1);
    assert.throws(() => sb.gs.moveTask_({ category: 'Work', id: task.id, toCategory: 'Work' }), /already in Work/);
    // Moving back is a copy, never a merge with the Dropped original (SPEC 5): a new W- row, Open, and the
    // Personal copy Dropped with "Moved to <newId>"; exactly one live copy exists.
    const back = sb.gs.moveTask_({ category: 'Personal', id: moved.id, toCategory: 'Work' }).task;
    assert.match(back.id, /^W-[a-z0-9]{8}$/);
    assert.notEqual(back.id, task.id);
    assert.equal(back.status, 'Open');
    assert.equal(back.sourceKey, 'gmail:m1');
    assert.equal(back.note, 'call the shop first');
    assert.equal(sb.gs.findTask('Personal', moved.id).status, 'Dropped');
    assert.equal(sb.gs.findTask('Personal', moved.id).note, 'Moved to ' + back.id);
    assert.equal(sb.gs.findTask('Work', task.id).status, 'Dropped', 'the first original stays Dropped');
    const open = sb.gs.readTasks('Work').concat(sb.gs.readTasks('Personal')).filter((x) => x.status === 'Open');
    assert.deepEqual(open.map((x) => x.id), [back.id], 'exactly one Open task after moving there and back');
    assert.equal(sb.mock.rows('Work').length, 2);
    // Re-adding the key into Work now lands on the live copy, not on a "Moved to" row
    const readd = sb.gs.addTask_({ category: 'Work', title: 'Something new with that key', sourceKey: 'gmail:m1' });
    assert.equal(readd.duplicate, true);
    assert.equal(readd.task.id, back.id);
    // A move never merges into a similar Open title in the target tab either
    sb.gs.addTask_({ category: 'Personal', title: 'Book the hall for the science fair' });
    const w = sb.gs.addTask_({ category: 'Work', title: 'Book the hall for the science fair' }).task;
    const movedW = sb.gs.moveTask_({ category: 'Work', id: w.id, toCategory: 'Personal' }).task;
    assert.match(movedW.id, /^P-/);
    assert.equal(sb.gs.readTasks('Personal').filter((x) => x.status === 'Open' && /science fair/.test(x.title)).length, 2, 'copied, not merged');
    assert.equal(sb.gs.findTask('Work', w.id).note, 'Moved to ' + movedW.id);
  });

  await t.test('createTasks dedupes under the script lock: a key written by an overlapping call is seen', (sb, assert) => {
    let fired = false;
    // Another execution (a double-tapped Promote, say) appends the same Source key while this one waits for the lock.
    sb.mock.locks.onWait = () => {
      if (fired) return;
      fired = true;
      sb.mock.seed('Work', [sb.gs.taskToRow({ id: 'W-other001', title: 'Written by the other execution', created: '2026-10-08', sourceKey: 'gmail:race' })]);
    };
    const r = sb.gs.addTask_({ category: 'Work', title: 'Completely different title', sourceKey: 'gmail:race' });
    assert.equal(fired, true, 'the read and the dedupe waited for the lock');
    assert.equal(r.duplicate, true);
    assert.equal(r.task.id, 'W-other001');
    assert.equal(sb.mock.rows('Work').length, 1, 'no second row with the same Source key');
    assert.equal(sb.mock.locks.held, 0);
    // Same for a similar Open title appended meanwhile
    fired = false;
    sb.mock.locks.onWait = () => {
      if (fired) return;
      fired = true;
      sb.mock.seed('Work', [sb.gs.taskToRow({ id: 'W-other002', title: 'Email the parents about the trip', created: '2026-10-08' })]);
    };
    const byTitle = sb.gs.addTask_({ category: 'Work', title: 'email the parents about the trip!' });
    assert.equal(byTitle.duplicate, true);
    assert.equal(byTitle.task.id, 'W-other002');
    assert.equal(sb.mock.rows('Work').length, 2);
  }, { now: NOW });

  await t.test('details, note and Source key are capped server-side (one oversized cell would abort the whole batch)', (sb, assert) => {
    const long = 'x'.repeat(6000);
    const t1 = sb.gs.addTask_({ category: 'Work', title: 'Capped', details: long, note: long, sourceKey: 'gmail:' + long }).task;
    assert.equal(t1.details.length, 5000);
    assert.equal(t1.note.length, 1000);
    assert.equal(t1.sourceKey.length, 200);
    const u = sb.gs.updateTask_({ category: 'Work', id: t1.id, patch: { details: long + 'y', note: long } }).task;
    assert.equal(u.details.length, 5000);
    assert.equal(u.note.length, 1000);
    const done = sb.gs.completeTask_({ category: 'Work', id: t1.id, note: 'z'.repeat(50) }).task;
    assert.equal(done.note.length, 1000, 'appendNote_ caps too');
    assert.equal(sb.gs.dropTask_({ category: 'Work', id: t1.id, note: long }).task.note.length, 1000);
  });

  await t.test('a title or note typed as "=…" is stored as text, never as a formula, and round-trips', (sb, assert) => {
    const formula = '=HYPERLINK("https://evil.example","click me")';
    const task = sb.gs.addTask_({ category: 'Personal', title: formula, details: '=1+1', note: '=SUM(A1)' }).task;
    assert.deepEqual(sb.mock.formulas('Personal'), [], 'no cell became a formula');
    const C = sb.eval('COLUMN.TASK');
    const cells = sb.mock.rows('Personal')[0];
    assert.equal(cells[C.title], ' ' + formula);
    assert.equal(cells[C.details], ' =1+1');
    assert.equal(cells[C.note], ' =SUM(A1)');
    const read = sb.gs.findTask('Personal', task.id);
    assert.equal(read.title, formula);
    assert.equal(read.details, '=1+1');
    assert.equal(read.note, '=SUM(A1)');
    sb.gs.updateTask_({ category: 'Personal', id: task.id, patch: { project: '=CMD()', note: '=2+2' } });
    assert.deepEqual(sb.mock.formulas('Personal'), []);
    assert.equal(sb.gs.findTask('Personal', task.id).project, '=CMD()');
    assert.equal(sb.gs.healSheet('Personal').fixed, 0, 'the guard space is stable across heals');
  });

  await t.test('saveTask_ writes only the changed cells, so a =HYPERLINK Link entered in the sheet survives a tick/edit', (sb, assert) => {
    const C = sb.eval('COLUMN.TASK');
    const task = sb.gs.addTask_({ category: 'Work', title: 'Has a hyperlink formula', project: 'PD' }).task;
    sb.mock.setFormula('Work', task.row, C.link + 1, '=HYPERLINK("https://docs.google.com/d/1","Unit plan")', 'Unit plan');
    assert.equal(sb.gs.findTask('Work', task.id).link, 'Unit plan', 'getValues() shows the label, as in Apps Script');
    const writes = sb.mock.writes;
    sb.gs.completeTask_({ category: 'Work', id: task.id, note: 'sent' });
    assert.equal(sb.mock.sheet('Work').getRange(task.row, C.link + 1).getFormula(), '=HYPERLINK("https://docs.google.com/d/1","Unit plan")', 'formula kept');
    assert.ok(sb.mock.writes - writes <= 2, 'status/done/note run + updated run: ' + (sb.mock.writes - writes) + ' write(s)');
    sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { project: 'Admin', discuss: true } });
    sb.gs.reopenTask_({ category: 'Work', id: task.id });
    assert.equal(sb.mock.sheet('Work').getRange(task.row, C.link + 1).getFormula(), '=HYPERLINK("https://docs.google.com/d/1","Unit plan")');
    const after = sb.gs.findTask('Work', task.id);
    assert.equal(after.project, 'Admin');
    assert.equal(after.discuss, true);
    assert.equal(after.status, 'Open');
    // An explicit Link edit does replace it
    sb.gs.updateTask_({ category: 'Work', id: task.id, patch: { link: 'https://new.example/' } });
    assert.equal(sb.mock.sheet('Work').getRange(task.row, C.link + 1).getFormula(), '');
    assert.equal(sb.gs.findTask('Work', task.id).link, 'https://new.example/');
  });

  await t.test('listTasks filters by category/status/from/to/search and sorts overdue → due today → High → created desc', (sb, assert) => {
    const add = (cat, title, extra) => sb.gs.addTask_(Object.assign({ category: cat, title: title }, extra || {})).task;
    const overdue = add('Work', 'Overdue one', { due: '2026-10-01', created: '2026-09-01' });
    const dueToday = add('Work', 'Due today one', { due: '2026-10-08', created: '2026-09-02' });
    const high = add('Work', 'High one', { priority: 'High', created: '2026-09-03', details: 'needs the projector cable' });
    const older = add('Work', 'Older plain', { created: '2026-09-04' });
    const newer = add('Work', 'Newer plain', { created: '2026-10-05', project: 'Teaching' });
    const personal = add('Personal', 'Personal plain', { created: '2026-10-06' });
    const doneTask = add('Work', 'Finished item', { created: '2026-09-10' });
    sb.gs.completeTask_({ category: 'Work', id: doneTask.id, note: 'ok' });
    const dropped = add('Work', 'Dropped item', { created: '2026-09-11', due: '2026-01-01', priority: 'High' });
    sb.gs.dropTask_({ category: 'Work', id: dropped.id });

    const all = sb.gs.listTasks_({}).tasks;
    assert.equal(all.length, 8);
    const order = all.map((x) => x.id);
    assert.deepEqual(order.slice(0, 3), [overdue.id, dueToday.id, high.id]);
    // Remaining Open + Done + Dropped by Created desc
    assert.deepEqual(order.slice(3), [personal.id, newer.id, dropped.id, doneTask.id, older.id]);

    const open = sb.gs.listTasks_({ category: 'Work', status: 'Open' }).tasks;
    assert.deepEqual(open.map((x) => x.id), [overdue.id, dueToday.id, high.id, newer.id, older.id]);
    const doneOnly = sb.gs.listTasks_({ status: 'done' }).tasks;
    assert.deepEqual(doneOnly.map((x) => x.id), [doneTask.id]);
    // from/to: Done uses the Done date (today), Open uses Created
    const range = sb.gs.listTasks_({ from: '2026-10-01', to: '2026-10-08' }).tasks;
    assert.deepEqual(range.map((x) => x.id).sort(), [personal.id, newer.id, doneTask.id].sort());
    const doneOut = sb.gs.listTasks_({ status: 'Done', from: '2026-09-01', to: '2026-09-30' }).tasks;
    assert.equal(doneOut.length, 0, 'Done date (today) outside the range');
    const search = sb.gs.listTasks_({ search: 'PLAIN' }).tasks;
    assert.deepEqual(search.map((x) => x.id), [personal.id, newer.id, older.id]);
    assert.deepEqual(sb.gs.listTasks_({ search: 'teaching' }).tasks.map((x) => x.id), [newer.id], 'search matches project');
    assert.deepEqual(sb.gs.listTasks_({ search: 'ok' }).tasks.map((x) => x.id), [doneTask.id], 'search matches note');
    assert.deepEqual(sb.gs.listTasks_({ search: 'PROJECTOR' }).tasks.map((x) => x.id), [high.id], 'search matches details, case-insensitive');
    assert.throws(() => sb.gs.listTasks_({ status: 'Bogus' }), /Status must be/);
    assert.throws(() => sb.gs.listTasks_({ from: 'yesterday' }), /From must be/);
    assert.equal(findUnsafe(all), '');
    const counts = sb.gs.taskCounts(sb.gs.readTasks('Work'), '2026-10-08');
    assert.deepEqual(counts, { open: 5, dueToday: 1, overdue: 1 });
  }, { now: NOW });

  await t.test('rowToTask tolerates rows written by other tools (strings, blanks, TRUE/FALSE)', (sb, assert) => {
    sb.mock.seed('Work', [
      ['W-claude01', '2026-10-07', 'From the routine', 'ctx', 'Claude', 'https://l', '', '', '', 'PD', 'TRUE', 'FALSE', '2026-10-09', '', 'gmail:zz', '2026-10-07 06:45'],
      ['W-weird', new Date('2026-10-06T20:00:00Z'), 'Weird status', '', '', '', 'Maybe', '', '', '', '', '', '', 'Urgent', '', '']
    ]);
    const tasks = sb.gs.readTasks('Work');
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].created, '2026-10-07');
    assert.equal(tasks[0].status, 'Open');
    assert.equal(tasks[0].priority, 'Normal');
    assert.equal(tasks[0].newsletter, true);
    assert.equal(tasks[0].discuss, false);
    assert.equal(tasks[0].due, '2026-10-09');
    assert.equal(tasks[0].updated, '2026-10-07T06:45:00+04:00');
    assert.equal(tasks[0].row, 2);
    assert.equal(tasks[1].created, '2026-10-07');
    assert.equal(tasks[1].status, 'Open', 'unknown status reads as Open');
    assert.equal(tasks[1].priority, 'Normal', 'unknown priority reads as Normal');
    assert.equal(findUnsafe(tasks), '');
  });
};
