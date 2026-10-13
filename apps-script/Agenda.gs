/**
 * Agenda.gs — week maths, agenda draft builder, rule-based questions, save/load of the
 * Agenda tab.
 */

const QUESTION_CAP_ = 8;

/**
 * Generated (column H) provenance (docs/AGENDA.md section 1): the tag on a line of the web app's own draft, and
 * the only text a save writes back as it came: "yyyy-MM-dd HH:mm[:ss] <tag>" for the three tags.
 */
const AGENDA_DRAFT_TAG = 'web-draft';
const AGENDA_TAG_RE_ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? (claude-desk|claude-review|web-draft)$/;
const AGENDA_CONFLICT_MESSAGE = "This agenda changed since you opened it (Claude's weekly review or another tab saved it). " +
  'Copy any edits you want to keep, then reload the agenda.';

/** Window for a meeting date: weekOf (Monday), from = meeting − 7, to = meeting − 1. */
function agendaWindow(meetingDate) {
  const md = toDateString(meetingDate);
  if (!md) throw userError('Meeting date must be yyyy-MM-dd');
  return { meetingDate: md, weekOf: mondayOf(md), from: addDays(md, -7), to: addDays(md, -1) };
}

/** Meeting date from input or the next MEETING_DAY on/after today. */
function resolveMeetingDate_(input, config) {
  const given = validDateOrBlank_(input && input.meetingDate, 'Meeting date');
  if (given) return given;
  return nextMeetingDate(todayDubai(), config.MEETING_DAY);
}

function inWindow_(dateStr, win) {
  return !!dateStr && dateStr >= win.from && dateStr <= win.to;
}

function updatedDate_(task) {
  return task.updated ? task.updated.slice(0, 10) : '';
}

function joinDetail_() {
  return Array.prototype.slice.call(arguments).map((x) => collapseWhitespace(x)).filter(Boolean).join(' · ');
}

function emptySections() {
  const out = {};
  AGENDA_SECTIONS.forEach((s) => { out[s] = []; });
  return out;
}

function agendaRow_(order, item, detail, link, taskId, generated) {
  return {
    order: order,
    item: truncate(collapseWhitespace(item), 300),
    detail: truncate(collapseWhitespace(detail), 1000),
    link: sanitiseLink(link),
    taskId: str(taskId).trim(),
    generated: str(generated).trim()
  };
}

function renumber_(rows) {
  return rows.map((r, i) => Object.assign({}, r, { order: i + 1 }));
}

/**
 * Builds the draft sections from Work tasks. Pure (tasks in, sections out). Every row is generated
 * "web-draft", so a line saved unchanged keeps that provenance (docs/AGENDA.md section 1).
 * @param {Array} tasks Work Task objects
 * @param {Object} win agendaWindow() result
 * @param {string} today yyyy-MM-dd
 */
