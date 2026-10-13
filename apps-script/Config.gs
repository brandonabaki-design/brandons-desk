/**
 * Config.gs — constants, column maps, enums and readConfig().
 *
 * Loaded first (see .clasp.json filePushOrder). Nothing here touches a Google
 * service at load time; every service call lives inside a function.
 */

/** Known sheet ID (docs/SPEC.md section 1). Overridden by Script Property SHEET_ID. */
const DEFAULT_SHEET_ID = '1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w';

/** Default time zone; Config key TIMEZONE overrides it at run time. */
const TIMEZONE = 'Asia/Dubai';

const APP_TITLE = "Brandon's Desk";

/**
 * The Desk page the Claude morning build publishes (docs/DESK.md). The web app links to it for
 * "Rebuild now" and when the Desk tab is empty or stale.
 */
const DESK_URL = 'https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr';

/** Tab names, in creation order. */
const TABS = {
  WORK: 'Work',
  PERSONAL: 'Personal',
  INBOX: 'Inbox',
  AGENDA: 'Agenda',
  CONFIG: 'Config',
  LOG: 'Log',
  DESK: 'Desk'
};

const TAB_ORDER = [TABS.WORK, TABS.PERSONAL, TABS.INBOX, TABS.AGENDA, TABS.CONFIG, TABS.LOG, TABS.DESK];

/** Exact header rows (docs/SPEC.md section 3). */
const TASK_HEADERS = ['ID', 'Created', 'Title', 'Details', 'Source', 'Link', 'Status', 'Done', 'Note',
  'Project', 'Newsletter', 'Discuss', 'Due', 'Priority', 'Source key', 'Updated'];

const HEADERS = {
  Work: TASK_HEADERS,
  Personal: TASK_HEADERS,
  Inbox: ['ID', 'Captured', 'Source', 'From', 'Subject', 'Snippet', 'Link', 'Source key', 'Status', 'Task ID', 'Category hint'],
  Agenda: ['Week of', 'Section', 'Order', 'Item', 'Detail', 'Link', 'Task ID', 'Generated'],
  Config: ['Key', 'Value', 'Notes'],
  Log: ['Time', 'Function', 'Level', 'Message'],
  // docs/DESK.md section 1: written only by the Claude morning build, read by getDesk().
  Desk: ['Key', 'JSON', 'Built']
};

/** 0-based column indexes per tab. */
const COLUMN = {
  TASK: {
    id: 0, created: 1, title: 2, details: 3, source: 4, link: 5, status: 6, done: 7, note: 8,
    project: 9, newsletter: 10, discuss: 11, due: 12, priority: 13, sourceKey: 14, updated: 15
  },
  INBOX: {
    id: 0, captured: 1, source: 2, from: 3, subject: 4, snippet: 5, link: 6, sourceKey: 7,
    status: 8, taskId: 9, categoryHint: 10
  },
  AGENDA: { weekOf: 0, section: 1, order: 2, item: 3, detail: 4, link: 5, taskId: 6, generated: 7 },
  CONFIG: { key: 0, value: 1, notes: 2 },
  LOG: { time: 0, fn: 1, level: 2, message: 3 },
  DESK: { key: 0, json: 1, built: 2 }
};

/** Which column map a tab uses. */
const TAB_COLUMNS = {
  Work: 'TASK',
  Personal: 'TASK',
  Inbox: 'INBOX',
  Agenda: 'AGENDA',
  Config: 'CONFIG',
  Log: 'LOG',
  Desk: 'DESK'
};

const CATEGORIES = ['Work', 'Personal'];
const ID_PREFIX = { Work: 'W', Personal: 'P', Inbox: 'I' };
const STATUSES = ['Open', 'Done', 'Dropped'];
const PRIORITIES = ['High', 'Normal', 'Low'];
const SOURCES = ['Gmail', 'Chat', 'Calendar', 'Manual', 'Import', 'Claude'];
const INBOX_STATUSES = ['New', 'Promoted', 'Ignored'];
const INBOX_SOURCES = ['Gmail', 'Chat'];
const AGENDA_SECTIONS = ['Done', 'In progress', 'Questions', 'Documents', 'Notes'];
const LOG_LEVELS = ['INFO', 'WARN', 'ERROR'];

