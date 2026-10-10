'use strict';
/**
 * In-memory mock of the Apps Script globals used by apps-script/*.gs.
 *
 * createMock(options) → { globals, state }
 *   globals: SpreadsheetApp, Utilities, LockService, PropertiesService, Logger, Session,
 *            GmailApp, UrlFetchApp, ScriptApp, HtmlService, CalendarApp
 *   state:   handles to inspect/seed the mock (spreadsheets, gmail fixtures, fetch handler…)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SHEET_ID = '1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w';

const TASK_HEADERS = ['ID', 'Created', 'Title', 'Details', 'Source', 'Link', 'Status', 'Done', 'Note',
  'Project', 'Newsletter', 'Discuss', 'Due', 'Priority', 'Source key', 'Updated'];
const HEADERS = {
  Work: TASK_HEADERS,
  Personal: TASK_HEADERS,
  Inbox: ['ID', 'Captured', 'Source', 'From', 'Subject', 'Snippet', 'Link', 'Source key', 'Status', 'Task ID', 'Category hint'],
  Agenda: ['Week of', 'Section', 'Order', 'Item', 'Detail', 'Link', 'Task ID', 'Generated'],
  Config: ['Key', 'Value', 'Notes'],
  Log: ['Time', 'Function', 'Level', 'Message']
};
const TAB_ORDER = ['Work', 'Personal', 'Inbox', 'Agenda', 'Config', 'Log'];

// ---------------------------------------------------------------------------
// Utilities.formatDate — Java SimpleDateFormat subset over Intl
// ---------------------------------------------------------------------------

const dtfCache = new Map();
/** Zone ids Intl rejected: the mock, like Java's TimeZone.getTimeZone, then formats them in GMT instead of throwing. */
const unknownZones = new Set();
function dateParts(date, tz) {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    const opts = {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', timeZoneName: 'longOffset'
    };
    try {
      dtf = new Intl.DateTimeFormat('en-US', opts);
    } catch (e) {
      // Apps Script's Utilities.formatDate (Java SimpleDateFormat) silently maps an unknown id such as
      // "Asia/Dubay" to GMT; mirror that so the code's own detection, not an exception, is what tests see.
      if (!(e instanceof RangeError)) throw e;
      unknownZones.add(tz);
      dtf = new Intl.DateTimeFormat('en-US', Object.assign({}, opts, { timeZone: 'UTC' }));
    }
    dtfCache.set(tz, dtf);
  }
  const out = {};
  dtf.formatToParts(date).forEach((p) => { out[p.type] = p.value; });
  if (out.hour === '24') out.hour = '00';
  return out;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function formatDateJava(date, tz, pattern) {
  if (!isDate(date) || isNaN(date.getTime())) {
    throw new Error('Utilities.formatDate: first argument must be a valid Date (got ' + typeof date + ')');
  }
  if (typeof tz !== 'string' || !tz) throw new Error('Utilities.formatDate: time zone required');
  if (typeof pattern !== 'string') throw new Error('Utilities.formatDate: pattern required');
  const p = dateParts(date, tz);
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  const second = Number(p.second);
  const millis = date.getUTCMilliseconds();
  const weekdayIdx = DAYS_LONG.indexOf(p.weekday); // 0 = Monday
  const offMatch = /GMT([+-])(\d{2}):(\d{2})/.exec(p.timeZoneName);
  const offSign = offMatch ? offMatch[1] : '+';
  const offH = offMatch ? offMatch[2] : '00';
  const offM = offMatch ? offMatch[3] : '00';
  const isUtc = offH === '00' && offM === '00';
  const pad = (n, w) => String(n).padStart(w, '0');
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "'") {
      const end = pattern.indexOf("'", i + 1);
      if (end === i + 1) { out += "'"; i += 2; continue; }
      if (end < 0) { out += pattern.slice(i + 1); break; }
      out += pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) { out += ch; i++; continue; }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    switch (ch) {
      case 'y': out += n === 2 ? pad(year % 100, 2) : pad(year, n); break;
      case 'M': out += n >= 4 ? MONTHS_LONG[month - 1] : n === 3 ? MONTHS_SHORT[month - 1] : pad(month, n); break;
      case 'd': out += pad(day, n); break;
      case 'H': out += pad(hour, n); break;
      case 'h': out += pad(hour % 12 === 0 ? 12 : hour % 12, n); break;
      case 'm': out += pad(minute, n); break;
      case 's': out += pad(second, n); break;
      case 'S': out += pad(millis, n); break;
      case 'E': out += n >= 4 ? DAYS_LONG[weekdayIdx] : DAYS_LONG[weekdayIdx].slice(0, 3); break;
      case 'u': out += String(weekdayIdx + 1); break;
      case 'a': out += hour < 12 ? 'AM' : 'PM'; break;
      case 'X':
        if (isUtc) out += 'Z';
        else if (n === 1) out += offSign + offH;
        else if (n === 2) out += offSign + offH + offM;
        else out += offSign + offH + ':' + offM;
        break;
      case 'Z': out += offSign + offH + offM; break;
      case 'z': out += 'GMT' + offSign + offH + ':' + offM; break;
      default: out += ch.repeat(n); break;
    }
    i += n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spreadsheet mock
