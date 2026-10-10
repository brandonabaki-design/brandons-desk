/**
 * Capture.gs — captureInbox() (Gmail + Chat → Inbox tab), the Inbox API implementations,
 * installTriggers() and removeTriggers().
 */

const AUTOMATED_SENDER_RE_ = /noreply|no-reply|donotreply|notifications?@|mailer-daemon|calendar-notification/i;
const TRIGGER_HANDLER_ = 'captureInbox';

/**
 * Trigger entry point (daily 06:15 Dubai). Skips Saturday and Sunday (ISO weekday 6/7).
 */
function captureInbox() {
  guard();
  const today = todayDubai();
  const weekday = isoWeekday(today);
  if (weekday === 6 || weekday === 7) {
    log('captureInbox', 'INFO', 'Weekend (' + today + '): capture skipped');
    return { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'off', errors: [], skipped: true };
  }
  return runCapture_();
}

/**
 * runCaptureNow: {} → {gmail, chat, chatMessages, chatMode, errors}. Bypasses the weekday guard.
 * chat = Chat Inbox rows written (one per conversation), chatMessages = messages in those rows.
 */
function runCaptureNow_() {
  return runCapture_();
}

/** The set of my addresses: effective user + Gmail aliases + ALLOWED_EMAILS (lower-cased). */
function myAddresses(config) {
  guard();
  const me = new Set();
  const add = (v) => { const e = extractEmail(v); if (e) me.add(e); };
  try { add(Session.getEffectiveUser().getEmail()); } catch (e) { /* ignore */ }
  try { (GmailApp.getAliases() || []).forEach(add); } catch (e) { /* getAliases has no documented scope */ }
  ((config && config.ALLOWED_EMAILS) || []).forEach(add);
  return me;
}

/** Work email used in Gmail links (the effective user). */
function workEmail_() {
  try {
    return String(Session.getEffectiveUser().getEmail() || '').trim();
  } catch (e) {
    return '';
  }
}

/** Source keys already present in Inbox, Work and Personal. */
function existingSourceKeys() {
  guard();
  const keys = new Set();
  readRows(TABS.INBOX).forEach((r) => { const k = str(r.sourceKey).trim(); if (k) keys.add(k); });
  CATEGORIES.forEach((c) => {
    readRows(c).forEach((r) => { const k = str(r.sourceKey).trim(); if (k) keys.add(k); });
  });
  return keys;
}

/** Is the message automated/bulk (sender pattern or list/auto headers)? */
function isAutomatedMessage(message) {
  if (AUTOMATED_SENDER_RE_.test(str(message.getFrom()))) return true;
  const header = (name) => {
    try { return str(message.getHeader(name)).trim(); } catch (e) { return ''; }
  };
  if (header('List-Unsubscribe') || header('List-Id')) return true;
  if (/^(bulk|list|junk)$/i.test(header('Precedence'))) return true;
  if (/^auto-/i.test(header('Auto-Submitted'))) return true;
  return false;
}

function gmailQuery_(config) {
  let q = str(config.GMAIL_QUERY).trim() || configDefaults().GMAIL_QUERY;
  if (!/\bnewer_than:/i.test(q) && !/\bafter:/i.test(q)) {
    q += ' newer_than:' + Math.max(1, Number(config.GMAIL_LOOKBACK_DAYS) || 2) + 'd';
  }
  return q;
}

/**
 * Gmail capture. Returns {rows, errors}; rows are Inbox row objects.
 * Skips: last message from me, thread has a draft, key already known, automated sender.
 */
function captureGmail(config, existingKeys, meSet) {
  guard();
  const rows = [];
  const errors = [];
  const email = workEmail_();
  try {
    const threads = GmailApp.search(gmailQuery_(config), 0, GMAIL_MAX_THREADS);
    const perThread = threads.length ? GmailApp.getMessagesForThreads(threads) : [];
    threads.forEach((thread, i) => {
      const msgs = perThread[i] || [];
      if (!msgs.length) return;
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      if (msgs.some((m) => m.isDraft())) return;
      if (meSet.has(extractEmail(last.getFrom()))) return;
      const key = 'gmail:' + first.getId();
      if (existingKeys.has(key)) return;
      if (isAutomatedMessage(last)) return;
      existingKeys.add(key);
      rows.push({
        source: 'Gmail',
        from: str(last.getFrom()),
        subject: str(last.getSubject()) || str(thread.getFirstMessageSubject()),
        snippet: cleanSnippet(stripQuotedReply(last.getPlainBody()), SNIPPET_MAX),
        link: 'https://mail.google.com/mail/u/' + email + '/#all/' + thread.getId(),
        sourceKey: key,
        categoryHint: 'Work'
      });
    });
  } catch (e) {
    log('captureGmail', 'ERROR', errorMessage(e));
    errors.push('Gmail: ' + errorMessage(e));
  }
  return { rows: rows, errors: errors };
}