const TITLE_MAX = 140;
const SNIPPET_MAX = 400;
/** Server-side length caps: a cell over 50 000 characters makes the whole setValues() throw after validation passed. */
const DETAILS_MAX = 5000;
const NOTE_MAX = 1000;
const SOURCE_KEY_MAX = 200;
const TASK_ID_MAX = 40;
const LOG_TRIM_AT = 2000;
const LOG_KEEP = 1500;
const LOCK_WAIT_MS = 10000;
const GMAIL_MAX_THREADS = 50;

/**
 * Config keys with type, default and the note written into the Config tab.
 * type: string | number | boolean | list (comma-separated).
 */
const CONFIG_SCHEMA = [
  { key: 'ALLOWED_EMAILS', type: 'list', value: 'bbaki@aisa.sch.ae, brandon.abaki@gmail.com',
    notes: 'Comma-separated. Only these accounts may call the web app.' },
  { key: 'TIMEZONE', type: 'string', value: 'Asia/Dubai',
    notes: 'IANA time zone for all "today" logic.' },
  { key: 'MEETING_DAY', type: 'string', value: 'Tuesday',
    notes: 'Weekday of the director meeting.' },
  { key: 'GMAIL_QUERY', type: 'string', value: 'in:inbox -in:chats -category:promotions -category:social -category:forums',
    notes: 'Gmail search for capture. newer_than:<GMAIL_LOOKBACK_DAYS>d is appended unless the query already contains newer_than: or after:.' },
  { key: 'GMAIL_LOOKBACK_DAYS', type: 'number', value: 2,
    notes: 'How many days back the Gmail capture looks.' },
  { key: 'CHAT_ENABLED', type: 'boolean', value: true,
    notes: 'TRUE to capture Google Chat (API, with email fallback). FALSE turns Chat capture off.' },
  { key: 'CHAT_LOOKBACK_DAYS', type: 'number', value: 2,
    notes: 'How many days back the Chat capture looks.' },
  { key: 'NEWSLETTER_KEYWORDS', type: 'list', value: 'AI, AI Learning Hub, newsletter, ChatGPT, Claude, Gemini, workshop, PD, training',
    notes: 'Comma-separated. A task whose title/details contain one of these (whole word) is ticked Newsletter.' },
  { key: 'DEFAULT_QUICKADD_CATEGORY', type: 'string', value: 'Work',
    notes: 'Work or Personal: default list for the quick-add bar.' },
  { key: 'PROJECTS', type: 'list', value: 'AI Learning Hub, Teaching, Admin, PD, Parents',
    notes: 'Comma-separated project suggestions.' },
  { key: 'DIRECTOR_NAME', type: 'string', value: '',
    notes: 'Shown on the agenda export when set.' }
];

/** Per-execution memo for readConfig(); globals reset on every Apps Script execution. */
let CONFIG_MEMO_ = null;

function clearConfigMemo() {
  CONFIG_MEMO_ = null;
}

/** Sheet ID from Script Property SHEET_ID, falling back to DEFAULT_SHEET_ID. */
function getSheetId() {
  let id = '';
  try {
    id = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || '';
  } catch (e) {
    id = '';
  }
  id = String(id).trim();
  return id || DEFAULT_SHEET_ID;
}

/** Defaults as a typed object (what readConfig() returns when the tab is empty). */
function configDefaults() {
  const out = {};
  CONFIG_SCHEMA.forEach((entry) => {
    out[entry.key] = coerceConfigValue_(entry.type, entry.value, entry.value);
  });
  return out;
}

/**
 * Reads the Config tab and returns typed values with defaults for missing keys.
 * Lists are split on commas and trimmed; booleans and numbers are coerced.
 * Reads the tab at most once per execution. guard() depends on this function, so it
 * must not itself be guarded, and it never creates the tab (a missing Config tab means
 * defaults; setup() creates the tabs in TAB_ORDER).
 */
