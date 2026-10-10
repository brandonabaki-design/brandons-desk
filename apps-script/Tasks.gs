/**
 * Tasks.gs — task operations (list/add/update/complete/reopen/drop/move), dedupe and
 * newsletter auto-tagging. The google.script.run entry points in Api.gs wrap these
 * `_`-suffixed implementations with guard() and error handling.
 */

const TASK_PATCH_FIELDS_ = ['title', 'details', 'project', 'due', 'priority', 'link', 'newsletter', 'discuss', 'note', 'status'];

/** Converts a raw sheet row (array) into the Task object of SPEC section 5. */
function rowToTask(values, category, rowNumber) {
  const C = COLUMN.TASK;
  const status = str(values[C.status]).trim() || 'Open';
  return {
    id: str(values[C.id]).trim(),
    category: category,
    created: toDateString(values[C.created]),
    title: str(values[C.title]).trim(),
    details: unguardCell(str(values[C.details])),
    source: str(values[C.source]).trim(),
    link: str(values[C.link]).trim(),
    status: STATUSES.includes(status) ? status : 'Open',
    done: toDateString(values[C.done]),
    note: unguardCell(str(values[C.note])),
    project: str(values[C.project]).trim(),
    newsletter: cellBoolean_(values[C.newsletter]),
    discuss: cellBoolean_(values[C.discuss]),
    due: toDateString(values[C.due]),
    priority: PRIORITIES.includes(str(values[C.priority]).trim()) ? str(values[C.priority]).trim() : 'Normal',
    sourceKey: str(values[C.sourceKey]).trim(),
    updated: toDateTimeString(values[C.updated]),
    row: rowNumber || 0
  };
}

/** Converts a Task object into the 16-cell row (Dates for date cells, booleans for checkboxes). */
function taskToRow(task, now) {
  const C = COLUMN.TASK;
  const row = new Array(TASK_HEADERS.length).fill('');
  row[C.id] = task.id;
  row[C.created] = dateCell(task.created);
  row[C.title] = task.title;
  row[C.details] = task.details || '';
  row[C.source] = task.source || 'Manual';
  row[C.link] = task.link || '';
  row[C.status] = task.status || 'Open';
  row[C.done] = dateCell(task.done);
  row[C.note] = task.note || '';
  row[C.project] = task.project || '';
  row[C.newsletter] = !!task.newsletter;
  row[C.discuss] = !!task.discuss;
  row[C.due] = dateCell(task.due);
  row[C.priority] = task.priority || 'Normal';
  row[C.sourceKey] = task.sourceKey || '';
  row[C.updated] = isDateValue(now) ? now : new Date();
  return row;
}

