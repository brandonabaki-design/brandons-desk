/**
 * Sheet.gs — spreadsheet access: open/ensure tabs, row <-> object mapping, healSheet,
 * append/update under LockService.
 */

let SPREADSHEET_MEMO_ = null;
let LOCK_DEPTH_ = 0;

/** Clears per-execution memos (used after setup() changes SHEET_ID, and by tests). */
function resetMemos() {
  SPREADSHEET_MEMO_ = null;
  clearConfigMemo();
}

/** The spreadsheet named by SHEET_ID (memoised per execution). */
function openSpreadsheet() {
  if (!SPREADSHEET_MEMO_) {
    SPREADSHEET_MEMO_ = SpreadsheetApp.openById(getSheetId());
  }
  return SPREADSHEET_MEMO_;
}

/** A tab by name; creates it with headers when it is missing. */
function getTab(name) {
  if (!Object.prototype.hasOwnProperty.call(HEADERS, name)) throw new Error('Unknown tab: ' + name);
  const ss = openSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ensureTab_(ss, name).sheet;
  }
  return sheet;
}

/** The 0-based column map for a tab. */
function columnMapFor(tabName) {
  const key = TAB_COLUMNS[tabName];
  if (!key) throw new Error('Unknown tab: ' + tabName);
  return COLUMN[key];
}

/** Number of columns a tab uses. */
function columnCount(tabName) {
  return HEADERS[tabName].length;
}

/**
 * Every data row of a tab as an object keyed by its column map plus `row` (1-based sheet
 * row). Fully blank rows are skipped. Cell values are returned raw (Date, boolean, …).
 *
 * Public helpers that read or write sheet data run guard() first (SPEC 7): Apps Script
 * exposes every non-underscore global to google.script.run, so the ALLOWED_EMAILS check must
 * not depend on the caller going through Api.gs.
 */
function readRows(tabName) {
  guard();
  return readRows_(tabName);
}

function readRows_(tabName) {
  return readSheetRows_(getTab(tabName), tabName);
}

function readSheetRows_(sheet, tabName) {
  const map = columnMapFor(tabName);
  const cols = columnCount(tabName);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, cols).getValues();
  const out = [];
  values.forEach((cells, i) => {
    if (isBlankRow_(cells)) return;
    const obj = { row: i + 2 };
    Object.keys(map).forEach((key) => {
      const v = cells[map[key]];
      obj[key] = v === undefined || v === null ? '' : v;
    });
    out.push(obj);
  });
  return out;
}

function isBlankRow_(cells) {
  return cells.every((v) => v === '' || v === null || v === undefined || v === false);
}

/** Runs fn while holding the script lock (re-entrant within one execution). */
function withLock(fn) {
  if (LOCK_DEPTH_ > 0) return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  LOCK_DEPTH_++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH_--;
    lock.releaseLock();
  }
}

/** Writes one full row (array of cell values) at a 1-based sheet row. */
function writeRow(tabName, rowNumber, values) {
  guard();
  const sheet = getTab(tabName);
  const cols = columnCount(tabName);
  const row = padRow_(values, cols);
  return withLock(() => {
    sheet.getRange(rowNumber, 1, 1, cols).setValues([row]);
    return rowNumber;
  });
}

/**
 * Writes only the cells of a row that differ from what the sheet holds now, as one
 * setValues() per run of changed columns, and returns how many cells were written.
 * getValues() returns the computed value of a formula cell (a =HYPERLINK("url","label") in
 * Link reads as "label"), so rewriting the whole row would replace such a formula by its
 * label; an unchanged cell is left alone and keeps its formula or rich text.
 */