function buildAgendaDraft(tasks, win, today) {
  const sections = emptySections();
  const t = today || todayDubai();
  const work = (tasks || []).filter((x) => x.category === 'Work' || !x.category);

  // Done: Status Done with Done date in the window, grouped by project then Done date.
  const done = work.filter((x) => x.status === 'Done' && inWindow_(x.done, win))
    .sort((a, b) => {
      const pa = a.project.toLowerCase();
      const pb = b.project.toLowerCase();
      if (pa !== pb) {
        if (!pa) return 1;
        if (!pb) return -1;
        return pa < pb ? -1 : 1;
      }
      if (a.done !== b.done) return a.done < b.done ? -1 : 1;
      return (a.row || 0) - (b.row || 0);
    });
  sections.Done = renumber_(done.map((x) => agendaRow_(0, x.title, joinDetail_(x.project, x.note), x.link, x.id, AGENDA_DRAFT_TAG)));

  // In progress: Open and (High, Discuss, Updated in window or Created in window).
  const progress = work.filter((x) => x.status === 'Open' &&
    (x.priority === 'High' || x.discuss || inWindow_(updatedDate_(x), win) || inWindow_(x.created, win)))
    .sort((a, b) => {
      const ha = a.priority === 'High' ? 0 : 1;
      const hb = b.priority === 'High' ? 0 : 1;
      if (ha !== hb) return ha - hb;
      if (a.due !== b.due) {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
      }
      if (a.created !== b.created) return a.created > b.created ? -1 : 1;
      return (a.row || 0) - (b.row || 0);
    });
  sections['In progress'] = renumber_(progress.map((x) => agendaRow_(0, x.title,
    joinDetail_(x.project, x.due ? 'due ' + x.due : '', x.priority === 'High' ? 'High' : '', x.discuss ? 'discuss' : '', x.note), x.link, x.id, AGENDA_DRAFT_TAG)));

  sections.Questions = renumber_(buildQuestions(work, win, t).map((q) => agendaRow_(0, q.text, q.detail, q.link, q.taskId, AGENDA_DRAFT_TAG)));

  // Documents: distinct links on Discuss-ticked tasks (Open or Done in window) and Done-in-window tasks.
  // Task.link comes from the sheet unsanitised; key and store the sanitised form so a non-http Link
  // never yields a Documents row with an empty link.
  const seen = new Set();
  const docs = [];
  work.forEach((x) => {
    const link = sanitiseLink(x.link);
    if (!link) return;
    const discussed = x.discuss && (x.status === 'Open' || (x.status === 'Done' && inWindow_(x.done, win)));
    const doneNow = x.status === 'Done' && inWindow_(x.done, win);
    if (!discussed && !doneNow) return;
    if (seen.has(link)) return;
    seen.add(link);
    docs.push(agendaRow_(0, x.title, joinDetail_(x.project, x.status === 'Done' ? 'done ' + x.done : ''), link, x.id, AGENDA_DRAFT_TAG));
  });
  sections.Documents = renumber_(docs);
  sections.Notes = [];
  return sections;
}

/**
 * Rule-based questions (SPEC 6a): each rule fires at most once, in order, max 8.
 * Returns [{rule, text, detail, link, taskId}].
 */
function buildQuestions(tasks, win, today) {
  const t = today || todayDubai();
  const work = (tasks || []).filter((x) => x.category === 'Work' || !x.category);
  const open = work.filter((x) => x.status === 'Open');
  const doneNow = work.filter((x) => x.status === 'Done' && inWindow_(x.done, win));
  const out = [];
  const used = new Set();
  const pick = (candidates) => {
    if (!candidates.length) return null;
    return candidates.find((c) => !used.has(c.id)) || candidates[0];
  };
  const push = (rule, task, text) => {
    if (out.length >= QUESTION_CAP_) return;
    if (task) used.add(task.id);
    out.push({ rule: rule, text: text, detail: task ? joinDetail_(task.project, task.note) : '', link: task ? task.link : '', taskId: task ? task.id : '' });
  };

  // 1. Overdue open task.
  const overdue = open.filter((x) => x.due && x.due < t).sort((a, b) => (a.due < b.due ? -1 : 1));
  const q1 = pick(overdue);
  if (q1) push(1, q1, '«' + q1.title + '» is overdue (due ' + q1.due + '). Still a priority, or should the date move?');

  // 2. Open > 14 days, not updated in 7.
  const stale = open.filter((x) => x.created && daysBetween(x.created, t) > 14 &&
    (!updatedDate_(x) || daysBetween(updatedDate_(x), t) > 7))
    .sort((a, b) => (a.created < b.created ? -1 : 1));
  const q2 = pick(stale);
  if (q2) push(2, q2, '«' + q2.title + '» has been open since ' + q2.created + ". What's blocking it, and is it still mine?");

  // 3. Discuss-ticked task.
  const discuss = work.filter((x) => x.discuss && (x.status === 'Open' || (x.status === 'Done' && inWindow_(x.done, win))))
    .sort((a, b) => (a.row || 0) - (b.row || 0));
  const q3 = pick(discuss);
  if (q3) push(3, q3, q3.title + ': ' + (collapseWhitespace(q3.note) || collapseWhitespace(q3.details) || 'what do you need from me on this?'));

  // 4. ≥ 3 Done tasks in one project this window.
  const byProject = Object.create(null); // project names are user text: "constructor" must not hit Object.prototype
  doneNow.forEach((x) => { if (x.project) byProject[x.project] = (byProject[x.project] || 0) + 1; });
  const busy = Object.keys(byProject).filter((p) => byProject[p] >= 3).sort((a, b) => byProject[b] - byProject[a]);
  if (busy.length) push(4, null, busy[0] + ': ' + byProject[busy[0]] + ' items closed this week. Should this be in the Hub newsletter or shared with staff?');

  // 5. Done tasks with Newsletter ticked (SPEC 6a fixed template: "{n} items", also when n is 1).
  const nl = doneNow.filter((x) => x.newsletter);
  if (nl.length) push(5, null, 'The newsletter draft includes ' + nl.length + " items. Is there anything you'd like added or held back?");

  // 6. Calendar-sourced task due within 7 days.
  const horizon = addDays(t, 7);
  const upcoming = open.filter((x) => x.source === 'Calendar' && x.due && x.due >= t && x.due <= horizon)
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  const q6 = pick(upcoming);
  if (q6) push(6, q6, '«' + q6.title + '» is coming up on ' + q6.due + '. Anything you want me to prepare?');

  // 7. High priority without a due date.
  const undated = open.filter((x) => x.priority === 'High' && !x.due).sort((a, b) => (a.row || 0) - (b.row || 0));
  const q7 = pick(undated);
  if (q7) push(7, q7, '«' + q7.title + '» is marked high priority but has no date. When do you need it by?');

  // 8. Always last.
  if (out.length >= QUESTION_CAP_) out.length = QUESTION_CAP_ - 1;
  push(8, null, 'Anything from your side that should go on my list for next week?');
  return out;
}

