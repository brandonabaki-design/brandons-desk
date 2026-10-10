'use strict';
const { makeTask, findUnsafe } = require('./fixtures/helpers');

const NOW = '2026-10-08T06:00:00Z';

module.exports = async function (t) {
  await t.test('selectNewsletterTasks: ticked Work tasks Done in range plus Open ones, grouped by project', (sb, assert) => {
    const tasks = [
      makeTask({ title: 'Hub done', newsletter: true, status: 'Done', done: '2026-10-01', project: 'AI Learning Hub' }),
      makeTask({ title: 'Hub open', newsletter: true, status: 'Open', project: 'AI Learning Hub' }),
      makeTask({ title: 'Old done', newsletter: true, status: 'Done', done: '2026-08-01', project: 'AI Learning Hub' }),
      makeTask({ title: 'Not ticked', newsletter: false, status: 'Done', done: '2026-10-01' }),
      makeTask({ title: 'Dropped', newsletter: true, status: 'Dropped' }),
      makeTask({ title: 'No project done', newsletter: true, status: 'Done', done: '2026-09-20', link: 'https://x' }),
      makeTask({ title: 'Teaching done', newsletter: true, status: 'Done', done: '2026-09-25', project: 'Teaching', note: 'went well' })
    ];
    const sel = sb.gs.selectNewsletterTasks(tasks, '2026-09-10', '2026-10-08');
    assert.deepEqual(sel.map((x) => x.title), ['Hub done', 'Hub open', 'Teaching done', 'No project done']);
    const md = sb.gs.newsletterMarkdown(sel, '2026-09-10', '2026-10-08');
    assert.ok(md.startsWith('# AI Learning Hub — newsletter notes\n'));
    assert.ok(md.includes('_Window: 2026-09-10 to 2026-10-08_'));
    const hubIdx = md.indexOf('## AI Learning Hub');
    const teachIdx = md.indexOf('## Teaching');
    const otherIdx = md.indexOf('## Other');
    assert.ok(hubIdx > 0 && teachIdx > hubIdx && otherIdx > teachIdx, 'groups in order, blank project last as Other');
    assert.ok(md.includes('- **Hub done** (done 2026-10-01)'));
    assert.ok(md.includes('- **Hub open** (in progress)'));
    assert.ok(md.includes('- **Teaching done** (done 2026-09-25) — went well'));
    assert.ok(md.includes('- **No project done** (done 2026-09-20) — [link](https://x)'));
    assert.ok(!md.includes('Old done'));
    assert.ok(!md.includes('Not ticked'));
    assert.ok(sb.gs.newsletterMarkdown([], 'a', 'b').includes('_No newsletter items in this window._'));
  });

  await t.test('markdown links: only http(s) survives and ")" / whitespace cannot break out of the link', (sb, assert) => {
    const tasks = [
      makeTask({ title: 'Script link', newsletter: true, status: 'Open', link: 'javascript:alert(1)' }),
      makeTask({ title: 'Data link', newsletter: true, status: 'Open', link: 'data:text/html,hi' }),
      makeTask({ title: 'Paren link', newsletter: true, status: 'Open', link: 'https://en.wikipedia.org/wiki/Foo_(bar)' }),
      makeTask({ title: 'Good link', newsletter: true, status: 'Open', link: 'https://x.test/a' })
    ];
    const md = sb.gs.newsletterMarkdown(tasks, '2026-09-10', '2026-10-08');
    assert.ok(!md.includes('javascript:'));
    assert.ok(!md.includes('data:'));
    assert.ok(md.includes('- **Script link** (in progress)\n'), 'no link part at all');
    assert.ok(md.includes('[link](https://en.wikipedia.org/wiki/Foo_%28bar%29)'), md);
    assert.ok(md.includes('[link](https://x.test/a)'));
  });

  await t.test('project names that collide with Object.prototype members still group (and never throw)', (sb, assert) => {
    const tasks = ['constructor', '__proto__', 'toString', 'hasOwnProperty'].map((p, i) =>
      makeTask({ title: 'Item ' + i, newsletter: true, status: 'Done', done: '2026-10-01', project: p }));
    const md = sb.gs.newsletterMarkdown(tasks, '2026-09-10', '2026-10-08');
    assert.equal((md.match(/^## /gm) || []).length, 4, 'four groups');
    assert.ok(md.includes('## constructor'));
    assert.ok(md.includes('## toString'));
    tasks.forEach((x) => assert.ok(md.includes('**' + x.title + '**'), x.title));
  });

  await t.test('getNewsletter defaults to the last 28 days and reads only the Work tab', (sb, assert) => {
    sb.gs.addTask_({ category: 'Work', title: 'In range', newsletter: true, status: 'Done', done: '2026-09-15', project: 'PD' });
    sb.gs.addTask_({ category: 'Work', title: 'Edge of range', newsletter: true, status: 'Done', done: '2026-09-10' });
    sb.gs.addTask_({ category: 'Work', title: 'Just outside', newsletter: true, status: 'Done', done: '2026-09-09' });
    sb.gs.addTask_({ category: 'Work', title: 'Still open', newsletter: true });
    sb.gs.addTask_({ category: 'Personal', title: 'Personal ticked', newsletter: true, status: 'Done', done: '2026-10-01' });
    const r = sb.gs.getNewsletter_({});
    assert.equal(r.from, '2026-09-10');
    assert.equal(r.to, '2026-10-08');
    assert.deepEqual(r.tasks.map((x) => x.title), ['In range', 'Edge of range', 'Still open']);
    assert.ok(r.markdown.includes('## PD'));
    assert.ok(r.markdown.includes('## Other'));
    assert.ok(!r.markdown.includes('Personal ticked'));
    assert.equal(findUnsafe(r), '');
    const narrow = sb.gs.getNewsletter_({ from: '2026-09-11', to: '2026-09-30' });
    assert.deepEqual(narrow.tasks.map((x) => x.title), ['In range', 'Still open']);
    assert.throws(() => sb.gs.getNewsletter_({ from: '2026-10-09', to: '2026-10-01' }), /From must not be after To/);
    assert.throws(() => sb.gs.getNewsletter_({ from: 'last month' }), /From must be/);
  }, { now: NOW });
};
