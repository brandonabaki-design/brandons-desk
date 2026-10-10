'use strict';
/**
 * Google Chat REST API fixtures: UrlFetchApp handlers that serve spaces and messages relative
 * to `now`, with optional scripted failures.
 *
 * buildChatFixture({ now, mode }) → { handler, state, spaces, messages, expectedKeys }
 *   mode: 'ok' (default) | 'forbidden' | 'unauthorized' | 'rate-limit-once' | 'rate-limit-always' | 'server-error'
 * buildChatServer({ spaces, messages, messagePageSize }) → { handler, state, spaces, messages }
 *   Serves the given spaces (one page) and messages. `messages` (space name → array) is read on
 *   every request, so a test can push new messages between two capture runs; each array is served
 *   in its stored order (not sorted), filtered by the create_time in the request's filter. A message
 *   marked deleted (deleteMessage) is served only to a request with showDeleted=true, as a tombstone.
 * deleteMessage(message, at) marks a fixture message deleted the way messages.list then shows it:
 *   deleteTime + deletionMetadata set, text gone.
 * buildLiveReplay({ now }) → buildChatServer result + { users, texts }
 *   Direct messages modelled on the first live capture (2026-10-10): the noise rows and the
 *   useful rows Brandon and Claude triaged by hand, verbatim (Arabic included).
 */

function iso(date) {
  return new Date(date).toISOString();
}

/**
 * The parts of the messages endpoint every fixture shares: create_time filter, optional paging, and
 * deleted messages (deleteTime or deletionMetadata set) left out unless showDeleted=true, as the API does.
 */
function serveMessages(list, u, pageSize) {
  const filter = u.searchParams.get('filter') || '';
  const fm = /create_time > "([^"]+)"/.exec(filter);
  if (!fm) return { code: 400, body: { error: { code: 400, message: 'bad filter: ' + filter, status: 'INVALID_ARGUMENT' } } };
  const cutoff = new Date(fm[1]).getTime();
  const showDeleted = u.searchParams.get('showDeleted') === 'true';
  const inWindow = (list || []).filter((msg) => new Date(msg.createTime).getTime() > cutoff &&
    (showDeleted || !(msg.deleteTime || msg.deletionMetadata)));
  if (!inWindow.length) return { code: 200, body: {} };
  if (!pageSize || inWindow.length <= pageSize) return { code: 200, body: { messages: inWindow } };
  const start = Number(u.searchParams.get('pageToken') || 0);
  const next = start + pageSize;
  const body = { messages: inWindow.slice(start, next) };
  if (next < inWindow.length) body.nextPageToken = String(next);
  return { code: 200, body: body };
}

function buildChatServer(options) {
  const opts = options || {};
  const spaces = opts.spaces || [];
  const messages = opts.messages || {};
  const state = { calls: [] };
  function handler(url, params) {
    state.calls.push({ url: url, params: params });
    const auth = params.headers && (params.headers.Authorization || params.headers.authorization);
    if (!auth || auth.indexOf('Bearer ') !== 0) return { code: 401, body: { error: { code: 401, message: 'no token', status: 'UNAUTHENTICATED' } } };
    const u = new URL(url);
    if (u.pathname === '/v1/spaces') return { code: 200, body: { spaces: spaces } };
    const m = /^\/v1\/(spaces\/[^/]+)\/messages$/.exec(u.pathname);
    if (m) return serveMessages(messages[m[1]], u, opts.messagePageSize);
    return { code: 404, body: { error: { code: 404, message: 'not found ' + url, status: 'NOT_FOUND' } } };
  }
  return { handler: handler, state: state, spaces: spaces, messages: messages };
}

const ME = { name: 'users/me', displayName: 'Brandon Abaki', email: 'bbaki@aisa.sch.ae', type: 'HUMAN' };

