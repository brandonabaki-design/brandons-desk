/**
 * Setup.gs — setup(): adopt or create the sheet, apply the schema, store SHEET_ID, write
 * Config defaults, install the trigger. createFreshSheet() and selfTest().
 *
 * Run these from the Apps Script editor (Run ▸ setup) after `clasp push -f`.
 */

/**
 * One-time setup. If Script Property SHEET_ID is unset: adopt DEFAULT_SHEET_ID when this
 * account can open it, otherwise create "Brandon's Desk" in the user's Drive. Then ensure
 * the schema, write Config defaults into an empty Config tab, install the trigger and log
 * the URL. Returns a plain report object.
 */
function setup() {
  guard();
  const props = PropertiesService.getScriptProperties();
  const report = { sheetId: '', url: '', created: false, adopted: false, tabsCreated: [], warnings: [], configWritten: false, triggers: null };
  let sheetId = str(props.getProperty('SHEET_ID')).trim();
  let ss = null;
  if (sheetId) {
    ss = SpreadsheetApp.openById(sheetId);
  } else {
    try {
      ss = SpreadsheetApp.openById(DEFAULT_SHEET_ID);
      report.adopted = true;
    } catch (e) {
      ss = SpreadsheetApp.create(APP_TITLE);
      report.created = true;
    }
    sheetId = ss.getId();
    props.setProperty('SHEET_ID', sheetId);
  }
  resetMemos();
  report.sheetId = sheetId;
  report.url = ss.getUrl();
  const schema = ensureSchema(ss);
  report.tabsCreated = schema.created;
  report.warnings = schema.warnings;
  report.configWritten = writeConfigDefaults(ss);
  resetMemos();
  try {
    report.triggers = installTriggers();
  } catch (e) {
    report.warnings.push('installTriggers failed: ' + errorMessage(e) + ' (run installTriggers from the editor)');
  }
  const what = report.created ? 'created a new sheet' : (report.adopted ? 'adopted the default sheet' : 'using the configured sheet');
  const msg = 'setup: ' + what + ' ' + report.url +
    (report.tabsCreated.length ? '; tabs created: ' + report.tabsCreated.join(', ') : '') +
    (report.configWritten ? '; Config defaults written' : '') +
    (report.warnings.length ? '; warnings: ' + report.warnings.join(' | ') : '');
  log('setup', report.warnings.length ? 'WARN' : 'INFO', msg);
  Logger.log('Sheet URL: ' + report.url);
  return report;
}

/** Creates a brand-new "Brandon's Desk" spreadsheet with the full schema and points SHEET_ID at it. */
function createFreshSheet() {
  guard();
  const ss = SpreadsheetApp.create(APP_TITLE);
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  resetMemos();
  const schema = ensureSchema(ss);
  writeConfigDefaults(ss);
  resetMemos();
  log('createFreshSheet', 'INFO', 'Created ' + ss.getUrl() + ' (tabs: ' + schema.created.join(', ') + ')');
  Logger.log('Sheet URL: ' + ss.getUrl());
  return { sheetId: ss.getId(), url: ss.getUrl(), tabsCreated: schema.created };
}

/**
 * Exercises add/complete/import on throwaway rows, probes Gmail and Chat, cleans up and
 * reports. Safe to run repeatedly.
 */
function selfTest() {
  guard();
  const report = { ok: true, steps: [], errors: [], sheetUrl: '', chat: null, gmail: null };
  const marker = 'selfTest ' + formatDateTime(new Date());
  const cleanup = []; // {category, id}
  const step = (name, fn) => {
    try {
      const out = fn();
      report.steps.push({ step: name, ok: true, result: out === undefined ? '' : out });
    } catch (e) {
      report.ok = false;
      report.errors.push(name + ': ' + errorMessage(e));
      report.steps.push({ step: name, ok: false, error: errorMessage(e) });
    }
  };

  step('openSpreadsheet', () => { const ss = openSpreadsheet(); report.sheetUrl = ss.getUrl(); return ss.getUrl(); });
  step('ensureSchema', () => ensureSchema(openSpreadsheet()));
  step('readConfig', () => { const c = readConfig(); return 'timezone ' + c.TIMEZONE + ', meeting day ' + c.MEETING_DAY + ', chat ' + (c.CHAT_ENABLED ? 'on' : 'off'); });
  step('healSheet', () => ({ work: healSheet(TABS.WORK).fixed, personal: healSheet(TABS.PERSONAL).fixed }));
  let taskId = '';
  step('addTask', () => {
    const r = addTask_({ category: TABS.WORK, title: marker, details: 'temporary row written by selfTest', source: 'Manual', newsletter: false });
    taskId = r.task.id;
    cleanup.push({ category: TABS.WORK, id: taskId });
    return taskId + (r.duplicate ? ' (duplicate)' : '');
  });
  step('completeTask', () => {
    if (!taskId) throw new Error('no task to complete');
    const r = completeTask_({ category: TABS.WORK, id: taskId, note: 'selfTest' });
    return r.task.status + ' ' + r.task.done;
  });
  step('importText', () => {
    const r = importText_({ category: TABS.PERSONAL, text: '# selfTest\n- [x] ' + marker + ' import line !' });
    r.added.forEach((t) => cleanup.push({ category: TABS.PERSONAL, id: t.id }));
    return 'added ' + r.added.length + ', skipped ' + r.skipped.length;
  });
  // Number-, boolean- and date-looking text must come back as typed: the '@' format on the text
  // columns (ensureSchema) is what stops Sheets parsing "007" into 7 or "10/12" into a date.
  step('textRoundTrip', () => {
    const r = addTask_({ category: TABS.PERSONAL, title: '007', details: marker, note: 'TRUE', project: '10/12', newsletter: false });
    cleanup.push({ category: TABS.PERSONAL, id: r.task.id });
    const back = findTask(TABS.PERSONAL, r.task.id);
    const got = [back.title, back.note, back.project];
    if (got.join('|') !== '007|TRUE|10/12') throw new Error('text cells were parsed on write: ' + JSON.stringify(got) + ' (run ensureSchema / setup again)');
    return 'title, note and project read back as typed';
  });
  step('gmail', () => {
    const threads = GmailApp.search('newer_than:1d', 0, 1);
    report.gmail = { ok: true, threads: threads.length };
    return 'ok (' + threads.length + ' thread(s) in the last day)';
  });
  step('chat', () => {
    const probe = chatProbe();
    report.chat = probe;
    return (probe.ok ? 'ok' : 'blocked (HTTP ' + probe.code + ')') + (probe.detail ? ' ' + probe.detail : '');
  });
  step('cleanup', () => {
    let removed = 0;
    // Delete bottom-up so row numbers stay valid.
    CATEGORIES.forEach((category) => {
      const ids = cleanup.filter((c) => c.category === category).map((c) => c.id);
      if (!ids.length) return;
      const rows = readTasks(category).filter((t) => ids.includes(t.id)).map((t) => t.row).sort((a, b) => b - a);
      rows.forEach((row) => { deleteRowNumber(category, row); removed++; });
    });
    return removed + ' throwaway row(s) removed';
  });
  const summary = report.steps.map((s) => s.step + ':' + (s.ok ? 'ok' : 'FAIL')).join(' ');
  log('selfTest', report.ok ? 'INFO' : 'ERROR', summary + (report.errors.length ? ' — ' + report.errors.join(' | ') : ''));
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