function writeRowChanges(tabName, rowNumber, values) {
  guard();
  const sheet = getTab(tabName);
  const cols = columnCount(tabName);
  const row = padRow_(values, cols);
  return withLock(() => {
    const current = sheet.getRange(rowNumber, 1, 1, cols).getValues()[0];
    const changed = [];
    for (let c = 0; c < cols; c++) {
      if (!cellEquals_(current[c], row[c])) changed.push(c);
    }
    let i = 0;
    let written = 0;
    while (i < changed.length) {
      let j = i;
      while (j + 1 < changed.length && changed[j + 1] === changed[j] + 1) j++;
      const first = changed[i];
      const count = changed[j] - first + 1;
      sheet.getRange(rowNumber, first + 1, 1, count).setValues([row.slice(first, first + count)]);
      written += count;
      i = j + 1;
    }
    return written;
  });
}

/** Writes selected cells of a row: `patch` maps column index → value. */
function writeCells(tabName, rowNumber, patch) {
  guard();
  const sheet = getTab(tabName);
  return withLock(() => {
    Object.keys(patch).forEach((col) => {
      sheet.getRange(rowNumber, Number(col) + 1, 1, 1).setValue(guardCell(patch[col]));
    });
    return rowNumber;
  });
}

/**
 * Last row holding content, ignoring rows whose cells are all blank or FALSE. A tab whose
 * checkbox columns were pre-filled down the sheet makes getLastRow() point at the last
 * checkbox, hundreds of rows below the last task; this walks up to the real last row.
 * Never below 1 (the header row).
 */
function lastDataRow_(sheet, cols) {
  const last = sheet.getLastRow();
  if (last < 2) return 1;
  const values = sheet.getRange(2, 1, last - 1, cols).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (!isBlankRow_(values[i])) return i + 2;
  }
  return 1;
}

/** Appends rows (arrays) in one write; returns the first new row number (0 when nothing). */
function appendRows(tabName, rows) {
  guard();
  if (!rows || !rows.length) return 0;
  const sheet = getTab(tabName);
  const cols = columnCount(tabName);
  const padded = rows.map((r) => padRow_(r, cols));
  return withLock(() => {
    const start = lastDataRow_(sheet, cols) + 1;
    const needed = start + padded.length - 1;
    if (sheet.getMaxRows() < needed) {
      sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
    }
    sheet.getRange(start, 1, padded.length, cols).setValues(padded);
    return start;
  });
}

/** Removes a single row (used by selfTest cleanup only). */
function deleteRowNumber(tabName, rowNumber) {
  guard();
  const sheet = getTab(tabName);
  return withLock(() => {
    sheet.deleteRow(rowNumber);
    return true;
  });
}

/** Pads a row to `cols` cells ('' for null/undefined) and applies the formula guard to every string. */
function padRow_(values, cols) {
  const row = [];
  for (let i = 0; i < cols; i++) {
    const v = values[i];
    row.push(v === undefined || v === null ? '' : guardCell(v));
  }
  return row;
}

// ---------------------------------------------------------------------------
// healSheet
// ---------------------------------------------------------------------------

/**
 * Fills blanks that other writers (Claude routines) may leave in a task tab: ID, Created,
 * Status, Priority, Updated (Work and Personal only: taskTabName() refuses any other tab, so the
 * Desk, Inbox, Agenda, Config and Log tabs are never touched). Trims whitespace, turns
 * date-like strings into Dates and TRUE/FALSE strings into booleans. Logs what it fixed.
 * Returns {fixed, details}.
 *
 * The common case (nothing to fix) is a plain unlocked read. When something needs fixing the
 * tab is re-read and re-scanned under the script lock before writing, so two executions that
 * heal at the same time (getBootstrap and listTasks run in parallel on every boot) cannot
 * invent different IDs for the same blank-ID row and overwrite each other.
 */
