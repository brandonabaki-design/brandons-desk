/**
 * Desk.gs — the Desk page (docs/DESK.md). The Claude morning build writes each day's
 * `desk-data` into the Desk tab (one JSON cell per key); getDesk_ assembles it, overlays each
 * item's tracker row (category, taskId, status, done) and lists the Manual tasks added since the
 * build; setDeskItemDone_ ticks an item straight into the Work/Personal tabs, creating its row
 * first when the build has not made one yet. rebuildDesk_ starts the routine through its API
 * trigger (Rebuild now) and getDeskStatus_ tells the page when the new build has landed.
 *
 * The google.script.run entry points (getDesk, setDeskItemDone, getDeskStatus, rebuildDesk) live in Api.gs and run guard()
 * through apiCall_. Everything here that touches the sheet is `_`-suffixed (private), so it is
 * not reachable from the browser on its own. expandDeskLink is a pure helper the client mirrors.
 */

/** desk-data keys stored one per row, besides the split `items`, `items2`, `items3`, … rows. */
const DESK_KEYS_ = ['meta', 'strip', 'cleared', 'priorities', 'coming', 'agenda', 'llt', 'quick'];
const DESK_ITEMS_KEY_RE_ = /^items(\d*)$/;

/** Lanes used when `meta.lanes` is missing or empty (the routine's usual names). */
const DESK_DEFAULT_LANES_ = [
  { key: 'now', title: 'Do today' },
  { key: 'reply', title: 'Reply & follow up' },
  { key: 'later', title: 'This week' }
];

/** At most this many Manual tasks are listed under `added` (newest Created first). */
const DESK_ADDED_MAX_ = 20;

/** Due tags resolve to a date at most this many days before or after today (Dubai). */
const DESK_DUE_WINDOW_ = 7;

const DESK_ITEM_GONE_ = 'That Desk item is no longer on the Desk';

/** setDeskItemDone refuses longer item ids (the routine's ids are short slugs). */
const DESK_ITEM_ID_MAX_ = 200;

/**
 * Rebuild now (docs/DESK.md 5): a POST to the routine's /fire endpoint (Claude Code routines API trigger, research preview)
 * with the token from Script Property DESK_ROUTINE_TOKEN. The start of the last rebuild is kept in Script Property
 * DESK_REBUILD as {startedAt: "yyyy-MM-dd HH:mm", ms, sessionUrl}; it counts as running for DESK_REBUILD_WINDOW_MIN_
 * minutes unless a build newer than its start lands in the Desk tab first, and no second rebuild starts meanwhile.
 */
const DESK_FIRE_URL_ = 'https://api.anthropic.com/v1/claude_code/routines/' + DESK_ROUTINE_ID + '/fire';
const DESK_FIRE_BETA_ = 'experimental-cc-routine-2026-04-01';
const DESK_FIRE_API_VERSION_ = '2023-06-01';
const DESK_TOKEN_PROP_ = 'DESK_ROUTINE_TOKEN';
const DESK_REBUILD_PROP_ = 'DESK_REBUILD';
const DESK_REBUILD_WINDOW_MIN_ = 20;
const DESK_SETUP_HINT_ = 'README, setup step 10';

/** Link shorthands (docs/DESK.md 1): AISA Gmail (thread, search) and personal Gmail (thread-f). */
const DESK_MAIL_WORK_ = 'https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#';
const DESK_MAIL_PERSONAL_ = 'https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:';

const DESK_WEEKDAYS_ = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7
};
/** Words after which a number counts something else ("period 2", "grade 7", "room 12"), never the day. */
const DESK_NOT_DAY_WORDS_ = {
  p: true, per: true, period: true, periods: true, lesson: true, lessons: true, block: true, grade: true, grades: true,
  gr: true, g: true, year: true, years: true, yr: true, y: true, room: true, rm: true, unit: true, week: true, wk: true,
  term: true, class: true, level: true, no: true, number: true, page: true, pg: true, chapter: true, ch: true, part: true,
  step: true, question: true, q: true, version: true, v: true
};
const DESK_MONTHS_ = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

// ---------------------------------------------------------------------------
// Link expansion (shared with the client, which mirrors this function)
// ---------------------------------------------------------------------------

