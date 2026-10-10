/**
 * Newsletter.gs — selection of newsletter-tagged Work tasks and a markdown digest
 * grouped by project.
 */

const NEWSLETTER_DEFAULT_DAYS_ = 28;

/** Pure selection: Newsletter-ticked Work tasks Done in [from, to] plus Open ones. */
function selectNewsletterTasks(tasks, from, to) {
  return (tasks || []).filter((t) => {
    if (!t.newsletter) return false;
    if (t.status === 'Open') return true;
    if (t.status === 'Done') return !!t.done && t.done >= from && t.done <= to;
    return false;
  }).sort((a, b) => {
    const pa = a.project.toLowerCase();
    const pb = b.project.toLowerCase();
    if (pa !== pb) {
      if (!pa) return 1;
      if (!pb) return -1;
      return pa < pb ? -1 : 1;
    }
    const sa = a.status === 'Done' ? 0 : 1;
    const sb = b.status === 'Done' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const da = a.status === 'Done' ? a.done : a.created;
    const db = b.status === 'Done' ? b.done : b.created;
    if (da !== db) return da < db ? -1 : 1;
    return (a.row || 0) - (b.row || 0);
  });
}

function mdEscape_(s) {
  return collapseWhitespace(s).replace(/([*_`[\]])/g, '\\$1');
}

/** Markdown grouped by project with notes and links. */
function newsletterMarkdown(tasks, from, to) {
  const lines = ['# AI Learning Hub — newsletter notes', '', '_Window: ' + from + ' to ' + to + '_', ''];
  if (!tasks.length) {
    lines.push('_No newsletter items in this window._');
    return lines.join('\n');
  }
  const groups = [];
  const byName = Object.create(null); // project names are user text: "constructor" must not hit Object.prototype
  tasks.forEach((t) => {
    const name = t.project || 'Other';
    if (!byName[name]) { byName[name] = []; groups.push(name); }
    byName[name].push(t);
  });
  groups.forEach((name) => {
    lines.push('## ' + mdEscape_(name));
    lines.push('');
    byName[name].forEach((t) => {
      let line = '- **' + mdEscape_(t.title) + '**';
      if (t.status === 'Done') line += ' (done ' + t.done + ')';
      else line += ' (in progress)';
      const note = collapseWhitespace(t.note) || collapseWhitespace(t.details);
      if (note) line += ' — ' + mdEscape_(note);
      // Task.link is the raw sheet cell: only http(s) survives, and ")" / whitespace cannot break out of the Markdown
      // link (encodeURIComponent leaves parentheses alone, so they are percent-encoded by hand).
      const link = sanitiseLink(t.link);
      if (link) line += ' — [link](' + link.replace(/[()\s]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) + ')';
      lines.push(line);
    });
    lines.push('');
  });
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/** getNewsletter: {from?, to?} → {tasks:[Task], markdown, from, to}. Default: last 28 days. */
function getNewsletter_(input) {
  const inp = input || {};
  const today = todayDubai();
  const to = validDateOrBlank_(inp.to, 'To') || today;
  const from = validDateOrBlank_(inp.from, 'From') || addDays(to, -NEWSLETTER_DEFAULT_DAYS_);
  if (from > to) throw userError('From must not be after To');
  const tasks = selectNewsletterTasks(readTasks(TABS.WORK), from, to);
  return { tasks: tasks, markdown: newsletterMarkdown(tasks, from, to), from: from, to: to };
}
