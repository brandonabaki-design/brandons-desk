/**
 * Import.gs — importText() and importHtml() (SPEC section 6). The HTML parser is
 * string/regex based and never evaluates anything.
 */

const IMPORT_CATEGORY_RE_ = /^\[\s*(work|personal|w|p)\s*\]\s*/i;
const IMPORT_DONE_RE_ = /^(?:-\s*\[\s*[xX✓✔]\s*\]|\[\s*[xX✓✔]\s*\]|✓|✔|☑)\s*/;
const IMPORT_BULLET_RE_ = /^(?:[-*•◦▪‣☐]|\[\s*\]|\d{1,3}[.)])\s+/;
const IMPORT_BULLET_BARE_RE_ = /^(?:[-*•◦▪‣☐]|\[\s*\])\s*/;
const IMPORT_DUE_AT_RE_ = /\s*@\s*(\d{4}-\d{2}-\d{2})\s*$/;
const IMPORT_DUE_WORD_RE_ = /\s*\bdue\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/i;
const IMPORT_BANG_RE_ = /\s*(!+)\s*$/;

/**
 * Parses one import line. Returns {title, category, done, due, priority, skip, reason}
 * where category is '' when the line carries no [Work]/[Personal] prefix.
 */
function parseImportLine(rawLine) {
  let s = collapseWhitespace(rawLine);
  const out = { title: '', category: '', done: false, due: '', priority: 'Normal', skip: false, reason: '' };
  if (!s) { out.skip = true; out.reason = 'empty'; return out; }
  // Leading tokens in any order: category prefix, done marks, bullets, "[ ]".
  let prev = null;
  while (prev !== s) {
    prev = s;
    const cat = IMPORT_CATEGORY_RE_.exec(s);
    if (cat) {
      const c = cat[1].toLowerCase();
      out.category = c === 'w' || c === 'work' ? 'Work' : 'Personal';
      s = s.slice(cat[0].length);
      continue;
    }
    const done = IMPORT_DONE_RE_.exec(s);
    if (done) { out.done = true; s = s.slice(done[0].length); continue; }
    const bullet = IMPORT_BULLET_RE_.exec(s) || IMPORT_BULLET_BARE_RE_.exec(s);
    if (bullet && bullet[0].length < s.length) { s = s.slice(bullet[0].length); continue; }
  }
  // Trailing tokens in any order: @date, due: date, ! / !!.
  prev = null;
  while (prev !== s) {
    prev = s;
    const at = IMPORT_DUE_AT_RE_.exec(s) || IMPORT_DUE_WORD_RE_.exec(s);
    if (at) {
      if (isDateString(at[1])) out.due = at[1];
      s = s.slice(0, at.index).trim();
      continue;
    }
    const bang = IMPORT_BANG_RE_.exec(s);
    if (bang) { out.priority = 'High'; s = s.slice(0, bang.index).trim(); continue; }
  }
  s = collapseWhitespace(s);
  if (s.length <= 2) { out.skip = true; out.reason = 'too short'; return out; }
  out.title = truncate(s, TITLE_MAX);
  return out;
}

/** Source key for an imported task. */
function importSourceKey(title, created) {
  return 'import:' + sha1Hex(normaliseTitle(title) + '|' + created);
}

/**
 * Turns parsed items into tasks per category in one append per tab.
 * items: [{title, category, project, done, due, priority, link, line, details?}].
 */
