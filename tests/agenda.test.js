'use strict';
const { makeTask, findUnsafe } = require('./fixtures/helpers');

// Fixed clock: Thursday 2026-10-08 10:00 Dubai → meeting Tue 2026-10-13, weekOf 2026-10-12, window 10-06..10-12.
const NOW = '2026-10-08T06:00:00Z';
const TODAY = '2026-10-08';
const WIN = { meetingDate: '2026-10-13', weekOf: '2026-10-12', from: '2026-10-06', to: '2026-10-12' };

function rules(sb, tasks) {
  return sb.gs.buildQuestions(tasks, WIN, TODAY).map((q) => q.rule);
}

module.exports = async function (t) {
  await t.test('window maths and default meeting date', (sb, assert) => {
    assert.deepEqual(sb.gs.agendaWindow('2026-10-13'), WIN);
    const r = sb.gs.getAgenda_({});
    assert.equal(r.meetingDate, '2026-10-13');
    assert.equal(r.weekOf, '2026-10-12');
    assert.deepEqual(r.window, { from: '2026-10-06', to: '2026-10-12' });
    assert.equal(r.saved, false);
    assert.deepEqual(Object.keys(r.sections), ['Done', 'In progress', 'Questions', 'Documents', 'Notes']);
    assert.equal(r.sections.Questions.length, 1, 'only the closing question on an empty sheet');
    assert.equal(findUnsafe(r), '');
    const explicit = sb.gs.getAgenda_({ meetingDate: '2026-10-20' });
    assert.deepEqual(explicit.window, { from: '2026-10-13', to: '2026-10-19' });
    assert.equal(explicit.weekOf, '2026-10-19');
    assert.throws(() => sb.gs.getAgenda_({ meetingDate: 'next tuesday' }), /Meeting date/);
    sb.mock.seed('Config', [['MEETING_DAY', 'Monday', '']]);
    sb.gs.clearConfigMemo();
    assert.equal(sb.gs.getAgenda_({}).meetingDate, '2026-10-12');
  }, { now: NOW });

  await t.test('rule 1: overdue open task fires, due today / Done tasks do not', (sb, assert) => {
    const overdue = makeTask({ title: 'Late', due: '2026-10-01' }, TODAY);
    const qs = sb.gs.buildQuestions([overdue], WIN, TODAY);
    assert.deepEqual(qs.map((q) => q.rule), [1, 8]);
    assert.equal(qs[0].text, '«Late» is overdue (due 2026-10-01). Still a priority, or should the date move?');
    assert.equal(qs[0].taskId, overdue.id);
    assert.deepEqual(rules(sb, [makeTask({ due: TODAY }, TODAY)]), [8], 'due today is not overdue');
    assert.deepEqual(rules(sb, [makeTask({ due: '2026-10-01', status: 'Done', done: '2026-10-02' }, TODAY)]), [8]);
    assert.deepEqual(rules(sb, [makeTask({ due: '2026-10-01', status: 'Dropped' }, TODAY)]), [8]);
    const earlier = makeTask({ title: 'Earlier', due: '2026-09-20' }, TODAY);
    const later = makeTask({ title: 'Later', due: '2026-10-05' }, TODAY);
    assert.equal(sb.gs.buildQuestions([later, earlier], WIN, TODAY)[0].taskId, earlier.id, 'most overdue first');
  });

  await t.test('rule 2: open > 14 days and not updated in 7 fires; fresh or recently updated does not', (sb, assert) => {
    const stale = makeTask({ title: 'Stale', created: '2026-09-10', updated: '2026-09-20T10:00:00+04:00' }, TODAY);
    const qs = sb.gs.buildQuestions([stale], WIN, TODAY);
    assert.deepEqual(qs.map((q) => q.rule), [2, 8]);
    assert.equal(qs[0].text, "«Stale» has been open since 2026-09-10. What's blocking it, and is it still mine?");
    assert.deepEqual(rules(sb, [makeTask({ created: '2026-09-28', updated: '2026-09-28T10:00:00+04:00' }, TODAY)]), [8], '10 days old');
    assert.deepEqual(rules(sb, [makeTask({ created: '2026-09-10', updated: '2026-10-07T10:00:00+04:00' }, TODAY)]), [8], 'updated yesterday');
    assert.deepEqual(rules(sb, [makeTask({ created: '2026-09-10', updated: '' }, TODAY)]), [2, 8], 'never updated counts as stale');
    // Exact boundaries: "older than 14 days" and "not updated in 7" are strict.
    assert.deepEqual(rules(sb, [makeTask({ created: '2026-09-24', updated: '2026-09-20T10:00:00+04:00' }, TODAY)]), [8], 'exactly 14 days old does not fire');
    assert.deepEqual(rules(sb, [makeTask({ created: '2026-09-23', updated: '2026-10-01T10:00:00+04:00' }, TODAY)]), [8], 'updated exactly 7 days ago does not fire');
    assert.deepEqual(rules(sb, [makeTask({ created: '2026-09-23', updated: '2026-09-30T10:00:00+04:00' }, TODAY)]), [2, 8], '15 days old, updated 8 days ago fires');
    assert.deepEqual(rules(sb, [makeTask({ created: '2026-09-10', updated: '2026-09-20T10:00:00+04:00', status: 'Done', done: '2026-10-07' }, TODAY)]), [8]);
  });

  await t.test('rule 3: discuss-ticked task uses note, then details, then the default', (sb, assert) => {
    const withNote = makeTask({ title: 'Budget', discuss: true, note: 'Need sign-off', details: 'ignored' }, TODAY);
    let qs = sb.gs.buildQuestions([withNote], WIN, TODAY);
    assert.deepEqual(qs.map((q) => q.rule), [3, 8]);
    assert.equal(qs[0].text, 'Budget: Need sign-off');
    qs = sb.gs.buildQuestions([makeTask({ title: 'Budget', discuss: true, details: 'Some context' }, TODAY)], WIN, TODAY);
    assert.equal(qs[0].text, 'Budget: Some context');
    qs = sb.gs.buildQuestions([makeTask({ title: 'Budget', discuss: true }, TODAY)], WIN, TODAY);
    assert.equal(qs[0].text, 'Budget: what do you need from me on this?');
    assert.deepEqual(rules(sb, [makeTask({ discuss: false }, TODAY)]), [8]);
    assert.deepEqual(rules(sb, [makeTask({ discuss: true, status: 'Dropped' }, TODAY)]), [8]);
    assert.deepEqual(rules(sb, [makeTask({ discuss: true, status: 'Done', done: '2026-10-07' }, TODAY)]), [3, 8], 'Done in window still discussed');
    assert.deepEqual(rules(sb, [makeTask({ discuss: true, status: 'Done', done: '2026-09-01' }, TODAY)]), [8], 'Done long ago is not');
  });

  await t.test('rule 4: three Done tasks in one project this window', (sb, assert) => {
    const mk = (n, project, done) => makeTask({ title: 'Done ' + n, status: 'Done', done: done || '2026-10-07', project: project }, TODAY);
    const three = [mk(1, 'AI Learning Hub'), mk(2, 'AI Learning Hub', '2026-10-06'), mk(3, 'AI Learning Hub', '2026-10-08')];
    const qs = sb.gs.buildQuestions(three, WIN, TODAY);
    assert.deepEqual(qs.map((q) => q.rule), [4, 8]);
    assert.equal(qs[0].text, 'AI Learning Hub: 3 items closed this week. Should this be in the Hub newsletter or shared with staff?');
    assert.deepEqual(rules(sb, three.slice(0, 2)), [8], 'two is not enough');
    assert.deepEqual(rules(sb, [mk(1, 'A'), mk(2, 'B'), mk(3, 'C')]), [8], 'different projects');
    assert.deepEqual(rules(sb, [mk(1, ''), mk(2, ''), mk(3, '')]), [8], 'blank project is not a project');
    assert.deepEqual(rules(sb, [mk(1, 'X', '2026-10-01'), mk(2, 'X', '2026-10-02'), mk(3, 'X', '2026-10-07')]), [8], 'outside the window');
    const busier = three.concat([mk(4, 'Teaching'), mk(5, 'Teaching'), mk(6, 'Teaching'), mk(7, 'Teaching')]);
    assert.equal(sb.gs.buildQuestions(busier, WIN, TODAY)[0].text.indexOf('Teaching: 4 items'), 0, 'busiest project wins');
    const proto = [mk(1, 'constructor'), mk(2, 'constructor'), mk(3, 'constructor')];
    assert.deepEqual(rules(sb, proto), [4, 8], 'a project named after an Object.prototype member still counts');
    assert.equal(sb.gs.buildQuestions(proto, WIN, TODAY)[0].text.indexOf('constructor: 3 items'), 0);
  });

  await t.test('rule 5: Done tasks with Newsletter ticked', (sb, assert) => {
    const one = makeTask({ status: 'Done', done: '2026-10-07', newsletter: true }, TODAY);
    const two = makeTask({ status: 'Done', done: '2026-10-06', newsletter: true }, TODAY);
    let qs = sb.gs.buildQuestions([one], WIN, TODAY);
    assert.deepEqual(qs.map((q) => q.rule), [5, 8]);
    assert.equal(qs[0].text, "The newsletter draft includes 1 items. Is there anything you'd like added or held back?", 'SPEC 6a fixed template, also for n = 1');
    qs = sb.gs.buildQuestions([one, two], WIN, TODAY);
    assert.equal(qs[0].text, "The newsletter draft includes 2 items. Is there anything you'd like added or held back?");
    assert.deepEqual(rules(sb, [makeTask({ status: 'Done', done: '2026-09-01', newsletter: true }, TODAY)]), [8], 'outside the window');
    assert.deepEqual(rules(sb, [makeTask({ status: 'Open', newsletter: true }, TODAY)]), [8], 'Open does not count');
    assert.deepEqual(rules(sb, [makeTask({ status: 'Done', done: '2026-10-07', newsletter: false }, TODAY)]), [8]);
  });

  await t.test('rule 6: Calendar-sourced task due within 7 days', (sb, assert) => {
    const soon = makeTask({ title: 'Parents evening', source: 'Calendar', due: '2026-10-10' }, TODAY);
    const qs = sb.gs.buildQuestions([soon], WIN, TODAY);
    assert.deepEqual(qs.map((q) => q.rule), [6, 8]);
    assert.equal(qs[0].text, '«Parents evening» is coming up on 2026-10-10. Anything you want me to prepare?');
    assert.deepEqual(rules(sb, [makeTask({ source: 'Calendar', due: '2026-10-15' }, TODAY)]), [6, 8], 'exactly 7 days ahead');
    assert.deepEqual(rules(sb, [makeTask({ source: 'Calendar', due: '2026-10-16' }, TODAY)]), [8], '8 days ahead');
    assert.deepEqual(rules(sb, [makeTask({ source: 'Gmail', due: '2026-10-10' }, TODAY)]), [8], 'not Calendar');
    assert.deepEqual(rules(sb, [makeTask({ source: 'Calendar', due: '' }, TODAY)]), [8], 'no due');
    assert.deepEqual(rules(sb, [makeTask({ source: 'Calendar', due: '2026-10-10', status: 'Done', done: '2026-10-07' }, TODAY)]), [8]);
    assert.deepEqual(rules(sb, [makeTask({ source: 'Calendar', due: '2026-10-01' }, TODAY)]), [1, 8], 'past calendar item is overdue, not upcoming');
  });

  await t.test('rule 7: High priority with no due date', (sb, assert) => {
    const undated = makeTask({ title: 'Urgent thing', priority: 'High' }, TODAY);
    const qs = sb.gs.buildQuestions([undated], WIN, TODAY);
    assert.deepEqual(qs.map((q) => q.rule), [7, 8]);
    assert.equal(qs[0].text, '«Urgent thing» is marked high priority but has no date. When do you need it by?');
    assert.deepEqual(rules(sb, [makeTask({ priority: 'High', due: '2026-10-20' }, TODAY)]), [8]);
    assert.deepEqual(rules(sb, [makeTask({ priority: 'Normal' }, TODAY)]), [8]);
    assert.deepEqual(rules(sb, [makeTask({ priority: 'High', status: 'Done', done: '2026-10-07' }, TODAY)]), [8]);
  });

  await t.test('rule 8 always fires last; all rules together give exactly 8 in order', (sb, assert) => {
    assert.deepEqual(rules(sb, []), [8]);
    const qs = sb.gs.buildQuestions([], WIN, TODAY);
    assert.equal(qs[0].text, 'Anything from your side that should go on my list for next week?');
    const all = [
      makeTask({ title: 'Overdue', due: '2026-10-01' }, TODAY),
      makeTask({ title: 'Stale', created: '2026-09-01', updated: '2026-09-15T10:00:00+04:00' }, TODAY),
      makeTask({ title: 'Discuss', discuss: true, note: 'note' }, TODAY),
      makeTask({ title: 'D1', status: 'Done', done: '2026-10-06', project: 'Hub', newsletter: true }, TODAY),
      makeTask({ title: 'D2', status: 'Done', done: '2026-10-07', project: 'Hub' }, TODAY),
      makeTask({ title: 'D3', status: 'Done', done: '2026-10-08', project: 'Hub' }, TODAY),
      makeTask({ title: 'Cal', source: 'Calendar', due: '2026-10-09' }, TODAY),
      makeTask({ title: 'High', priority: 'High' }, TODAY)
    ];
    const out = sb.gs.buildQuestions(all, WIN, TODAY);
    assert.deepEqual(out.map((q) => q.rule), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(out.length, 8);
    // A task that satisfies several rules is used once where another candidate exists
    const multi = makeTask({ title: 'Multi', due: '2026-10-01', priority: 'High', discuss: true, created: '2026-09-01', updated: '' }, TODAY);
    const other = makeTask({ title: 'Other', due: '2026-10-02' }, TODAY);
    const mixed = sb.gs.buildQuestions([multi, other], WIN, TODAY);
    assert.deepEqual(mixed.map((q) => q.rule), [1, 2, 3, 8]);
    assert.equal(mixed[0].taskId, multi.id, 'most overdue');
    assert.equal(mixed[1].taskId, multi.id, 'only candidate');
    const personalOnly = makeTask({ title: 'P', category: 'Personal', due: '2026-10-01' }, TODAY);
    assert.deepEqual(rules(sb, [personalOnly]), [8], 'Personal tasks are ignored');
  });

  await t.test('draft sections: Done grouped by project, In progress ordering, Documents dedupe, Notes empty', (sb, assert) => {
    const tasks = [
      makeTask({ title: 'Done B2', status: 'Done', done: '2026-10-08', project: 'Beta', note: 'n2', link: 'https://doc/shared' }, TODAY),
      makeTask({ title: 'Done A1', status: 'Done', done: '2026-10-07', project: 'Alpha', link: 'https://doc/a1' }, TODAY),
      makeTask({ title: 'Done B1', status: 'Done', done: '2026-10-06', project: 'Beta', note: 'n1' }, TODAY),
      makeTask({ title: 'Done none', status: 'Done', done: '2026-10-09', project: '', note: 'solo' }, TODAY),
      makeTask({ title: 'Done old', status: 'Done', done: '2026-09-30', project: 'Alpha', link: 'https://doc/old' }, TODAY),
      makeTask({ title: 'Prog high no due', priority: 'High', created: '2026-09-01', updated: '2026-09-01T10:00:00+04:00', link: 'https://doc/shared' }, TODAY),
      makeTask({ title: 'Prog high due', priority: 'High', due: '2026-10-20', created: '2026-09-01', updated: '2026-09-01T10:00:00+04:00' }, TODAY),
      makeTask({ title: 'Prog discuss', discuss: true, created: '2026-09-01', updated: '2026-09-01T10:00:00+04:00', link: 'https://doc/discuss', due: '2026-10-15' }, TODAY),
      makeTask({ title: 'Prog updated', created: '2026-09-01', updated: '2026-10-07T10:00:00+04:00', due: '2026-10-14' }, TODAY),
      makeTask({ title: 'Prog created', created: '2026-10-06', updated: '2026-10-06T10:00:00+04:00' }, TODAY),
      makeTask({ title: 'Quiet open with link', created: '2026-09-01', updated: '2026-09-01T10:00:00+04:00', link: 'https://doc/quiet' }, TODAY),
      makeTask({ title: 'Dropped', status: 'Dropped', discuss: true, link: 'https://doc/dropped' }, TODAY),
      makeTask({ title: 'Discussed weeks ago', status: 'Done', done: '2026-09-20', discuss: true, link: 'https://doc/olddiscuss' }, TODAY),
      makeTask({ title: 'Doc with bad link', status: 'Done', done: '2026-10-06', discuss: true, link: 'ftp://files/x' }, TODAY),
      makeTask({ title: 'Doc with javascript link', status: 'Done', done: '2026-10-07', link: 'javascript:alert(1)' }, TODAY)
    ];
    const s = sb.gs.buildAgendaDraft(tasks, WIN, TODAY);
    assert.deepEqual(s.Done.map((r) => r.item), ['Done A1', 'Done B1', 'Done B2', 'Doc with bad link', 'Doc with javascript link', 'Done none']);
    assert.deepEqual(s.Done.map((r) => r.order), [1, 2, 3, 4, 5, 6]);
    assert.equal(s.Done[3].link, '', 'a non-http Link is not rendered');
    assert.equal(s.Done[0].detail, 'Alpha');
    assert.equal(s.Done[1].detail, 'Beta · n1');
    assert.equal(s.Done[5].detail, 'solo');
    assert.equal(s.Done[0].link, 'https://doc/a1');
    assert.equal(s.Done[0].taskId, tasks[1].id);
    assert.deepEqual(s['In progress'].map((r) => r.item), ['Prog high due', 'Prog high no due', 'Prog updated', 'Prog discuss', 'Prog created'],
      'High first, then by Due (blank last), then Created desc');
    assert.equal(s['In progress'][0].detail, 'due 2026-10-20 · High');
    assert.equal(s['In progress'][3].detail, 'due 2026-10-15 · discuss');
    assert.deepEqual(s.Documents.map((r) => r.link), ['https://doc/shared', 'https://doc/a1', 'https://doc/discuss']);
    assert.deepEqual(s.Documents.map((r) => r.item), ['Done B2', 'Done A1', 'Prog discuss']);
    assert.deepEqual(s.Documents.map((r) => r.order), [1, 2, 3]);
    assert.ok(!s.Documents.some((r) => r.link === 'https://doc/olddiscuss'), 'Discuss-ticked but Done before the window is not a document');
    assert.ok(!s.Documents.some((r) => /bad link|javascript/.test(r.item)), 'a task whose Link is not http(s) never yields a Documents row with an empty link');
    assert.ok(s.Documents.every((r) => /^https?:\/\//.test(r.link)));
    assert.deepEqual(s.Notes, []);
    assert.ok(s.Questions.length >= 2);
    assert.equal(findUnsafe(s), '');
  });

  await t.test('getAgenda returns saved rows when they exist; regenerate keeps saved Questions and Notes', (sb, assert) => {
    sb.gs.addTask_({ category: 'Work', title: 'Closed this week', project: 'Hub', status: 'Done', done: '2026-10-07', link: 'https://doc/x' });
    sb.gs.addTask_({ category: 'Work', title: 'Open high', priority: 'High' });
    const draft = sb.gs.getAgenda_({});
    assert.equal(draft.saved, false);
    assert.deepEqual(draft.sections.Done.map((r) => r.item), ['Closed this week']);
    assert.deepEqual(draft.sections['In progress'].map((r) => r.item), ['Open high']);
    assert.deepEqual(draft.sections.Documents.map((r) => r.link), ['https://doc/x']);
    assert.equal(draft.sections.Questions.length, 2, 'rule 7 (High without due) and rule 8');

    // Save an edited version (one Question kept, a Note added, Done emptied)
    const edited = {
      Done: [],
      'In progress': draft.sections['In progress'],
      Questions: [{ order: 2, item: 'Second saved question' }, { order: 1, item: 'First saved question', detail: 'why', link: 'javascript:bad' }],
      Documents: draft.sections.Documents,
      Notes: [{ order: 1, item: 'Director said yes' }, { item: '   ' }]
    };
    const saved = sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: edited });
    assert.deepEqual(saved, { ok: true, rows: 5 });
    const rows = sb.mock.rows('Agenda');
    assert.equal(rows.length, 5);
    const CA = sb.eval('COLUMN.AGENDA');
    rows.forEach((r) => {
      assert.equal(sb.gs.formatDate(r[CA.weekOf]), '2026-10-12');
      assert.equal(Object.prototype.toString.call(r[CA.generated]), '[object Date]');
    });
    const q = rows.filter((r) => r[CA.section] === 'Questions');
    assert.deepEqual(q.map((r) => [r[CA.order], r[CA.item], r[CA.link]]), [[1, 'First saved question', ''], [2, 'Second saved question', '']]);

    const got = sb.gs.getAgenda_({ meetingDate: '2026-10-13' });
    assert.equal(got.saved, true);
    assert.deepEqual(got.sections.Done, []);
    assert.deepEqual(got.sections.Questions.map((r) => r.item), ['First saved question', 'Second saved question']);
    assert.equal(got.sections.Questions[0].detail, 'why');
    assert.deepEqual(got.sections.Notes.map((r) => r.item), ['Director said yes']);
    assert.deepEqual(got.sections['In progress'].map((r) => r.item), ['Open high']);
    assert.equal(findUnsafe(got), '');
    // Another week stays a draft
    assert.equal(sb.gs.getAgenda_({ meetingDate: '2026-10-20' }).saved, false);

    const regen = sb.gs.regenerateAgenda_({ meetingDate: '2026-10-13' });
    assert.equal(regen.saved, false);
    assert.deepEqual(regen.sections.Done.map((r) => r.item), ['Closed this week'], 'Done rebuilt from tasks');
    assert.deepEqual(regen.sections.Questions.map((r) => r.item), ['First saved question', 'Second saved question'], 'saved questions kept');
    assert.deepEqual(regen.sections.Notes.map((r) => r.item), ['Director said yes'], 'saved notes kept');
    assert.equal(sb.mock.rows('Agenda').length, 5, 'regenerate does not write');

    // Saving another week keeps this week's rows; re-saving this week replaces only its rows
    sb.gs.saveAgenda_({ meetingDate: '2026-10-20', sections: { Notes: [{ item: 'Next week note' }] } });
    assert.equal(sb.mock.rows('Agenda').length, 6);
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Questions: [{ item: 'Only one now' }] } });
    const after = sb.mock.rows('Agenda');
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((r) => r[CA.item]).sort(), ['Next week note', 'Only one now']);
    assert.throws(() => sb.gs.saveAgenda_({ meetingDate: '2026-10-13' }), /Sections required/);
    assert.throws(() => sb.gs.saveAgenda_({ meetingDate: 'x', sections: {} }), /Meeting date/);
  }, { now: NOW });

  await t.test('rows written by the Claude routines (string dates) are read as saved, kept by regenerate and replaced by save', (sb, assert) => {
    sb.mock.seed('Agenda', [
      ['2026-10-12', 'Questions', 1, 'Routine question?', '', '', '', '2026-10-05 18:12'],
      ['2026-10-12', 'Notes', 1, 'Routine note', '', '', '', '2026-10-05 18:12'],
      ['2026-10-05', 'Notes', 1, 'Last week', '', '', '', '2026-09-28 18:12']
    ]);
    const got = sb.gs.getAgenda_({ meetingDate: '2026-10-13' });
    assert.equal(got.saved, true, 'string Week of matches weekOf');
    assert.deepEqual(got.sections.Questions.map((r) => r.item), ['Routine question?']);
    assert.deepEqual(got.sections.Notes.map((r) => r.item), ['Routine note']);
    assert.deepEqual(sb.gs.regenerateAgenda_({ meetingDate: '2026-10-13' }).sections.Questions.map((r) => r.item), ['Routine question?']);
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: 'Replaced' }] } });
    assert.deepEqual(sb.mock.rows('Agenda').map((r) => r[3]).sort(), ['Last week', 'Replaced'], 'string-dated rows of this week replaced, other week kept');
    assert.equal(sb.mock.rows('Agenda')[0][0], '2026-10-05', "the other week's cells are left exactly as the routine wrote them");
    sb.mock.seed('Log', [['2026-10-08 06:45:12', 'claude-morning', 'INFO', 'added W:1 P:0']]);
    assert.equal(sb.gs.getLog({}).rows.find((r) => r.fn === 'claude-morning').time, '2026-10-08T06:45:12+04:00', 'routine Log time with seconds');
    assert.equal(sb.gs.parseDate('2026-10-08 06:45:12').toISOString(), '2026-10-08T02:45:12.000Z');
    sb.mock.seed('Inbox', [['I-r1', '2026-10-08 06:15', 'Gmail', 'A', 'S', 's', '', 'gmail:r1', 'New', '', 'Work']]);
    assert.equal(sb.gs.listInbox_({}).items[0].captured, '2026-10-08T06:15:00+04:00');
  }, { now: NOW });

  await t.test("saveAgenda never rewrites other weeks' rows: a literal \"=\" Item stays text and a formula keeps its formula", (sb, assert) => {
    const CA = sb.eval('COLUMN.AGENDA');
    // A cell holding the literal text "=HYPERLINK(...)" (a RAW Sheets-API write by the agenda routine): mock.setCell is the
    // plain-value path, so this is text, not a formula, exactly like an apostrophe-prefixed cell in the live sheet.
    sb.mock.setCell('Agenda', 2, CA.weekOf + 1, '2026-09-28');
    sb.mock.setCell('Agenda', 2, CA.section + 1, 'Notes');
    sb.mock.setCell('Agenda', 2, CA.order + 1, 1);
    sb.mock.setCell('Agenda', 2, CA.item + 1, '=HYPERLINK("https://evil","click")');
    sb.mock.setFormula('Agenda', 2, CA.link + 1, '=HYPERLINK("https://docs.google.com/d/1","Doc")', 'Doc');
    sb.mock.setRichText('Agenda', 2, CA.detail + 1, 'the doc', 'https://docs.google.com/d/2');
    sb.mock.cellWrites.length = 0;
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: 'new week note' }] } });
    assert.deepEqual(sb.mock.formulas('Agenda'), [{ row: 2, col: CA.link + 1, formula: '=HYPERLINK("https://docs.google.com/d/1","Doc")' }], 'the Item text did not become a formula; the Link formula is still there');
    assert.equal(sb.mock.rows('Agenda')[0][CA.item], '=HYPERLINK("https://evil","click")', 'kept row untouched');
    assert.equal(sb.mock.richText('Agenda', 2, CA.detail + 1), 'https://docs.google.com/d/2', 'rich text kept');
    assert.ok(!sb.mock.cellWrites.some((w) => w.sheet === 'Agenda' && w.row === 2), "no cell of the other week's row was written");
    assert.equal(sb.gs.getAgenda_({ meetingDate: '2026-09-29' }).sections.Notes[0].item, '=HYPERLINK("https://evil","click")', 'reads back as text');
    assert.deepEqual(sb.mock.rows('Agenda').map((r) => r[CA.item]), ['=HYPERLINK("https://evil","click")', 'new week note']);
    // Re-saving this week deletes only its rows (a contiguous run under the kept week) and appends the new ones
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: 'n1' }, { item: 'n2' }] } });
    sb.gs.saveAgenda_({ meetingDate: '2026-10-20', sections: { Notes: [{ item: 'next' }] } });
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Questions: [{ item: 'q' }] } });
    assert.deepEqual(sb.mock.rows('Agenda').map((r) => [sb.gs.toDateString(r[CA.weekOf]), r[CA.item]]),
      [['2026-09-28', '=HYPERLINK("https://evil","click")'], ['2026-10-19', 'next'], ['2026-10-12', 'q']]);
    assert.equal(sb.mock.sheet('Agenda').getRange(2, CA.link + 1).getFormula(), '=HYPERLINK("https://docs.google.com/d/1","Doc")');
  }, { now: NOW });

  await t.test("a failing write during saveAgenda cannot wipe the tab: other weeks' rows survive", (sb, assert) => {
    const CA = sb.eval('COLUMN.AGENDA');
    sb.gs.saveAgenda_({ meetingDate: '2026-10-06', sections: { Notes: [{ item: 'two weeks ago' }] } });
    sb.gs.saveAgenda_({ meetingDate: '2026-10-20', sections: { Notes: [{ item: 'next week' }] } });
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: 'this week, old' }] } });
    const sheet = sb.mock.sheet('Agenda');
    const getRange = sheet.getRange;
    let thrown = 0;
    sheet.getRange = function () {
      const r = getRange.apply(this, arguments);
      r.setValues = () => { thrown++; throw new Error('Service error: Spreadsheets (simulated)'); };
      return r;
    };
    assert.throws(() => sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: 'this week, new' }] } }), /Service error: Spreadsheets/);
    sheet.getRange = getRange;
    assert.equal(thrown, 1);
    assert.deepEqual(sb.mock.rows('Agenda').map((r) => r[CA.item]).sort(), ['next week', 'two weeks ago'], 'only the week being saved was affected');
    assert.equal(sb.mock.locks.held, 0, 'lock released');
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: { Notes: [{ item: 'this week, retried' }] } });
    assert.deepEqual(sb.mock.rows('Agenda').map((r) => r[CA.item]).sort(), ['next week', 'this week, retried', 'two weeks ago']);
    // Deleting the last data rows of a nearly empty grid never trips "cannot delete all non-frozen rows"
    const small = sb.mock.sheet('Agenda');
    small.maxRows = small.getLastRow();
    sb.gs.saveAgenda_({ meetingDate: '2026-10-13', sections: {} });
    sb.gs.saveAgenda_({ meetingDate: '2026-10-20', sections: {} });
    sb.gs.saveAgenda_({ meetingDate: '2026-10-06', sections: {} });
    assert.deepEqual(sb.mock.rows('Agenda'), []);
  }, { now: NOW });
};
