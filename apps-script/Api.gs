/**
 * Api.gs — doGet(), the google.script.run entry points, auth guard, input validation
 * and error wrapping. Every entry point takes one plain object and returns one
 * JSON-safe object (no Date, no undefined in arrays, no functions).
 */

/** Serves the single-page app. */
function doGet(e) {
  try {
    guard();
  } catch (err) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Not allowed.</p>').setTitle(APP_TITLE);
  }
  const template = HtmlService.createTemplateFromFile('Index');
  template.appTitle = APP_TITLE;
  // X-Frame-Options stays DEFAULT (research-notes: it only matters for embedding; the app is
  // opened directly, never framed by another site).
  return template.evaluate()
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Template include helper: <?!= include('Styles') ?>. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Auth guard: the active user's email (falling back to the effective user when blank) must be
 * in Config ALLOWED_EMAILS (case-insensitive, trimmed). Returns the email or throws "Not allowed".
 */
function guard() {
  let email = '';
  try { email = str(Session.getActiveUser().getEmail()).trim(); } catch (e) { email = ''; }
  if (!email) {
    try { email = str(Session.getEffectiveUser().getEmail()).trim(); } catch (e) { email = ''; }
  }
  if (!email) {
    guardExplain_('Google returned no email address for this run, so it cannot be checked against Config ' +
      'ALLOWED_EMAILS. Usually the project was pushed without this repo\'s manifest: run ' +
      '"git checkout -- apps-script/appsscript.json" and "clasp push -f", reload the editor and run again.');
    throw userError('Not allowed');
  }
  const allowed = readConfig().ALLOWED_EMAILS.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email.toLowerCase())) {
    guardExplain_('this run is signed in as ' + email + ', which is not in Config ALLOWED_EMAILS (' +
      allowed.join(', ') + '). The script must belong to and run as the work account: check ' +
      '"clasp show-authorized-user" and the account menu in the editor. Only add ' + email +
      ' to ALLOWED_EMAILS in the Config tab if it really is one of your accounts.');
    throw userError('Not allowed');
  }
  return email;
}

/**
 * Writes why guard() refused to the execution log (the Apps Script editor shows it above the
 * error). The thrown message stays the short "Not allowed" the web page shows.
 */
function guardExplain_(reason) {
  try { Logger.log('guard: Not allowed because ' + reason); } catch (e) { /* ignore */ }
}

/** Recursively converts a value into something google.script.run can return. */
function jsonSafe(value) {
  if (value === undefined || value === null) return null;
  if (isDateValue(value)) return formatDateTime(value);
  if (typeof value === 'function') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : jsonSafe(v)));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      const v = value[k];
      if (typeof v === 'function') return;
      out[k] = v === undefined ? null : jsonSafe(v);
    });
    return out;
  }
  return value;
}

function inputObject_(input) {
  if (input === undefined || input === null) return {};
  if (typeof input === 'string') {
    try { return JSON.parse(input) || {}; } catch (e) { throw userError('Bad request'); }
  }
  if (typeof input !== 'object' || Array.isArray(input)) throw userError('Bad request');
  return input;
}

/**
 * Wraps an API body: guard(), run, make the result JSON-safe. User errors are rethrown with
 * their short message; anything else is logged with its stack and rethrown as a short Error.
 */
function apiCall_(name, input, fn) {
  let email = '';
  try {
    email = guard();
  } catch (e) {
    // log_ (not log): the guarded log() would write nothing for the rejected caller.
    try { log_('api.' + name, 'WARN', 'guard rejected call'); } catch (e2) { /* ignore */ }
    throw new Error('Not allowed');
  }
  try {
    const result = fn(inputObject_(input), email);
    return jsonSafe(result === undefined ? {} : result);
  } catch (e) {
    if (e && e.isUserError) throw new Error(errorMessage(e));
    try { log('api.' + name, 'ERROR', (e && e.stack) ? String(e.stack) : errorMessage(e)); } catch (e2) { /* ignore */ }
    throw new Error(errorMessage(e) || 'Something went wrong');
  }
}

// ---------------------------------------------------------------------------
// Entry points (SPEC section 5)
// ---------------------------------------------------------------------------