function healSheet(category) {
  guard();
  const tabName = taskTabName(category);
  const sheet = getTab(tabName);
  const cols = TASK_HEADERS.length;
  const result = { fixed: 0, details: {} };
  const probe = scanTaskRows_(sheet, tabName, cols);
  if (!probe.changedRows.length) return result;
  return withLock(() => {
    const scan = scanTaskRows_(sheet, tabName, cols);
    if (!scan.changedRows.length) return result;
    writeRowRuns_(sheet, scan.values, scan.changedRows, cols, scan.formulas, scan.original);
    result.fixed = scan.changedRows.length;
    result.details = scan.counts;
    const summary = Object.keys(scan.counts).map((k) => k + ' ' + scan.counts[k]).join(', ');
    log('healSheet', 'INFO', tabName + ': fixed ' + scan.changedRows.length + ' row(s): ' + summary);
    if (scan.warnings.length) log('healSheet', 'WARN', tabName + ': ' + scan.warnings.join('; '));
    return result;
  });
}

/**
 * Writes the healed cells back: for every changed row, only the cells that differ from what
 * the sheet held (as writeRowChanges does), one setValues() per run of consecutive changed
 * columns. A cell the heal did not touch is never rewritten, so a Link or Title that holds a
 * rich-text hyperlink (Insert → Link in the sheet reads through getValues() as its plain label)
 * keeps its link, and a formula cell keeps its formula. Strings get the formula guard.
 */
function writeRowRuns_(sheet, values, changedRows, cols, formulas, original) {
  changedRows.slice().sort((a, b) => a - b).forEach((r) => {
    const f = (formulas && formulas[r]) || [];
    const before = (original && original[r]) || [];
    const changed = [];
    for (let c = 0; c < cols; c++) {
      if (f[c]) continue; // scanTaskRows_ leaves formula cells alone
      if (!cellEquals_(before[c], guardCell(values[r][c]))) changed.push(c);
    }
    let i = 0;
    while (i < changed.length) {
      let j = i;
      while (j + 1 < changed.length && changed[j + 1] === changed[j] + 1) j++;
      const first = changed[i];
      const count = changed[j] - first + 1;
      sheet.getRange(r + 2, first + 1, 1, count).setValues([values[r].slice(first, first + count).map(guardCell)]);
      i = j + 1;
    }
  });
}

/**
 * Reads a task tab and computes the healed rows in memory.
 * Returns {values, changedRows (0-based indexes into values), counts, formulas, warnings,
 * original (the cells as read, so the writer can diff them)}.
 * A cell that holds a formula (a =HYPERLINK in Link, say) is carried as that formula and
 * left alone, so a heal of the row never replaces it by its display value.
 */