// ---------------------------------------------------------------------------

function cloneValue(v) {
  if (isDate(v)) return new Date(v.getTime());
  return v;
}

function normaliseCell(v) {
  if (v === undefined || v === null) return '';
  if (isDate(v)) return new Date(v.getTime());
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  throw new Error('Cell value must be a string, number, boolean or Date; got ' + typeof v);
}

function isEmptyCell(v) {
  return v === '' || v === null || v === undefined;
}

/**
 * What Sheets makes of a typed/API-written string in a cell without a plain-text format:
 * number-, boolean- and date-looking text is parsed (opt-in through state.coerceStrings).
 */
function coerceInput(s) {
  const t = s.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 4 * 3600000); // midnight Asia/Dubai
  m = /^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?$/.exec(t); // "10/12", "1-2", "10/12/2026" (month/day, as an en-US locale reads them)
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
    return new Date(Date.UTC(m[3] ? +m[3] : new Date().getUTCFullYear(), +m[1] - 1, +m[2]) - 4 * 3600000);
  }
  return s;
}

function colToLetters(col) {
  let s = '';
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function lettersToCol(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

class MockDataValidation {
  constructor(spec) { this.spec = spec; }
  getCriteriaType() { return this.spec.type; }
  getCriteriaValues() { return this.spec.values || []; }
  getAllowInvalid() { return this.spec.allowInvalid !== false; }
}

class MockDataValidationBuilder {
  constructor() { this.spec = { type: 'NONE', values: [], allowInvalid: true, helpText: '' }; }
  requireValueInList(values, showDropdown) {
    this.spec.type = 'VALUE_IN_LIST';
    this.spec.values = [values.slice(), showDropdown !== false];
    return this;
  }
  requireCheckbox(checked, unchecked) {
    this.spec.type = 'CHECKBOX';
    this.spec.values = arguments.length ? [checked, unchecked] : [];
    return this;
  }
  requireDate() { this.spec.type = 'DATE_IS_VALID_DATE'; return this; }
  setAllowInvalid(flag) { this.spec.allowInvalid = !!flag; return this; }
  setHelpText(text) { this.spec.helpText = text; return this; }
  build() { return new MockDataValidation(Object.assign({}, this.spec)); }
}

class MockConditionalFormatRuleBuilder {
  constructor() { this.spec = { ranges: [], formula: '', background: '', fontColor: '', bold: null, strikethrough: null }; }
  whenFormulaSatisfied(f) { this.spec.formula = f; return this; }
  setBackground(c) { this.spec.background = c; return this; }
  setFontColor(c) { this.spec.fontColor = c; return this; }
  setBold(b) { this.spec.bold = !!b; return this; }
  setStrikethrough(b) { this.spec.strikethrough = !!b; return this; }
  setItalic(b) { this.spec.italic = !!b; return this; }
  setRanges(ranges) { this.spec.ranges = ranges.slice(); return this; }
  build() { return { spec: Object.assign({}, this.spec), getRanges: () => this.spec.ranges.slice() }; }
}

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (!(row >= 1) || !(col >= 1) || !(numRows >= 1) || !(numCols >= 1)) {
      throw new Error('The coordinates or dimensions of the range are invalid. (' + [row, col, numRows, numCols].join(', ') + ')');
    }
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getLastRow() { return this.row + this.numRows - 1; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getA1Notation() {
    return colToLetters(this.col) + this.row + ':' + colToLetters(this.getLastColumn()) + this.getLastRow();
  }
  getSheet() { return this.sheet; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      const src = this.sheet.data[this.row - 1 + r] || [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        rowArr.push(v === undefined || v === null ? '' : cloneValue(v));
      }
      out.push(rowArr);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  getDisplayValues() {
    return this.getValues().map((r) => r.map((v) => (isDate(v) ? v.toISOString() : String(v))));
  }
  /** Formula strings of the cells ('' where a cell holds a plain value), like Apps Script. */
  getFormulas() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) rowArr.push(this.sheet.getFormula_(this.row + r, this.col + c));
      out.push(rowArr);
    }
    return out;
  }
  getFormula() { return this.getFormulas()[0][0]; }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows) {
      throw new Error('The number of rows in the data does not match the number of rows in the range. The data has ' +
        (Array.isArray(values) ? values.length : 'no') + ' but the range has ' + this.numRows + '.');
    }
    values.forEach((rowArr, r) => {
      if (!Array.isArray(rowArr) || rowArr.length !== this.numCols) {
        throw new Error('The number of columns in the data does not match the number of columns in the range. The data has ' +
          (Array.isArray(rowArr) ? rowArr.length : 'no') + ' but the range has ' + this.numCols + '.');
      }
      rowArr.forEach((v, c) => this.sheet.writeCell_(this.row + r, this.col + c, v));
    });
    this.sheet.spreadsheet.state.writes++;
    return this;
  }
  setValue(v) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.sheet.writeCell_(this.row + r, this.col + c, v);
    }
    this.sheet.spreadsheet.state.writes++;
    return this;
  }
  setFormula(f) { return this.setValue(String(f || '')); }
  setFormulas(values) { return this.setValues(values.map((r) => r.map((f) => String(f || '')))); }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.sheet.writeCell_(this.row + r, this.col + c, '');
    }
    return this;
  }
  clear() { return this.clearContent(); }
  setNumberFormat(fmt) { this.sheet.meta_('formats', this, fmt); return this; }
  setNumberFormats(fmts) { this.sheet.meta_('formats', this, fmts); return this; }
  setDataValidation(rule) { this.sheet.meta_('validations', this, rule); return this; }
  clearDataValidations() { this.sheet.meta_('validations', this, null); return this; }
  getDataValidation() { return this.sheet.metaGet_('validations', this.row, this.col); }
  getNumberFormat() { return this.sheet.metaGet_('formats', this.row, this.col); }
  setBackground(c) { this.sheet.meta_('backgrounds', this, c); return this; }
  setFontWeight(w) { this.sheet.meta_('fontWeights', this, w); return this; }
  setFontColor(c) { this.sheet.meta_('fontColors', this, c); return this; }
  setFontFamily() { return this; }
  setFontSize() { return this; }
  setFontLine() { return this; }
  setWrap() { return this; }
  setWrapStrategy() { return this; }
  setHorizontalAlignment() { return this; }
  setVerticalAlignment() { return this; }
  setFontStyle() { return this; }
  setBorder() { return this; }
  insertCheckboxes() {
    this.setDataValidation(new MockDataValidationBuilder().requireCheckbox().build());
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        if (isEmptyCell(this.sheet.getCell_(this.row + r, this.col + c))) this.sheet.setCell_(this.row + r, this.col + c, false);
      }
    }
    return this;
  }
  createTextFinder(text) {
    const self = this;
    let entire = false;
    return {
      matchEntireCell(flag) { entire = !!flag; return this; },
      matchCase() { return this; },
      findNext() {
        const values = self.getValues();
        for (let r = 0; r < values.length; r++) {
          for (let c = 0; c < values[r].length; c++) {
            const v = String(values[r][c]);
            if (entire ? v === String(text) : v.indexOf(String(text)) >= 0) {
              return new MockRange(self.sheet, self.row + r, self.col + c, 1, 1);
            }
          }
        }
        return null;
      },
      findAll() { return []; }
    };
  }
}

