/*
 * In-browser shim for google.script.run (and google.script.url / google.script.history), backed by
 * fixtures that mirror SPEC.md section 5. Injected by tests/ui/render.js before the page scripts run,
 * or inlined by `node tests/ui/assemble.js --mock` for a manual look in a browser.
 *
 * Test hooks on window.__mock: state (fixtures), latency (ms), failNext(fn, message), calls (log), deskMode, agendaStamp(weekOf).
 * The agenda (getAgenda / saveAgenda / regenerateAgenda) follows docs/AGENDA.md section 2: rows carry `generated`, every answer a
 * `stamp` of the week, and saveAgenda refuses a stale stamp; editing window.__mock.state.agendaStore stands in for a Claude routine.
 * The Desk (getDesk / setDeskItemDone, docs/DESK.md) is a fictional board; ?desk=empty|invalid|stale|minimal in the
 * page URL (or window.__mock.deskMode) switches what getDesk answers.
 */
(function () {
  'use strict';
  var TODAY = '2026-10-10'; // Saturday; next Tuesday = 2026-10-13, weekOf = 2026-10-12
  var NOW = TODAY + 'T09:30:00+04:00';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdDays(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null; }
  function daysYmd(n) { var d = new Date(n * 86400000); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function addDays(s, n) { return daysYmd(ymdDays(s) + n); }
  function d(n) { return addDays(TODAY, n); }
  function weekday(s) { return new Date(ymdDays(s) * 86400000).getUTCDay(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var seq = 0;
  function newId(prefix) { seq++; return prefix + '-' + ('mock' + (1000 + seq)).slice(-8); }
  function norm(s) { return String(s || '').toLowerCase().replace(/^(re|fwd?)\s*:\s*/, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function dice(a, b) {
    var A = norm(a).split(' '), B = norm(b).split(' ');
    if (A.length < 3 || B.length < 3) return 0;
    var set = {}, inter = 0; A.forEach(function (w) { set[w] = 1; }); B.forEach(function (w) { if (set[w]) { inter++; set[w] = 0; } });
    return 2 * inter / (A.length + B.length);
  }
  function similar(a, b) { return norm(a) === norm(b) || dice(a, b) >= 0.8; }

  var KEYWORDS = ['ai', 'newsletter', 'hub', 'workshop', 'ai learning hub'];
  function autoTag(title, details) {
    var text = ' ' + norm(title + ' ' + (details || '')) + ' ';
    return KEYWORDS.some(function (k) { return text.indexOf(' ' + k + ' ') >= 0; });
  }

  function task(cat, n, o) {
    var base = { id: (cat === 'Work' ? 'W-' : 'P-') + ('fx' + n + 'abcdef').slice(0, 8), category: cat, created: d(-10), title: '', details: '', source: 'Manual', link: '',
      status: 'Open', done: '', note: '', project: '', newsletter: false, discuss: false, due: '', priority: 'Normal', sourceKey: '', updated: d(-2) + 'T08:00:00+04:00', row: 0 };
    Object.keys(o).forEach(function (k) { base[k] = o[k]; });
    return base;
  }
  var tasks = [
    task('Work', 1, { title: 'Send AI Learning Hub launch note to staff', project: 'AI Learning Hub', due: d(0), newsletter: true, discuss: true, priority: 'High', source: 'Gmail',
      link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3a1b2c3d4e5f6', details: 'Sarah asked for the numbers before Tuesday.', sourceKey: 'gmail:18f3a1b2c3d4e5f6', created: d(-6) }),
    task('Work', 2, { title: 'Book the robotics lab for the Grade 9 showcase', project: 'Robotics Club', due: d(-3), source: 'Chat', link: 'https://chat.google.com/room/AAAAxyz123', sourceKey: 'chat:spaces/AAAAxyz123/messages/abc.def', created: d(-9) }),
    task('Work', 3, { title: 'Review Grade 10 Design unit plan draft', project: 'Grade 10 Design', due: d(-1), priority: 'High', source: 'Claude', link: 'https://docs.google.com/document/d/1AbCdEf/edit', details: 'Lina shared the draft rubric on Thursday.', created: d(-4) }),
    task('Work', 4, { title: 'Prepare for PD session on AI tools', project: 'PD', due: d(2), newsletter: true, source: 'Calendar', link: 'https://www.google.com/calendar/event?eid=abc123', sourceKey: 'cal:abc123', created: d(-2) }),
    task('Work', 5, { title: 'Reply to Fatima Al Ali about the AI club trial', due: d(0), source: 'Gmail', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3a1b2c3d4e5aa', sourceKey: 'gmail:18f3a1b2c3d4e5aa', created: d(-1) }),
    task('Work', 6, { title: 'Order replacement micro:bits', project: 'Robotics Club', discuss: true, source: 'Claude', details: 'Twelve units are dead; budget code needed.', created: d(-12) }),
    task('Work', 7, { title: 'Draft newsletter section on student AI projects', project: 'AI Learning Hub', newsletter: true, priority: 'Low', source: 'Claude', created: d(-3) }),
    task('Work', 8, { title: 'Update the department website links', source: 'Import', details: 'Three broken links reported by the comms team.', created: d(-20), updated: d(-10) + 'T10:00:00+04:00' }),
    task('Work', 9, { title: 'Share workshop photos with comms team', project: 'AI Learning Hub', newsletter: true, status: 'Done', done: d(0), note: 'Sent 12 photos', updated: NOW, created: d(-5) }),
    task('Work', 10, { title: 'Submit term 1 assessment calendar', status: 'Done', done: d(0), note: 'Submitted to Omar', updated: d(0) + 'T08:10:00+04:00', created: d(-8) }),
    task('Work', 11, { title: 'Set up Chat space for Hub mentors', project: 'AI Learning Hub', discuss: true, status: 'Done', done: d(-2), link: 'https://chat.google.com/room/AAAAmentors', note: 'Eight mentors joined', created: d(-7) }),
    task('Work', 12, { title: 'Finish MYP unit reflections', project: 'Grade 10 Design', status: 'Done', done: d(-5), created: d(-15) }),
    task('Work', 13, { title: 'Test AI tutor pilot with Grade 8', project: 'AI Learning Hub', newsletter: true, status: 'Done', done: d(-8), note: 'Students liked the hints mode; 2 of 24 opted out.', link: 'https://docs.google.com/document/d/1PilotNotes/edit', created: d(-20) }),
    task('Work', 14, { title: 'Migrate shared drive folders', status: 'Dropped', note: 'Superseded by the IT migration plan', created: d(-30) }),
    task('Work', 15, { title: 'Write Hub workshop recap for newsletter', project: 'AI Learning Hub', newsletter: true, status: 'Done', done: d(-20), note: 'Published in the September issue', created: d(-25) }),
    task('Work', 16, { title: 'Check projector in room 204', link: 'javascript:alert(1)', details: 'Reported by Daniel; flickers after 10 minutes.', created: d(0), updated: NOW }),
    task('Work', 17, { title: 'Coordinate with the IT team about single sign-on for the new AI Learning Hub portal and confirm the rollout timeline with leadership', project: 'AI Learning Hub', priority: 'High', discuss: true, source: 'Claude', created: d(-1) }),
    task('Personal', 1, { title: 'Renew car registration', project: 'Home', due: d(-6), priority: 'High', source: 'Claude', created: d(-14) }),
    task('Personal', 2, { title: 'Call the dentist to reschedule', due: d(0), created: d(-3) }),
    task('Personal', 3, { title: 'Pay the electricity bill', due: d(1), link: 'https://www.dewa.gov.ae/en/consumer/billing', created: d(-2) }),
    task('Personal', 4, { title: 'Buy a birthday present for Maya', due: d(4), created: d(-1) }),
    task('Personal', 5, { title: 'Plan the weekend hike', priority: 'Low', source: 'Claude', created: d(-6) }),
    task('Personal', 6, { title: 'Book flights for December', project: 'Home', source: 'Claude', details: 'Compare Emirates and Etihad for 18–28 Dec.', created: d(-9) }),
    task('Personal', 7, { title: 'Sort out gym membership', status: 'Done', done: d(0), updated: NOW, created: d(-4) }),
    task('Personal', 8, { title: 'Return library books', status: 'Done', done: d(-3), created: d(-10) }),
    task('Personal', 9, { title: 'Fix the garden tap', status: 'Dropped', note: 'Landlord is handling it', created: d(-21) }),
    task('Personal', 10, { title: "Read 'The Alignment Problem'", source: 'Import', created: d(-30) }),
    // Ticked on the Desk two days ago: the board item "swim" finds it by its Source key and shows ticked.
    task('Personal', 11, { title: 'Confirm the swim lesson slot', source: 'Claude', sourceKey: 'desk:swim', status: 'Done', done: d(-2), created: d(-4), updated: d(-2) + 'T07:10:00+04:00' })
  ];
  tasks.forEach(function (t, i) { t.row = i + 2; });

  function inboxRow(n, o) {
    var base = { id: 'I-' + ('ib' + n + 'abcdef').slice(0, 8), captured: d(0) + 'T06:15:0' + (n % 10) + '+04:00', source: 'Gmail', from: '', subject: '', snippet: '', link: '', sourceKey: '', status: 'New', taskId: '', categoryHint: 'Work' };
    Object.keys(o).forEach(function (k) { base[k] = o[k]; });
    return base;
  }
  var inbox = [
    inboxRow(1, { from: 'Sarah Mitchell <smitchell@aisa.sch.ae>', subject: 'Agenda for Tuesday?', snippet: 'Hi Brandon, could you send me the Hub numbers before our meeting? I would like to share them with the board on Wednesday.', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3b0c1d2e3f4a5', sourceKey: 'gmail:18f3b0c1d2e3f4a5' }),
    inboxRow(2, { from: 'Omar Haddad <ohaddad@aisa.sch.ae>', subject: 'Robotics kit inventory', snippet: 'Can you confirm how many micro:bit kits are still working? Finance needs the count by Thursday for the reorder.', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3b0c1d2e3f4b6', sourceKey: 'gmail:18f3b0c1d2e3f4b6' }),
    inboxRow(3, { source: 'Chat', from: 'Lina Park (lpark@aisa.sch.ae)', subject: 'Grade 10 Design team', snippet: '@Brandon can you share the rubric by Thursday? The students start the project on Sunday.', link: 'https://chat.google.com/room/AAAAdesign10', sourceKey: 'chat:spaces/AAAAdesign10/messages/1.1' }),
    inboxRow(4, { from: 'Fatima Al Ali <fatima.alali@example.com>', subject: 'Question about the AI club', snippet: 'My daughter Noor would like to join the AI club on Wednesdays. Is there still space, and what does she need to bring?', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3b0c1d2e3f4c7', sourceKey: 'gmail:18f3b0c1d2e3f4c7', categoryHint: 'Work' }),
    inboxRow(5, { source: 'Chat', from: 'Daniel Reyes (dreyes@aisa.sch.ae)', subject: 'Direct message', snippet: 'Are you free to look at the PD slides this afternoon? I want to add the AI tools demo you ran last week.', link: 'https://mail.google.com/chat/u/0/#chat/space/AAAAdm12345', sourceKey: 'chat:spaces/AAAAdm12345/messages/2.2' }),
    inboxRow(6, { from: 'AISA Comms <comms@aisa.sch.ae>', subject: 'Newsletter deadline Friday', snippet: 'Reminder that Hub newsletter content is due Friday 17:00. Please send photos as attachments rather than Drive links.', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3b0c1d2e3f4d8', sourceKey: 'gmail:18f3b0c1d2e3f4d8' }),
    inboxRow(7, { from: 'Omar Haddad <ohaddad@aisa.sch.ae>', subject: 'Assessment calendar', snippet: 'Thanks, received.', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3b0c1d2e3f4e9', sourceKey: 'gmail:18f3b0c1d2e3f4e9', status: 'Promoted', taskId: 'W-fx10abcd', captured: d(-1) + 'T06:15:00+04:00' }),
    inboxRow(8, { from: 'Library <library-noreply@example.com>', subject: 'New arrivals this week', snippet: 'Twelve new titles are on the shelf.', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3b0c1d2e3f4f0', sourceKey: 'gmail:18f3b0c1d2e3f4f0', status: 'Ignored', captured: d(-1) + 'T06:15:00+04:00' })
  ];

  var config = { ALLOWED_EMAILS: 'bbaki@aisa.sch.ae, brandon.abaki@gmail.com', TIMEZONE: 'Asia/Dubai', MEETING_DAY: 'Tuesday', GMAIL_QUERY: 'to:me newer_than:2d -from:me', GMAIL_LOOKBACK_DAYS: '2',
    CHAT_ENABLED: 'TRUE', CHAT_LOOKBACK_DAYS: '2', NEWSLETTER_KEYWORDS: 'AI, newsletter, Hub, workshop, AI Learning Hub', DEFAULT_QUICKADD_CATEGORY: 'Work',
    PROJECTS: 'AI Learning Hub, Grade 10 Design, Robotics Club, PD, Home', DIRECTOR_NAME: 'Dr Sarah Mitchell' };
  var projects = config.PROJECTS.split(',').map(function (s) { return s.trim(); });

  function nextMeeting(from) { var dow = 2, s = from; while (weekday(s) !== dow) s = addDays(s, 1); return s; }
  function weekOf(meeting) { var s = meeting; while (weekday(s) !== 1) s = addDays(s, -1); return s; }
  var agendaStore = {}; // weekOf -> sections
  (function seedAgenda() {
    var m = nextMeeting(TODAY), REVIEW = '2026-10-05 14:46 claude-review', MINE = '2026-10-06 18:02:11';
    agendaStore[weekOf(m)] = {
      'Done': [{ order: 1, item: 'Set up Chat space for Hub mentors', detail: 'AI Learning Hub · Eight mentors joined', link: 'https://chat.google.com/room/AAAAmentors', taskId: 'W-fx11abcd', generated: REVIEW },
        { order: 2, item: 'Finish MYP unit reflections', detail: 'Grade 10 Design', link: '', taskId: 'W-fx12abcd', generated: REVIEW },
        { order: 3, item: 'Share workshop photos with comms team', detail: 'AI Learning Hub · Sent 12 photos', link: '', taskId: 'W-fx9abcde', generated: MINE }],
      'In progress': [{ order: 1, item: 'Send AI Learning Hub launch note to staff', detail: 'AI Learning Hub · due ' + d(0) + ' · High', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3a1b2c3d4e5f6', taskId: 'W-fx1abcde', generated: REVIEW },
        { order: 2, item: 'Review Grade 10 Design unit plan draft', detail: 'Grade 10 Design · due ' + d(-1) + ' · High', link: 'https://docs.google.com/document/d/1AbCdEf/edit', taskId: 'W-fx3abcde', generated: REVIEW },
        { order: 3, item: 'Order replacement micro:bits', detail: 'Robotics Club · Twelve units are dead; budget code needed.', link: '', taskId: 'W-fx6abcde', generated: REVIEW }],
      'Questions': [{ order: 1, item: '«Book the robotics lab for the Grade 9 showcase» is overdue (due ' + d(-3) + '). Still a priority, or should the date move?', detail: '', link: '', taskId: 'W-fx2abcde', generated: REVIEW },
        { order: 2, item: 'Order replacement micro:bits: Twelve units are dead; budget code needed.', detail: '', link: '', taskId: 'W-fx6abcde', generated: REVIEW },
        { order: 3, item: 'The newsletter draft includes 3 items. Is there anything you would like added or held back?', detail: '', link: '', taskId: '', generated: MINE },
        { order: 4, item: 'Anything from your side that should go on my list for next week?', detail: '', link: '', taskId: '', generated: REVIEW }],
      'Documents': [{ order: 1, item: 'Review Grade 10 Design unit plan draft', detail: 'The rubric to agree', link: 'https://docs.google.com/document/d/1AbCdEf/edit', taskId: 'W-fx3abcde', generated: REVIEW },
        { order: 2, item: 'Set up Chat space for Hub mentors', detail: '', link: 'https://chat.google.com/room/AAAAmentors', taskId: 'W-fx11abcd', generated: MINE }],
      'Notes': [{ order: 1, item: 'Sarah wants the Hub numbers before the board meeting on Wednesday.', detail: '', link: '', taskId: '', generated: MINE }]
    };
  })();

  function windowFor(meeting) { return { from: addDays(meeting, -7), to: addDays(meeting, -1) }; }
  function inWindow(s, w) { return s && s >= w.from && s <= w.to; }
  function buildDraft(meeting, keep) {
    var w = windowFor(meeting), work = tasks.filter(function (t) { return t.category === 'Work'; });
    var done = work.filter(function (t) { return t.status === 'Done' && inWindow(t.done, w); }).sort(function (a, b) { return (a.project > b.project ? 1 : a.project < b.project ? -1 : 0) || (a.done > b.done ? 1 : -1); });
    var prog = work.filter(function (t) { return t.status === 'Open' && (t.priority === 'High' || t.discuss || inWindow(t.updated.slice(0, 10), w) || inWindow(t.created, w)); })
      .sort(function (a, b) { return (a.priority === 'High' ? 0 : 1) - (b.priority === 'High' ? 0 : 1) || ((a.due || '9') > (b.due || '9') ? 1 : -1); });
    var sections = { 'Done': [], 'In progress': [], 'Questions': [], 'Documents': [], 'Notes': [] };
    done.forEach(function (t, i) { sections.Done.push({ order: i + 1, item: t.title, detail: (t.project || '') + (t.note ? ' · ' + t.note : ''), link: t.link, taskId: t.id, generated: 'web-draft' }); });
    prog.forEach(function (t, i) { sections['In progress'].push({ order: i + 1, item: t.title, detail: [t.project, t.due ? 'due ' + t.due : '', t.priority === 'High' ? 'High' : ''].filter(Boolean).join(' · '), link: t.link, taskId: t.id, generated: 'web-draft' }); });
    var qs = [];
    work.filter(function (t) { return t.status === 'Open' && t.due && t.due < TODAY; }).slice(0, 1).forEach(function (t) { qs.push('«' + t.title + '» is overdue (due ' + t.due + '). Still a priority, or should the date move?'); });
    work.filter(function (t) { return t.status === 'Open' && t.discuss; }).slice(0, 1).forEach(function (t) { qs.push(t.title + ': ' + (t.note || t.details || 'what do you need from me on this?')); });
    qs.push('Anything from your side that should go on my list for next week?');
    sections.Questions = (keep && keep.Questions && keep.Questions.length) ? clone(keep.Questions) : qs.map(function (q, i) { return { order: i + 1, item: q, detail: '', link: '', taskId: '', generated: 'web-draft' }; });
    var seen = {};
    work.filter(function (t) { return t.link && /^https?:/i.test(t.link) && ((t.discuss && (t.status === 'Open' || (t.status === 'Done' && inWindow(t.done, w)))) || (t.status === 'Done' && inWindow(t.done, w))); })
      .forEach(function (t) { if (!seen[t.link]) { seen[t.link] = 1; sections.Documents.push({ order: sections.Documents.length + 1, item: t.title, detail: '', link: t.link, taskId: t.id, generated: 'web-draft' }); } });
    sections.Notes = (keep && keep.Notes) ? clone(keep.Notes) : [];
    return { meetingDate: meeting, weekOf: weekOf(meeting), window: w, saved: false, sections: sections, stamp: agendaStamp(weekOf(meeting)) };
  }
  // The week's fingerprint, as Agenda.gs computes it from the sheet: any change to the stored rows changes it (djb2 over the rows).
  function agendaStamp(wk) {
    var text = JSON.stringify(agendaStore[wk] || null), h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return ('0000000' + h.toString(16)).slice(-8) + ('0000000' + text.length.toString(16)).slice(-8);
  }
  // Column H as saveAgenda writes it (docs/AGENDA.md section 2), and read back: a tag stays, "web-draft" gets the save time,
  // anything else is Brandon's line (the save time, read back as yyyy-MM-dd HH:mm:ss).
  var AGENDA_TAG = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? (claude-desk|claude-review|web-draft)$/;
  function savedGenerated(g) {
    if (typeof g === 'string' && AGENDA_TAG.test(g)) return g;
    if (g === 'web-draft') return TODAY + ' 09:30 web-draft';
    return TODAY + ' 09:30:00';
  }
  var AGENDA_CONFLICT = "This agenda changed since you opened it (Claude's weekly review or another tab saved it). Copy any edits you want to keep, then reload the agenda.";

  var log = [{ time: NOW, fn: 'captureInbox', level: 'INFO', message: 'gmail 4, chat 2, chatMode api' }, { time: d(-1) + 'T06:16:00+04:00', fn: 'healSheet', level: 'INFO', message: 'Work: filled 1 ID' }];

  // ---- The Desk (docs/DESK.md): a fictional board shaped like the routine's desk-data -------------------------------
  // Every tag kind (late, due, new, home, gh, list, '' source) and link kind (https, wt:, w:, p:, and a javascript: target that
  // must render as plain text). Items with "task" point at fixture tasks; "swim" is found by Source key desk:swim; the rest have
  // no tracker row yet, so ticking them makes setDeskItemDone create one.
  var DESK_URL = 'https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr';
  var CAL = 'https://calendar.google.com/calendar/r/day/2026/10/';
  var desk = {
    built: 'Sat 10 Oct, 9:12am Gulf time', eyebrow: 'Saturday 10 October 2026 · weekend',
    sources: 'the AISA calendar, personal Gmail, the 06:15 Inbox capture and your tracker sheet',
    lanes: [{ key: 'now', title: 'Do today' }, { key: 'reply', title: 'Reply & follow up' }, { key: 'later', title: 'This week' }],
    rebuild: { trigger: 'trig_fixture' },
    strip: [
      { cls: 'now', d: 'Sat 10 · today', t: 'Weekend catch-up', s: 'Hub numbers and the unit plan review', href: CAL + '10' },
      { cls: '', d: 'Mon 12', t: 'Hub numbers to the director', s: 'Board meets Wednesday', href: CAL + '12' },
      { cls: '', d: 'Tue 13', t: 'Director meeting 10:00', s: 'Agenda below', href: CAL + '13' },
      { cls: 'pd', d: 'Wed 14', t: 'PD day: AI tools', s: 'You present at 14:00', href: CAL + '14' },
      { cls: 'brk', d: 'Thu 15 – Fri 16', t: 'Mid-term break', s: 'No classes', href: '' },
      { cls: '', d: 'Mon 19', t: 'Back at school', s: 'Grade 10 project week', href: CAL + '19' },
      { cls: 'odd', d: 'Tue 20', t: 'Grade 9 showcase', s: 'Robotics lab from 13:00', href: 'javascript:alert(1)' }
    ],
    items: [
      { id: 'launch', lane: 'now', title: 'Send the Hub launch note to staff', why: 'Sarah wants it out before Tuesday, with the sign-up numbers in the first line.',
        tags: [['due', 'Today'], ['', 'Email']], links: [['Thread', 'wt:18f3a1b2c3d4e5f6'], ['Numbers', 'https://docs.google.com/spreadsheets/d/1HubNumbersDemo/edit']], task: 'W-fx1abcde' },
      { id: 'unitplan', lane: 'now', title: 'Review the Grade 10 Design unit plan', why: 'Lina shared the draft rubric on Thursday; the project starts Monday.',
        tags: [['late', 'Since Fri 9'], ['', 'Docs']], links: [['Draft', 'https://docs.google.com/document/d/1AbCdEf/edit']], task: 'W-fx3abcde' },
      { id: 'lab', lane: 'now', title: 'Book the robotics lab for the showcase', why: 'Omar asked in Chat on Wednesday; the lab fills up before the break.',
        tags: [['late', 'Since Wed 7'], ['', 'Chat']], links: [['Chat', 'https://chat.google.com/room/AAAAxyz123']], task: 'W-fx2abcde' },
      { id: 'pdslides', lane: 'now', title: 'Add the AI tools demo to the PD slides', why: 'Daniel wants it in before the Wednesday session; ten minutes, live.',
        tags: [['new', 'New'], ['due', 'Today'], ['', 'Chat']], links: [['Slides', 'https://docs.google.com/presentation/d/1PdSlidesDemo/edit']] },
      { id: 'dentist', lane: 'now', title: 'Call the dentist to reschedule', why: '', tags: [['due', 'Today'], ['home', 'Personal']], links: [], task: 'P-fx2abcde' },
      { id: 'bill', lane: 'now', title: 'Pay the electricity bill', why: 'Due tomorrow; the reminder came on Thursday.', tags: [['due', 'Sun 11'], ['home', 'Personal'], ['', 'Email']],
        links: [['Pay', 'https://www.dewa.gov.ae/en/consumer/billing'], ['Reminder', 'p:1812345678901234567']], task: 'P-fx3abcde' },
      { id: 'fatima', lane: 'reply', title: 'Reply to Fatima about the AI club trial', why: 'Her daughter wants to join on Wednesdays; she asked what to bring.',
        tags: [['due', 'Today'], ['', 'Email']], links: [['Thread', 'wt:18f3a1b2c3d4e5aa']], task: 'W-fx5abcde' },
      { id: 'kits', lane: 'reply', title: 'Tell Omar how many micro:bit kits still work', why: 'Finance needs the count by Thursday for the reorder.',
        tags: [['due', 'Thu 15'], ['', 'Email']], links: [['Thread', 'wt:18f3b0c1d2e3f4b6'], ['Inventory', 'https://docs.google.com/spreadsheets/d/1KitsDemo/edit']] },
      { id: 'rubric', lane: 'reply', title: 'Share the Grade 10 rubric with Lina', why: 'She asked in the team chat; students start on Monday.',
        tags: [['late', 'Since Thu 8'], ['', 'Chat']], links: [['Chat', 'https://chat.google.com/room/AAAAdesign10']] },
      { id: 'swim', lane: 'reply', title: 'Confirm the swim lesson slot', why: 'The pool asked for Saturday or Sunday mornings.',
        tags: [['home', 'Personal'], ['', 'Email']], links: [['Thread', 'p:1812345678901234999']] },
      { id: 'survey', lane: 'reply', title: 'Check the link in the parent survey email', why: 'A parent said the form link does nothing on a phone.',
        tags: [['', 'Email']], links: [['Survey', 'javascript:alert(1)'], ['Search mail', 'w:subject:(parent survey) newer_than:7d']] },
      { id: 'invite', lane: 'later', title: 'Accept the GitHub invite for the Hub repo', why: 'Expires in six days.',
        tags: [['gh', 'GitHub'], ['new', 'New']], links: [['Invite', 'https://github.com/orgs/example-school/invitation']] },
      { id: 'sso', lane: 'later', title: 'Agree the single sign-on date with IT', why: 'Leadership wants a date before the Hub portal goes live.',
        tags: [['list', 'Your list']], links: [['Portal plan', 'https://docs.google.com/document/d/1SsoPlanDemo/edit']], task: 'W-fx17abcd' },
      { id: 'pdprep', lane: 'later', title: 'Prepare the PD session on AI tools', why: 'Forty minutes on Wednesday afternoon; the room has two projectors.',
        tags: [['due', 'Mon 12'], ['', 'Calendar']], links: [['Event', 'https://www.google.com/calendar/event?eid=abc123']], task: 'W-fx4abcde' },
      { id: 'rota', lane: 'later', title: 'Confirm the Hub mentor rota', why: 'Two mentors asked to swap weeks.',
        tags: [['due', 'Mon 12'], ['list', 'Your list']], links: [['Mail search', 'w:subject:(mentor rota) newer_than:7d']] },
      { id: 'flights', lane: 'later', title: 'Book flights for December', why: 'Compare the two airlines for 18–28 Dec.',
        tags: [['home', 'Personal'], ['list', 'Your list']], links: [['Compare', 'https://www.example.com/flights']], task: 'P-fx6abcde' }
    ],
    cleared: ['Sent the assessment calendar to Omar', 'Shared the workshop photos with comms', 'Sorted out the gym membership'],
    priorities: [
      { title: 'AI Learning Hub launch', tag: ['due', 'Tue 13'], points: ['Launch note drafted; numbers still to add', 'Eight mentors joined the Chat space', 'Newsletter section due Friday'],
        links: [['Hub plan', 'https://docs.google.com/document/d/1HubPlanDemo/edit'], ['Mentor space', 'https://chat.google.com/room/AAAAmentors']] },
      { title: 'Grade 10 Design unit', tag: ['late', 'Rubric overdue'], points: ['Unit plan review this weekend', 'Rubric to Lina before Monday'],
        links: [['Unit plan', 'https://docs.google.com/document/d/1AbCdEf/edit']] },
      { title: 'Robotics Club', points: ['Twelve micro:bits need replacing'], links: [] }
    ],
    coming: [
      { when: 'Tue 13', hl: true, title: 'Director meeting', detail: '10:00 · agenda below', href: CAL + '13' },
      { when: 'Wed 14', title: 'PD day: AI tools', detail: 'You present at 14:00', href: CAL + '14' },
      { when: 'Wed 14', title: 'Board meeting', detail: 'Hub numbers go in the pack' },
      { when: 'Thu 15', title: 'Mid-term break', detail: 'Back on Mon 19' },
      { when: 'Tue 20', title: 'Grade 9 showcase', detail: 'Robotics lab, 13:00', href: CAL + '20' },
      { when: 'Wed 21', title: 'Leadership team meeting', detail: '14:00–15:00', href: 'javascript:alert(1)' }
    ],
    agenda: { title: 'Tue 13 Oct · Director', open: true, meeting: '2026-10-13', sections: [
      { name: 'Done', items: [{ t: 'Hub mentors on board', d: 'Eight mentors in the Chat space' }, { t: 'Assessment calendar submitted', d: 'Sent to Omar on Friday' }, { t: 'Workshop photos shared', d: '' }] },
      { name: 'In progress', items: [{ t: 'Hub launch note', d: '+18 sign-ups since the soft launch' }, { t: 'Grade 10 Design unit plan', d: 'Rubric with Lina by Monday' }, { t: 'Single sign-on for the Hub portal', d: 'Waiting on IT for a date' }] },
      { name: 'Decisions & questions', items: [{ t: 'Budget for twelve replacement micro:bits?', d: 'Finance needs the code by Thursday' }, { t: '=Shared drive clean-up: still mine?', d: '' }, { t: 'Anything from your side for my list next week?', d: '' }] }
    ] },
    llt: { title: 'LLT · Wed 14 Oct, 2–3pm', padlet: 'https://padlet.com/example-school/fill-us-in-demo',
      working: ['Hub launch and mentor rota', 'Grade 10 Design unit with the team', 'PD session on AI tools'], great: ['Eight mentors signed up in a week'], night: ['Single sign-on date still open'],
      raise: [{ t: 'One message on AI use in coursework', d: 'Every division should give students the same rule before the break.' }] },
    quick: [
      ['Tracker sheet', 'Work, Personal, Inbox', 'https://docs.google.com/spreadsheets/d/1TrackerDemo/edit'],
      ['Work mail', 'Inbox', 'https://mail.google.com/mail/u/0/#inbox'],
      ['Calendar', 'This week', 'https://calendar.google.com/calendar/r/week'],
      ['Hub folder', 'Shared drive', 'https://drive.google.com/drive/folders/1HubDemo'],
      ['Personal mail', 'Gmail', 'https://mail.google.com/mail/u/1/#inbox'],
      ['Old intranet', 'Not a web link', 'ftp://intranet.example.com/']
    ]
  };
  // ?desk=minimal: a board with most fields missing or of the wrong type (the page must still render).
  var deskMinimal = { items: [
    { id: 'm1', lane: 'nowhere', title: 'An item whose lane is not listed', tags: 'not a list', links: [['Only a label']] },
    { id: 'm2', title: 'No lane and no why' }, 'not an object', { lane: 'now', title: 'No id, so it cannot be ticked' }
  ], agenda: null, llt: null, quick: 'not a list' };
  var AISA_MAIL = 'https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#';
  function deskExpand(t) {
    t = String(t || '').trim();
    if (t.indexOf('wt:') === 0) return AISA_MAIL + 'all/' + t.slice(3);
    if (t.indexOf('w:') === 0) return AISA_MAIL + 'search/' + encodeURIComponent(t.slice(2)).replace(/%20/g, '+');
    if (t.indexOf('p:') === 0) return 'https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:' + t.slice(2);
    return t;
  }
  function webLink(u) { u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }
  function deskTags(it) { return Array.isArray(it.tags) ? it.tags.filter(Array.isArray) : []; } // the minimal board has tags that are not a list
  function deskCategory(it) {
    if (/^W-/.test(it.task || '')) return 'Work';
    if (/^P-/.test(it.task || '')) return 'Personal';
    return deskTags(it).some(function (t) { return t[0] === 'home'; }) ? 'Personal' : 'Work';
  }
  // DESK.md section 2: the row with the item's task ID in its tab, else the row whose Source key is desk:<item id> in either tab.
  function deskRow(it) {
    var cat = deskCategory(it), row = null;
    if (it.task) tasks.forEach(function (t) { if (!row && t.id === it.task && t.category === cat) row = t; });
    if (!row) tasks.forEach(function (t) { if (!row && t.sourceKey === 'desk:' + it.id) row = t; });
    return row;
  }
  var WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function deskDue(it) {
    var tag = ''; deskTags(it).forEach(function (t) { if (!tag && (t[0] === 'due' || t[0] === 'late')) tag = String(t[1]); });
    if (/\btoday\b/i.test(tag)) return TODAY;
    if (/\btomorrow\b/i.test(tag)) return d(1);
    var m = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(\d{1,2})\b/i.exec(tag);
    if (!m) return '';
    for (var k = -14; k <= 30; k++) { var c = d(k); if (+c.slice(8) === +m[2] && WD[weekday(c)] === m[1].toLowerCase()) return c; }
    return '';
  }
  function deskSource(it) {
    var src = 'Claude';
    deskTags(it).forEach(function (t) {
      if (t[0] === '' && t[1] === 'Email') src = 'Gmail';
      else if (t[0] === '' && (t[1] === 'Chat' || t[1] === 'Calendar')) src = t[1];
      else if (t[0] === 'list' && t[1] === 'Added by you') src = 'Manual';
    });
    return src;
  }
  function deskAdded(linked) {
    return clone(tasks.filter(function (t) { return t.status === 'Open' && t.source === 'Manual' && !linked[t.id]; })
      .sort(function (a, b) { return a.created < b.created ? 1 : a.created > b.created ? -1 : 0; }).slice(0, 20));
  }
  function getDeskImpl() {
    var mode = mock.deskMode;
    if (mode === 'empty') return { ok: false, reason: 'empty', message: 'The Desk tab has no rows yet.', deskUrl: DESK_URL, added: deskAdded({}) };
    if (mode === 'invalid') return { ok: false, reason: 'invalid', message: 'The Desk tab could not be read: items2 is not valid JSON.', deskUrl: DESK_URL, added: deskAdded({}) };
    var src = clone(mode === 'minimal' ? deskMinimal : desk), linked = {};
    if (mode === 'stale') { src.built = 'Fri 9 Oct, 6:45am Gulf time'; src.eyebrow = 'Friday 9 October 2026 · school day'; }
    var items = (Array.isArray(src.items) ? src.items : []).map(function (it) {
      if (!it || typeof it !== 'object') return it;
      var row = deskRow(it);
      it.category = deskCategory(it); it.taskId = row ? row.id : ''; it.status = row ? row.status : ''; it.done = !!row && (row.status === 'Done' || row.status === 'Dropped');
      if (row) linked[row.id] = 1;
      return it;
    });
    var builtDate = mode === 'stale' ? d(-1) : TODAY;
    return { ok: true, desk: { built: src.built, eyebrow: src.eyebrow, sources: src.sources, lanes: src.lanes, strip: src.strip, items: items, cleared: src.cleared,
      priorities: src.priorities, coming: src.coming, agenda: src.agenda, llt: src.llt, quick: src.quick },
      added: deskAdded(linked), builtAt: builtDate + ' 09:12', builtDate: builtDate, stale: builtDate !== TODAY, deskUrl: DESK_URL };
  }
  function setDeskItemDoneImpl(p) {
    var it = null;
    if (mock.deskMode !== 'empty' && mock.deskMode !== 'invalid') (mock.deskMode === 'minimal' ? deskMinimal : desk).items.forEach(function (x) { if (x && x.id === p.itemId) it = x; });
    if (!it) throw new Error('That Desk item is no longer on the Desk');
    var row = deskRow(it);
    if (!row) { // create the tracker row first (createTasks semantics), Source key desk:<item id>
      var due = deskDue(it), late = deskTags(it).some(function (t) { return t[0] === 'late'; });
      var r = addTaskImpl({ category: deskCategory(it), title: it.title, details: it.why || '', link: webLink(deskExpand(((Array.isArray(it.links) ? it.links : [])[0] || [])[1])),
        source: deskSource(it), due: due, priority: it.lane === 'now' && (late || due === TODAY) ? 'High' : 'Normal', sourceKey: 'desk:' + it.id });
      row = findTask(null, r.task.id);
    }
    if (p.done) { if (row.status !== 'Done' || !row.done) row.done = TODAY; row.status = 'Done'; row.note = appendNote(row.note, p.note); }
    else { row.status = 'Open'; row.done = ''; }
    return { task: touch(row) };
  }

  function findTask(cat, id) { for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id && (!cat || tasks[i].category === cat)) return tasks[i]; throw new Error('Task not found: ' + id); }
  function appendNote(existing, note) {
    var n = String(note || '').replace(/\s+/g, ' ').trim(), e = String(existing || '').trim();
    if (!n) return e;
    if (e === n || e.slice(-(n.length + 3)) === ' · ' + n) return e;
    return e ? e + ' · ' + n : n;
  }
  function touch(t) { t.updated = NOW; return clone(t); }
  function sortTasks(list) {
    function rank(t) { if (t.status !== 'Open') return 4; if (t.due && t.due < TODAY) return 0; if (t.due === TODAY) return 1; if (t.priority === 'High') return 2; return 3; }
    return list.slice().sort(function (a, b) { return rank(a) - rank(b) || (b.created > a.created ? 1 : b.created < a.created ? -1 : 0); });
  }
  function addTaskImpl(p) {
    if (!p.title || !String(p.title).trim()) throw new Error('Title is required');
    if (p.category !== 'Work' && p.category !== 'Personal') throw new Error('Category must be Work or Personal');
    var dup = null;
    tasks.forEach(function (t) { if (dup) return; if (p.sourceKey && t.sourceKey === p.sourceKey) dup = t; else if (t.status === 'Open' && t.category === p.category && similar(t.title, p.title)) dup = t; });
    if (dup) return { task: clone(dup), duplicate: true };
    var t = task(p.category, 900 + (++seq), { id: newId(p.category === 'Work' ? 'W' : 'P'), title: String(p.title).trim().slice(0, 140), details: p.details || '', project: p.project || '', due: p.due || '',
      priority: p.priority || 'Normal', link: p.link || '', source: p.source || 'Manual', created: p.created || TODAY, sourceKey: p.sourceKey || '', discuss: !!p.discuss,
      newsletter: p.newsletter === undefined ? autoTag(p.title, p.details) : !!p.newsletter, status: p.status || 'Open', done: p.done || '', updated: NOW, row: tasks.length + 2 });
    tasks.push(t);
    return { task: clone(t), duplicate: false };
  }

  var handlers = {
    getBootstrap: function () {
      function counts(cat) { var c = { open: 0, dueToday: 0, overdue: 0 }; tasks.forEach(function (t) { if (t.category !== cat || t.status !== 'Open') return; c.open++; if (t.due === TODAY) c.dueToday++; else if (t.due && t.due < TODAY) c.overdue++; }); return c; }
      return { user: 'bbaki@aisa.sch.ae', today: TODAY, config: clone(config), projects: projects.slice(), categories: ['Work', 'Personal'],
        counts: { work: counts('Work'), personal: counts('Personal'), inboxNew: inbox.filter(function (i) { return i.status === 'New'; }).length } };
    },
    listTasks: function (p) {
      var list = tasks.filter(function (t) {
        if (p.category && t.category !== p.category) return false;
        if (p.status && t.status !== p.status) return false;
        var dateField = t.status === 'Done' ? t.done : t.created;
        if (p.from && dateField < p.from) return false;
        if (p.to && dateField > p.to) return false;
        if (p.search) { var q = String(p.search).toLowerCase(); if (![t.title, t.details, t.note, t.project].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; })) return false; }
        return true;
      });
      return { tasks: clone(sortTasks(list)) };
    },
    addTask: addTaskImpl,
    updateTask: function (p) {
      var t = findTask(p.category, p.id), patch = p.patch || {};
      ['title', 'details', 'project', 'due', 'priority', 'link', 'newsletter', 'discuss', 'note', 'status'].forEach(function (k) { if (patch[k] !== undefined) t[k] = patch[k]; });
      if (patch.status === 'Done' && !t.done) t.done = TODAY;
      if (patch.status === 'Open') t.done = '';
      return { task: touch(t) };
    },
    // Same semantics as Tasks.gs: a note is APPENDED with " · " (never replaced), a task already Done keeps its Done date.
    completeTask: function (p) { var t = findTask(p.category, p.id); if (t.status !== 'Done' || !t.done) t.done = TODAY; t.status = 'Done'; t.note = appendNote(t.note, p.note); return { task: touch(t) }; },
    reopenTask: function (p) { var t = findTask(p.category, p.id); t.status = 'Open'; t.done = ''; return { task: touch(t) }; },
    dropTask: function (p) { var t = findTask(p.category, p.id); t.status = 'Dropped'; t.note = appendNote(t.note, p.note); return { task: touch(t) }; },
    // The copy keeps the Source key; the Dropped original gives it up (Tasks.gs moveTaskLocked_).
    moveTask: function (p) {
      var t = findTask(p.category, p.id);
      var copy = clone(t); copy.id = newId(p.toCategory === 'Work' ? 'W' : 'P'); copy.category = p.toCategory; copy.row = tasks.length + 2; copy.updated = NOW;
      tasks.push(copy); t.status = 'Dropped'; t.note = 'Moved to ' + copy.id; t.sourceKey = ''; touch(t);
      return { task: clone(copy) };
    },
    importText: function (p) {
      var added = [], skipped = [], project = '', created = p.created || TODAY;
      String(p.text || '').split(/\r?\n/).forEach(function (line) {
        var raw = line.trim(); if (!raw) return;
        if (raw.charAt(0) === '#') { project = raw.replace(/^#+\s*/, '').trim(); return; }
        var s = raw, cat = p.category || 'Work', done = false, due = '', prio = 'Normal', m;
        m = /^\[(work|personal|w|p)\]\s*/i.exec(s); if (m) { cat = /^(w|work)$/i.test(m[1]) ? 'Work' : 'Personal'; s = s.slice(m[0].length); }
        m = /^(-\s*\[[xX]\]|\[[xX]\]|✓|✔|☑)\s*/.exec(s); if (m) { done = true; s = s.slice(m[0].length); }
        m = /^([-*•☐]|\[ \]|\d+[.)])\s*/.exec(s); if (m) s = s.slice(m[0].length);
        m = /\s*(!{1,2})$/.exec(s); if (m) { prio = 'High'; s = s.slice(0, m.index); }
        m = /\s*(?:@|due:\s*)(\d{4}-\d{2}-\d{2})$/i.exec(s); if (m) { due = m[1]; s = s.slice(0, m.index); }
        s = s.trim();
        if (s.length <= 2) { skipped.push({ line: raw, reason: 'too short' }); return; } // measured after stripping, as Import.gs does
        var r = addTaskImpl({ category: cat, title: s, project: project, due: due, priority: prio, source: 'Import', created: created, sourceKey: 'import:' + norm(s) + '|' + created, status: done ? 'Done' : 'Open', done: done ? created : '' });
        if (r.duplicate) skipped.push({ line: raw, reason: 'duplicate' }); else added.push(r.task);
      });
      return { added: added, skipped: skipped };
    },
    importHtml: function (p) { return handlers.importText({ category: p.category || 'Work', text: String(p.html || '').replace(/<[^>]+>/g, '\n'), created: p.created }); },
    listInbox: function (p) { var st = p.status || 'New'; return { items: clone(inbox.filter(function (i) { return i.status === st; }).sort(function (a, b) { return a.captured < b.captured ? 1 : -1; })) }; },
    promoteInbox: function (p) {
      var it = null; inbox.forEach(function (i) { if (i.id === p.inboxId) it = i; });
      if (!it) throw new Error('Inbox item not found');
      var r = addTaskImpl({ category: p.category || it.categoryHint || 'Work', title: p.title || it.subject, project: p.project, due: p.due, priority: p.priority, source: it.source, link: it.link, sourceKey: it.sourceKey, details: it.snippet.slice(0, 200) });
      it.status = 'Promoted'; it.taskId = r.task.id;
      return { task: r.task };
    },
    ignoreInbox: function (p) { var ok = false; inbox.forEach(function (i) { if (i.id === p.inboxId) { i.status = 'Ignored'; ok = true; } }); if (!ok) throw new Error('Inbox item not found'); return { ok: true }; },
    getAgenda: function (p) {
      var meeting = p.meetingDate || nextMeeting(TODAY), wk = weekOf(meeting);
      if (agendaStore[wk]) return { meetingDate: meeting, weekOf: wk, window: windowFor(meeting), saved: true, sections: clone(agendaStore[wk]), stamp: agendaStamp(wk) };
      return buildDraft(meeting, null);
    },
    saveAgenda: function (p) {
      if (!p.meetingDate) throw new Error('meetingDate is required');
      var wk = weekOf(p.meetingDate);
      if (typeof p.stamp === 'string' && p.stamp !== agendaStamp(wk)) throw new Error(AGENDA_CONFLICT);
      var n = 0, sections = {}; ['Done', 'In progress', 'Questions', 'Documents', 'Notes'].forEach(function (s) {
        sections[s] = clone((p.sections && p.sections[s]) || []).map(function (r) { r.generated = savedGenerated(r.generated); return r; });
        n += sections[s].length;
      });
      agendaStore[wk] = sections;
      return { ok: true, rows: n, stamp: agendaStamp(wk) };
    },
    regenerateAgenda: function (p) { var meeting = p.meetingDate || nextMeeting(TODAY); return buildDraft(meeting, agendaStore[weekOf(meeting)] || null); },
    getNewsletter: function (p) {
      var to = p.to || TODAY, from = p.from || addDays(to, -28);
      var list = tasks.filter(function (t) { return t.category === 'Work' && t.newsletter && ((t.status === 'Done' && t.done >= from && t.done <= to) || t.status === 'Open'); });
      var groups = {}, order = [];
      list.forEach(function (t) { var k = t.project || 'Other'; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(t); });
      var md = ['# AI Learning Hub — newsletter notes', '', '_Window: ' + from + ' to ' + to + '_', '']; // Newsletter.gs heading
      order.forEach(function (k) { md.push('## ' + k); groups[k].forEach(function (t) { md.push('- ' + (t.status === 'Done' ? '[x] ' : '[ ] ') + t.title + (t.note ? ' — ' + t.note : '') + (t.link ? ' (' + t.link + ')' : '')); }); md.push(''); });
      return { tasks: clone(list), markdown: md.join('\n') };
    },
    runCaptureNow: function () {
      var n = inbox.length + 1;
      inbox.push(inboxRow(n, { from: 'Priya Nair <pnair@aisa.sch.ae>', subject: 'Hub mentor schedule', snippet: 'Could you confirm the mentor rota for next week? Two mentors asked to swap.', link: 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/18f3c0d1e2f3a4b' + n, sourceKey: 'gmail:18f3c0d1e2f3a4b' + n, captured: NOW }));
      log.unshift({ time: NOW, fn: 'runCaptureNow', level: 'INFO', message: 'gmail 1, chat 0, chatMode ' + window.__mock.chatMode });
      return { gmail: 1, chat: 0, chatMessages: 0, chatMode: window.__mock.chatMode, errors: [] };
    },
    getLog: function (p) { return { rows: clone(log.slice(0, p.limit || 100)) }; },
    getDesk: getDeskImpl,
    setDeskItemDone: setDeskItemDoneImpl
  };

  var deskParam = /[?&]desk=(empty|invalid|stale|minimal)\b/.exec(location.search);
  var mock = { state: { tasks: tasks, inbox: inbox, agendaStore: agendaStore, config: config, today: TODAY, desk: desk }, latency: 40, chatMode: 'api', calls: [], failures: {},
    deskMode: deskParam ? deskParam[1] : 'ok',
    failNext: function (name, message) { mock.failures[name] = message || 'Mock failure'; }, agendaStamp: agendaStamp };
  window.__mock = mock;

  function runner(success, failure) {
    var r = {
      withSuccessHandler: function (fn) { return runner(fn, failure); },
      withFailureHandler: function (fn) { return runner(success, fn); },
      withUserObject: function () { return r; }
    };
    Object.keys(handlers).forEach(function (name) {
      r[name] = function (payload) {
        var input = payload === undefined ? {} : JSON.parse(JSON.stringify(payload));
        mock.calls.push({ name: name, payload: input });
        setTimeout(function () {
          if (mock.failures[name]) { var msg = mock.failures[name]; delete mock.failures[name]; if (failure) failure(new Error(msg)); return; }
          var out;
          try { out = JSON.parse(JSON.stringify(handlers[name](input))); }
          catch (e) { if (failure) failure(e); else console.error(e); return; }
          if (success) success(out);
        }, mock.latency);
      };
    });
    return r;
  }
  window.google = {
    script: {
      run: runner(null, null),
      host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, editor: {} },
      url: { getLocation: function (cb) { cb({ hash: location.hash.replace(/^#/, ''), parameter: {}, parameters: {} }); } },
      history: {
        push: function (s, q, hash) { if (hash !== undefined) location.hash = hash; },
        replace: function (s, q, hash) { if (hash !== undefined && location.hash.replace(/^#/, '') !== hash) location.replace('#' + hash); },
        setChangeHandler: function (cb) { window.addEventListener('hashchange', function () { cb({ state: null, location: { hash: location.hash.replace(/^#/, ''), parameter: {}, parameters: {} } }); }); }
      }
    }
  };
})();