// ---------------------------------------------------------------------------
// Agenda tab
// ---------------------------------------------------------------------------

/** The Agenda rows whose Week of is weekOf (as Date or yyyy-MM-dd text), in sheet order, whatever their Section. */
function agendaWeekRows_(weekOf) {
  return readRows(TABS.AGENDA).filter((r) => toDateString(r.weekOf) === weekOf);
}

/**
 * A Generated cell as text (docs/AGENDA.md section 2): a Date as yyyy-MM-dd HH:mm:ss in the configured
 * zone (Asia/Dubai), anything else as its text, trimmed. Read only: column H is never healed or reformatted.
 */
function agendaGeneratedText_(v) {
  if (isDateValue(v)) return formatDate(v, 'yyyy-MM-dd HH:mm:ss');
  return unguardCell(str(v)).trim();
}

/**
 * Fingerprint of one week's rows as the sheet holds them (docs/AGENDA.md section 2, stale-save protection):
 * every row of that Week of in sheet order (all sections), each as section, order, item, detail, link, task ID
 * and generated text, plus the row count. A short hex string that changes whenever one of those rows does;
 * other weeks' rows and row numbers do not count.
 */
function agendaStamp_(rows) {
  const parts = [String(rows.length)];
  rows.forEach((r) => {
    parts.push([r.section, r.order, r.item, r.detail, r.link, r.taskId].map((v) => str(v)).concat(agendaGeneratedText_(r.generated)).join('\u001f'));
  });
  return sha1Hex(parts.join('\u001e')).slice(0, 16);
}

/** Saved rows for a weekOf, as sections (each row with its generated text), and the week's stamp. */
function readSavedSections_(weekOf) {
  const sections = emptySections();
  let any = false;
  const week = agendaWeekRows_(weekOf);
  week.forEach((r) => {
    const section = str(r.section).trim();
    if (!AGENDA_SECTIONS.includes(section)) return;
    any = true;
    sections[section].push({
      order: Number(r.order) || 0,
      item: unguardCell(str(r.item)),
      detail: unguardCell(str(r.detail)),
      link: sanitiseLink(r.link),
      taskId: str(r.taskId).trim(),
      generated: agendaGeneratedText_(r.generated),
      row: r.row
    });
  });
  AGENDA_SECTIONS.forEach((s) => {
    sections[s].sort((a, b) => (a.order - b.order) || (a.row - b.row));
    sections[s] = renumber_(sections[s].map((x) => agendaRow_(x.order, x.item, x.detail, x.link, x.taskId, x.generated)));
  });
  return { sections: sections, any: any, stamp: agendaStamp_(week) };
}