function cellBoolean_(v) {
  if (typeof v === 'boolean') return v;
  const s = str(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

/** All tasks of a category as Task objects (raw rows; blank rows skipped). */
function readTasks(category) {
  guard();
  const tabName = taskTabName(category);
  const sheet = getTab(tabName);
  const cols = TASK_HEADERS.length;
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, cols).getValues();
  const out = [];
  values.forEach((cells, i) => {
    if (isBlankRow_(cells)) return;
    out.push(rowToTask(cells, tabName, i + 2));
  });
  return out;
}

/** Finds a task by id in a category; throws a user error when missing. */
function findTask(category, id) {
  guard();
  const wanted = str(id).trim();
  if (!wanted) throw userError('Task id required');
  const tasks = readTasks(category);
  const hit = tasks.find((t) => t.id === wanted);
  if (!hit) throw userError('Task not found: ' + wanted);
  return hit;
}

/**
 * Writes a Task back to its row with Updated = now and returns the refreshed Task. Only the
 * cells that differ from the sheet are written (writeRowChanges), so a Link cell Brandon
 * entered as =HYPERLINK("url","label") survives a tick, edit or reopen.
 */
function saveTask_(task) {
  const now = new Date();
  const tabName = taskTabName(task.category);
  if (!task.row) throw new Error('Task has no row');
  writeRowChanges(tabName, task.row, taskToRow(task, now));
  task.updated = formatDateTime(now);
  return task;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validTitle_(title) {
  const t = truncate(collapseWhitespace(title), TITLE_MAX);
  if (!t) throw userError('Title is required');
  return t;
}

function validDateOrBlank_(value, label) {
  if (value === null || value === undefined || value === '') return '';
  const s = toDateString(value);
  if (!s) throw userError((label || 'Date') + ' must be yyyy-MM-dd');
  return s;
}

function validPriority_(value) {
  const s = str(value).trim();
  if (!s) return 'Normal';
  const hit = PRIORITIES.find((p) => p.toLowerCase() === s.toLowerCase());
  if (!hit) throw userError('Priority must be High, Normal or Low');
  return hit;
}

function validStatus_(value) {
  const s = str(value).trim();
  if (!s) return 'Open';
  const hit = STATUSES.find((p) => p.toLowerCase() === s.toLowerCase());
  if (!hit) throw userError('Status must be Open, Done or Dropped');
  return hit;
}

function validSource_(value) {
  const s = str(value).trim();
  if (!s) return 'Manual';
  const hit = SOURCES.find((p) => p.toLowerCase() === s.toLowerCase());
  return hit || truncate(s, 40);
}

function validLink_(value) {
  const s = str(value).trim();
  if (!s) return '';
  const clean = sanitiseLink(s);
  if (!clean) throw userError('Link must start with http:// or https://');
  return clean;
}

function optionalBoolean_(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const s = str(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Create (shared by addTask, import and promoteInbox)
// ---------------------------------------------------------------------------

/**
 * Creates tasks from specs in one append. Each spec:
 * {title, details?, project?, due?, priority?, link?, newsletter?, discuss?, source?,
 *  created?, sourceKey?, status?, done?, note?, line?}.
 * Dedupe: same sourceKey (any status) or similar title among Open tasks → skipped with
 * reason 'duplicate' (and `task` = the existing one). Applies the newsletter auto-tag
 * when `newsletter` is undefined. Returns {added:[Task], skipped:[{line, reason, task?}]}.
 *
 * The read, the dedupe, the id generation and the append all happen under one script lock:
 * two overlapping calls (a double-tapped Promote, the trigger and "Run capture now") must not
 * both pass the Source-key check and append the same key twice (SPEC 3: unique when present).
 *
 * A Source key is unique across BOTH tabs (SPEC 3; capture and the Claude routines check
 * Work and Personal alike), so the key map holds the other tab's rows too and a known key
 * returns the task that already carries it whichever list it lives in. Title similarity
 * stays per tab.
 */
function createTasks(category, specs, options) {
  guard();
  const opts = options || {};
  const tabName = taskTabName(category);
  const config = opts.config || readConfig();
  return withLock(() => createTasksLocked_(tabName, specs, config));
}

function createTasksLocked_(tabName, specs, config) {
  const existing = readTasks(tabName);
  const ids = new Set(existing.map((t) => t.id).filter(Boolean));
  const openTasks = existing.filter((t) => t.status === 'Open');
  const byKey = new Map();
  CATEGORIES.filter((c) => c !== tabName).forEach((other) => {
    readTasks(other).forEach((t) => { if (t.sourceKey) byKey.set(t.sourceKey, t); });
  });
  existing.forEach((t) => { if (t.sourceKey) byKey.set(t.sourceKey, t); }); // this tab wins when both hold a key
  const today = todayDubai();
  const now = new Date();
  const added = [];
  const skipped = [];
  const rows = [];

  (specs || []).forEach((spec) => {
    const line = spec.line !== undefined ? str(spec.line) : str(spec.title);
    let title;
    try {
      title = validTitle_(spec.title);
    } catch (e) {
      skipped.push({ line: line, reason: 'title required' });
      return;
    }
    const sourceKey = truncate(str(spec.sourceKey).trim(), SOURCE_KEY_MAX);
    let dup = sourceKey ? byKey.get(sourceKey) : null;
    if (!dup) dup = openTasks.find((t) => isSimilarTitle(t.title, title)) || null;
    if (dup) {
      skipped.push({ line: line, reason: 'duplicate', task: dup });
      return;
    }
    const details = truncate(str(spec.details).trim(), DETAILS_MAX);
    const status = validStatus_(spec.status);
    const created = validDateOrBlank_(spec.created, 'Created') || today;
    const done = status === 'Done' ? (validDateOrBlank_(spec.done, 'Done') || created) : '';
    const nl = optionalBoolean_(spec.newsletter);
    const task = {
      id: newId(ID_PREFIX[tabName], ids),
      category: tabName,
      created: created,
      title: title,
      details: details,
      source: validSource_(spec.source),
      link: validLink_(spec.link),
      status: status,
      done: done,
      note: truncate(str(spec.note).trim(), NOTE_MAX),
      project: truncate(collapseWhitespace(spec.project), 80),
      newsletter: nl === undefined ? keywordHit(title + ' ' + details, config.NEWSLETTER_KEYWORDS) : nl,
      discuss: optionalBoolean_(spec.discuss) === true,
      due: validDateOrBlank_(spec.due, 'Due'),
      priority: validPriority_(spec.priority),
      sourceKey: sourceKey,
      updated: formatDateTime(now),
      row: 0
    };
    ids.add(task.id);
    if (task.status === 'Open') openTasks.push(task);
    if (task.sourceKey) byKey.set(task.sourceKey, task);
    rows.push(taskToRow(task, now));
    added.push(task);
  });

  if (rows.length) {
    const start = appendRows(tabName, rows);
    added.forEach((t, i) => { t.row = start + i; });
  }
  return { added: added, skipped: skipped };
}

// ---------------------------------------------------------------------------
// API implementations
// ---------------------------------------------------------------------------

/**
 * listTasks: {category?, status?, from?, to?, search?} → {tasks:[Task]}.
 * from/to filter on Created (non-Done) or Done (Done). Sorted overdue → due today →
 * High → others, then Created desc.
 */
function listTasks_(input) {
  const inp = input || {};
  const categories = inp.category ? [taskTabName(inp.category)] : CATEGORIES.slice();
  const status = inp.status ? validStatus_(inp.status) : '';
  const from = validDateOrBlank_(inp.from, 'From');
  const to = validDateOrBlank_(inp.to, 'To');
  const search = collapseWhitespace(inp.search).toLowerCase();
  const today = todayDubai();
  let tasks = [];
  categories.forEach((c) => { tasks = tasks.concat(readTasks(c)); });
  tasks = tasks.filter((t) => {
    if (status && t.status !== status) return false;
    const ref = t.status === 'Done' ? (t.done || t.created) : t.created;
    if (from && (!ref || ref < from)) return false;
    if (to && (!ref || ref > to)) return false;
    if (search) {
      const hay = [t.title, t.details, t.note, t.project].join(' ').toLowerCase();
      if (hay.indexOf(search) < 0) return false;
    }
    return true;
  });
  return { tasks: sortTasks(tasks, today) };
}

/** Rank 0 overdue, 1 due today, 2 High, 3 others (Open tasks only). */
function taskRank(task, today) {
  if (task.status !== 'Open') return 3;
  if (task.due && task.due < today) return 0;
  if (task.due && task.due === today) return 1;
  if (task.priority === 'High') return 2;
  return 3;
}

function sortTasks(tasks, today) {
  const t = today || todayDubai();
  return tasks.slice().sort((a, b) => {
    const ra = taskRank(a, t);
    const rb = taskRank(b, t);
    if (ra !== rb) return ra - rb;
    if (ra === 0 && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.created !== b.created) return a.created > b.created ? -1 : 1;
    return (b.row || 0) - (a.row || 0);
  });
}

/** Counts for the bootstrap payload. */
function taskCounts(tasks, today) {
  const t = today || todayDubai();
  const out = { open: 0, dueToday: 0, overdue: 0 };
  tasks.forEach((task) => {
    if (task.status !== 'Open') return;
    out.open++;
    if (task.due && task.due < t) out.overdue++;
    else if (task.due === t) out.dueToday++;
  });
  return out;
}

/**
 * addTask: {category, title, details?, project?, due?, priority?, link?, newsletter?,
 * discuss?, source?, created?, sourceKey?} → {task, duplicate}.
 */
function addTask_(input) {
  const inp = input || {};
  const category = taskTabName(inp.category);
  const title = validTitle_(inp.title);
  const spec = {
    title: title,
    details: inp.details,
    project: inp.project,
    due: inp.due,
    priority: inp.priority,
    link: inp.link,
    newsletter: inp.newsletter,
    discuss: inp.discuss,
    source: inp.source,
    created: inp.created,
    sourceKey: inp.sourceKey,
    status: inp.status,
    done: inp.done,
    note: inp.note
  };
  // Validate eagerly so bad input surfaces as a user error, not as a skipped spec.
  validDateOrBlank_(spec.due, 'Due');
  validDateOrBlank_(spec.created, 'Created');
  validPriority_(spec.priority);
  validLink_(spec.link);
  const result = createTasks(category, [spec]);
  if (result.added.length) return { task: result.added[0], duplicate: false };
  const skip = result.skipped[0];
  if (skip && skip.reason === 'duplicate') return { task: skip.task, duplicate: true };
  throw userError(skip ? skip.reason : 'Could not add task');
}

/** updateTask: {category, id, patch} → {task}. Whitelisted fields only. */
function updateTask_(input) {
  const inp = input || {};
  const task = findTask(inp.category, inp.id);
  const patch = inp.patch && typeof inp.patch === 'object' ? inp.patch : {};
  const today = todayDubai();
  TASK_PATCH_FIELDS_.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
    const v = patch[field];
    switch (field) {
      case 'title': task.title = validTitle_(v); break;
      case 'details': task.details = truncate(str(v).trim(), DETAILS_MAX); break;
      case 'project': task.project = truncate(collapseWhitespace(v), 80); break;
      case 'due': task.due = validDateOrBlank_(v, 'Due'); break;
      case 'priority': task.priority = validPriority_(v); break;
      case 'link': task.link = validLink_(v); break;
      case 'newsletter': task.newsletter = optionalBoolean_(v) === true; break;
      case 'discuss': task.discuss = optionalBoolean_(v) === true; break;
      case 'note': task.note = truncate(str(v).trim(), NOTE_MAX); break;
      case 'status': {
        const s = validStatus_(v);
        task.status = s;
        if (s === 'Done' && !task.done) task.done = today;
        if (s === 'Open') task.done = '';
        break;
      }
      default: break;
    }
  });
  return { task: saveTask_(task) };
}

/**
 * Appends a note segment ("existing · new"). A note that already ends with the same segment
 * (a retried or replayed call, the editor sending the note it was seeded with) is left alone.
 */
function appendNote_(existing, note) {
  const n = collapseWhitespace(note);
  if (!n) return str(existing);
  const e = str(existing).trim();
  if (e === n || e.endsWith(' · ' + n)) return e;
  return truncate(e ? e + ' · ' + n : n, NOTE_MAX);
}

/**
 * completeTask: {category, id, note?} → {task}. Status Done, Done = today (Dubai), Note
 * appended if given. A task that is already Done keeps its Done date (as updateTask's
 * status:Done path does), so a retried or stale call cannot move it into another agenda or
 * newsletter window.
 */
function completeTask_(input) {
  const inp = input || {};
  const task = findTask(inp.category, inp.id);
  if (task.status !== 'Done' || !task.done) task.done = todayDubai();
  task.status = 'Done';
  task.note = appendNote_(task.note, inp.note);
  return { task: saveTask_(task) };
}

const MOVED_NOTE_RE_ = /^Moved to ([WP]-[a-z0-9]{8})$/;

/**
 * reopenTask: {category, id} → {task}. Status Open, Done cleared. The Dropped original of a
 * move ("Moved to <id>") is refused while its copy still exists in the other tab: reopening it
 * would leave two live rows for one task, one of them without its Source key.
 */
function reopenTask_(input) {
  const inp = input || {};
  const task = findTask(inp.category, inp.id);
  const moved = MOVED_NOTE_RE_.exec(str(task.note).trim());
  if (moved && task.status === 'Dropped') {
    const copyTab = moved[1].charAt(0) === 'P' ? TABS.PERSONAL : TABS.WORK;
    if (copyTab !== task.category && readTasks(copyTab).some((t) => t.id === moved[1])) {
      throw userError('This task was moved to ' + moved[1] + ' (' + copyTab + '); reopen it there');
    }
  }
  task.status = 'Open';
  task.done = '';
  return { task: saveTask_(task) };
}

/** dropTask: {category, id, note?} → {task}. */
function dropTask_(input) {
  const inp = input || {};
  const task = findTask(inp.category, inp.id);
  task.status = 'Dropped';
  task.note = appendNote_(task.note, inp.note);
  return { task: saveTask_(task) };
}

/**
 * moveTask: {category, id, toCategory} → {task}. Copies the row to the other tab with a
 * new ID and marks the old row Dropped with Note "Moved to <newId>" (SPEC section 5; the
 * copy keeps the original note, status and Done date). A move is a copy, never a merge:
 * it bypasses createTasks' dedupe, so moving a task back to its original list (whose
 * Dropped row still carries the same title) or next to a similarly titled task always
 * creates a new row. The Dropped original gives up its Source key: the key lives only on
 * the live copy, so a later re-add, capture or move back never dedupes against the
 * "Moved to" row. Both writes happen under one lock acquisition.
 */
function moveTask_(input) {
  const inp = input || {};
  const fromTab = taskTabName(inp.category);
  const toTab = taskTabName(inp.toCategory);
  if (fromTab === toTab) throw userError('Task is already in ' + toTab);
  return withLock(() => moveTaskLocked_(fromTab, toTab, inp.id));
}

function moveTaskLocked_(fromTab, toTab, id) {
  const task = findTask(fromTab, id);
  const now = new Date();
  const targetIds = new Set(readTasks(toTab).map((t) => t.id).filter(Boolean));
  const copy = Object.assign({}, task, {
    id: newId(ID_PREFIX[toTab], targetIds),
    category: toTab,
    updated: formatDateTime(now),
    row: 0
  });
  copy.row = appendRows(toTab, [taskToRow(copy, now)]);
  task.status = 'Dropped';
  task.note = 'Moved to ' + copy.id;
  task.sourceKey = '';
  saveTask_(task);
  return { task: copy };
}