function scanTaskRows_(sheet, tabName, cols) {
  const C = COLUMN.TASK;
  const last = sheet.getLastRow();
  if (last < 2) return { values: [], changedRows: [], counts: {}, formulas: [], warnings: [], original: [] };
  const range = sheet.getRange(2, 1, last - 1, cols);
  const values = range.getValues();
  const original = values.map((row) => row.slice());
  const formulas = range.getFormulas();
  const ids = new Set();
  values.forEach((row) => {
    const id = str(row[C.id]).trim();
    if (id) ids.add(id);
  });
  const prefix = ID_PREFIX[tabName];
  const todayStr = todayDubai();
  const today = dateCell(todayStr);
  const now = new Date();
  const changedRows = [];
  const counts = {};
  const warnings = [];
  const bump = (what) => { counts[what] = (counts[what] || 0) + 1; };

  values.forEach((row, i) => {
    if (isBlankRow_(row)) return;
    const f = formulas[i] || [];
    const isFormula = (c) => !!f[c];
    for (let c = 0; c < cols; c++) {
      if (isFormula(c)) row[c] = f[c];
    }
    let changed = false;
    const where = () => tabName + ' row ' + (i + 2) + (str(row[C.id]).trim() ? ' (' + str(row[C.id]).trim() + ')' : '');
    for (let c = 0; c < cols; c++) {
      if (isFormula(c) || typeof row[c] !== 'string') continue;
      const trimmed = row[c].trim();
      // The space guardCell puts before "=" is not whitespace to remove: compare the guarded form.
      if (guardCell(trimmed) !== row[c]) { changed = true; bump('whitespace'); }
      row[c] = trimmed;
    }
    if (!str(row[C.id])) {
      const id = newId(prefix, ids);
      ids.add(id);
      row[C.id] = id; changed = true; bump('id');
    }
    [C.created, C.done, C.due].forEach((c) => {
      if (isFormula(c)) return;
      if (typeof row[c] === 'string' && row[c] !== '') {
        const d = dateCell(row[c]);
        if (d) {
          row[c] = d; changed = true; bump('dateType');
        } else {
          // Unparseable text in a date column reads as blank through the API, and the first write would
          // blank the cell silently; make the sheet say what the app sees and name the row in the Log.
          warnings.push(where() + ': ' + TASK_HEADERS[c] + ' "' + truncate(row[c], 40) + '" is not a date, ' +
            (c === C.created ? 'set to today' : 'cleared'));
          row[c] = ''; changed = true; bump('badDate');
        }
      }
    });
    if (!isFormula(C.created) && (row[C.created] === '' || row[C.created] === null)) { row[C.created] = today; changed = true; bump('created'); }
    if (!str(row[C.status])) { row[C.status] = 'Open'; changed = true; bump('status'); }
    if (!str(row[C.priority])) { row[C.priority] = 'Normal'; changed = true; bump('priority'); }
    // Status Done with no Done date (the sheet's dropdown, or a routine row): the agenda and the
    // newsletter key on Done, so fill it from the Updated cell's date, else today.
    if (!isFormula(C.done) && str(row[C.status]).trim() === 'Done' && (row[C.done] === '' || row[C.done] === null)) {
      const upd = isFormula(C.updated) ? null : parseDate(row[C.updated]);
      row[C.done] = dateCell(upd ? formatDate(upd) : todayStr); changed = true; bump('done');
    }
    [C.newsletter, C.discuss].forEach((c) => {
      if (isFormula(c)) return;
      if (typeof row[c] !== 'boolean') {
        const s = str(row[c]).trim().toLowerCase();
        row[c] = s === 'true' || s === 'yes' || s === '1';
        changed = true; bump('checkbox');
      }
    });
    if (!isFormula(C.updated)) {
      if (typeof row[C.updated] === 'string' && row[C.updated] !== '') {
        const d = parseDate(row[C.updated]);
        if (d) {
          row[C.updated] = d; changed = true; bump('dateType');
        } else {
          warnings.push(where() + ': Updated "' + truncate(row[C.updated], 40) + '" is not a date, set to now');
          row[C.updated] = ''; changed = true; bump('badDate');
        }
      }
      if (row[C.updated] === '' || row[C.updated] === null) { row[C.updated] = now; changed = true; bump('updated'); }
    }
    if (changed) changedRows.push(i);
  });
  return { values: values, changedRows: changedRows, counts: counts, formulas: formulas, warnings: warnings, original: original };
}

/** 'Work' | 'Personal' for a category (throws a user error otherwise). */
function taskTabName(category) {
  const c = str(category).trim();
  const hit = CATEGORIES.find((x) => x.toLowerCase() === c.toLowerCase());
  if (!hit) throw userError('Category must be Work or Personal');
  return hit;
}

// ---------------------------------------------------------------------------
// ensureSchema
// ---------------------------------------------------------------------------

/**
 * Creates any missing tab with the exact headers, validations, date formats and
 * conditional formatting; verifies the header row of existing tabs.
 * Returns {created:[tab], warnings:[string]}.
 */
function ensureSchema(spreadsheet) {
  guard();
  const ss = spreadsheet || openSpreadsheet();
  const created = [];
  const warnings = [];
  TAB_ORDER.forEach((name) => {
    const r = ensureTab_(ss, name);
    if (r.created) created.push(name);
    if (r.warning) warnings.push(r.warning);
  });
  return { created: created, warnings: warnings };
}