function buildLiveReplay(options) {
  const opts = options || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const hoursAgo = (h) => iso(now.getTime() - h * 3600000);
  const users = {
    hana: { name: 'users/11', displayName: 'Hana Saleh', email: 'hana.saleh@aisa.sch.ae', type: 'HUMAN' },
    omar: { name: 'users/12', displayName: 'Omar Haddad', email: 'omar@aisa.sch.ae', type: 'HUMAN' },
    reem: { name: 'users/13', displayName: 'Reem Al Mansoori', email: 'reem@aisa.sch.ae', type: 'HUMAN' },
    me: ME
  };
  // Every text the first live run wrote as its own Inbox row, sorted into noise and useful.
  const texts = {
    noise: ['correct', 'Go', 'I saw it.', 'Aww poor thing', 'Oh shoot! Take care', '', '0506480801', 'Sure - 0501260445',
      'صباح الخير', 'كيفك اليوم', 'تفضل عالفطور', 'بانتظارك'],
    useful: ['Please can you come to room 216',
      'If Elementary decides to book you in for a certain time let me know so I can factor it in',
      "IB students don't have tutorial during the Arabic class ... They might have tutorial only during the Islamic studies class"]
  };
  let seq = 0;
  const msg = (space, sender, h, text) => {
    seq++;
    const out = { name: space + '/messages/live' + seq + '.live' + seq, sender: sender, createTime: hoursAgo(h), text: text };
    if (text === '') delete out.text; // attachment / sticker: no text at all
    return out;
  };
  const spaces = [
    { name: 'spaces/DMHANA', spaceType: 'DIRECT_MESSAGE', lastActiveTime: hoursAgo(1), spaceUri: 'https://chat.google.com/dm/DMHANA' },
    { name: 'spaces/DMOMAR', spaceType: 'DIRECT_MESSAGE', lastActiveTime: hoursAgo(2), spaceUri: 'https://chat.google.com/dm/DMOMAR' },
    { name: 'spaces/DMREEM', spaceType: 'DIRECT_MESSAGE', lastActiveTime: hoursAgo(3), spaceUri: 'https://chat.google.com/dm/DMREEM' }
  ];
  const messages = {
    // Greetings, a request, then more noise after it (including a sticker and a phone number).
    'spaces/DMHANA': [
      msg('spaces/DMHANA', users.hana, 20, 'صباح الخير'),
      msg('spaces/DMHANA', users.hana, 19.9, 'كيفك اليوم'),
      msg('spaces/DMHANA', ME, 19.5, 'Good morning! All good, thanks'),
      msg('spaces/DMHANA', users.hana, 19, 'Please can you come to room 216'),
      msg('spaces/DMHANA', users.hana, 18.9, 'correct'),
      msg('spaces/DMHANA', users.hana, 18.8, ''),
      msg('spaces/DMHANA', users.hana, 18.7, 'تفضل عالفطور'),
      msg('spaces/DMHANA', users.hana, 18.6, 'Sure - 0501260445')
    ],
    // Two useful messages with noise between them.
    'spaces/DMOMAR': [
      msg('spaces/DMOMAR', users.omar, 30, 'If Elementary decides to book you in for a certain time let me know so I can factor it in'),
      msg('spaces/DMOMAR', ME, 29, 'Will do'),
      msg('spaces/DMOMAR', users.omar, 28.9, 'Go'),
      msg('spaces/DMOMAR', users.omar, 28.8, 'I saw it.'),
      msg('spaces/DMOMAR', users.omar, 28.7, '0506480801'),
      msg('spaces/DMOMAR', users.omar, 10, "IB students don't have tutorial during the Arabic class ... They might have tutorial only during the Islamic studies class")
    ],
    // Nothing but noise: no row at all.
    'spaces/DMREEM': [
      msg('spaces/DMREEM', users.reem, 6, 'Aww poor thing'),
      msg('spaces/DMREEM', users.reem, 5.9, 'Oh shoot! Take care'),
      msg('spaces/DMREEM', users.reem, 5.8, 'بانتظارك'),
      msg('spaces/DMREEM', users.reem, 5.7, 'صباح الخير')
    ]
  };
  return Object.assign(buildChatServer({ spaces: spaces, messages: messages }), { users: users, texts: texts });
}

