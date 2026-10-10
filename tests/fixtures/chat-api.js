'use strict';
/**
 * Google Chat REST API fixture: builds a UrlFetchApp handler that serves spaces and
 * messages relative to `now`, with optional scripted failures.
 *
 * buildChatFixture({ now, mode }) → { handler, expected }
 *   mode: 'ok' (default) | 'forbidden' | 'unauthorized' | 'rate-limit-once' | 'rate-limit-always' | 'server-error'
 */

function iso(date) {
  return new Date(date).toISOString();
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

module.exports = { buildChatFixture };