function getBootstrap(input) {
  return apiCall_('getBootstrap', input, (inp, email) => {
    healSheet(TABS.WORK);
    healSheet(TABS.PERSONAL);
    const config = readConfig();
    const today = todayDubai();
    const work = readTasks(TABS.WORK);
    const personal = readTasks(TABS.PERSONAL);
    const inboxNew = readRows(TABS.INBOX).filter((r) => (str(r.status).trim() || 'New') === 'New').length;
    return {
      user: email,
      today: today,
      config: config,
      projects: config.PROJECTS,
      categories: CATEGORIES.slice(),
      counts: {
        work: taskCounts(work, today),
        personal: taskCounts(personal, today),
        inboxNew: inboxNew
      }
    };
  });
}

function listTasks(input) {
  return apiCall_('listTasks', input, (inp) => {
    const cats = inp.category ? [taskTabName(inp.category)] : CATEGORIES;
    cats.forEach((c) => healSheet(c));
    return listTasks_(inp);
  });
}

function addTask(input) {
  return apiCall_('addTask', input, (inp) => addTask_(inp));
}

function updateTask(input) {
  return apiCall_('updateTask', input, (inp) => updateTask_(inp));
}

function completeTask(input) {
  return apiCall_('completeTask', input, (inp) => completeTask_(inp));
}

function reopenTask(input) {
  return apiCall_('reopenTask', input, (inp) => reopenTask_(inp));
}

function dropTask(input) {
  return apiCall_('dropTask', input, (inp) => dropTask_(inp));
}

function moveTask(input) {
  return apiCall_('moveTask', input, (inp) => moveTask_(inp));
}

function importText(input) {
  return apiCall_('importText', input, (inp) => importText_(inp));
}

function importHtml(input) {
  return apiCall_('importHtml', input, (inp) => importHtml_(inp));
}

function listInbox(input) {
  return apiCall_('listInbox', input, (inp) => listInbox_(inp));
}

function promoteInbox(input) {
  return apiCall_('promoteInbox', input, (inp) => promoteInbox_(inp));
}

function ignoreInbox(input) {
  return apiCall_('ignoreInbox', input, (inp) => ignoreInbox_(inp));
}

function getAgenda(input) {
  return apiCall_('getAgenda', input, (inp) => {
    healSheet(TABS.WORK);
    return getAgenda_(inp);
  });
}

function saveAgenda(input) {
  return apiCall_('saveAgenda', input, (inp) => saveAgenda_(inp));
}

function regenerateAgenda(input) {
  return apiCall_('regenerateAgenda', input, (inp) => {
    healSheet(TABS.WORK);
    return regenerateAgenda_(inp);
  });
}

function getNewsletter(input) {
  return apiCall_('getNewsletter', input, (inp) => {
    healSheet(TABS.WORK);
    return getNewsletter_(inp);
  });
}

function runCaptureNow(input) {
  return apiCall_('runCaptureNow', input, () => runCaptureNow_());
}

function getLog(input) {
  return apiCall_('getLog', input, (inp) => {
    const given = inp.limit === undefined || inp.limit === null || inp.limit === '' ? 100 : Number(inp.limit);
    const limit = Math.max(1, Math.min(1000, isFinite(given) ? given : 100));
    const rows = readRows(TABS.LOG).map((r) => ({
      time: toDateTimeString(r.time),
      fn: unguardCell(str(r.fn)),
      level: str(r.level),
      message: unguardCell(str(r.message)),
      row: r.row
    })).sort((a, b) => b.row - a.row).slice(0, limit)
      .map((r) => ({ time: r.time, fn: r.fn, level: r.level, message: r.message }));
    return { rows: rows };
  });
}

// ---------------------------------------------------------------------------
// Desk page entry points (docs/DESK.md section 2; implementations in Desk.gs)
// ---------------------------------------------------------------------------

function getDesk(input) {
  return apiCall_('getDesk', input, () => {
    healSheet(TABS.WORK);
    healSheet(TABS.PERSONAL);
    return getDesk_();
  });
}

function setDeskItemDone(input) {
  return apiCall_('setDeskItemDone', input, (inp) => {
    // Rows the routine appended with a blank ID get one first, so a tick resolves to them
    // instead of creating a second row.
    healSheet(TABS.WORK);
    healSheet(TABS.PERSONAL);
    return setDeskItemDone_(inp);
  });
}

function getDeskStatus(input) {
  return apiCall_('getDeskStatus', input, () => getDeskStatus_());
}

function rebuildDesk(input) {
  return apiCall_('rebuildDesk', input, () => rebuildDesk_());
}