function buildChatFixture(options) {
  const opts = options || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const hoursAgo = (h) => iso(now.getTime() - h * 3600000);
  const daysAgo = (d) => iso(now.getTime() - d * 86400000);
  const mode = opts.mode || 'ok';
  const me = 'bbaki@aisa.sch.ae';

  const spaces = [
    { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE', lastActiveTime: hoursAgo(5), spaceUri: 'https://chat.google.com/dm/DM1' },
    { name: 'spaces/GRP1', spaceType: 'GROUP_CHAT', lastActiveTime: hoursAgo(20) },
    { name: 'spaces/ROOM1', spaceType: 'SPACE', displayName: 'Science Department', lastActiveTime: hoursAgo(2), spaceUri: 'https://chat.google.com/room/ROOM1' },
    { name: 'spaces/OLD', spaceType: 'SPACE', displayName: 'Old room', lastActiveTime: daysAgo(30), spaceUri: 'https://chat.google.com/room/OLD' },
    { name: 'spaces/BOTDM', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true, lastActiveTime: hoursAgo(1) }
  ];

  const messages = {
    'spaces/DM1': [
      { name: 'spaces/DM1/messages/m1.m1', sender: { name: 'users/1', displayName: 'Sara Khan', email: 'sara.khan@aisa.sch.ae', type: 'HUMAN' }, createTime: hoursAgo(5), text: 'Can you share the AI workshop slides before Thursday?' },
      { name: 'spaces/DM1/messages/m2.m2', sender: { name: 'users/me', displayName: 'Brandon Abaki', email: me, type: 'HUMAN' }, createTime: hoursAgo(4), text: 'Sure, later today.' }
    ],
    'spaces/GRP1': [
      { name: 'spaces/GRP1/messages/g1.g1', sender: { name: 'users/2', displayName: 'Omar Haddad', email: 'omar@aisa.sch.ae', type: 'HUMAN' }, createTime: hoursAgo(20), text: 'Who is covering the lab on Monday?' },
      { name: 'spaces/GRP1/messages/g2.g2', sender: { name: 'users/bot', displayName: 'Reminder Bot', type: 'BOT' }, createTime: hoursAgo(19), text: 'Reminder: timesheets due.' }
    ],
    // ROOM1 is served in two pages (see the handler): the only message that mentions me is the
    // newest one and lands on page 2, so a first-page-only implementation misses it.
    'spaces/ROOM1': [
      { name: 'spaces/ROOM1/messages/r2.r2', sender: { name: 'users/3', displayName: 'Maya Lin', email: 'maya.lin@aisa.sch.ae', type: 'HUMAN' }, createTime: hoursAgo(2), text: 'General chatter without a mention.' },
      { name: 'spaces/ROOM1/messages/r3.r3', sender: { name: 'users/4', displayName: 'Nadia', email: 'nadia@aisa.sch.ae', type: 'HUMAN' }, createTime: hoursAgo(1), text: '@Omar can you check?', annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/2', email: 'omar@aisa.sch.ae', type: 'HUMAN' }, type: 'MENTION' } }] },
      { name: 'spaces/ROOM1/messages/r1.r1', sender: { name: 'users/3', displayName: 'Maya Lin', email: 'maya.lin@aisa.sch.ae', type: 'HUMAN' }, createTime: hoursAgo(0.5), text: '@Brandon Abaki can you approve the lab booking?', annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/me', email: me, type: 'HUMAN' }, type: 'MENTION' } }] }
    ],
    'spaces/OLD': [
      { name: 'spaces/OLD/messages/o1.o1', sender: { name: 'users/5', displayName: 'Ghost', email: 'ghost@aisa.sch.ae', type: 'HUMAN' }, createTime: daysAgo(30), text: 'Should never be fetched' }
    ],
    'spaces/BOTDM': [
      { name: 'spaces/BOTDM/messages/b1.b1', sender: { name: 'users/bot2', displayName: 'Some bot', type: 'BOT' }, createTime: hoursAgo(1), text: 'bot dm' }
    ]
  };

  const state = { calls: [], rateLimited: 0 };
  function handler(url, params) {
    state.calls.push({ url: url, params: params });
    const auth = params.headers && (params.headers.Authorization || params.headers.authorization);
    if (!auth || auth.indexOf('Bearer ') !== 0) return { code: 401, body: { error: { code: 401, message: 'no token', status: 'UNAUTHENTICATED' } } };
    if (mode === 'forbidden') {
      return { code: 403, body: { error: { code: 403, message: 'Google Chat API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }] } } };
    }
    if (mode === 'unauthorized') return { code: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } };
    if (mode === 'server-error') return { code: 500, body: { error: { code: 500, message: 'Internal error', status: 'INTERNAL' } } };
    if (mode === 'rate-limit-always' || (mode === 'rate-limit-once' && state.rateLimited === 0)) {
      state.rateLimited++;
      return { code: 429, body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } };
    }
    const u = new URL(url);
    if (u.pathname === '/v1/spaces') {
      // Two pages to exercise nextPageToken.
      const page = u.searchParams.get('pageToken') || '';
      if (!page) return { code: 200, body: { spaces: spaces.slice(0, 2), nextPageToken: 'page2' } };
      return { code: 200, body: { spaces: spaces.slice(2) } };
    }
    const m = /^\/v1\/(spaces\/[^/]+)\/messages$/.exec(u.pathname);
    if (m) {
      const filter = u.searchParams.get('filter') || '';
      const fm = /create_time > "([^"]+)"/.exec(filter);
      if (!fm) return { code: 400, body: { error: { code: 400, message: 'bad filter: ' + filter, status: 'INVALID_ARGUMENT' } } };
      const cutoff = new Date(fm[1]).getTime();
      const list = (messages[m[1]] || []).filter((msg) => new Date(msg.createTime).getTime() > cutoff);
      if (!list.length) return { code: 200, body: {} };
      if (m[1] === 'spaces/ROOM1') {
        // Two pages of messages to exercise nextPageToken on the messages call (SPEC 6).
        const page = u.searchParams.get('pageToken') || '';
        if (!page) return { code: 200, body: { messages: list.slice(0, 2), nextPageToken: 'mp2' } };
        if (page === 'mp2') return { code: 200, body: { messages: list.slice(2) } };
        return { code: 400, body: { error: { code: 400, message: 'bad pageToken ' + page, status: 'INVALID_ARGUMENT' } } };
      }
      return { code: 200, body: { messages: list } };
    }
    return { code: 404, body: { error: { code: 404, message: 'not found ' + url, status: 'NOT_FOUND' } } };
  }

  return {
    handler: handler,
    state: state,
    spaces: spaces,
    messages: messages,
    // Keys the capture should produce in 'ok' mode.
    expectedKeys: ['chat:spaces/DM1/messages/m1.m1', 'chat:spaces/GRP1/messages/g1.g1', 'chat:spaces/ROOM1/messages/r1.r1']
  };
}

function deleteMessage(message, at) {
  message.deleteTime = iso(at || Date.now());
  message.deletionMetadata = { deletionType: 'CREATOR' };
  delete message.text;
  delete message.formattedText;
  return message;
}

module.exports = { buildChatFixture, buildChatServer, buildLiveReplay, deleteMessage, ME };
