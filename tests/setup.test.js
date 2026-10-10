'use strict';
const { HEADERS, TAB_ORDER } = require('./gas-mock');
const { findUnsafe } = require('./fixtures/helpers');

module.exports = async function (t) {
  await t.test('setup adopts the default sheet when SHEET_ID is unset and it can be opened', (sb, assert) => {
    sb.mock.sheet('Config').clearContents();
    sb.mock.sheet('Config').appendRow(['Key', 'Value', 'Notes']);
    const r = sb.gs.setup();
    assert.equal(r.sheetId, '1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w');
    assert.equal(r.adopted, true);
    assert.equal(r.created, false);
    assert.deepEqual(r.tabsCreated, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.configWritten, true);
    assert.deepEqual(r.triggers, { installed: 1, removed: 0 });
    assert.equal(sb.mock.properties.SHEET_ID, r.sheetId);
    assert.equal(sb.mock.rows('Config').length, 11);
    assert.equal(sb.mock.triggers.filter((x) => x.getHandlerFunction() === 'captureInbox').length, 1);
    const setupLog = sb.mock.logRows().find((row) => row.fn === 'setup');
    assert.equal(setupLog.level, 'INFO');
    assert.match(setupLog.message, /adopted the default sheet https:\/\/docs\.google\.com\/spreadsheets\/d\//);
    assert.ok(sb.mock.logs.some((l) => /Sheet URL: https/.test(l)));
    assert.equal(findUnsafe(r), '');
    // Second run: existing config kept, nothing recreated, trigger replaced not duplicated
    const again = sb.gs.setup();
    assert.equal(again.adopted, false);
    assert.equal(again.configWritten, false);
    assert.deepEqual(again.triggers, { installed: 1, removed: 1 });
    assert.equal(sb.mock.triggers.length, 1);
  });

  await t.test('setup creates a new spreadsheet with the full schema when the default cannot be opened', (sb, assert) => {
    const r = sb.gs.setup();
    assert.equal(r.created, true);
    assert.equal(r.adopted, false);
    assert.match(r.sheetId, /^mock-created-/);
    assert.equal(sb.mock.properties.SHEET_ID, r.sheetId);
    assert.deepEqual(r.tabsCreated, TAB_ORDER);
    assert.equal(r.configWritten, true);
    const ss = sb.mock.spreadsheets.get(r.sheetId);
    assert.equal(ss.getName(), "Brandon's Desk");
    assert.deepEqual(ss.getSheets().map((s) => s.getName()), TAB_ORDER);
    TAB_ORDER.forEach((tab) => {
      assert.deepEqual(ss.getSheetByName(tab).getRange(1, 1, 1, HEADERS[tab].length).getValues()[0], HEADERS[tab]);
    });
    assert.equal(sb.mock.rows('Config', r.sheetId).length, 11);
    assert.ok(sb.mock.logRows(r.sheetId).some((row) => row.fn === 'setup' && /created a new sheet/.test(row.message)));
    // Subsequent calls use the new sheet
    assert.equal(sb.gs.openSpreadsheet(), ss);
    const task = sb.gs.addTask_({ category: 'Work', title: 'Lives in the new sheet' }).task;
    assert.equal(sb.mock.rows('Work', r.sheetId)[0][0], task.id);
  }, { noDefaultSheet: true });

  await t.test('setup honours an existing SHEET_ID property', (sb, assert) => {
    const other = sb.mock.buildSpreadsheet('other-sheet', 'Other', false);
    sb.mock.properties.SHEET_ID = 'other-sheet';
    const r = sb.gs.setup();
    assert.equal(r.sheetId, 'other-sheet');
    assert.equal(r.adopted, false);
    assert.equal(r.created, false);
    assert.deepEqual(r.tabsCreated, TAB_ORDER);
    assert.deepEqual(other.getSheets().map((s) => s.getName()), TAB_ORDER);
    assert.equal(sb.mock.rows('Work').length, 0, 'default sheet untouched');
  });

  await t.test('createFreshSheet makes a new sheet and points SHEET_ID at it', (sb, assert) => {
    const r = sb.gs.createFreshSheet();
    assert.match(r.sheetId, /^mock-created-/);
    assert.match(r.url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/mock-created-/);
    assert.deepEqual(r.tabsCreated, TAB_ORDER);
    assert.equal(sb.mock.properties.SHEET_ID, r.sheetId);
    assert.equal(sb.gs.getSheetId(), r.sheetId);
    assert.equal(sb.mock.rows('Config', r.sheetId).length, 11);
    assert.ok(sb.mock.logRows(r.sheetId).some((row) => row.fn === 'createFreshSheet'), 'logged into the new sheet');
    assert.equal(sb.mock.logRows().length, 0, 'nothing written to the old sheet');
  });

  await t.test('selfTest exercises add/complete/import and Gmail/Chat probes, then removes its throwaway rows', (sb, assert) => {
    sb.gs.addTask_({ category: 'Work', title: 'Pre-existing task' });
    sb.mock.urlFetch.handler = () => ({ code: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } } });
    const r = sb.gs.selfTest();
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.steps.map((s) => s.step), ['openSpreadsheet', 'ensureSchema', 'readConfig', 'healSheet', 'addTask', 'completeTask', 'importText', 'textRoundTrip', 'gmail', 'chat', 'cleanup']);
    assert.ok(r.steps.every((s) => s.ok));
    assert.match(r.steps[4].result, /^W-[a-z0-9]{8}$/);
    assert.match(r.steps[5].result, /^Done \d{4}-\d{2}-\d{2}$/);
    assert.equal(r.steps[6].result, 'added 1, skipped 0');
    assert.equal(r.steps[7].result, 'title, note and project read back as typed');
    assert.equal(r.chat.ok, false);
    assert.equal(r.chat.code, 403);
    assert.match(r.chat.detail, /SERVICE_DISABLED/);
    assert.equal(r.gmail.ok, true);
    assert.equal(r.steps[10].result, '3 throwaway row(s) removed');
    assert.equal(sb.mock.rows('Work').length, 1, 'only the pre-existing task remains');
    assert.equal(sb.mock.rows('Work')[0][2], 'Pre-existing task');
    assert.equal(sb.mock.rows('Personal').length, 0);
    assert.ok(sb.mock.logRows().some((row) => /^CHAT_API_BLOCKED HTTP 403/.test(row.message)));
    const summary = sb.mock.logRows().find((row) => row.fn === 'selfTest');
    assert.equal(summary.level, 'INFO');
    assert.match(summary.message, /addTask:ok completeTask:ok importText:ok textRoundTrip:ok gmail:ok chat:ok cleanup:ok/);
    assert.equal(findUnsafe(r), '');
    // With Sheets' input parsing modelled, the step passes only because ensureSchema put '@' on the text columns
    // (tasks.test.js shows the same strings coming back as 7 / true / a Date without it).
    sb.mock.coerceStrings = true;
    const typed = sb.gs.selfTest();
    assert.equal(typed.ok, true, JSON.stringify(typed.errors));
    assert.equal(typed.steps[7].result, 'title, note and project read back as typed');
    sb.mock.coerceStrings = false;
    // A failing step is reported, not thrown
    sb.mock.gmail.throwOnSearch = 'You do not have permission to call GmailApp.search';
    const bad = sb.gs.selfTest();
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.errors, ['gmail: You do not have permission to call GmailApp.search']);
    assert.equal(sb.mock.rows('Work').length, 1, 'cleanup still ran');
    assert.equal(sb.mock.logRows().filter((row) => row.fn === 'selfTest').pop().level, 'ERROR');
  });
};