function ensureTab_(ss, name) {
  const headers = HEADERS[name];
  let sheet = ss.getSheetByName(name);
  let created = false;
  let warning = '';
  if (!sheet) {
    const spare = spareDefaultSheet_(ss);
    if (spare) {
      spare.setName(name);
      sheet = spare;
    } else {
      sheet = ss.insertSheet(name);
    }
    created = true;
  }
  const firstCell = sheet.getLastRow() >= 1 ? sheet.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  const hasHeader = firstCell.some((v) => str(v).trim() !== '');
  if (!hasHeader) {
    withLock(() => {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
      applyTabFormatting_(sheet, name);
    });
    created = true;
  } else {
    const actual = firstCell.map((v) => str(v).trim());
    const mismatch = headers.some((h, i) => actual[i] !== h);
    if (mismatch) {
      warning = name + ': header row differs from the schema (' + actual.join(' | ') + ')';
    }
    // The live sheet pre-dates setup(): give its text columns the plain-text format too (idempotent).
    withLock(() => { applyTextFormats_(sheet, name); });
  }
  try {
    if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  } catch (e) {
    // some mocks/environments may not support it; not fatal
  }
  return { sheet: sheet, created: created, warning: warning };
}

/** A blank default "Sheet1" that can be renamed instead of inserting a new tab. */
function spareDefaultSheet_(ss) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const n = s.getName();
    if (!Object.prototype.hasOwnProperty.call(HEADERS, n) && /^Sheet\d*$/i.test(n) && s.getLastRow() === 0) {
      return s;
    }
  }
  return null;
}

function listValidation_(values, strict) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(!strict)
    .build();
}

function checkboxValidation_() {
  return SpreadsheetApp.newDataValidation().requireCheckbox().build();
}

function dataRows_(sheet) {
  return Math.max(sheet.getMaxRows() - 1, 1);
}

/** 0-based indexes of the free-text columns of a tab (everything that is not a date, number, boolean or enum). */
function textColumns_(name) {
  const T = COLUMN.TASK;
  const I = COLUMN.INBOX;
  const A = COLUMN.AGENDA;
  switch (name) {
    case TABS.WORK:
    case TABS.PERSONAL: return [T.title, T.details, T.source, T.link, T.note, T.project, T.sourceKey];
    case TABS.INBOX: return [I.from, I.subject, I.snippet, I.link, I.sourceKey, I.taskId];
    case TABS.AGENDA: return [A.item, A.detail, A.link, A.taskId];
    case TABS.CONFIG: return [COLUMN.CONFIG.value];
    case TABS.LOG: return [COLUMN.LOG.message];
    // docs/DESK.md 1: column B (JSON) is plain text so a cell is never parsed as a number or a
    // formula; Built (C) too, so "2026-10-13 06:45" reads back exactly as the routine wrote it.
    case TABS.DESK: return [COLUMN.DESK.json, COLUMN.DESK.built];
    default: return [];
  }
}

/**
 * Plain-text number format ('@') on the free-text columns. Range.setValue(s) and appendRow
 * write strings with user-entered semantics: a Chat message or mail subject that is just
 * "10/12", "1-2", "3.50", "007" or "+971501234567" would otherwise land as a Date or a number
 * and read back as "2026-10-12T00:00:00+04:00", 3.5 or 7. With '@' on the column the string
 * is stored as typed. Idempotent; also run on existing tabs by ensureTab_.
 */
function applyTextFormats_(sheet, name) {
  const rows = dataRows_(sheet);
  textColumns_(name).forEach((idx) => {
    sheet.getRange(2, idx + 1, rows, 1).setNumberFormat('@');
  });
}