/** Inbox row object → 11-cell row. */
function inboxToRow_(item, id, now) {
  const C = COLUMN.INBOX;
  const row = new Array(HEADERS.Inbox.length).fill('');
  row[C.id] = id;
  row[C.captured] = now;
  row[C.source] = item.source;
  row[C.from] = truncate(item.from, 200);
  row[C.subject] = truncate(item.subject, 200);
  row[C.snippet] = truncate(item.snippet, SNIPPET_MAX);
  row[C.link] = sanitiseLink(item.link);
  row[C.sourceKey] = item.sourceKey;
  row[C.status] = 'New';
  row[C.taskId] = '';
  row[C.categoryHint] = CATEGORIES.includes(item.categoryHint) ? item.categoryHint : 'Work';
  return row;
}

/** Chat rows in a list of Inbox row objects, and the messages they carry (an email-fallback row is one message). */
function chatCounts_(items) {
  const chat = items.filter((item) => item.source === 'Chat');
  return { rows: chat.length, messages: chat.reduce((n, item) => n + (Number(item.messageCount) || 1), 0) };
}

/** Shared capture body: heal, collect, append, log. */
function runCapture_() {
  const config = readConfig();
  const result = { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'off', errors: [] };
  try { healSheet(TABS.WORK); healSheet(TABS.PERSONAL); } catch (e) { result.errors.push('heal: ' + errorMessage(e)); }
  const existingKeys = existingSourceKeys();
  const me = myAddresses(config);
  const now = new Date();
  let items = [];

  const gmail = captureGmail(config, existingKeys, me);
  items = items.concat(gmail.rows);
  result.gmail = gmail.rows.length;
  result.errors = result.errors.concat(gmail.errors);

  if (config.CHAT_ENABLED) {
    const chat = captureChat(config, existingKeys, me, now);
    items = items.concat(chat.rows);
    const counted = chatCounts_(chat.rows);
    result.chat = counted.rows;
    result.chatMessages = counted.messages;
    result.chatMode = chat.mode;
    result.errors = result.errors.concat(chat.errors);
  }

  let dropped = 0;
  if (items.length) {
    // Gmail/Chat fetching stayed outside the lock; the key check and the append share one lock
    // acquisition so an overlapping run (06:15 trigger + "Run capture now") cannot write the
    // same Source key twice.
    withLock(() => {
      const keysNow = existingSourceKeys();
      const fresh = items.filter((item) => !keysNow.has(item.sourceKey));
      dropped = items.length - fresh.length;
      items = fresh;
      if (!items.length) return;
      const existingIds = new Set(readRows(TABS.INBOX).map((r) => str(r.id)));
      const rows = items.map((item) => {
        const id = newId(ID_PREFIX.Inbox, existingIds);
        existingIds.add(id);
        return inboxToRow_(item, id, now);
      });
      appendRows(TABS.INBOX, rows);
    });
    result.gmail = items.filter((item) => item.source === 'Gmail').length;
    const written = chatCounts_(items);
    result.chat = written.rows;
    result.chatMessages = written.messages;
  }
  log('captureInbox', result.errors.length ? 'WARN' : 'INFO',
    'gmail ' + result.gmail + ', chat ' + result.chat + ' (mode ' + result.chatMode + ')' +
    (result.chat ? ', ' + result.chatMessages + ' chat message(s)' : '') +
    (dropped ? '; ' + dropped + ' row(s) already captured by an overlapping run' : '') +
    (result.errors.length ? '; errors: ' + result.errors.join(' | ') : ''));
  return result;
}

// ---------------------------------------------------------------------------
// Inbox API implementations
// ---------------------------------------------------------------------------