function agendaResult_(win, saved, sections, stamp) {
  return {
    meetingDate: win.meetingDate,
    weekOf: win.weekOf,
    window: { from: win.from, to: win.to },
    saved: !!saved,
    sections: sections,
    stamp: stamp
  };
}

/** getAgenda: {meetingDate?} → saved rows for that week, or a draft; either way with the week's stamp. */
function getAgenda_(input) {
  const config = readConfig();
  const win = agendaWindow(resolveMeetingDate_(input, config));
  const saved = readSavedSections_(win.weekOf);
  if (saved.any) return agendaResult_(win, true, saved.sections, saved.stamp);
  const tasks = readTasks(TABS.WORK);
  return agendaResult_(win, false, buildAgendaDraft(tasks, win, todayDubai()), saved.stamp);
}

/** regenerateAgenda: {meetingDate} → draft rebuilt from tasks, keeping saved Questions and Notes (with their generated). */
function regenerateAgenda_(input) {
  const config = readConfig();
  const win = agendaWindow(resolveMeetingDate_(input, config));
  const saved = readSavedSections_(win.weekOf);
  const draft = buildAgendaDraft(readTasks(TABS.WORK), win, todayDubai());
  if (saved.sections.Questions.length) draft.Questions = saved.sections.Questions;
  if (saved.sections.Notes.length) draft.Notes = saved.sections.Notes;
  return agendaResult_(win, false, draft, saved.stamp);
}

/**
 * Validates and normalises a sections payload into [{section, order, item, detail, link, taskId, generated}].
 * `generated` is the client's value as sent (a string, else ''); agendaGeneratedCell_ decides what column H gets.
 */
function normaliseSections_(sections) {
  if (!sections || typeof sections !== 'object') throw userError('Sections required');
  const rows = [];
  AGENDA_SECTIONS.forEach((section) => {
    const list = Array.isArray(sections[section]) ? sections[section] : [];
    list.forEach((r, i) => {
      if (!r || typeof r !== 'object') return;
      const item = collapseWhitespace(r.item);
      if (!item) return;
      rows.push({
        section: section,
        order: Number(r.order) > 0 ? Number(r.order) : i + 1,
        item: truncate(item, 300),
        detail: truncate(collapseWhitespace(r.detail), 1000),
        link: sanitiseLink(r.link),
        taskId: truncate(str(r.taskId).trim(), TASK_ID_MAX),
        generated: typeof r.generated === 'string' ? r.generated : ''
      });
    });
  });
  // Renumber within each section by the given order, and write rows section by section in that order.
  AGENDA_SECTIONS.forEach((section) => {
    rows.filter((r) => r.section === section).sort((a, b) => a.order - b.order).forEach((r, i) => { r.order = i + 1; });
  });
  rows.sort((a, b) => (AGENDA_SECTIONS.indexOf(a.section) - AGENDA_SECTIONS.indexOf(b.section)) || (a.order - b.order));
  return rows;
}

/**
 * Column H for a saved row (docs/AGENDA.md section 2). A provenance tag as the sheet held it
 * ("yyyy-MM-dd HH:mm[:ss] claude-desk|claude-review|web-draft") is written back exactly; the bare
 * "web-draft" of an unchanged draft line becomes "<save time yyyy-MM-dd HH:mm> web-draft"; anything
 * else is Brandon's line and gets the save time as a Date. No other client value reaches the cell.
 */
function agendaGeneratedCell_(generated, now, draftText) {
  if (typeof generated === 'string') {
    if (AGENDA_TAG_RE_.test(generated)) return generated;
    if (generated === AGENDA_DRAFT_TAG) return draftText;
  }
  return now;
}