function applyTabFormatting_(sheet, name) {
  const headers = HEADERS[name];
  const header = sheet.getRange(1, 1, 1, headers.length);
  header.setFontWeight('bold').setBackground('#21076C').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  const rows = dataRows_(sheet);
  const col = (idx) => sheet.getRange(2, idx + 1, rows, 1);
  applyTextFormats_(sheet, name);
  if (name === TABS.WORK || name === TABS.PERSONAL) {
    const C = COLUMN.TASK;
    col(C.source).setDataValidation(listValidation_(SOURCES, false));
    col(C.status).setDataValidation(listValidation_(STATUSES, true));
    col(C.priority).setDataValidation(listValidation_(PRIORITIES, true));
    col(C.newsletter).setDataValidation(checkboxValidation_());
    col(C.discuss).setDataValidation(checkboxValidation_());
    col(C.created).setNumberFormat('yyyy-mm-dd');
    col(C.done).setNumberFormat('yyyy-mm-dd');
    col(C.due).setNumberFormat('yyyy-mm-dd');
    col(C.updated).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.setColumnWidth(C.title + 1, 320);
    sheet.setColumnWidth(C.details + 1, 320);
    sheet.setColumnWidth(C.link + 1, 160);
    sheet.setColumnWidth(C.note + 1, 220);
    sheet.setColumnWidth(C.project + 1, 150);
    applyTaskConditionalFormats_(sheet, rows);
  } else if (name === TABS.INBOX) {
    const C = COLUMN.INBOX;
    col(C.source).setDataValidation(listValidation_(INBOX_SOURCES, false));
    col(C.status).setDataValidation(listValidation_(INBOX_STATUSES, true));
    col(C.categoryHint).setDataValidation(listValidation_(CATEGORIES, false));
    col(C.captured).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.setColumnWidth(C.subject + 1, 260);
    sheet.setColumnWidth(C.snippet + 1, 420);
  } else if (name === TABS.AGENDA) {
    const C = COLUMN.AGENDA;
    col(C.section).setDataValidation(listValidation_(AGENDA_SECTIONS, true));
    col(C.weekOf).setNumberFormat('yyyy-mm-dd');
    col(C.generated).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.setColumnWidth(C.item + 1, 320);
    sheet.setColumnWidth(C.detail + 1, 320);
  } else if (name === TABS.CONFIG) {
    sheet.setColumnWidth(COLUMN.CONFIG.key + 1, 220);
    sheet.setColumnWidth(COLUMN.CONFIG.value + 1, 360);
    sheet.setColumnWidth(COLUMN.CONFIG.notes + 1, 420);
  } else if (name === TABS.LOG) {
    col(COLUMN.LOG.time).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.setColumnWidth(COLUMN.LOG.message + 1, 600);
  } else if (name === TABS.DESK) {
    sheet.setColumnWidth(COLUMN.DESK.key + 1, 110);
    sheet.setColumnWidth(COLUMN.DESK.json + 1, 600);
    sheet.setColumnWidth(COLUMN.DESK.built + 1, 140);
  }
}

function applyTaskConditionalFormats_(sheet, rows) {
  try {
    const range = sheet.getRange(2, 1, rows, TASK_HEADERS.length);
    const done = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$G2="Done"')
      .setFontColor('#9E9E9E').setStrikethrough(true)
      .setRanges([range]).build();
    const dropped = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$G2="Dropped"')
      .setFontColor('#BDBDBD')
      .setRanges([range]).build();
    const high = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($N2="High",$G2="Open")')
      .setFontColor('#C62828').setBold(true)
      .setRanges([range]).build();
    sheet.setConditionalFormatRules([high, done, dropped]);
  } catch (e) {
    // Conditional formatting is cosmetic; never block setup on it.
  }
}

/** Writes CONFIG_SCHEMA defaults into an empty Config tab. Returns true when written. */
function writeConfigDefaults(spreadsheet) {
  guard();
  const ss = spreadsheet || openSpreadsheet();
  const sheet = ss.getSheetByName(TABS.CONFIG) || ensureTab_(ss, TABS.CONFIG).sheet;
  if (sheet.getLastRow() >= 2) return false;
  const rows = CONFIG_SCHEMA.map((e) => [e.key, e.value, e.notes]);
  withLock(() => {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  });
  clearConfigMemo();
  return true;
}
