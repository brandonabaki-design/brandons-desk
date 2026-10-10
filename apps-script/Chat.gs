/**
 * Chat.gs — Google Chat capture: REST API with user auth through UrlFetchApp, plus the
 * chat-noreply email-notification fallback parser.
 */

const CHAT_API_BASE_ = 'https://chat.googleapis.com/v1/';
const CHAT_NOREPLY_ = 'chat-noreply@google.com';
const CHAT_LINK_RE_ = /https:\/\/(?:chat\.google\.com|mail\.google\.com\/chat)\/[^\s"'<>)\]]+/;

/**
 * A message whose whole text (normalised by chatNormalise_) is one of these is only an
 * acknowledgement and is never shown (SPEC 6). Normalised once, at first use.
 */
const CHAT_ACKS_ = ['ok', 'okay', 'k', 'thanks', 'thank you', 'thx', 'ty', 'correct', 'yes', 'yeah', 'yep', 'no', 'nope',
  'sure', 'go', 'done', 'noted', 'great', 'perfect', 'cool', 'nice', 'lol', 'haha', 'good', 'fine', 'got it', 'will do',
  'on it', 'see you', 'take care', 'شكرا', 'شكراً', 'تمام', 'حاضر', 'ماشي', 'اوكي', 'نعم', 'لا'];
/** Interjections that, like the acknowledgements, do not count towards the length at the start or end of a message. */
const CHAT_INTERJECTIONS_ = ['oh', 'ohh', 'ah', 'ahh', 'aw', 'aww', 'awww', 'ooh', 'wow', 'oops', 'hmm', 'um', 'uh', 'hi', 'hey', 'hello'];
/** Letters and digits a message needs (outside phone numbers and edge filler) to count without "?" or a URL. */
const CHAT_MIN_CHARS_ = 12;
const CHAT_URL_RE_ = /https?:\/\/\S/i;
const CHAT_URLS_RE_ = /https?:\/\/\S+/gi;
/** Phone-number-like: 7 or more digits, optionally with a leading + and space - . ( ) / between them. */
const CHAT_PHONE_RE_ = /\+?\d(?:[\s\-.()\/]*\d){6,}/g;
const CHAT_SNIPPET_JOIN_ = ' · ';
let chatFiller_ = null;

/** Control-flow error carrying the HTTP code of a failed Chat API call. */
function chatHttpError_(code, body, url) {
  const err = new Error('Chat API HTTP ' + code + ' for ' + url);
  err.chatCode = code;
  err.chatBody = body;
  return err;
}

function parseJsonSafe_(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    return { raw: String(text).slice(0, 500) };
  }
}

/**
 * GET a Chat API URL with the user's OAuth token. 429 → wait 2 s and retry once.
 * Any other non-2xx response is thrown as a chatHttpError_.
 */
function chatGet_(url, token) {
  let retried = false;
  for (;;) {
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 429 && !retried) {
      retried = true;
      Utilities.sleep(2000);
      continue;
    }
    const body = parseJsonSafe_(res.getContentText());
    if (code < 200 || code >= 300) throw chatHttpError_(code, body, url);
    return body;
  }
}

function chatBlockedDetail_(body) {
  const parts = [];
  if (body && body.error) {
    if (body.error.status) parts.push(body.error.status);
    const d = body.error.details;
    if (Array.isArray(d) && d[0] && d[0].reason) parts.push(d[0].reason);
    if (!parts.length && body.error.message) parts.push(truncate(body.error.message, 120));
  }
  return parts.join(' ');
}

