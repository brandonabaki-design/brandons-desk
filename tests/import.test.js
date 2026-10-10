'use strict';
const { fixture, findUnsafe } = require('./fixtures/helpers');

const NOW = '2026-10-08T06:00:00Z';

module.exports = async function (t) {
  await t.test('parseImportLine handles every prefix/suffix syntax', (sb, assert) => {
    const p = sb.gs.parseImportLine;
    assert.deepEqual(p('- [x] Done thing'), { title: 'Done thing', category: '', done: true, due: '', priority: 'Normal', skip: false, reason: '' });
    assert.equal(p('[X] upper').done, true);
    assert.equal(p('✓ tick').done, true);
    assert.equal(p('✔ heavy tick').done, true);
    assert.equal(p('☑ ballot').done, true);
    assert.equal(p('* [x] star done').done, true);
    assert.equal(p('- plain').title, 'plain');
    assert.equal(p('* star').title, 'star');
    assert.equal(p('• bullet').title, 'bullet');
    assert.equal(p('☐ box').title, 'box');
    assert.equal(p('[ ] empty box').title, 'empty box');
    assert.equal(p('1. numbered').title, 'numbered');
    assert.equal(p('12) numbered paren').title, 'numbered paren');
    assert.equal(p('[Work] x y').category, 'Work');
    assert.equal(p('[W] x y').category, 'Work');
    assert.equal(p('[personal] x y').category, 'Personal');
    assert.equal(p('[P] x y').category, 'Personal');
    assert.equal(p('[P] - [x] all at once !!').category, 'Personal');
    assert.equal(p('[P] - [x] all at once !!').done, true);
    assert.equal(p('[P] - [x] all at once !!').priority, 'High');
    assert.equal(p('[P] - [x] all at once !!').title, 'all at once');
    assert.deepEqual(p('Call Sara @2026-10-14'), { title: 'Call Sara', category: '', done: false, due: '2026-10-14', priority: 'Normal', skip: false, reason: '' });
    assert.equal(p('Call Sara due: 2026-10-14').due, '2026-10-14');
    assert.equal(p('Call Sara Due:2026-10-14').due, '2026-10-14');
    assert.equal(p('Call Sara @2026-10-14 !').priority, 'High');
    assert.equal(p('Call Sara @2026-10-14 !').due, '2026-10-14');
    assert.equal(p('Call Sara ! @2026-10-14').priority, 'High');
    assert.equal(p('Call Sara ! @2026-10-14').title, 'Call Sara');
    assert.equal(p('Call Sara !!').priority, 'High');
    assert.equal(p('Call Sara @2026-13-45').due, '', 'invalid date ignored');
    assert.equal(p('Call Sara @2026-13-45').title, 'Call Sara');
    assert.equal(p('ok').skip, true);
    assert.equal(p('ok').reason, 'too short');
    assert.equal(p('   ').skip, true);
    assert.equal(p('-').skip, true);
    assert.equal(p('- [x]').skip, true);
    assert.equal(p('!!!').skip, true, 'only bangs → nothing left');
    assert.equal(p('x'.repeat(300)).title.length, 140);
    assert.equal(p('Email the #1 vendor').title, 'Email the #1 vendor', 'inline # is not a heading');
  });

  await t.test('importText: every syntax from the fixture, projects, categories, dedupe on re-import', (sb, assert) => {
    const text = fixture('import-sample.txt');
    const r = sb.gs.importText_({ category: 'Work', text: text, created: '2026-10-07' });
    assert.equal(findUnsafe(r), '');
    const byTitle = {};
    r.added.forEach((x) => { byTitle[x.title] = x; });
    assert.equal(r.added.length, 17, Object.keys(byTitle).join(' | '));
    assert.deepEqual(r.skipped.map((s) => s.reason), ['too short', 'too short']);
    assert.deepEqual(r.skipped.map((s) => s.line), ['ok', '-']);
    const work = r.added.filter((x) => x.category === 'Work');
    const personal = r.added.filter((x) => x.category === 'Personal');
    assert.equal(work.length, 15);
    assert.equal(personal.length, 2);
    // Done markers
    ['Draft the Hub newsletter intro', 'Send the agenda to the director', 'Book the hall', 'Print the certificates', 'File the timetable'].forEach((title) => {
      assert.equal(byTitle[title].status, 'Done', title);
      assert.equal(byTitle[title].done, '2026-10-07', title + ' done = created');
    });
    assert.equal(byTitle['Book the ICT lab for the AI workshop'].due, '2026-10-16');
    assert.equal(byTitle['Book the ICT lab for the AI workshop'].status, 'Open');
    assert.equal(byTitle['Order the robotics kits for Grade 7'].due, '2026-10-20');
    assert.equal(byTitle['Order the robotics kits for Grade 7'].priority, 'High');
    assert.equal(byTitle['Call the vendor about the licence'].priority, 'High');
    assert.equal(byTitle['Prepare the PD session on ChatGPT'].newsletter, true);
    assert.equal(byTitle['Review the Gemini pilot feedback'].status, 'Open');
    assert.equal(byTitle['Collect the consent forms'].project, 'AI Learning Hub');
    assert.equal(byTitle['Scan the signed forms'].project, 'AI Learning Hub');
    assert.equal(byTitle['Buy a birthday gift for Mum'].category, 'Personal');
    assert.equal(byTitle['Buy a birthday gift for Mum'].due, '2026-10-18');
    assert.match(byTitle['Buy a birthday gift for Mum'].id, /^P-/);
    assert.equal(byTitle['Renew car registration'].category, 'Personal');
    assert.equal(byTitle['Renew car registration'].priority, 'High');
    assert.equal(byTitle['Email Sara about the timetable'].category, 'Work');
    assert.equal(byTitle['Email Sara about the timetable'].due, '2026-10-14');
    assert.equal(byTitle['Chase the invoice'].category, 'Work');
    assert.equal(byTitle['Update the staff handbook'].project, 'Admin');
    const crypto = require('node:crypto');
    const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
    r.added.forEach((x) => {
      assert.equal(x.source, 'Import');
      assert.equal(x.created, '2026-10-07');
      assert.match(x.sourceKey, /^import:[0-9a-f]{40}$/);
      assert.equal(x.sourceKey, sb.gs.importSourceKey(x.title, '2026-10-07'));
    });
    // SPEC 6 formula pinned independently of the implementation: sha1(normalisedTitle + '|' + created).
    assert.equal(sb.gs.importSourceKey('Re: Email Sara!', '2026-10-07'), 'import:' + sha1('email sara|2026-10-07'));
    assert.equal(byTitle['Chase the invoice'].sourceKey, 'import:' + sha1('chase the invoice|2026-10-07'));
    assert.equal(sb.mock.rows('Work').length, 15);
    assert.equal(sb.mock.rows('Personal').length, 2);
    // Re-import: everything is a duplicate (Done items via sourceKey, Open ones via sourceKey/title)
    const again = sb.gs.importText_({ category: 'Work', text: text, created: '2026-10-07' });
    assert.equal(again.added.length, 0);
    assert.equal(again.skipped.filter((s) => s.reason === 'duplicate').length, 17);
    assert.equal(sb.mock.rows('Work').length, 15);
    // Same titles on a different date: Open ones dedupe by title, Done ones get a new key and are re-added
    const other = sb.gs.importText_({ category: 'Work', text: '- [x] Book the hall\n- Chase the invoice', created: '2026-10-08' });
    assert.equal(other.added.length, 1);
    assert.equal(other.added[0].title, 'Book the hall');
    assert.equal(other.skipped[0].reason, 'duplicate');
  }, { now: NOW });

  await t.test('importText defaults, created validation and blank text', (sb, assert) => {
    assert.deepEqual(sb.gs.importText_({ category: 'Personal', text: '   \n\n' }), { added: [], skipped: [] });
    const r = sb.gs.importText_({ category: 'Personal', text: 'Single line task' });
    assert.equal(r.added[0].created, '2026-10-08', 'Created defaults to today (fixed clock)');
    assert.equal(r.added[0].category, 'Personal');
    assert.throws(() => sb.gs.importText_({ category: 'Personal', text: 'x y z', created: 'soon' }), /Created must be/);
    assert.throws(() => sb.gs.importText_({ text: 'x y z' }), /Category must be/);
    // In-batch duplicates
    const dup = sb.gs.importText_({ category: 'Work', text: 'Email the parents tonight\nemail the parents tonight!' });
    assert.equal(dup.added.length, 1);
    assert.equal(dup.skipped.length, 1);
    assert.equal(dup.skipped[0].reason, 'duplicate');
  }, { now: NOW });

  await t.test('importHtml: Claude-in-Chrome-style sample with headings, checkboxes, classes and links', (sb, assert) => {
    const html = fixture('import-sample.html');
    const r = sb.gs.importHtml_({ html: html, created: '2026-10-07' });
    assert.equal(findUnsafe(r), '');
    const byTitle = {};
    r.added.forEach((x) => { byTitle[x.title] = x; });
    assert.equal(r.added.length, 8, Object.keys(byTitle).join(' | '));
    assert.deepEqual(r.skipped, [{ line: 'ok', reason: 'too short' }]);
    const work = r.added.filter((x) => x.category === 'Work');
    const personal = r.added.filter((x) => x.category === 'Personal');
    assert.equal(work.length, 4);
    assert.equal(personal.length, 4);
    work.forEach((x) => assert.equal(x.project, 'AI Learning Hub', x.title));
    personal.forEach((x) => assert.equal(x.project, '', x.title + ' (category heading resets the project)'));
    const draft = byTitle['Draft the Hub newsletter intro'];
    assert.equal(draft.status, 'Done');
    assert.equal(draft.done, '2026-10-07');
    assert.equal(draft.newsletter, true);
    const book = byTitle['Book the ICT lab for the AI workshop (plan)'];
    assert.ok(book, 'link text stays in the title');
    assert.equal(book.status, 'Open');
    assert.equal(book.due, '2026-10-16');
    assert.equal(book.link, 'https://docs.google.com/document/d/abc123/edit');
    const parents = byTitle['Email parents about the robotics club'];
    assert.equal(parents.status, 'Done', 'line-through class');
    const review = byTitle['Review the Gemini pilot feedback & summarise it'];
    assert.ok(review, 'entities decoded');
    assert.equal(review.priority, 'High');
    assert.equal(review.link, '', 'javascript: href dropped');
    assert.equal(review.newsletter, true);
    assert.equal(byTitle['Renew car registration'].priority, 'High');
    assert.match(byTitle['Renew car registration'].id, /^P-/);
    assert.equal(byTitle['Buy birthday gift for Mum & Dad'].due, '2026-10-20');
    assert.equal(byTitle['Call the bank about the card fee'].status, 'Open');
    assert.equal(byTitle['Pay the electricity bill'].status, 'Done');
    r.added.forEach((x) => assert.equal(x.source, 'Import'));
    assert.ok(!JSON.stringify(r).includes('should never run'), 'script content never surfaces');
    assert.ok(!JSON.stringify(r).includes('Captured on 10 October'), 'plain paragraphs are not items');
  }, { now: NOW });

  await t.test('importHtml falls back to the text importer when there are no list items', (sb, assert) => {
    const r = sb.gs.importHtml_({ html: fixture('import-nolist.html'), category: 'Personal', created: '2026-10-07' });
    const titles = r.added.map((x) => x.title).sort();
    assert.deepEqual(titles, ['Email Sara about the lab timetable', 'Mark the unit 3 quizzes', 'Prepare the Grade 9 AI lesson slides']);
    assert.deepEqual(r.skipped, [{ line: 'ok', reason: 'too short' }]);
    r.added.forEach((x) => {
      assert.equal(x.category, 'Personal');
      assert.equal(x.project, 'Teaching', 'heading became a # project line');
    });
    const slides = r.added.find((x) => x.title.startsWith('Prepare'));
    assert.equal(slides.priority, 'High');
    assert.equal(r.added.find((x) => x.title.startsWith('Mark')).due, '2026-10-15');
    assert.ok(!JSON.stringify(r).includes('never'), 'script stripped');
    assert.deepEqual(sb.gs.importHtml_({ html: '   ' }), { added: [], skipped: [] });
    assert.deepEqual(sb.gs.importHtml_({ html: '<p>ok</p>' }), { added: [], skipped: [{ line: 'ok', reason: 'too short' }] });
  }, { now: NOW });

  await t.test('parseImportHtml edge cases: nested lists, unquoted attributes, del/s tags, checkbox outside lists', (sb, assert) => {
    const html = '<h2>school</h2><ul><li>Parent <b>one</b><ul><li>Nested child item</li></ul></li>' +
      '<li class=task-done>Unquoted class task-done</li>' +
      '<li><del>Deleted means done</del></li>' +
      '<li><s>Struck means done</s></li>' +
      '<li><input type=checkbox checked=checked>Checked no quotes</li>' +
      '<li style="text-decoration: line-through">Inline style done</li></ul>' +
      '<h2>Home stuff</h2>' +
      '<input type="checkbox"> Loose checkbox item<br>' +
      '<input type="checkbox" checked> Second loose checkbox item<p>Not an item</p>';
    const parsed = sb.gs.parseImportHtml(html, 'Personal');
    const items = parsed.items;
    const byTitle = {};
    items.forEach((i) => { byTitle[i.title] = i; });
    assert.equal(byTitle['Parent one'].category, 'Work');
    assert.equal(byTitle['Nested child item'].category, 'Work');
    assert.equal(byTitle['Unquoted class task-done'].done, true);
    assert.equal(byTitle['Deleted means done'].done, true);
    assert.equal(byTitle['Struck means done'].done, true);
    assert.equal(byTitle['Checked no quotes'].done, true);
    assert.equal(byTitle['Inline style done'].done, true);
    assert.equal(byTitle['Loose checkbox item'].category, 'Personal');
    assert.equal(byTitle['Loose checkbox item'].done, false);
    assert.equal(byTitle['Second loose checkbox item'].done, true);
    assert.equal(byTitle['Not an item'], undefined);
    assert.equal(items.length, 9);
  });
};