function importItems_(items, defaultCategory, created) {
  const added = [];
  const skipped = [];
  const byCategory = {};
  items.forEach((it) => {
    if (it.skip) { skipped.push({ line: it.line, reason: it.reason }); return; }
    const cat = it.category || defaultCategory;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({
      title: it.title,
      details: it.details || '',
      project: it.project || '',
      due: it.due || '',
      priority: it.priority || 'Normal',
      link: it.link || '',
      source: 'Import',
      created: created,
      status: it.done ? 'Done' : 'Open',
      done: it.done ? created : '',
      sourceKey: importSourceKey(it.title, created),
      line: it.line
    });
  });
  CATEGORIES.forEach((cat) => {
    if (!byCategory[cat]) return;
    const r = createTasks(cat, byCategory[cat]);
    r.added.forEach((t) => added.push(t));
    r.skipped.forEach((s) => skipped.push({ line: s.line, reason: s.reason }));
  });
  return { added: added, skipped: skipped };
}

/** Parses import text into items (no sheet access). */
function parseImportText(text, defaultCategory) {
  const lines = str(text).replace(/\r\n?/g, '\n').split('\n');
  const items = [];
  let project = '';
  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line[0] === '#') {
      project = collapseWhitespace(line.replace(/^#+\s*/, ''));
      return;
    }
    const p = parseImportLine(line);
    items.push({
      line: line,
      title: p.title,
      category: p.category || defaultCategory,
      project: project,
      done: p.done,
      due: p.due,
      priority: p.priority,
      link: '',
      skip: p.skip,
      reason: p.reason
    });
  });
  return items;
}