/**
 * saveAgenda: {meetingDate, sections, stamp?} → {ok:true, rows:n, stamp}. Replaces that week's rows.
 *
 * Only the rows whose Week of is this weekOf are touched: they are deleted (bottom-up, as
 * contiguous runs) and the new rows are appended through appendRows(). Other weeks' rows,
 * whether saved here, written by the Claude agenda routine or edited by hand, are never read
 * back and rewritten, so a cell that holds the literal text "=…" can never be turned into a
 * live formula, a =HYPERLINK() or rich-text link in another week keeps its formula, and a
 * failing write cannot wipe the tab (there is no clear-everything step).
 *
 * Stale-save protection: with a `stamp` (the one getAgenda / regenerateAgenda / the last save
 * returned), the week's stamp is recomputed from the sheet inside the lock before anything is
 * deleted; when they differ (a Claude routine or another tab wrote the week since) nothing is
 * written and the user error AGENDA_CONFLICT_MESSAGE is thrown. Without one it saves as before.
 * The returned stamp is the week's as written, re-read under the same lock. The routines write through the Sheets connector
 * without the lock, so when the re-read finds more (or fewer) rows than were written, the returned stamp is 'changed': it
 * matches no week, and the next save from that page is refused until the agenda is reloaded (and shows the routine's rows).
 */
function saveAgenda_(input) {
  const inp = input || {};
  const win = agendaWindow(validDateOrBlank_(inp.meetingDate, 'Meeting date') || resolveMeetingDate_(inp, readConfig()));
  const rows = normaliseSections_(inp.sections);
  const now = new Date();
  const draftText = formatDate(now, 'yyyy-MM-dd HH:mm') + ' ' + AGENDA_DRAFT_TAG;
  const weekOfCell = dateCell(win.weekOf);
  const C = COLUMN.AGENDA;
  const cols = HEADERS.Agenda.length;
  const newRows = rows.map((r) => {
    const cells = new Array(cols).fill('');
    cells[C.weekOf] = weekOfCell;
    cells[C.section] = r.section;
    cells[C.order] = r.order;
    cells[C.item] = r.item;
    cells[C.detail] = r.detail;
    cells[C.link] = r.link;
    cells[C.taskId] = r.taskId;
    cells[C.generated] = agendaGeneratedCell_(r.generated, now, draftText);
    return cells.map(guardCell); // item/detail are user text: never a formula
  });
  let stamp = '';
  withLock(() => {
    if (typeof inp.stamp === 'string' && agendaStamp_(agendaWeekRows_(win.weekOf)) !== inp.stamp) {
      log('saveAgenda', 'WARN', 'week of ' + win.weekOf + ': not saved, the week changed since it was opened');
      throw userError(AGENDA_CONFLICT_MESSAGE);
    }
    const sheet = getTab(TABS.AGENDA);
    deleteAgendaWeek_(sheet, win.weekOf);
    appendRows(TABS.AGENDA, newRows);
    const after = agendaWeekRows_(win.weekOf);
    stamp = after.length === newRows.length ? agendaStamp_(after) : 'changed'; // a routine wrote the week mid-save: the next save must reload first
    if (stamp === 'changed') log('saveAgenda', 'WARN', 'week of ' + win.weekOf + ': changed during the save (' + newRows.length + ' row(s) written, ' + after.length + ' read back)');
  });
  log('saveAgenda', 'INFO', 'week of ' + win.weekOf + ': ' + rows.length + ' row(s) saved');
  return { ok: true, rows: rows.length, stamp: stamp };
}

/** Deletes the Agenda rows whose Week of equals weekOf (as Date or yyyy-MM-dd text), bottom-up in contiguous runs. */
function deleteAgendaWeek_(sheet, weekOf) {
  const C = COLUMN.AGENDA;
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const weekCells = sheet.getRange(2, C.weekOf + 1, last - 1, 1).getValues();
  const doomed = [];
  weekCells.forEach((cells, i) => {
    if (toDateString(cells[0]) === weekOf) doomed.push(i + 2);
  });
  if (!doomed.length) return 0;
  // Sheets refuses to delete every non-frozen row: keep at least one spare row below the header.
  if (sheet.getMaxRows() - doomed.length < 2) sheet.insertRowsAfter(sheet.getMaxRows(), 2);
  let i = doomed.length - 1;
  while (i >= 0) {
    let j = i;
    while (j - 1 >= 0 && doomed[j - 1] === doomed[j] - 1) j--;
    sheet.deleteRows(doomed[j], i - j + 1);
    i = j - 1;
  }
  return doomed.length;
}