class MockSheet {
  constructor(spreadsheet, name, id) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this.id = id;
    this.data = [];
    this.fdata = []; // formulas, parallel to data ('' where a cell holds a plain value)
    this.rdata = []; // rich-text link URLs, parallel to data ('' where a cell holds no hyperlink)
    this.maxRows = 1000;
    this.maxCols = 26;
    this.frozenRows = 0;
    this.columnWidths = {};
    this.metadata = { formats: {}, validations: {}, backgrounds: {}, fontWeights: {}, fontColors: {} };
    this.conditionalRules = [];
  }
  getCell_(row, col) {
    const r = this.data[row - 1];
    return r ? r[col - 1] : undefined;
  }
  /** Stores a plain value (no formula interpretation): the seeding path for tests. */
  setCell_(row, col, value) {
    if (row > this.maxRows) {
      throw new Error('Range out of bounds: row ' + row + ' exceeds the sheet\'s ' + this.maxRows + ' rows (' + this.name + ')');
    }
    if (col > this.maxCols) this.maxCols = col;
    while (this.data.length < row) this.data.push([]);
    const r = this.data[row - 1];
    while (r.length < col) r.push('');
    r[col - 1] = value;
  }
  getFormula_(row, col) {
    const r = this.fdata[row - 1];
    return r && r[col - 1] ? r[col - 1] : '';
  }
  /**
   * Stores a formula. Apps Script would compute its value; the mock cannot, so getValues() gives
   * the `display` a test seeded (state.setFormula), the previous display when the same formula is
   * written back, or the marker '#FORMULA' for anything else.
   */
  setFormula_(row, col, formula, display) {
    const same = this.getFormula_(row, col) === formula;
    const shown = display !== undefined ? display : (same ? this.getCell_(row, col) : '#FORMULA');
    this.setCell_(row, col, shown);
    while (this.fdata.length < row) this.fdata.push([]);
    const r = this.fdata[row - 1];
    while (r.length < col) r.push('');
    r[col - 1] = formula;
  }
  clearFormula_(row, col) {
    const r = this.fdata[row - 1];
    if (r && r.length >= col) r[col - 1] = '';
  }
  /**
   * A rich-text hyperlink (Sheets: Insert → Link with a label). getValues() shows the label;
   * any write through setValue(s)/appendRow replaces the cell with plain text and the URL is gone,
   * exactly as in Sheets. state.setRichText seeds one, state.richText reads the URL back.
   */
  setRichText_(row, col, label, url) {
    this.clearFormula_(row, col);
    this.setCell_(row, col, String(label));
    while (this.rdata.length < row) this.rdata.push([]);
    const r = this.rdata[row - 1];
    while (r.length < col) r.push('');
    r[col - 1] = String(url || '');
  }
  getRichUrl_(row, col) {
    const r = this.rdata[row - 1];
    return r && r[col - 1] ? r[col - 1] : '';
  }
  clearRich_(row, col) {
    const r = this.rdata[row - 1];
    if (r && r.length >= col) r[col - 1] = '';
  }
  /**
   * What Range.setValue(s) and Sheet.appendRow do with one value: a string beginning with "="
   * is interpreted as a formula (Apps Script reference), anything else is stored as a value.
   * Any write drops a rich-text link the cell held. With state.coerceStrings on, a string in a
   * cell whose number format is not '@' is parsed the way Sheets parses typed input (see
   * coerceInput); the '@' format ensureSchema puts on the text columns keeps it as text.
   */
  writeCell_(row, col, v) {
    this.clearRich_(row, col);
    this.spreadsheet.state.cellWrites.push({ sheet: this.name, row: row, col: col });
    if (typeof v === 'string' && v.charAt(0) === '=') {
      this.setFormula_(row, col, v);
    } else {
      this.clearFormula_(row, col);
      let value = normaliseCell(v);
      if (typeof value === 'string' && this.spreadsheet.state.coerceStrings && this.metaGet_('formats', row, col) !== '@') {
        value = coerceInput(value);
      }
      this.setCell_(row, col, value);
    }
  }
  meta_(kind, range, value) {
    for (let r = 0; r < range.numRows; r++) {
      for (let c = 0; c < range.numCols; c++) {
        this.metadata[kind][(range.row + r) + ':' + (range.col + c)] = value;
      }
    }
  }
  metaGet_(kind, row, col) {
    const v = this.metadata[kind][row + ':' + col];
    return v === undefined ? null : v;
  }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  getSheetId() { return this.id; }
  getIndex() { return this.spreadsheet.sheets.indexOf(this) + 1; }
  getParent() { return this.spreadsheet; }
  getLastRow() {
    for (let r = this.data.length - 1; r >= 0; r--) {
      if (this.data[r].some((v) => !isEmptyCell(v))) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((row) => {
      for (let c = row.length - 1; c >= 0; c--) {
        if (!isEmptyCell(row[c])) { if (c + 1 > max) max = c + 1; break; }
      }
    });
    return max;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Za-z]+)(\d*)(?::([A-Za-z]+)(\d*))?$/.exec(a.replace(/\$/g, ''));
      if (!m) throw new Error('Unsupported A1 notation in mock: ' + a);
      const c1 = lettersToCol(m[1]);
      const r1 = m[2] ? Number(m[2]) : 1;
      const c2 = m[3] ? lettersToCol(m[3]) : c1;
      const r2 = m[4] ? Number(m[4]) : (m[3] ? this.maxRows : r1);
      return new MockRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new MockRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getDataRange() {
    const rows = Math.max(this.getLastRow(), 1);
    const cols = Math.max(this.getLastColumn(), 1);
    return new MockRange(this, 1, 1, rows, cols);
  }
  appendRow(values) {
    const row = this.getLastRow() + 1;
    if (row > this.maxRows) this.maxRows = row;
    values.forEach((v, i) => this.writeCell_(row, i + 1, v));
    this.spreadsheet.state.writes++;
    return this;
  }
  deleteRow(row) { return this.deleteRows(row, 1); }
  deleteRows(start, n) {
    if (start < 1 || n < 1) throw new Error('Invalid deleteRows arguments');
    if (start + n - 1 > this.maxRows) throw new Error('Those rows are out of bounds. (deleteRows ' + start + ', ' + n + ' of ' + this.maxRows + ')');
    if (this.maxRows - n <= this.frozenRows) throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
    this.data.splice(start - 1, n);
    this.fdata.splice(start - 1, n);
    this.rdata.splice(start - 1, n);
    this.maxRows = Math.max(1, this.maxRows - n);
    return this;
  }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  insertRowsBefore(before, n) { this.maxRows += n; return this; }
  insertRowAfter(after) { return this.insertRowsAfter(after, 1); }
  clearContents() { this.data = []; this.fdata = []; this.rdata = []; return this; }
  clear() { this.data = []; this.fdata = []; this.rdata = []; return this; }
  /** [{row, col, formula}] for every formula cell (test inspection). */
  formulaCells_() {
    const out = [];
    this.fdata.forEach((r, i) => r.forEach((f, j) => { if (f) out.push({ row: i + 1, col: j + 1, formula: f }); }));
    return out;
  }
  /** Rich-text value of one cell (label + first link URL), as RichTextValue.getText()/getLinkUrl() give it. */
  getRichTextValue() {
    const self = this;
    const url = this.sheet.getRichUrl_(this.row, this.col);
    return { getText: () => String(self.getValue()), getLinkUrl: () => url || null };
  }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  getFrozenRows() { return this.frozenRows; }
  setFrozenColumns() { return this; }
  setColumnWidth(col, w) { this.columnWidths[col] = w; return this; }
  setColumnWidths(col, n, w) { for (let i = 0; i < n; i++) this.columnWidths[col + i] = w; return this; }
  autoResizeColumn() { return this; }
  autoResizeColumns() { return this; }
  setConditionalFormatRules(rules) { this.conditionalRules = rules.slice(); return this; }
  getConditionalFormatRules() { return this.conditionalRules.slice(); }
  getSheets() { return this.spreadsheet.getSheets(); }
  activate() { return this; }
  setTabColor() { return this; }
  hideSheet() { return this; }
  showSheet() { return this; }
}

