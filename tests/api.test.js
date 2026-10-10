'use strict';
const { findUnsafe } = require('./fixtures/helpers');

const NOW = '2026-10-08T06:00:00Z';

module.exports = async function (t) {
  await t.test('guard(): allowed email passes, other email throws, blank active falls back to effective, blank both throws', (sb, assert) => {
    assert.equal(sb.gs.guard(), 'bbaki@aisa.sch.ae');
    sb.mock.session.activeEmail = '  BBaki@AISA.sch.ae ';
    assert.equal(sb.gs.guard(), 'BBaki@AISA.sch.ae', 'case-insensitive, trimmed');
    sb.mock.session.activeEmail = 'intruder@example.com';
    assert.throws(() => sb.gs.guard(), /^Error: Not allowed$/);
    assert.ok(sb.mock.loggerLines().some((l) => /guard: Not allowed because this run is signed in as intruder@example\.com, which is not in Config ALLOWED_EMAILS \(bbaki@aisa\.sch\.ae, brandon\.abaki@gmail\.com\)/.test(l)),
      'the editor log names the account guard() saw and the allowed list');
    sb.mock.session.activeEmail = '';
    sb.mock.session.effectiveEmail = 'brandon.abaki@gmail.com';
    assert.equal(sb.gs.guard(), 'brandon.abaki@gmail.com', 'falls back to the effective user');
    sb.mock.session.effectiveEmail = 'intruder@example.com';
    assert.throws(() => sb.gs.guard(), /Not allowed/);
    sb.mock.session.effectiveEmail = '';
    assert.throws(() => sb.gs.guard(), /Not allowed/, 'blank on both');
    assert.ok(sb.mock.loggerLines().some((l) => /guard: Not allowed because Google returned no email address/.test(l)),
      'the editor log explains a blank email');
    sb.mock.session.activeEmail = null;
    sb.mock.session.effectiveEmail = null;
    assert.throws(() => sb.gs.guard(), /Not allowed/);
    // Config-driven list
    sb.mock.session.activeEmail = 'other@school.org';
    sb.mock.seed('Config', [['ALLOWED_EMAILS', 'Other@School.org', '']]);
    sb.gs.clearConfigMemo();
    assert.equal(sb.gs.guard(), 'other@school.org');
  });

  await t.test('every API entry point enforces guard and returns JSON-safe output', (sb, assert) => {
    sb.gs.addTask({ category: 'Work', title: 'Seed task', due: '2026-10-09', link: 'https://x' });
    sb.mock.seed('Inbox', [['I-1', new Date(), 'Gmail', 'A', 'S', 'snip', 'https://l', 'gmail:1', 'New', '', 'Work']]);
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    sb.gs.log('x', 'INFO', 'y');
    const calls = {
      getBootstrap: {},
      listTasks: {},
      addTask: { category: 'Personal', title: 'Another one' },
      updateTask: null,
      completeTask: null,
      reopenTask: null,
      dropTask: null,
      moveTask: null,
      importText: { category: 'Work', text: '- Imported line' },
      importHtml: { html: '<ul><li>HTML line</li></ul>' },
      listInbox: {},
      promoteInbox: { inboxId: 'I-1', category: 'Work' },
      ignoreInbox: { inboxId: 'I-1' },
      getAgenda: {},
      saveAgenda: { meetingDate: '2026-10-13', sections: { Notes: [{ item: 'n' }] } },
      regenerateAgenda: {},
      getNewsletter: {},
      runCaptureNow: {},
      getLog: { limit: 5 }
    };
    const id = sb.gs.listTasks({ category: 'Work' }).tasks[0].id;
    calls.updateTask = { category: 'Work', id: id, patch: { note: 'n' } };
    calls.completeTask = { category: 'Work', id: id };
    calls.reopenTask = { category: 'Work', id: id };
    calls.dropTask = { category: 'Work', id: id };
    calls.moveTask = { category: 'Work', id: id, toCategory: 'Personal' };
    Object.keys(calls).forEach((name) => {
      const out = sb.gs[name](calls[name]);
      assert.equal(typeof out, 'object', name + ' returns an object');
      assert.equal(findUnsafe(out), '', name + ': ' + findUnsafe(out));
      JSON.stringify(out);
    });
    // Rejected for an intruder, without touching the sheet
    sb.mock.session.activeEmail = 'intruder@example.com';
    const writes = sb.mock.writes;
    Object.keys(calls).forEach((name) => {
      assert.throws(() => sb.gs[name](calls[name]), /^Error: Not allowed$/, name);
    });
    assert.equal(sb.mock.writes - writes, Object.keys(calls).length, 'only the guard WARN log rows were written');
    assert.ok(sb.mock.logRows().filter((r) => /guard rejected/.test(r.message)).length >= Object.keys(calls).length);
  }, { now: NOW });

  await t.test('apiCall: user errors pass through with their message; internal errors are logged and shortened', (sb, assert) => {
    assert.throws(() => sb.gs.listTasks({ category: 'Bogus' }), /^Error: Category must be Work or Personal$/);
    assert.throws(() => sb.gs.addTask({ category: 'Work' }), /^Error: Title is required$/);
    assert.throws(() => sb.gs.addTask('{"category":"Work"}'), /Title is required/, 'JSON string input is tolerated');
    assert.throws(() => sb.gs.addTask('{bad json'), /^Error: Bad request$/);
    assert.throws(() => sb.gs.addTask([1, 2]), /^Error: Bad request$/);
    assert.ok(!sb.mock.logRows().some((r) => r.level === 'ERROR'), 'user errors are not logged as errors');
    const original = sb.gs.readTasks;
    sb.gs.readTasks = () => { throw new Error('boom: internal detail that should still be short ' + 'x'.repeat(400)); };
    let caught = null;
    try { sb.gs.listTasks({}); } catch (e) { caught = e; }
    sb.gs.readTasks = original;
    assert.ok(caught, 'threw');
    assert.ok(caught.message.length <= 200, 'short message');
    assert.ok(caught.message.startsWith('boom: internal detail'));
    const errRows = sb.mock.logRows().filter((r) => r.level === 'ERROR' && r.fn === 'api.listTasks');
    assert.equal(errRows.length, 1);
    assert.match(errRows[0].message, /boom: internal detail/);
    assert.match(errRows[0].message, /at /, 'stack trace logged');
    assert.deepEqual(sb.gs.listTasks(undefined).tasks, [], 'undefined input is {}');
  });

  await t.test('jsonSafe converts Dates, drops undefined/functions', (sb, assert) => {
    const d = new Date('2026-10-10T02:40:12Z');
    const out = sb.gs.jsonSafe({ a: d, b: [1, undefined, d, { c: undefined, f: () => 1 }], g: () => 2, n: NaN, s: 'x', t: true, z: null });
    assert.deepEqual(out, { a: '2026-10-10T06:40:12+04:00', b: [1, null, '2026-10-10T06:40:12+04:00', { c: null }], n: null, s: 'x', t: true, z: null });
    assert.equal(findUnsafe(out), '');
  });

  await t.test('doGet serves the Index template with title and viewport meta (X-Frame DEFAULT); intruders get "Not allowed"', (sb, assert) => {
    const out = sb.gs.doGet({ parameter: {} });
    assert.equal(out.title, "Brandon's Desk");
    assert.deepEqual(out.metaTags, [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }]);
    assert.equal(out.xFrame, 'DEFAULT', 'research-notes: leave X-Frame-Options at DEFAULT');
    assert.equal(sb.mock.html.templates.length, 1);
    assert.equal(sb.mock.html.templates[0].name, 'Index');
    sb.mock.session.activeEmail = 'intruder@example.com';
    const denied = sb.gs.doGet({});
    assert.match(denied.getContent(), /Not allowed/);
    assert.equal(sb.mock.html.templates.length, 1, 'template not evaluated for intruders');
    assert.equal(typeof sb.gs.include('Styles'), 'string');
  });

  await t.test('every read entry point heals the task tabs first (SPEC 3)', (sb, assert) => {
    const blank = () => ['', '', 'Needs healing', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    const cases = [['listTasks', { category: 'Work' }], ['listTasks', {}], ['getAgenda', {}], ['regenerateAgenda', {}], ['getNewsletter', {}]];
    cases.forEach(([name, input]) => {
      const fresh = t.createSandbox({ now: NOW });
      fresh.mock.seed('Work', [blank()]);
      fresh.mock.seed('Personal', [blank()]);
      fresh.gs[name](input);
      assert.match(fresh.mock.rows('Work')[0][0], /^W-[a-z0-9]{8}$/, name + ' heals Work');
      assert.ok(fresh.mock.logRows().some((r) => r.fn === 'healSheet'), name + ' logs the heal');
      if (name === 'listTasks' && !input.category) assert.match(fresh.mock.rows('Personal')[0][0], /^P-[a-z0-9]{8}$/, 'listTasks without a category heals Personal too');
    });
  }, { now: NOW });

  await t.test('getBootstrap heals both tabs and reports counts; getLog is newest first with a limit', (sb, assert) => {
    sb.mock.seed('Work', [['', '', 'Needs healing', '', '', '', '', '', '', '', '', '', '2026-10-01', '', '', '']]);
    sb.gs.addTask_({ category: 'Work', title: 'Due today', due: '2026-10-08' });
    sb.gs.addTask_({ category: 'Work', title: 'Later', due: '2026-10-20' });
    const doneId = sb.gs.addTask_({ category: 'Work', title: 'Finished' }).task.id;
    sb.gs.completeTask_({ category: 'Work', id: doneId });
    sb.gs.addTask_({ category: 'Personal', title: 'Personal open' });
    sb.mock.seed('Inbox', [
      ['I-1', new Date(), 'Gmail', 'A', 'S', 's', '', 'gmail:1', 'New', '', 'Work'],
      ['I-2', new Date(), 'Gmail', 'A', 'S', 's', '', 'gmail:2', 'Ignored', '', 'Work'],
      ['I-3', new Date(), 'Chat', 'A', 'S', 's', '', 'chat:3', '', '', 'Work']
    ]);
    const b = sb.gs.getBootstrap({});
    assert.equal(b.user, 'bbaki@aisa.sch.ae');
    assert.equal(b.today, '2026-10-08');
    assert.deepEqual(b.categories, ['Work', 'Personal']);
    assert.deepEqual(b.projects, ['AI Learning Hub', 'Teaching', 'Admin', 'PD', 'Parents']);
    assert.equal(b.config.MEETING_DAY, 'Tuesday');
    assert.equal(b.config.DEFAULT_QUICKADD_CATEGORY, 'Work');
    assert.deepEqual(b.counts, { work: { open: 3, dueToday: 1, overdue: 1 }, personal: { open: 1, dueToday: 0, overdue: 0 }, inboxNew: 2 });
    assert.match(sb.mock.rows('Work')[0][0], /^W-/, 'healed');
    assert.equal(findUnsafe(b), '');
    sb.gs.log('a', 'INFO', 'first');
    sb.gs.log('b', 'WARN', 'second');
    sb.gs.log('c', 'ERROR', 'third');
    const logs = sb.gs.getLog({ limit: 2 });
    assert.deepEqual(logs.rows.map((r) => r.message), ['third', 'second']);
    assert.deepEqual(Object.keys(logs.rows[0]), ['time', 'fn', 'level', 'message']);
    assert.match(logs.rows[0].time, /^2026-10-08T10:00:00\+04:00$/);
    assert.equal(logs.rows[0].fn, 'c');
    assert.equal(logs.rows[0].level, 'ERROR');
    assert.ok(sb.gs.getLog({}).rows.length >= 3);
    assert.equal(findUnsafe(logs), '');
    // Default limit 100 (SPEC 5), newest first, floor at 1
    const filler = [];
    for (let i = 0; i < 150; i++) filler.push([new Date(), 'fill', 'INFO', 'row ' + i]);
    sb.mock.seed('Log', filler);
    assert.equal(sb.gs.getLog({}).rows.length, 100, 'default limit 100');
    assert.equal(sb.gs.getLog({}).rows[0].message, 'row 149', 'newest first');
    assert.equal(sb.gs.getLog({ limit: 0 }).rows.length, 1, 'limit floors at 1');
    assert.equal(sb.gs.getLog({ limit: 'abc' }).rows.length, 100, 'junk limit → default');
    assert.equal(sb.gs.getLog({ limit: 5000 }).rows.length, sb.mock.logRows().length, 'ceiling 1000, so every row here');
  }, { now: NOW });

  // SPEC 7: Apps Script exposes every non-underscore global to google.script.run, so the ALLOWED_EMAILS check must not
  // depend on the caller going through Api.gs. Every public function that reads or writes sheet data or script state
  // runs guard() first; the few it cannot (what guard() itself needs) are listed with the reason.
  const GUARD_EXEMPT = {
    readConfig: 'guard() reads ALLOWED_EMAILS through it',
    openSpreadsheet: 'returns a Spreadsheet object (not JSON-serialisable); readConfig needs it',
    getTab: 'returns a Sheet object; log_() and readConfig need it',
    getSheetId: 'a Script Property read; readConfig needs it',
    log: 'runs guard() inside and silently writes nothing for an outsider (never throws, by contract)',
    guard: 'is the guard',
    doGet: 'runs guard() inside its own try/catch and serves "Not allowed"',
    include: 'template helper, reads a project HTML file only',
    withLock: 'needs a function argument, which google.script.run cannot pass'
  };
  const SERVICE_RE = /\b(SpreadsheetApp|PropertiesService|ScriptApp|GmailApp|UrlFetchApp|Session)\b|\b(getTab|readRows_?|readSheetRows_|readTasks|appendRows|writeRow|writeRowChanges|writeCells|deleteRowNumber|healSheet|createTasks|openSpreadsheet|findTask|existingSourceKeys)\(/;

  await t.test('every public function that touches sheet data or script state runs guard() first (static check)', (sb, assert) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', 'apps-script');
    const problems = [];
    let checked = 0;
    fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).forEach((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // Top-level declarations start at column 0; each function chunk runs to the next one.
      const chunks = src.split(/^(?=(?:function|const|let|var)\s)/m);
      chunks.forEach((chunk) => {
        const m = /^function\s+(\w+)\s*\(([^)]*)\)\s*\{/.exec(chunk);
        if (!m) return;
        const name = m[1];
        if (name.endsWith('_')) return;
        if (Object.prototype.hasOwnProperty.call(GUARD_EXEMPT, name)) return;
        const body = chunk.slice(m[0].length).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (!SERVICE_RE.test(body)) return;
        checked++;
        if (/apiCall_\(/.test(body)) return; // Api.gs entry points: apiCall_ guards
        if (/^\s*guard\(\);/.test(body)) return;
        problems.push(f + ': ' + name + '(' + m[2] + ') touches sheet data without guard() as its first statement');
      });
    });
    assert.deepEqual(problems, []);
    assert.ok(checked >= 20, 'the check saw ' + checked + ' functions');
  });

  await t.test('public helpers throw "Not allowed" for an outsider and touch nothing', (sb, assert) => {
    sb.gs.addTask_({ category: 'Work', title: 'Seed' });
    sb.mock.seed('Inbox', [['I-1', new Date(), 'Gmail', 'A', 'S', 's', '', 'gmail:1', 'New', '', 'Work']]);
    sb.gs.readConfig(); // memoised before the switch, exactly as in a real execution that already read it
    sb.mock.session.activeEmail = 'intruder@example.com';
    sb.mock.session.effectiveEmail = 'intruder@example.com';
    const writes = sb.mock.writes;
    const triggers = sb.mock.triggers.length;
    const calls = {
      setup: () => sb.gs.setup(),
      createFreshSheet: () => sb.gs.createFreshSheet(),
      selfTest: () => sb.gs.selfTest(),
      installTriggers: () => sb.gs.installTriggers(),
      removeTriggers: () => sb.gs.removeTriggers(),
      captureInbox: () => sb.gs.captureInbox(),
      healSheet: () => sb.gs.healSheet('Work'),
      deleteRowNumber: () => sb.gs.deleteRowNumber('Work', 2),
      writeRow: () => sb.gs.writeRow('Work', 2, ['W-hacked']),
      writeRowChanges: () => sb.gs.writeRowChanges('Work', 2, ['W-hacked']),
      writeCells: () => sb.gs.writeCells('Work', 2, { 0: 'W-hacked' }),
      appendRows: () => sb.gs.appendRows('Work', [['W-hacked']]),
      readRows: () => sb.gs.readRows('Config'),
      readTasks: () => sb.gs.readTasks('Work'),
      findTask: () => sb.gs.findTask('Work', 'W-x'),
      createTasks: () => sb.gs.createTasks('Work', [{ title: 'x y z' }]),
      ensureSchema: () => sb.gs.ensureSchema(),
      writeConfigDefaults: () => sb.gs.writeConfigDefaults(),
      chatProbe: () => sb.gs.chatProbe(),
      existingSourceKeys: () => sb.gs.existingSourceKeys(),
      myAddresses: () => sb.gs.myAddresses({}),
      captureGmail: () => sb.gs.captureGmail({}, new Set(), new Set()),
      captureChat: () => sb.gs.captureChat({}, new Set(), new Set(), new Date()),
      captureChatEmails: () => sb.gs.captureChatEmails({}, new Set(), 2)
    };
    Object.keys(calls).forEach((name) => {
      assert.throws(calls[name], /Not allowed/, name + ' must reject an outsider');
    });
    sb.gs.log('intruder', 'INFO', 'should not be written');
    assert.equal(sb.mock.writes, writes, 'nothing was written');
    assert.equal(sb.mock.triggers.length, triggers);
    assert.equal(sb.mock.gmail.searches.length, 0);
    assert.equal(sb.mock.urlFetch.calls.length, 0);
    assert.equal(sb.mock.rows('Work').length, 1);
    assert.equal(sb.mock.rows('Work')[0][2], 'Seed');
    assert.ok(!sb.mock.logRows().some((r) => /should not be written/.test(r.message)));
    // The owner still passes everywhere, including the trigger entry point
    sb.mock.session.activeEmail = 'bbaki@aisa.sch.ae';
    sb.mock.session.effectiveEmail = 'bbaki@aisa.sch.ae';
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    assert.equal(sb.gs.readRows('Work').length, 1);
    assert.equal(sb.gs.captureInbox().skipped, undefined);
    assert.equal(sb.gs.removeTriggers(), 0);
    sb.gs.log('owner', 'INFO', 'written');
    assert.ok(sb.mock.logRows().some((r) => r.message === 'written'));
  }, { now: NOW });
};