/** Lists every space the caller belongs to (paging through nextPageToken). */
function chatListSpaces_(token) {
  const spaces = [];
  let pageToken = '';
  do {
    const url = CHAT_API_BASE_ + 'spaces?pageSize=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const body = chatGet_(url, token);
    (body.spaces || []).forEach((s) => spaces.push(s));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return spaces;
}

/** Lists messages of a space created after `cutoffIso` (RFC-3339). */
function chatListMessages_(token, spaceName, cutoffIso) {
  const messages = [];
  let pageToken = '';
  const filter = encodeURIComponent('create_time > "' + cutoffIso + '"');
  do {
    const url = CHAT_API_BASE_ + spaceName + '/messages?pageSize=100&filter=' + filter +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const body = chatGet_(url, token);
    (body.messages || []).forEach((m) => messages.push(m));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return messages;
}

function spaceIdOf_(spaceName) {
  return str(spaceName).replace(/^spaces\//, '');
}

function chatSpaceLink_(space) {
  const uri = sanitiseLink(space && space.spaceUri);
  if (uri) return uri;
  return 'https://mail.google.com/chat/u/0/#chat/space/' + spaceIdOf_(space && space.name);
}

function mentionsMe_(message, meSet) {
  const ann = Array.isArray(message.annotations) ? message.annotations : [];
  return ann.some((a) => {
    if (!a || a.type !== 'USER_MENTION') return false;
    const user = a.userMention && a.userMention.user;
    const email = user && user.email ? String(user.email).toLowerCase() : '';
    return !!email && meSet.has(email);
  });
}

/**
 * Decides whether a Chat message becomes an Inbox row. Pure.
 * @return {boolean}
 */
function chatMessageWanted(message, space, meSet) {
  if (!message || !message.sender) return false;
  if (message.sender.type === 'BOT') return false;
  const email = message.sender.email ? String(message.sender.email).toLowerCase() : '';
  if (email && meSet.has(email)) return false;
  const type = space && space.spaceType;
  if (type === 'DIRECT_MESSAGE' || type === 'GROUP_CHAT') return true;
  return mentionsMe_(message, meSet);
}

function chatText_(message) {
  return str(message && (message.text || message.formattedText));
}

function chatKey_(message) {
  return 'chat:' + str(message && message.name);
}

/**
 * Lower-case, combining marks (Arabic harakat/tanween) and tatweel removed, alef forms unified,
 * every character that is not a letter, digit or space (punctuation, emoji, symbols) turned into
 * a space, whitespace collapsed.
 */
function chatNormalise_(s) {
  return str(s).toLowerCase()
    .replace(/[\p{M}\u0640]/gu, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** {acks:Set, filler:Set, longest:n} built from CHAT_ACKS_ + CHAT_INTERJECTIONS_ (normalised). */
function chatFillerSets_() {
  if (chatFiller_) return chatFiller_;
  const acks = new Set(CHAT_ACKS_.map(chatNormalise_));
  const filler = new Set(Array.from(acks).concat(CHAT_INTERJECTIONS_.map(chatNormalise_)));
  let longest = 1;
  filler.forEach((p) => { longest = Math.max(longest, p.split(' ').length); });
  chatFiller_ = { acks: acks, filler: filler, longest: longest };
  return chatFiller_;
}

/**
 * Letters and digits left in normalised text once acknowledgement phrases and interjections are
 * peeled off its start and its end ("oh shoot take care" → "oh shoot" → "shoot" → 5).
 */
function chatCoreLength_(normalised) {
  const sets = chatFillerSets_();
  const words = normalised ? normalised.split(' ') : [];
  let start = 0;
  let end = words.length;
  const peel = (fromStart) => {
    for (let n = Math.min(sets.longest, end - start); n >= 1; n--) {
      const phrase = (fromStart ? words.slice(start, start + n) : words.slice(end - n, end)).join(' ');
      if (sets.filler.has(phrase)) {
        if (fromStart) start += n; else end -= n;
        return true;
      }
    }
    return false;
  };
  while (start < end && peel(true)) { /* peel leading filler */ }
  while (start < end && peel(false)) { /* peel trailing filler */ }
  return Array.from(words.slice(start, end).join('')).length;
}

/**
 * Is this Chat message text worth an Inbox line (SPEC 6)? Pure.
 * A URL always is. Otherwise, with phone numbers taken out: it needs a letter, must not be only
 * an acknowledgement, and needs a "?" (or "؟") or at least CHAT_MIN_CHARS_ letters/digits once
 * acknowledgements and interjections are peeled off its start and end.
 */
function chatTextSubstantive(text) {
  const raw = str(text).trim();
  if (!raw) return false;
  if (CHAT_URL_RE_.test(raw)) return true;
  const core = chatNormalise_(raw.replace(CHAT_URLS_RE_, ' ').replace(CHAT_PHONE_RE_, ' '));
  if (!/\p{L}/u.test(core)) return false;
  if (chatFillerSets_().acks.has(core)) return false;
  if (/[?؟]/.test(raw)) return true;
  return chatCoreLength_(core) >= CHAT_MIN_CHARS_;
}

/**
 * The text chatTextSubstantive judges: the message text without its @mentions, so that
 * "@Brandon Abaki ok" is still only an acknowledgement. Annotated USER_MENTION ranges are cut
 * when they start with "@" (startIndex omitted = 0, as proto3 JSON drops zero values); any other
 * "@word" left over is cut too.
 */
function chatTextForFilter_(message) {
  let text = chatText_(message);
  const ann = Array.isArray(message && message.annotations) ? message.annotations : [];
  ann.filter((a) => a && a.type === 'USER_MENTION' && Number(a.length) > 0)
    .map((a) => ({ start: Number(a.startIndex) || 0, length: Number(a.length) }))
    .sort((a, b) => b.start - a.start)
    .forEach((r) => {
      if (text.charAt(r.start) === '@') text = text.slice(0, r.start) + ' ' + text.slice(r.start + r.length);
    });
  return text.replace(/(^|\s)@\S+/g, '$1');
}

/** Messages sorted by createTime, oldest first (stable; a missing/bad time sorts first). */
function chatSortByTime_(messages) {
  return (messages || []).map((m, i) => {
    const t = m && m.createTime ? Date.parse(m.createTime) : NaN;
    return { m: m, t: isNaN(t) ? 0 : t, i: i };
  }).sort((a, b) => (a.t - b.t) || (a.i - b.i)).map((x) => x.m);
}

/**
 * The messages of one space that go into this run's Inbox row, oldest first. Pure.
 * `messages` is every message of the space in the lookback window. Only messages after the
 * newest KNOWN one (key chat:<name> already in existingKeys) are new; of those, the wanted
 * (chatMessageWanted) and substantive (chatTextSubstantive of the text without @mentions) ones
 * are returned.
 */
function chatNewMessages(messages, space, meSet, existingKeys) {
  const sorted = chatSortByTime_(messages).filter((m) => m && typeof m === 'object');
  let lastKnown = -1;
  sorted.forEach((m, i) => { if (existingKeys.has(chatKey_(m))) lastKnown = i; });
  return sorted.slice(lastKnown + 1).filter((m) => chatMessageWanted(m, space, meSet) && chatTextSubstantive(chatTextForFilter_(m)));
}

function chatSenderLabel_(sender) {
  const s = sender || {};
  return collapseWhitespace(s.displayName) || str(s.email).trim() || 'Chat user';
}

function chatSenderFirstName_(sender) {
  const s = sender || {};
  const name = collapseWhitespace(s.displayName);
  if (name) return name.split(' ')[0];
  const email = str(s.email).trim();
  return email ? email.split('@')[0] : 'Chat user';
}

/** Keeps the END of s: longer than max → "… " + the last characters, total ≤ max. */
function chatKeepEnd_(s, max) {
  if (s.length <= max) return s;
  let tail = s.slice(s.length - (max - 2));
  const c = tail.charCodeAt(0);
  if (c >= 0xDC00 && c <= 0xDFFF) tail = tail.slice(1); // never start on half of a surrogate pair
  return '… ' + tail.replace(/^\s+/, '');
}

function chatSubject_(space) {
  const name = collapseWhitespace(space && space.displayName);
  if (name) return name;
  return space && space.spaceType === 'GROUP_CHAT' ? 'Group chat' : 'Direct message';
}

/**
 * Inbox row object for one space from its included messages (oldest first, non-empty). Pure.
 * messageCount is internal (counted into runCaptureNow's chatMessages, never written to the sheet).
 */
function chatConversationToInbox(messages, space) {
  const names = [];
  messages.forEach((m) => {
    const label = chatSenderLabel_(m.sender);
    if (names.indexOf(label) < 0) names.push(label);
  });
  const firstEmail = str(messages[0].sender && messages[0].sender.email).trim();
  if (firstEmail && names[0] !== firstEmail) names[0] += ' <' + firstEmail + '>';
  const lines = messages.map((m) => chatSenderFirstName_(m.sender) + ': ' + collapseWhitespace(chatText_(m)));
  return {
    source: 'Chat',
    from: names.join(', '),
    subject: chatSubject_(space),
    snippet: chatKeepEnd_(lines.join(CHAT_SNIPPET_JOIN_), SNIPPET_MAX),
    link: chatSpaceLink_(space),
    sourceKey: chatKey_(messages[messages.length - 1]),
    categoryHint: 'Work',
    messageCount: messages.length
  };
}

/**
 * Chat capture via the API. Returns {rows, mode, errors}: one row per space with something new
 * (chatNewMessages); mode "api" on success (or after a 429 skip), "email" when the API answered
 * 401/403 (rows then come from the email fallback, one per notification email).
 */
function captureChat(config, existingKeys, meSet, now) {
  guard();
  const errors = [];
  const at = isDateValue(now) ? now : new Date();
  const lookback = Math.max(1, Number(config.CHAT_LOOKBACK_DAYS) || 2);
  const cutoff = new Date(at.getTime() - lookback * 86400000);
  const cutoffIso = cutoff.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const rows = [];
  let token = '';
  try {
    token = ScriptApp.getOAuthToken();
  } catch (e) {
    errors.push('Chat: no OAuth token (' + errorMessage(e) + ')');
    return { rows: rows, mode: 'api', errors: errors };
  }
  try {
    const spaces = chatListSpaces_(token);
    spaces.forEach((space) => {
      if (space.singleUserBotDm) return;
      if (space.lastActiveTime) {
        const last = parseDate(space.lastActiveTime);
        if (last && last.getTime() < cutoff.getTime()) return;
      }
      // One row per space: its new, wanted and substantive messages (SPEC 6).
      const included = chatNewMessages(chatListMessages_(token, space.name, cutoffIso), space, meSet, existingKeys);
      if (!included.length) return;
      const row = chatConversationToInbox(included, space);
      if (existingKeys.has(row.sourceKey)) return;
      existingKeys.add(row.sourceKey);
      rows.push(row);
    });
    return { rows: rows, mode: 'api', errors: errors };
  } catch (e) {
    const code = e && e.chatCode;
    if (code === 401 || code === 403) {
      const detail = chatBlockedDetail_(e.chatBody);
      log('captureChat', 'WARN', 'CHAT_API_BLOCKED HTTP ' + code + (detail ? ' ' + detail : '') + ' — using the email-notification fallback for this run');
      const fallback = captureChatEmails(config, existingKeys, lookback);
      return { rows: fallback.rows, mode: 'email', errors: errors.concat(fallback.errors) };
    }
    if (code === 429) {
      log('captureChat', 'WARN', 'Chat API HTTP 429 after one retry; Chat skipped for this run');
      return { rows: rows, mode: 'api', errors: errors };
    }
    const msg = code ? 'Chat API HTTP ' + code + ' ' + chatBlockedDetail_(e.chatBody) : errorMessage(e);
    log('captureChat', 'ERROR', msg);
    errors.push('Chat: ' + collapseWhitespace(msg));
    return { rows: rows, mode: 'api', errors: errors };
  }
}

// ---------------------------------------------------------------------------
// Email-notification fallback
// ---------------------------------------------------------------------------

/** Is this Gmail message a Google Chat reminder email? */
function isChatNotification(message) {
  const from = str(message.getFrom());
  if (extractEmail(from) === CHAT_NOREPLY_) return true;
  return /google chat/i.test(extractDisplayName(from));
}

function paragraphIsBoilerplate_(p) {
  if (/unsubscribe|notification settings|google llc|you received this|received this email|amphitheatre|privacy policy|terms of service|manage notifications|turn off/i.test(p)) return true;
  if (/^https?:\/\/\S+$/i.test(p)) return true;
  if (/^(reply|open) in (google )?chat/i.test(p)) return true;
  return p.length < 3;
}

/**
 * Tolerant parser for a Chat reminder email. Returns {from, subject, snippet, link}.
 * The subject is the sender/space hint; the body gives the link and the quoted text.
 */
function parseChatNotificationEmail(subject, body) {
  const subj = collapseWhitespace(subject);
  const text = str(body).replace(/\r\n?/g, '\n');
  const linkMatch = CHAT_LINK_RE_.exec(text);
  const link = linkMatch ? sanitiseLink(linkMatch[0].replace(/[.,;:]+$/, '')) : '';
  const paragraphs = text.split(/\n\s*\n/).map((p) => collapseWhitespace(p)).filter((p) => p && !paragraphIsBoilerplate_(p));
  const quoted = paragraphs.filter((p) => /^["“‘'>]/.test(p));
  const pool = quoted.length ? quoted : paragraphs;
  let best = '';
  pool.forEach((p) => { if (p.length > best.length) best = p; });
  best = best.replace(/^[>\s]+/, '').replace(/^["“‘']+/, '').replace(/["”’']+$/, '').trim();
  let from = subj;
  const who = /^(.+?)\s+(?:sent you|messaged you|mentioned you|replied|posted|shared)/i.exec(subj);
  if (who) from = who[1].trim();
  let space = 'Google Chat';
  const inSpace = /\bin\s+(?:the\s+)?(?:space\s+)?["“]?([^"”]+?)["”]?\s*(?:on Google Chat)?$/i.exec(subj);
  if (inSpace && inSpace[1] && !/google chat$/i.test(inSpace[1])) space = inSpace[1].trim();
  return {
    from: from || 'Google Chat',
    subject: space,
    snippet: cleanSnippet(best || subj, SNIPPET_MAX),
    link: link
  };
}

/**
 * Parses chat-noreply reminder emails from the lookback window into Inbox rows.
 * Source key chat:email:<messageId>.
 */
function captureChatEmails(config, existingKeys, lookbackDays) {
  guard();
  const rows = [];
  const errors = [];
  const days = Math.max(1, Number(lookbackDays) || 2);
  try {
    // Address or display name (SPEC 6): isChatNotification() is the precise filter afterwards.
    const threads = GmailApp.search('from:(' + CHAT_NOREPLY_ + ' OR "Google Chat") newer_than:' + days + 'd', 0, GMAIL_MAX_THREADS);
    const perThread = threads.length ? GmailApp.getMessagesForThreads(threads) : [];
    perThread.forEach((messages) => {
      (messages || []).forEach((message) => {
        if (!isChatNotification(message)) return;
        const key = 'chat:email:' + message.getId();
        if (existingKeys.has(key)) return;
        const parsed = parseChatNotificationEmail(message.getSubject(), message.getPlainBody());
        existingKeys.add(key);
        rows.push({
          source: 'Chat',
          from: parsed.from,
          subject: parsed.subject + ' (email notification)',
          snippet: parsed.snippet,
          link: parsed.link,
          sourceKey: key,
          categoryHint: 'Work'
        });
      });
    });
  } catch (e) {
    log('captureChatEmails', 'ERROR', errorMessage(e));
    errors.push('Chat email fallback: ' + errorMessage(e));
  }
  return { rows: rows, errors: errors };
}

/** One cheap API call to report whether Chat is reachable (used by selfTest). */
function chatProbe() {
  guard();
  const out = { ok: false, code: 0, detail: '' };
  try {
    const token = ScriptApp.getOAuthToken();
    const res = UrlFetchApp.fetch(CHAT_API_BASE_ + 'spaces?pageSize=1', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    out.code = res.getResponseCode();
    const body = parseJsonSafe_(res.getContentText());
    out.ok = out.code >= 200 && out.code < 300;
    out.detail = out.ok ? ((body.spaces || []).length + ' space(s) visible') : chatBlockedDetail_(body);
    if (out.code === 401 || out.code === 403) {
      log('chatProbe', 'WARN', 'CHAT_API_BLOCKED HTTP ' + out.code + (out.detail ? ' ' + out.detail : ''));
    }
  } catch (e) {
    out.detail = errorMessage(e);
  }
  return out;
}