function rowToInboxItem_(r) {
  return {
    id: str(r.id).trim(),
    captured: toDateTimeString(r.captured),
    source: str(r.source).trim(),
    from: unguardCell(str(r.from)),
    subject: unguardCell(str(r.subject)),
    snippet: unguardCell(str(r.snippet)),
    link: sanitiseLink(r.link),
    sourceKey: str(r.sourceKey).trim(),
    status: str(r.status).trim() || 'New',
    taskId: str(r.taskId).trim(),
    categoryHint: CATEGORIES.includes(str(r.categoryHint).trim()) ? str(r.categoryHint).trim() : 'Work',
    row: r.row
  };
}

/** listInbox: {status?} → {items:[InboxItem]} (default New, newest first). */
function listInbox_(input) {
  const inp = input || {};
  const wanted = str(inp.status).trim();
  const status = wanted ? (INBOX_STATUSES.find((s) => s.toLowerCase() === wanted.toLowerCase()) || (wanted.toLowerCase() === 'all' ? '' : null)) : 'New';
  if (status === null) throw userError('Status must be New, Promoted, Ignored or all');
  const items = readRows(TABS.INBOX).map(rowToInboxItem_)
    .filter((it) => !status || it.status === status)
    .sort((a, b) => {
      if (a.captured !== b.captured) return a.captured > b.captured ? -1 : 1;
      return b.row - a.row;
    });
  return { items: items };
}

function findInbox_(inboxId) {
  const id = str(inboxId).trim();
  if (!id) throw userError('Inbox id required');
  const hit = readRows(TABS.INBOX).map(rowToInboxItem_).find((it) => it.id === id);
  if (!hit) throw userError('Inbox item not found: ' + id);
  return hit;
}

/**
 * promoteInbox: {inboxId, category, title?, project?, due?, priority?} → {task}.
 * Creates the task (Source, Link and Source key copied) and marks the row Promoted. A row
 * that is already Promoted returns the task it was promoted to (the UI hides the button, but
 * the call is reachable): promoting it again into the other list must not create a second
 * task with the same Source key.
 */
function promoteInbox_(input) {
  const inp = input || {};
  const item = findInbox_(inp.inboxId);
  const category = taskTabName(inp.category || item.categoryHint);
  if (item.status === 'Promoted' && item.taskId) {
    const tab = item.taskId.charAt(0) === 'P' ? TABS.PERSONAL : TABS.WORK;
    const already = readTasks(tab).find((t) => t.id === item.taskId);
    if (already) return { task: already, duplicate: true };
  }
  const title = validTitle_(str(inp.title).trim() || item.subject || item.snippet);
  const details = ['From ' + item.from, item.snippet].filter(Boolean).join(': ');
  const spec = {
    title: title,
    details: truncate(details, 1000),
    project: inp.project,
    due: inp.due,
    priority: inp.priority,
    link: sanitiseLink(item.link),
    source: INBOX_SOURCES.includes(item.source) ? item.source : 'Manual',
    sourceKey: item.sourceKey
  };
  validDateOrBlank_(spec.due, 'Due');
  validPriority_(spec.priority);
  const result = createTasks(category, [spec]);
  let task;
  if (result.added.length) task = result.added[0];
  else if (result.skipped[0] && result.skipped[0].reason === 'duplicate') task = result.skipped[0].task;
  else throw userError(result.skipped[0] ? result.skipped[0].reason : 'Could not promote');
  const C = COLUMN.INBOX;
  const patch = {};
  patch[C.status] = 'Promoted';
  patch[C.taskId] = task.id;
  writeCells(TABS.INBOX, item.row, patch);
  return { task: task, duplicate: !result.added.length };
}

/** ignoreInbox: {inboxId} → {ok:true}. */
function ignoreInbox_(input) {
  const inp = input || {};
  const item = findInbox_(inp.inboxId);
  const patch = {};
  patch[COLUMN.INBOX.status] = 'Ignored';
  writeCells(TABS.INBOX, item.row, patch);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Deletes every captureInbox trigger. Returns the number removed. */
function removeTriggers() {
  guard();
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === TRIGGER_HANDLER_) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/** Idempotent: removes existing captureInbox triggers, then installs one daily at 06:15 Dubai. */
function installTriggers() {
  guard();
  const removed = removeTriggers();
  const tz = getTimeZone();
  ScriptApp.newTrigger(TRIGGER_HANDLER_)
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .nearMinute(15)
    .inTimezone(tz)
    .create();
  log('installTriggers', 'INFO', 'captureInbox trigger installed (daily 06:15 ' + tz + '); removed ' + removed + ' old');
  return { installed: 1, removed: removed };
}