class MockSpreadsheet {
  constructor(state, id, name) {
    this.state = state;
    this.id = id;
    this.name = name;
    this.sheets = [];
    this.nextSheetId = 0;
    this.timeZone = 'Asia/Dubai';
  }
  getId() { return this.id; }
  getName() { return this.name; }
  rename(name) { this.name = name; return this; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name, index) {
    if (name && this.getSheetByName(name)) throw new Error('A sheet with the name "' + name + '" already exists. Please enter another name.');
    const sheet = new MockSheet(this, name || ('Sheet' + (this.sheets.length + 1)), this.nextSheetId++);
    if (typeof index === 'number') this.sheets.splice(index, 0, sheet);
    else this.sheets.push(sheet);
    return sheet;
  }
  deleteSheet(sheet) { this.sheets = this.sheets.filter((s) => s !== sheet); return this; }
  getActiveSheet() { return this.sheets[0] || null; }
  setActiveSheet(s) { return s; }
  getSpreadsheetTimeZone() { return this.timeZone; }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; return this; }
  getNumSheets() { return this.sheets.length; }
  toast() { return this; }
}

// ---------------------------------------------------------------------------
// Gmail mock
// ---------------------------------------------------------------------------

function makeMessage(thread, spec, index) {
  const headers = {};
  Object.keys(spec.headers || {}).forEach((k) => { headers[k.toLowerCase()] = spec.headers[k]; });
  const date = spec.date ? new Date(spec.date) : new Date(Date.now() - (10 - index) * 3600000);
  return {
    spec: spec,
    getId() { return spec.id || (thread.spec.id + '-m' + index); },
    getFrom() { return spec.from || ''; },
    getTo() { return spec.to || ''; },
    getCc() { return spec.cc || ''; },
    getBcc() { return spec.bcc || ''; },
    getReplyTo() { return spec.replyTo || ''; },
    getSubject() { return spec.subject !== undefined ? spec.subject : (thread.spec.subject || ''); },
    getPlainBody() { return spec.body || ''; },
    getBody() { return spec.html || ('<div>' + (spec.body || '') + '</div>'); },
    getDate() { return date; },
    isDraft() { return !!spec.draft; },
    isUnread() { return spec.unread !== false; },
    isInInbox() { return spec.inInbox !== false; },
    getHeader(name) {
      const v = headers[String(name).toLowerCase()];
      return v === undefined ? '' : v;
    },
    getThread() { return thread; },
    getRawContent() { return spec.raw || ''; }
  };
}