/**
 * Expands a Desk link target into a URL and sanitises it (docs/DESK.md 1). The target is
 * trimmed, then:
 *   "wt:<thread id>" → https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#all/<id>
 *   "w:<search>"     → https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#search/<encodeURIComponent(search), %20 → +>
 *   "p:<id>"         → https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:<id>
 *   anything else    → itself.
 * The result goes through sanitiseLink, so only http(s) URLs survive: "javascript:", "data:",
 * protocol-relative and unknown shorthands come back as ''. The prefixes are case-sensitive,
 * exactly as the routine writes them. A search that cannot be encoded (a lone surrogate from
 * text cut mid-emoji) also gives ''. The client's expandDeskLink (App.html) must return exactly
 * the same string for every input; tests/desk.test.js runs both on the same inputs.
 */
function expandDeskLink(target) {
  const t = str(target).trim();
  let url = t;
  if (t.indexOf('wt:') === 0) url = DESK_MAIL_WORK_ + 'all/' + t.slice(3);
  else if (t.indexOf('w:') === 0) url = deskSearchUrl_(t.slice(2));
  else if (t.indexOf('p:') === 0) url = DESK_MAIL_PERSONAL_ + t.slice(2);
  return sanitiseLink(url);
}

function deskSearchUrl_(search) {
  try {
    return DESK_MAIL_WORK_ + 'search/' + encodeURIComponent(search).replace(/%20/g, '+');
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Reading the Desk tab
// ---------------------------------------------------------------------------

function deskIsObject_(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A string field of desk-data ('' for anything that is not a string or a number). */
function deskText_(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return '';
}

function deskList_(v) {
  return Array.isArray(v) ? v : [];
}

/** [[a, b], …] as two-string pairs; a bare string becomes ['', string] (a source tag). */
function deskPairs_(list) {
  const out = [];
  deskList_(list).forEach((p) => {
    if (Array.isArray(p)) out.push([deskText_(p[0]), deskText_(p[1])]);
    else if (typeof p === 'string') out.push(['', p]);
  });
  return out;
}

/** The Source key that ties a tracker row to a Desk item. */
function deskSourceKey_(itemId) {
  return truncate('desk:' + str(itemId).trim(), SOURCE_KEY_MAX);
}

/**
 * The Built cell as "yyyy-MM-dd HH:mm" (Dubai), or ''. The routine writes text; a cell that
 * Sheets turned into a date-time (a write with user-entered semantics before the column had the
 * text format) is formatted in the configured zone.
 */
function deskBuiltString_(v) {
  if (v === '' || v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return '';
  if (isDateValue(v)) return formatDate(v, 'yyyy-MM-dd HH:mm');
  const s = str(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s);
  if (m && isDateString(m[1]) && (!m[2] || Number(m[2]) < 24)) {
    return m[1] + ' ' + (m[2] ? (m[2].length === 1 ? '0' : '') + m[2] + ':' + m[3] : '00:00');
  }
  const d = /\d{4}/.test(s) ? parseDate(s) : null;
  return d ? formatDate(d, 'yyyy-MM-dd HH:mm') : '';
}

/**
 * Reads the Desk tab. Returns {values:{key: parsed}, items:[{n, key, row, value}] in key order,
 * builtAt, rows (rows used: a known key and a non-blank JSON cell from the newest build),
 * bad:{key, row, error}|null}. Keys are trimmed and lower-cased; unknown keys and blank JSON
 * cells are ignored (a blank cell reads as a missing field). `items`, `items2`, `items3`, … are
 * ordered by their numeric suffix (`items` and `items1` both count as 1).
 *
 * Only rows whose Built is the newest one are used, so rows left from an earlier build (the
 * routine's clear did not run) never mix into today's Desk; when no row has a Built, all rows
 * are used. A key that appears twice keeps its first row (row order otherwise does not
 * matter). Skipped rows are logged as a WARN. The first used cell that does not parse is
 * reported in `bad`; its error names the length and position only, never the cell's text.
 */
function readDeskTab_() {
  const out = { values: {}, items: [], builtAt: '', rows: 0, bad: null };
  const cells = [];
  readRows_(TABS.DESK).forEach((r) => {
    const key = str(r.key).trim().toLowerCase();
    const m = DESK_ITEMS_KEY_RE_.exec(key);
    if (!m && DESK_KEYS_.indexOf(key) < 0) return;
    const text = unguardCell(str(r.json)).trim();
    if (!text) return;
    const n = m ? (m[1] ? Number(m[1]) : 1) : 0;
    const built = deskBuiltString_(r.built);
    if (built > out.builtAt) out.builtAt = built;
    cells.push({ key: key, slot: m ? 'items#' + n : key, n: n, row: r.row, text: text, built: built });
  });
  const skipped = [];
  const used = new Set();
  cells.sort((a, b) => a.row - b.row).forEach((c) => {
    if (out.builtAt && c.built !== out.builtAt) {
      skipped.push(c.key + ' (row ' + c.row + ', Built ' + (c.built || 'blank') + ')');
      return;
    }
    if (used.has(c.slot)) {
      skipped.push(c.key + ' (row ' + c.row + ', repeated key)');
      return;
    }
    used.add(c.slot);
    out.rows++;
    let value;
    try {
      value = JSON.parse(c.text);
    } catch (e) {
      if (!out.bad) out.bad = { key: c.key, row: c.row, error: deskJsonError_(e, c.text) };
      return;
    }
    if (c.n) out.items.push({ n: c.n, key: c.key, row: c.row, value: value });
    else out.values[c.key] = value;
  });
  if (skipped.length) log('getDesk', 'WARN', 'Desk tab rows skipped (newest build ' + (out.builtAt || 'unknown') + '): ' + skipped.join(', '));
  out.items.sort((a, b) => a.n - b.n || a.row - b.row);
  return out;
}

/**
 * A JSON.parse failure as "<length> characters[, error at position <p>]". V8's own message can
 * quote the start of the cell (a task title or a name), which must not reach the Log tab.
 */
function deskJsonError_(e, text) {
  const pos = /position (\d+)/.exec(errorMessage(e));
  return text.length + ' characters' + (pos ? ', error at position ' + pos[1] : '');
}

function deskLanes_(lanes) {
  const out = [];
  const seen = new Set(); // a Set, so a lane key such as "__proto__" is recorded like any other
  deskList_(lanes).forEach((l) => {
    if (!deskIsObject_(l)) return;
    const key = deskText_(l.key).trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key: key, title: deskText_(l.title).trim() || key });
  });
  return out.length ? out : DESK_DEFAULT_LANES_.map((l) => ({ key: l.key, title: l.title }));
}

/**
 * One desk-data item with every documented field present and typed. `prompt` (more context) and `outcome` (what done
 * looks like) are optional and only feed the Prompt Claude button ('' when the routine wrote none).
 */
function deskItem_(it) {
  return {
    id: deskText_(it.id).trim(),
    lane: deskText_(it.lane).trim(),
    title: deskText_(it.title),
    why: deskText_(it.why),
    tags: deskPairs_(it.tags),
    links: deskPairs_(it.links),
    task: deskTaskId_(it.task),
    prompt: deskText_(it.prompt),
    outcome: deskText_(it.outcome)
  };
}

/** A `task` ID with its W-/P- prefix upper-cased ("p-abcdef12" → "P-abcdef12"), as the tabs store IDs. */
function deskTaskId_(v) {
  const s = deskText_(v).trim();
  return /^[wp]-/i.test(s) ? s.slice(0, 2).toUpperCase() + s.slice(2) : s;
}

/**
 * Builds the `desk` object of getDesk from a readDeskTab_ result: `meta` fields at the top
 * level (`rebuild` is left out), every other key with its default when missing or of the
 * wrong type ([] for lists, null for agenda/llt), items concatenated in key order. An item
 * whose id an earlier item already has is left out (and logged), so one id is one card.
 */
function assembleDesk_(tab) {
  const v = tab.values;
  const meta = deskIsObject_(v.meta) ? v.meta : {};
  let items = [];
  tab.items.forEach((part) => {
    if (Array.isArray(part.value)) {
      items = items.concat(part.value);
    } else {
      log('getDesk', 'WARN', 'Desk tab row ' + part.row + ' (' + part.key + ') is not a list of items; skipped');
    }
  });
  const ids = new Set();
  let repeated = 0;
  items = items.filter(deskIsObject_).map(deskItem_).filter((it) => {
    if (!it.id) return true;
    if (ids.has(it.id)) {
      repeated++;
      return false;
    }
    ids.add(it.id);
    return true;
  });
  if (repeated) log('getDesk', 'WARN', repeated + ' Desk item(s) repeat an earlier item\'s id; skipped');
  return {
    built: deskText_(meta.built),
    eyebrow: deskText_(meta.eyebrow),
    sources: deskText_(meta.sources),
    lanes: deskLanes_(meta.lanes),
    strip: deskList_(v.strip),
    items: items,
    cleared: deskList_(v.cleared),
    priorities: deskList_(v.priorities),
    coming: deskList_(v.coming),
    agenda: deskIsObject_(v.agenda) ? v.agenda : null,
    llt: deskIsObject_(v.llt) ? v.llt : null,
    quick: deskList_(v.quick)
  };
}

function deskInvalidMessage_(key) {
  return 'The Desk in the sheet could not be read: the "' + key + '" row is not valid JSON.';
}

// ---------------------------------------------------------------------------
// Items ↔ tracker rows
// ---------------------------------------------------------------------------

/** 'Work' / 'Personal' for a task ID by its W-/P- prefix, else ''. */
function deskTaskTab_(taskId) {
  const p = str(taskId).trim().slice(0, 2).toUpperCase();
  if (p === 'W-') return TABS.WORK;
  if (p === 'P-') return TABS.PERSONAL;
  return '';
}

function deskTagKind_(tag) {
  return str(tag[0]).trim().toLowerCase();
}

/** Work/Personal: from the `task` prefix W-/P-, else Personal when a tag kind is `home`, else Work. */
function deskItemCategory_(item) {
  const byTask = deskTaskTab_(item.task);
  if (byTask) return byTask;
  return item.tags.some((t) => deskTagKind_(t) === 'home') ? TABS.PERSONAL : TABS.WORK;
}

/** Both task tabs read once: {Work:{byId, byKey}, Personal:{byId, byKey}, all:[Task]}. */
function deskTaskIndex_() {
  const index = { all: [] };
  CATEGORIES.forEach((c) => {
    const byId = new Map();
    const byKey = new Map();
    readTasks(c).forEach((t) => {
      if (t.id && !byId.has(t.id)) byId.set(t.id, t);
      if (t.sourceKey && !byKey.has(t.sourceKey)) byKey.set(t.sourceKey, t);
      index.all.push(t);
    });
    index[c] = { byId: byId, byKey: byKey };
  });
  return index;
}

/**
 * A row that moveTask dropped ("Moved to <id>") stands for its copy in the other tab: the
 * item follows the task to its new list instead of reading as Dropped.
 */
function deskFollowMove_(task, index) {
  let t = task;
  for (let hops = 0; hops < 5; hops++) {
    if (t.status !== 'Dropped') return t;
    const m = MOVED_NOTE_RE_.exec(str(t.note).trim());
    const tab = m ? deskTaskTab_(m[1]) : '';
    const next = tab ? index[tab].byId.get(m[1]) : null;
    if (!next || next === t) return t;
    t = next;
  }
  return t;
}

/**
 * The tracker row of a Desk item: the row whose ID is the item's `task` in that ID's tab;
 * else the row whose Source key is desk:<item id>, in the item's category tab first, then the
 * other. A row moveTask left behind resolves to its copy. null when nothing matches.
 */
function deskResolveRow_(item, index) {
  let hit = null;
  const taskTab = deskTaskTab_(item.task);
  if (taskTab) hit = index[taskTab].byId.get(item.task) || null;
  if (!hit && item.id) {
    const key = deskSourceKey_(item.id);
    const first = deskItemCategory_(item);
    const order = first === TABS.PERSONAL ? [TABS.PERSONAL, TABS.WORK] : [TABS.WORK, TABS.PERSONAL];
    for (let i = 0; i < order.length && !hit; i++) hit = index[order[i]].byKey.get(key) || null;
  }
  return hit ? deskFollowMove_(hit, index) : null;
}

/**
 * The date a `due`/`late` tag names, resolved against today (Dubai), as yyyy-MM-dd, or ''.
 * "Today" (also "Today 9:00"), "Tomorrow", "Yesterday" and a yyyy-MM-dd date are read directly.
 * Otherwise the weekday ("Tue", "Thursday"), the day of the month and an optional month name
 * are picked out ("Tue 20", "By Thu 15", "Since Mon 12", "Before Wed 14", "Fri 16 Oct"; times
 * such as "9:00" or "2pm", durations such as "3 days" and numbers that count something else,
 * such as "P3", "period 2" or "Grade 7", are ignored), and the answer is the
 * date within DESK_DUE_WINDOW_ (7) days of today that matches every part given, nearest to
 * today. With both a weekday and a day of the month at most one date in the window matches.
 * A weekday alone matches twice in the window; a `due` tag then prefers today or later and a
 * `late` tag today or earlier. No match, or no date in the text ("Overdue"), gives ''.
 */
function deskTagDate_(text, kind, today) {
  let s = str(text).toLowerCase();
  const iso = /(^|[^\d])(\d{4}-\d{2}-\d{2})(?!\d)/.exec(s);
  if (iso) return isDateString(iso[2]) ? iso[2] : '';
  s = s.replace(/\b\d{1,2}[:.]\d{2}(\s*[ap]\.?m\b\.?)?/g, ' ')
    .replace(/\b\d{1,2}\s*[ap]\.?m\b\.?/g, ' ')
    .replace(/\b\d+\s*(days?|weeks?|wks?|hours?|hrs?|mins?|minutes?)\b/g, ' ');
  if (/\b(today|tonight)\b/.test(s)) return today;
  if (/\btomorrow\b/.test(s)) return addDays(today, 1);
  if (/\byesterday\b/.test(s)) return addDays(today, -1);
  let weekday = 0;
  let month = 0;
  let day = 0;
  let prev = '';
  const words = /[a-z]+|\d+/g;
  let m;
  while ((m = words.exec(s)) !== null) {
    const w = m[0];
    if (/^\d+$/.test(w)) {
      // A number glued to a letter ("P3") or after "period", "grade", … is not the day of the month.
      const glued = m.index > 0 && /[a-z]/.test(s.charAt(m.index - 1));
      const counted = Object.prototype.hasOwnProperty.call(DESK_NOT_DAY_WORDS_, prev);
      const n = Number(w);
      if (!day && !glued && !counted && w.length <= 2 && n >= 1 && n <= 31) day = n;
    } else if (!weekday && Object.prototype.hasOwnProperty.call(DESK_WEEKDAYS_, w)) {
      weekday = DESK_WEEKDAYS_[w];
    } else if (!month && Object.prototype.hasOwnProperty.call(DESK_MONTHS_, w)) {
      month = DESK_MONTHS_[w];
    }
    prev = w;
  }
  if (!weekday && !day) return '';
  const k = str(kind).trim().toLowerCase();
  let best = '';
  let bestRank = Infinity;
  for (let d = -DESK_DUE_WINDOW_; d <= DESK_DUE_WINDOW_; d++) {
    const date = addDays(today, d);
    if (weekday && isoWeekday(date) !== weekday) continue;
    if (day && Number(date.slice(8, 10)) !== day) continue;
    if (month && Number(date.slice(5, 7)) !== month) continue;
    const away = (k === 'due' && d < 0) || (k === 'late' && d > 0) ? 100 : 0;
    const rank = away + Math.abs(d);
    if (rank < bestRank) {
      best = date;
      bestRank = rank;
    }
  }
  return best;
}

/** Due for a new row: the first `due`/`late` tag that resolves, else ''. */
function deskItemDue_(item, today) {
  for (let i = 0; i < item.tags.length; i++) {
    const kind = deskTagKind_(item.tags[i]);
    if (kind !== 'due' && kind !== 'late') continue;
    const d = deskTagDate_(item.tags[i][1], kind, today);
    if (d) return d;
  }
  return '';
}

/** High when the item is in the `now` lane and tagged `late` or `due` today; else Normal. */
function deskItemPriority_(item, today) {
  if (item.lane.toLowerCase() !== 'now') return 'Normal';
  const urgent = item.tags.some((t) => {
    const kind = deskTagKind_(t);
    return kind === 'late' || (kind === 'due' && deskTagDate_(t[1], kind, today) === today);
  });
  return urgent ? 'High' : 'Normal';
}

/**
 * Source for a new row from the first tag that names one: ["","Email"] → Gmail, ["","Chat"] →
 * Chat, ["","Calendar"] → Calendar, a tag "Added by you" → Manual; otherwise Claude.
 */
function deskItemSource_(item) {
  for (let i = 0; i < item.tags.length; i++) {
    const kind = deskTagKind_(item.tags[i]);
    const text = str(item.tags[i][1]).trim().toLowerCase();
    if (text === 'added by you') return 'Manual';
    if (kind !== '') continue;
    if (text === 'email') return 'Gmail';
    if (text === 'chat') return 'Chat';
    if (text === 'calendar') return 'Calendar';
  }
  return 'Claude';
}

/** The item's first link that expands to an http(s) URL, or ''. */
function deskItemLink_(item) {
  for (let i = 0; i < item.links.length; i++) {
    const url = expandDeskLink(item.links[i][1]);
    if (url) return url;
  }
  return '';
}

/**
 * Creates the tracker row for a Desk item that has none (createTasks semantics, so the
 * newsletter auto-tag and dedupe apply). When createTasks finds a similar Open task without a
 * Source key, that task becomes the item's row and gets the desk:<id> key, so the next getDesk
 * finds it again. A similar task that already belongs to something else (it carries another
 * Source key, such as gmail:… or another item's desk:…, or it is another Desk item's row) is
 * never claimed: the item gets a row of its own. `taken` holds the row IDs of the other Desk
 * items. Returns the Task.
 */
function deskCreateTask_(item, taken) {
  const today = todayDubai();
  const category = deskItemCategory_(item);
  const spec = {
    title: item.title,
    details: item.why,
    link: deskItemLink_(item),
    source: deskItemSource_(item),
    due: deskItemDue_(item, today),
    priority: deskItemPriority_(item, today),
    sourceKey: deskSourceKey_(item.id)
  };
  const others = taken || new Set();
  const free = (t) => (!t.sourceKey || t.sourceKey === spec.sourceKey) && !others.has(t.id);
  const result = createTasks(category, [spec], { titleMatch: free });
  if (result.added.length) return result.added[0];
  const skip = result.skipped[0];
  if (skip && skip.reason === 'duplicate' && skip.task) {
    const dup = skip.task;
    if (!dup.sourceKey && dup.row) {
      const patch = {};
      patch[COLUMN.TASK.sourceKey] = spec.sourceKey;
      writeCells(dup.category, dup.row, patch);
      dup.sourceKey = spec.sourceKey;
    }
    return dup;
  }
  if (skip && skip.reason === 'title required') throw userError('That Desk item has no title');
  throw userError('Could not add the Desk item to your list');
}

// ---------------------------------------------------------------------------
// API implementations (entry points in Api.gs)
// ---------------------------------------------------------------------------

/**
 * getDesk: {} → {ok:true, desk, added, builtAt, builtDate, stale, deskUrl, rebuildNow}, or
 * {ok:false, reason:'empty'|'invalid', message, deskUrl, added, rebuildNow} (docs/DESK.md 2).
 * Each item gains category, taskId, status and done from its tracker row; `category` is the
 * row's tab when a row matched, else the item's own rule. `added` = Open Manual tasks (either
 * tab) that are not an item's row, newest Created first, at most 20.
 */
function getDesk_() {
  const tab = readDeskTab_();
  const index = deskTaskIndex_();
  if (tab.bad) {
    log('getDesk', 'ERROR', 'Desk tab row ' + tab.bad.row + ' (' + tab.bad.key + ') is not valid JSON (' + tab.bad.error + ')');
    return { ok: false, reason: 'invalid', message: deskInvalidMessage_(tab.bad.key), deskUrl: DESK_URL, added: deskAdded_(index, new Set()),
      rebuildNow: deskRebuildNow_(tab.builtAt) };
  }
  if (!tab.rows) {
    return { ok: false, reason: 'empty', message: 'The Desk tab has no data yet.', deskUrl: DESK_URL, added: deskAdded_(index, new Set()),
      rebuildNow: deskRebuildNow_(tab.builtAt) };
  }
  const desk = assembleDesk_(tab);
  const taskIds = new Set();
  desk.items.forEach((item) => {
    const row = deskResolveRow_(item, index);
    item.category = row ? row.category : deskItemCategory_(item);
    item.taskId = row ? row.id : '';
    item.status = row ? row.status : '';
    item.done = !!row && (row.status === 'Done' || row.status === 'Dropped');
    if (row) taskIds.add(row.id);
  });
  const builtAt = tab.builtAt;
  const builtDate = builtAt ? builtAt.slice(0, 10) : '';
  return {
    ok: true,
    desk: desk,
    added: deskAdded_(index, taskIds),
    builtAt: builtAt,
    builtDate: builtDate,
    stale: builtDate !== todayDubai(),
    deskUrl: DESK_URL,
    rebuildNow: deskRebuildNow_(builtAt)
  };
}

/** Open tasks with Source Manual that are not the row of any Desk item, newest first, ≤ 20. */
function deskAdded_(index, taskIds) {
  return index.all
    .filter((t) => t.status === 'Open' && str(t.source).trim().toLowerCase() === 'manual' && t.id && !taskIds.has(t.id))
    .sort((a, b) => {
      if (a.created !== b.created) return a.created > b.created ? -1 : 1;
      if (a.updated !== b.updated) return a.updated > b.updated ? -1 : 1;
      return (b.row || 0) - (a.row || 0);
    })
    .slice(0, DESK_ADDED_MAX_);
}

/**
 * setDeskItemDone: {itemId, done, note?} → {task}. Finds the item on the Desk, resolves its
 * tracker row like getDesk (creating it when there is none), then completes it (done:true,
 * note appended when given) or reopens it (done:false). All under one script lock, so a double
 * tap cannot create two rows.
 */
function setDeskItemDone_(input) {
  const inp = input || {};
  if (typeof inp.itemId !== 'string' || !inp.itemId.trim()) throw userError('Desk item id required');
  if (inp.itemId.length > DESK_ITEM_ID_MAX_) throw userError('Desk item id is too long');
  const itemId = inp.itemId.trim();
  // true/false, or the "true"/"false" text every other boolean input accepts (optionalBoolean_)
  const done = typeof inp.done === 'boolean' || typeof inp.done === 'string' ? optionalBoolean_(inp.done) : undefined;
  if (done === undefined) throw userError('done must be true or false');
  if (inp.note !== undefined && inp.note !== null && typeof inp.note !== 'string') throw userError('Note must be text');
  return withLock(() => {
    const tab = readDeskTab_();
    if (tab.bad) throw userError(deskInvalidMessage_(tab.bad.key));
    const items = tab.rows ? assembleDesk_(tab).items : [];
    const item = items.find((it) => it.id === itemId);
    if (!item) throw userError(DESK_ITEM_GONE_);
    const index = deskTaskIndex_();
    let task = deskResolveRow_(item, index);
    if (!task) {
      // The rows of the other items, which a similar-titled tick must not claim
      const taken = new Set();
      items.forEach((other) => {
        if (other === item) return;
        const row = deskResolveRow_(other, index);
        if (row && row.id) taken.add(row.id);
        if (other.task) taken.add(other.task);
      });
      task = deskCreateTask_(item, taken);
    }
    const ref = { category: task.category, id: task.id };
    if (done) return completeTask_({ category: ref.category, id: ref.id, note: inp.note });
    return reopenTask_(ref);
  });
}

// ---------------------------------------------------------------------------
// Rebuild now (docs/DESK.md section 5)
// ---------------------------------------------------------------------------

/**
 * The newest Built of the Desk tab's data rows ('' when there are none), as readDeskTab_ works it out but without parsing
 * or logging anything: getDeskStatus_ runs it about once a minute while a rebuild is on its way.
 */
function deskBuiltAt_() {
  let newest = '';
  readRows_(TABS.DESK).forEach((r) => {
    const key = str(r.key).trim().toLowerCase();
    if (!DESK_ITEMS_KEY_RE_.test(key) && DESK_KEYS_.indexOf(key) < 0) return;
    if (!unguardCell(str(r.json)).trim()) return;
    const built = deskBuiltString_(r.built);
    if (built > newest) newest = built;
  });
  return newest;
}

/** The last rebuild's start as Script Property DESK_REBUILD holds it ({startedAt, ms, sessionUrl}), or null. */
function deskLastRebuild_() {
  let v = null;
  try {
    v = JSON.parse(PropertiesService.getScriptProperties().getProperty(DESK_REBUILD_PROP_) || 'null');
  } catch (e) {
    v = null;
  }
  return deskIsObject_(v) && typeof v.startedAt === 'string' && typeof v.ms === 'number' && isFinite(v.ms) ? v : null;
}

/**
 * Rebuild now as the page shows it: {ready, running, startedAt, sessionUrl}. ready = a token is saved. running = the last
 * rebuild started less than DESK_REBUILD_WINDOW_MIN_ minutes ago and the Desk tab holds no build newer than its start
 * (builtAt and startedAt are both "yyyy-MM-dd HH:mm" in Dubai). startedAt and sessionUrl are '' unless it is running.
 */
function deskRebuildNow_(builtAt) {
  const ready = !!str(PropertiesService.getScriptProperties().getProperty(DESK_TOKEN_PROP_)).trim();
  const last = deskLastRebuild_();
  const age = last ? Date.now() - last.ms : -1;
  const running = !!last && age >= 0 && age < DESK_REBUILD_WINDOW_MIN_ * 60000 && !(str(builtAt) > last.startedAt);
  return { ready: ready, running: running, startedAt: running ? last.startedAt : '', sessionUrl: running ? deskSessionUrl_(last.sessionUrl) : '' };
}

/** The run's session link from the routine API, kept only when it is a claude.ai https URL. */
function deskSessionUrl_(v) {
  const url = sanitiseLink(str(v));
  return url.indexOf('https://claude.ai/') === 0 ? url : '';
}

/** " (<error type>: <message>)" from a routine API error body, kept short for the Log; '' when there is none. */
function deskFireErrorDetail_(body) {
  const err = deskIsObject_(body) && deskIsObject_(body.error) ? body.error : null;
  if (!err) return '';
  const parts = [str(err.type).trim(), truncate(collapseWhitespace(str(err.message)), 160)].filter(Boolean);
  return parts.length ? ' (' + parts.join(': ') + ')' : '';
}

/** What the page says when the routine API refuses a rebuild. */
function deskFireRefusal_(code) {
  if (code === 401 || code === 403) {
    return 'The Desk routine refused the saved token. Generate a new one on the routine\'s API trigger and save it as ' +
      DESK_TOKEN_PROP_ + ' (' + DESK_SETUP_HINT_ + ').';
  }
  if (code === 404) return 'The Desk routine or its API trigger was not found. Check it on claude.ai/code/routines (' + DESK_SETUP_HINT_ + ').';
  if (code === 429) return 'Too many rebuilds in the last hour. Try again later.';
  return 'The rebuild did not start (HTTP ' + code + '). Try again in a few minutes.';
}

/** getDeskStatus: {} → {builtAt, rebuildNow}. The page polls it while a rebuild runs and reads the Desk again once builtAt moves. */
function getDeskStatus_() {
  const builtAt = deskBuiltAt_();
  return { builtAt: builtAt, rebuildNow: deskRebuildNow_(builtAt) };
}

/**
 * rebuildDesk: {} → {started:true, sessionUrl, rebuildNow}. Starts the Desk routine now (the same full build as the
 * morning one) through its API trigger. Refused while the last rebuild is still running, so two builds never write the
 * sheet at once. The token stays on the server and never reaches the Log.
 */
function rebuildDesk_() {
  const props = PropertiesService.getScriptProperties();
  const token = str(props.getProperty(DESK_TOKEN_PROP_)).trim();
  if (!token) {
    throw userError('Rebuild now is not set up yet: give the Desk routine an API trigger and save its token as the Script Property ' +
      DESK_TOKEN_PROP_ + ' (' + DESK_SETUP_HINT_ + ').');
  }
  // The user lock, not withLock's script lock: the HTTP call below must not hold up ticks and saves.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw userError('A rebuild is being started already. Try again in a moment.');
  try {
    const builtAt = deskBuiltAt_();
    const before = deskRebuildNow_(builtAt);
    if (before.running) throw userError('The rebuild started at ' + before.startedAt.slice(11) + ' is still running. The Desk updates here when it lands.');
    const now = new Date();
    let res;
    try {
      res = UrlFetchApp.fetch(DESK_FIRE_URL_, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': DESK_FIRE_BETA_, 'anthropic-version': DESK_FIRE_API_VERSION_ },
        payload: JSON.stringify({ text: 'Manual rebuild requested from the web app\'s Rebuild now button at ' + formatDate(now, 'HH:mm') + ' Gulf time. Do a full build.' }),
        muteHttpExceptions: true
      });
    } catch (e) {
      log('rebuildDesk', 'ERROR', 'Could not reach the routine API: ' + errorMessage(e));
      throw userError('Could not reach the routine service. Try again in a few minutes.');
    }
    const code = res.getResponseCode();
    const body = parseJsonSafe_(res.getContentText());
    if (code < 200 || code >= 300) {
      log('rebuildDesk', 'WARN', 'The routine API refused the rebuild: HTTP ' + code + deskFireErrorDetail_(body));
      throw userError(deskFireRefusal_(code));
    }
    const sessionUrl = deskSessionUrl_(body.claude_code_session_url);
    props.setProperty(DESK_REBUILD_PROP_, JSON.stringify({ startedAt: formatDate(now, 'yyyy-MM-dd HH:mm'), ms: now.getTime(), sessionUrl: sessionUrl }));
    log('rebuildDesk', 'INFO', 'Rebuild started' + (body.claude_code_session_id ? ' (session ' + truncate(str(body.claude_code_session_id), 80) + ')' : ''));
    return { started: true, sessionUrl: sessionUrl, rebuildNow: deskRebuildNow_(builtAt) };
  } finally {
    lock.releaseLock();
  }
}