function readConfig() {
  if (CONFIG_MEMO_) return cloneConfig_(CONFIG_MEMO_);
  const raw = {};
  try {
    const sheet = openSpreadsheet().getSheetByName(TABS.CONFIG);
    const rows = sheet ? readSheetRows_(sheet, TABS.CONFIG) : [];
    rows.forEach((r) => {
      const key = String(r.key === null || r.key === undefined ? '' : r.key).trim().toUpperCase();
      if (key) raw[key] = r.value;
    });
  } catch (e) {
    // A missing or unreadable Config tab means defaults; the error is not fatal.
    raw.__error = String(e && e.message ? e.message : e);
  }
  const config = {};
  CONFIG_SCHEMA.forEach((entry) => {
    const present = Object.prototype.hasOwnProperty.call(raw, entry.key) && !isBlankCell_(raw[entry.key]);
    config[entry.key] = present
      ? coerceConfigValue_(entry.type, raw[entry.key], entry.value)
      : coerceConfigValue_(entry.type, entry.value, entry.value);
  });
  if (!CATEGORIES.includes(config.DEFAULT_QUICKADD_CATEGORY)) config.DEFAULT_QUICKADD_CATEGORY = 'Work';
  config.TIMEZONE = validTimeZone_(config.TIMEZONE);
  CONFIG_MEMO_ = config;
  return cloneConfig_(config);
}

/** IANA zone ids: "Asia/Dubai", "America/Argentina/Buenos_Aires", "Etc/GMT+4", plus bare UTC/GMT. */
const TIMEZONE_RE_ = /^(UTC|GMT|[A-Za-z]+(\/[A-Za-z0-9_+\-]+){1,2})$/;

/** Zone ids that legitimately sit at +0000 all year round (UTC/GMT aliases, Etc/*, the West African GMT zones). */
const GMT_ZONE_RE_ = /^(UTC|GMT|Etc\/.+|Africa\/(Abidjan|Accra|Bamako|Banjul|Bissau|Conakry|Dakar|Freetown|Lome|Monrovia|Nouakchott|Ouagadougou|Sao_Tome|Timbuktu)|Atlantic\/(Reykjavik|St_Helena)|America\/Danmarkshavn)$/;

/**
 * Keeps a Config TIMEZONE only when it looks like an IANA id and the runtime really knows it.
 * Java's TimeZone.getTimeZone maps an unknown id ("Dubai", "GST", a typo such as "Asia/Dubay")
 * to GMT WITHOUT throwing, which would silently shift every "today" by four hours. So the check
 * does not rely on an exception: the zone is formatted at two instants (January and July) and an
 * offset of +0000 at both means "unknown" unless the id is one of the zones that really are GMT.
 * Rejected values fall back to Asia/Dubai with a WARN in the Log.
 */
function validTimeZone_(tz) {
  const s = String(tz === null || tz === undefined ? '' : tz).trim();
  if (s && TIMEZONE_RE_.test(s)) {
    try {
      const jan = Utilities.formatDate(new Date(Date.UTC(2026, 0, 1, 12)), s, 'Z');
      const jul = Utilities.formatDate(new Date(Date.UTC(2026, 6, 1, 12)), s, 'Z');
      if (!(jan === '+0000' && jul === '+0000') || GMT_ZONE_RE_.test(s)) return s;
    } catch (e) {
      // a runtime that throws for an unknown zone: fall through to the fallback
    }
  }
  if (s && s !== TIMEZONE) {
    // log_ (not log): this runs inside readConfig, which guard() itself calls.
    try { log_('readConfig', 'WARN', 'Config TIMEZONE "' + s + '" is not a valid IANA zone id; using ' + TIMEZONE); } catch (e) { /* ignore */ }
  }
  return TIMEZONE;
}

function cloneConfig_(config) {
  const out = {};
  Object.keys(config).forEach((k) => {
    out[k] = Array.isArray(config[k]) ? config[k].slice() : config[k];
  });
  return out;
}

function isBlankCell_(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function coerceConfigValue_(type, value, fallback) {
  if (type === 'list') {
    if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
    return String(value === null || value === undefined ? '' : value)
      .split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(s)) return true;
    if (['false', 'no', '0', 'off'].includes(s)) return false;
    return !!fallback;
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return isFinite(n) ? n : Number(fallback);
  }
  return String(value === null || value === undefined ? '' : value).trim();
}