/** importText: {category, text, created?} → {added:[Task], skipped:[{line, reason}]}. */
function importText_(input) {
  const inp = input || {};
  const category = taskTabName(inp.category);
  const created = validDateOrBlank_(inp.created, 'Created') || todayDubai();
  if (!str(inp.text).trim()) return { added: [], skipped: [] };
  const items = parseImportText(inp.text, category);
  return importItems_(items, category, created);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_BLOCK_TAGS_ = ['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th',
  'table', 'section', 'article', 'header', 'footer', 'nav', 'blockquote', 'pre', 'label', 'form', 'fieldset',
  'dt', 'dd', 'dl', 'main', 'aside', 'summary', 'details'];

function stripScriptsAndStyles_(html) {
  return str(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/<(head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

function attr_(attrs, name) {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(attrs || '');
  if (!m) return '';
  return decodeEntities(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
}

function hasAttr_(attrs, name) {
  return new RegExp('(?:^|\\s)' + name + '(?:\\s*=|\\s|$|/)', 'i').test(attrs || '');
}

function classLooksDone_(cls, style) {
  const c = ' ' + str(cls).toLowerCase() + ' ';
  if (/[\s_-](line-through|done|completed|checked|complete|strike)[\s_-]/.test(c)) return true;
  return /line-through/i.test(str(style));
}

function classLooksItem_(cls) {
  return /task|todo/i.test(str(cls));
}

/** SPEC 6: a heading whose text *contains* work/school/AISA → Work, personal/home → Personal (same as the client preview). */
function headingCategory_(text) {
  if (/work|school|aisa/i.test(text)) return 'Work';
  if (/personal|home/i.test(text)) return 'Personal';
  return '';
}

/**
 * Walks headings and list-like elements of an HTML string and returns parsed items.
 * Returns {items, text} where text is the tag-stripped text (for the fallback).
 */
function parseImportHtml(html, defaultCategory) {
  const src = stripScriptsAndStyles_(html);
  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>|([^<]+)/g;
  const items = [];
  const textParts = [];
  let category = defaultCategory;
  let project = '';
  let heading = null; // {tag, text}
  let item = null; // {text, link, done, checkbox, endTag, depth, implicit}
  let m;

  const finishItem = () => {
    if (!item) return;
    const text = collapseWhitespace(decodeEntities(item.text));
    const p = parseImportLine(text);
    items.push({
      line: text,
      title: p.title,
      category: p.category || item.category,
      project: item.project,
      done: item.done || p.done,
      due: p.due,
      priority: p.priority,
      link: item.link,
      skip: p.skip,
      reason: p.reason
    });
    item = null;
  };
  const startItem = (endTag, cls, style, implicit) => {
    finishItem();
    item = { text: '', link: '', done: classLooksDone_(cls, style), endTag: endTag, depth: 0,
      implicit: !!implicit, category: category, project: project };
  };

  while ((m = tokenRe.exec(src)) !== null) {
    if (m[3] !== undefined) {
      const chunk = m[3];
      if (item) item.text += chunk;
      else if (heading) heading.text += chunk;
      textParts.push(chunk);
      continue;
    }
    const closing = m[0][1] === '/';
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const cls = attr_(attrs, 'class');
    const style = attr_(attrs, 'style');

    if (!closing && /^h[1-4]$/.test(tag)) {
      finishItem();
      heading = { tag: tag, text: '' };
      textParts.push('\n# ');
      continue;
    }
    if (closing && heading && tag === heading.tag) {
      const text = collapseWhitespace(decodeEntities(heading.text));
      const cat = headingCategory_(text);
      if (cat) { category = cat; project = ''; } else if (text) { project = text; }
      heading = null;
      textParts.push('\n');
      continue;
    }
    if (heading) continue;

    if (!closing && tag === 'li') {
      startItem('li', cls, style, false);
      textParts.push('\n');
      continue;
    }
    if (!closing && tag === 'input' && /checkbox/i.test(attr_(attrs, 'type'))) {
      const checked = hasAttr_(attrs, 'checked');
      if (item) {
        item.done = item.done || checked;
      } else {
        startItem('', cls, style, true);
        item.done = item.done || checked;
      }
      continue;
    }
    if (!closing && !item && classLooksItem_(cls) && tag !== 'ul' && tag !== 'ol' && tag !== 'input') {
      startItem(tag, cls, style, false);
      textParts.push('\n');
      continue;
    }
    if (item) {
      if (!closing && tag === 'a') {
        const href = sanitiseLink(attr_(attrs, 'href'));
        if (href && !item.link) item.link = href;
      }
      if (!closing && (tag === 's' || tag === 'del' || tag === 'strike')) item.done = true;
      if (!closing && (cls || style) && classLooksDone_(cls, style)) item.done = true;
      if (tag === 'br') item.text += ' ';
      if (item.endTag) {
        if (!closing && tag === item.endTag && !/\/\s*$/.test(attrs)) item.depth++;
        else if (closing && tag === item.endTag) {
          if (item.depth > 0) item.depth--;
          else { finishItem(); textParts.push('\n'); continue; }
        }
      } else if (item.implicit) {
        const boundary = HTML_BLOCK_TAGS_.includes(tag) && !(tag === 'label' && !closing);
        if (boundary || tag === 'br' || (!closing && tag === 'input')) {
          finishItem();
          textParts.push('\n');
          if (!closing && tag === 'input' && /checkbox/i.test(attr_(attrs, 'type'))) {
            startItem('', cls, style, true);
            item.done = item.done || hasAttr_(attrs, 'checked');
          } else if (!closing && tag === 'li') {
            startItem('li', cls, style, false);
          }
          continue;
        }
      }
      continue;
    }
    if (HTML_BLOCK_TAGS_.includes(tag) || tag === 'br') textParts.push('\n');
  }
  finishItem();

  const text = decodeEntities(textParts.join(''))
    .split('\n').map((l) => collapseWhitespace(l)).filter(Boolean).join('\n');
  return { items: items, text: text };
}

/** importHtml: {html, category?, created?} → {added:[Task], skipped:[{line, reason}]}. */
function importHtml_(input) {
  const inp = input || {};
  const category = taskTabName(inp.category || 'Work');
  const created = validDateOrBlank_(inp.created, 'Created') || todayDubai();
  const html = str(inp.html);
  if (!html.trim()) return { added: [], skipped: [] };
  const parsed = parseImportHtml(html, category);
  if (parsed.items.length) {
    return importItems_(parsed.items, category, created);
  }
  const items = parseImportText(parsed.text, category);
  return importItems_(items, category, created);
}