function makeThread(spec) {
  const thread = { spec: spec, messages: [] };
  thread.messages = (spec.messages || []).map((m, i) => makeMessage(thread, m, i));
  thread.getId = () => spec.id;
  thread.getMessages = () => thread.messages.slice();
  thread.getMessageCount = () => thread.messages.length;
  thread.getFirstMessageSubject = () => (thread.messages[0] ? thread.messages[0].getSubject() : (spec.subject || ''));
  thread.getLastMessageDate = () => (thread.messages.length ? thread.messages[thread.messages.length - 1].getDate() : new Date());
  thread.getPermalink = () => 'https://mail.google.com/mail/u/0/#inbox/' + spec.id;
  thread.hasStarredMessages = () => false;
  thread.isInInbox = () => true;
  thread.getLabels = () => [];
  return thread;
}

// ---------------------------------------------------------------------------
// createMock
// ---------------------------------------------------------------------------

function createMock(options) {
  const opts = options || {};
  const state = {
    writes: 0,
    // Every cell a setValue(s)/appendRow/clearContent touched: [{sheet, row, col}] (tests assert what was NOT written).
    cellWrites: [],
    // true: strings written to a cell without the '@' number format are parsed like typed input (see coerceInput).
    coerceStrings: false,
    spreadsheets: new Map(),
    nextSpreadsheetId: 1,
    properties: Object.assign({}, opts.properties || {}),
    userProperties: {},
    logs: [],
    // lastWaitMs: the timeout passed to the last waitLock(); onWait(ms): optional hook run while the
    // lock is being acquired (tests use it to simulate another execution writing first).
    locks: { waits: 0, releases: 0, held: 0, maxHeld: 0, failWait: false, lastWaitMs: null, onWait: null },
    session: {
      activeEmail: opts.activeEmail !== undefined ? opts.activeEmail : 'bbaki@aisa.sch.ae',
      effectiveEmail: opts.effectiveEmail !== undefined ? opts.effectiveEmail : 'bbaki@aisa.sch.ae',
      timeZone: 'Asia/Dubai'
    },
    // bulkLoads counts GmailApp.getMessagesForThreads() calls; perThreadLoads counts thread.getMessages().
    gmail: { threads: [], aliases: [], aliasesThrow: false, searches: [], searchHandler: null, throwOnSearch: null, bulkLoads: 0, perThreadLoads: 0 },
    urlFetch: { calls: [], handler: null },
    triggers: [],
    sleeps: [],
    html: { templates: [], outputs: [] },
    oauthToken: 'mock-oauth-token'
  };

  // --- default spreadsheet with the six tabs and headers -------------------
  function buildSpreadsheet(id, name, withTabs) {
    const ss = new MockSpreadsheet(state, id, name);
    if (withTabs) {
      TAB_ORDER.forEach((tab) => {
        const sheet = ss.insertSheet(tab);
        HEADERS[tab].forEach((h, i) => sheet.setCell_(1, i + 1, h));
        sheet.setFrozenRows(1);
      });
    } else {
      ss.insertSheet('Sheet1');
    }
    state.spreadsheets.set(id, ss);
    return ss;
  }
  state.defaultSpreadsheet = opts.noDefaultSheet ? null : buildSpreadsheet(DEFAULT_SHEET_ID, "Brandon's Desk", true);
  state.buildSpreadsheet = buildSpreadsheet;
  state.sheet = (tab, id) => {
    const ss = state.spreadsheets.get(id || DEFAULT_SHEET_ID);
    if (!ss) throw new Error('No spreadsheet ' + (id || DEFAULT_SHEET_ID));
    const s = ss.getSheetByName(tab);
    if (!s) throw new Error('No tab ' + tab);
    return s;
  };
  state.rows = (tab, id) => {
    const s = state.sheet(tab, id);
    const last = s.getLastRow();
    if (last < 2) return [];
    return s.getRange(2, 1, last - 1, Math.max(s.getLastColumn(), 1)).getValues();
  };
  state.seed = (tab, rows, id) => {
    const s = state.sheet(tab, id);
    rows.forEach((r) => s.appendRow(r));
  };
  state.setCell = (tab, row, col, value, id) => {
    state.sheet(tab, id).setCell_(row, col, normaliseCell(value));
  };
  // A formula cell with a known computed value, e.g. setFormula('Work', 2, 6, '=HYPERLINK("https://d","Doc")', 'Doc').
  state.setFormula = (tab, row, col, formula, display, id) => {
    state.sheet(tab, id).setFormula_(row, col, String(formula), display === undefined ? '#FORMULA' : display);
  };
  // Every formula cell of a tab: [] proves nothing the code wrote was interpreted as a formula.
  state.formulas = (tab, id) => state.sheet(tab, id).formulaCells_();
  // A rich-text hyperlink cell (label shown by getValues(), URL kept until something rewrites the cell).
  state.setRichText = (tab, row, col, label, url, id) => { state.sheet(tab, id).setRichText_(row, col, label, url); };
  state.richText = (tab, row, col, id) => state.sheet(tab, id).getRichUrl_(row, col);
  state.logRows = (id) => state.rows('Log', id).map((r) => ({ time: r[0], fn: r[1], level: r[2], message: r[3] }));
  // Threads built through the mock count their per-thread getMessages() calls.
  const makeCountedThread = (spec) => {
    const thread = makeThread(spec);
    thread.getMessages = () => { state.gmail.perThreadLoads++; return thread.messages.slice(); };
    return thread;
  };
  state.gmail.makeThread = makeCountedThread;
  state.gmail.setThreads = (specs) => { state.gmail.threads = specs.map(makeCountedThread); };

  const SpreadsheetApp = {
    openById(id) {
      const ss = state.spreadsheets.get(id);
      if (!ss) throw new Error('Requested entity was not found. (openById ' + id + ')');
      return ss;
    },
    openByUrl(url) {
      const m = /\/d\/([^/]+)/.exec(url);
      return SpreadsheetApp.openById(m ? m[1] : url);
    },
    create(name) {
      const id = 'mock-created-' + (state.nextSpreadsheetId++);
      return buildSpreadsheet(id, name, false);
    },
    getActiveSpreadsheet() { return state.defaultSpreadsheet; },
    getActive() { return state.defaultSpreadsheet; },
    newDataValidation() { return new MockDataValidationBuilder(); },
    newConditionalFormatRule() { return new MockConditionalFormatRuleBuilder(); },
    flush() {},
    DataValidationCriteria: { VALUE_IN_LIST: 'VALUE_IN_LIST', CHECKBOX: 'CHECKBOX' },
    BandingTheme: { LIGHT_GREY: 'LIGHT_GREY' },
    WrapStrategy: { WRAP: 'WRAP', CLIP: 'CLIP', OVERFLOW: 'OVERFLOW' }
  };

  const Utilities = {
    formatDate: formatDateJava,
    computeDigest(algorithm, value, charset) {
      const algo = { SHA_1: 'sha1', MD5: 'md5', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512' }[algorithm];
      if (!algo) throw new Error('Unsupported digest algorithm ' + algorithm);
      const buf = crypto.createHash(algo).update(String(value), charset === 'US_ASCII' ? 'ascii' : 'utf8').digest();
      return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
    },
    base64Encode(data) { return Buffer.from(typeof data === 'string' ? data : Uint8Array.from(data.map((b) => (b + 256) % 256))).toString('base64'); },
    base64EncodeWebSafe(data) { return Utilities.base64Encode(data).replace(/\+/g, '-').replace(/\//g, '_'); },
    base64Decode(s) { return Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)); },
    getUuid() { return crypto.randomUUID(); },
    sleep(ms) { state.sleeps.push(ms); },
    newBlob(data, type, name) { return { getDataAsString: () => String(data), getContentType: () => type, getName: () => name }; },
    parseCsv(csv) { return String(csv).split('\n').map((l) => l.split(',')); },
    DigestAlgorithm: { SHA_1: 'SHA_1', MD5: 'MD5', SHA_256: 'SHA_256', SHA_384: 'SHA_384', SHA_512: 'SHA_512' },
    Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' }
  };

  function makeLock() {
    let held = false;
    return {
      waitLock(ms) {
        state.locks.lastWaitMs = ms;
        if (state.locks.failWait) throw new Error('Lock timeout: another process was holding the lock for too long (' + ms + ' ms)');
        if (typeof state.locks.onWait === 'function') state.locks.onWait(ms);
        state.locks.waits++;
        held = true;
        state.locks.held++;
        if (state.locks.held > state.locks.maxHeld) state.locks.maxHeld = state.locks.held;
      },
      tryLock(ms) { try { this.waitLock(ms); return true; } catch (e) { return false; } },
      releaseLock() { if (held) { held = false; state.locks.releases++; state.locks.held--; } },
      hasLock() { return held; }
    };
  }
  const LockService = {
    getScriptLock: makeLock,
    getDocumentLock: makeLock,
    getUserLock: makeLock
  };

  function makeProperties(store) {
    return {
      getProperty(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setProperty(k, v) { store[k] = String(v); return this; },
      deleteProperty(k) { delete store[k]; return this; },
      getProperties() { return Object.assign({}, store); },
      setProperties(obj, del) { if (del) Object.keys(store).forEach((k) => delete store[k]); Object.keys(obj).forEach((k) => { store[k] = String(obj[k]); }); return this; },
      deleteAllProperties() { Object.keys(store).forEach((k) => delete store[k]); return this; },
      getKeys() { return Object.keys(store); }
    };
  }
  const PropertiesService = {
    getScriptProperties() { return makeProperties(state.properties); },
    getUserProperties() { return makeProperties(state.userProperties); },
    getDocumentProperties() { return makeProperties(state.userProperties); }
  };

  const Logger = {
    log(msg) { state.logs.push(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
    getLog() { return state.logs.join('\n'); },
    clear() { state.logs = []; }
  };

  const Session = {
    getActiveUser() { return { getEmail: () => state.session.activeEmail, getUsername: () => String(state.session.activeEmail).split('@')[0] }; },
    getEffectiveUser() { return { getEmail: () => state.session.effectiveEmail, getUsername: () => String(state.session.effectiveEmail).split('@')[0] }; },
    getScriptTimeZone() { return state.session.timeZone; },
    getActiveUserLocale() { return 'en'; },
    getTemporaryActiveUserKey() { return 'mock-user-key'; }
  };

  const GmailApp = {
    search(query, start, max) {
      state.gmail.searches.push({ query: query, start: start, max: max });
      if (state.gmail.throwOnSearch) throw new Error(state.gmail.throwOnSearch);
      let threads = state.gmail.threads;
      if (typeof state.gmail.searchHandler === 'function') threads = state.gmail.searchHandler(query, threads) || [];
      const s = start || 0;
      return threads.slice(s, max ? s + max : undefined);
    },
    getMessagesForThreads(threads) { state.gmail.bulkLoads++; return threads.map((t) => t.messages.slice()); },
    getMessagesForThread(thread) { state.gmail.bulkLoads++; return thread.messages.slice(); },
    getAliases() {
      if (state.gmail.aliasesThrow) throw new Error('GmailApp.getAliases is not available');
      return state.gmail.aliases.slice();
    },
    getThreadById(id) { return state.gmail.threads.find((t) => t.getId() === id) || null; },
    getMessageById(id) {
      for (const t of state.gmail.threads) { const m = t.getMessages().find((x) => x.getId() === id); if (m) return m; }
      return null;
    }
  };

  const UrlFetchApp = {
    fetch(url, params) {
      const call = { url: url, params: params || {} };
      state.urlFetch.calls.push(call);
      let res = typeof state.urlFetch.handler === 'function' ? state.urlFetch.handler(url, params || {}, call) : null;
      if (res === null || res === undefined) res = { code: 404, body: { error: { code: 404, message: 'No mock handler for ' + url, status: 'NOT_FOUND' } } };
      if (typeof res === 'string') res = { code: 200, body: res };
      const code = res.code === undefined ? 200 : res.code;
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body === undefined ? {} : res.body);
      if (!(params && params.muteHttpExceptions) && code >= 400) {
        throw new Error('Request failed for ' + url + ' returned code ' + code + '. Truncated server response: ' + text.slice(0, 200));
      }
      return {
        getResponseCode: () => code,
        getContentText: () => text,
        getHeaders: () => res.headers || {},
        getAllHeaders: () => res.headers || {},
        getBlob: () => Utilities.newBlob(text, 'application/json', 'response')
      };
    },
    fetchAll(requests) { return requests.map((r) => UrlFetchApp.fetch(typeof r === 'string' ? r : r.url, r)); }
  };

  function makeTrigger(spec) {
    const id = 'trig-' + crypto.randomBytes(4).toString('hex');
    return {
      spec: spec,
      getHandlerFunction: () => spec.handler,
      getUniqueId: () => id,
      getTriggerSource: () => 'CLOCK',
      getEventType: () => 'CLOCK',
      getTriggerSourceId: () => null
    };
  }
  const ScriptApp = {
    getOAuthToken() { return state.oauthToken; },
    getProjectTriggers() { return state.triggers.slice(); },
    getUserTriggers() { return state.triggers.slice(); },
    deleteTrigger(t) { state.triggers = state.triggers.filter((x) => x !== t); },
    newTrigger(handler) {
      const spec = { handler: handler, type: '' };
      const clock = {
        atHour(h) { spec.hour = h; return clock; },
        nearMinute(m) { spec.minute = m; return clock; },
        everyDays(n) { spec.everyDays = n; return clock; },
        everyHours(n) { spec.everyHours = n; return clock; },
        everyMinutes(n) { spec.everyMinutes = n; return clock; },
        everyWeeks(n) { spec.everyWeeks = n; return clock; },
        onWeekDay(d) { spec.weekDay = d; return clock; },
        at(d) { spec.at = d; return clock; },
        after(ms) { spec.after = ms; return clock; },
        inTimezone(tz) { spec.timezone = tz; return clock; },
        create() { const t = makeTrigger(spec); state.triggers.push(t); return t; }
      };
      return {
        timeBased() { spec.type = 'CLOCK'; return clock; },
        forSpreadsheet() { spec.type = 'SPREADSHEET'; return { onEdit: () => ({ create: () => { const t = makeTrigger(spec); state.triggers.push(t); return t; } }) }; }
      };
    },
    getService() { return { getUrl: () => 'https://script.google.com/macros/s/mock-deployment/exec', isEnabled: () => true }; },
    getScriptId() { return 'mock-script-id'; },
    requireScopes() {},
    WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
    AuthMode: { NONE: 'NONE', LIMITED: 'LIMITED', FULL: 'FULL' }
  };

  const htmlDir = opts.htmlDir || path.join(__dirname, '..', 'apps-script');
  function readHtmlFile(name) {
    const file = path.join(htmlDir, name + '.html');
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
  }
  function makeOutput(content) {
    const out = { content: content, title: '', metaTags: [], xFrame: 'DEFAULT', sandbox: '', favicon: '' };
    out.setTitle = (t) => { out.title = t; return out; };
    out.addMetaTag = (n, v) => { out.metaTags.push({ name: n, content: v }); return out; };
    out.setXFrameOptionsMode = (m) => { out.xFrame = m; return out; };
    out.setSandboxMode = (m) => { out.sandbox = m; return out; };
    out.setFaviconUrl = (u) => { out.favicon = u; return out; };
    out.setWidth = () => out;
    out.setHeight = () => out;
    out.getContent = () => out.content;
    out.append = (s) => { out.content += s; return out; };
    state.html.outputs.push(out);
    return out;
  }
  const HtmlService = {
    createTemplateFromFile(name) {
      const tpl = { name: name, raw: readHtmlFile(name) };
      state.html.templates.push(tpl);
      tpl.evaluate = () => makeOutput(tpl.raw.replace(/<\?!?=?[\s\S]*?\?>/g, ''));
      tpl.getRawContent = () => tpl.raw;
      return tpl;
    },
    createHtmlOutputFromFile(name) { return makeOutput(readHtmlFile(name)); },
    createHtmlOutput(html) { return makeOutput(html === undefined ? '' : String(html)); },
    createTemplate(html) { const tpl = { raw: String(html) }; tpl.evaluate = () => makeOutput(tpl.raw); return tpl; },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME', NATIVE: 'NATIVE', EMULATED: 'EMULATED' }
  };

  const CalendarApp = {
    getDefaultCalendar() { return { getEvents: () => [], getEventsForDay: () => [], getName: () => 'mock' }; },
    getCalendarById() { return CalendarApp.getDefaultCalendar(); },
    getEvents() { return []; }
  };

  const globals = {
    SpreadsheetApp, Utilities, LockService, PropertiesService, Logger, Session, GmailApp, UrlFetchApp,
    ScriptApp, HtmlService, CalendarApp
  };
  return { globals: globals, state: state };
}

module.exports = { createMock, formatDateJava, HEADERS, TAB_ORDER, DEFAULT_SHEET_ID, makeThread, unknownZones };
