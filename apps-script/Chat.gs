/**
 * Chat.gs — Google Chat capture: REST API with user auth through UrlFetchApp, plus the
 * chat-noreply email-notification fallback parser.
 */

const CHAT_API_BASE_ = 'https://chat.googleapis.com/v1/';
const CHAT_NOREPLY_ = 'chat-noreply@google.com';
const CHAT_LINK_RE_ = /https:\/\/(?:chat\.google\.com|mail\.google\.com\/chat)\/[^\s"'<>)\]]+/;

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

/** Inbox row object for a Chat API message. */
function chatMessageToInbox(message, space) {
  const sender = message.sender || {};
  const from = [sender.displayName || '', sender.email ? '<' + sender.email + '>' : ''].filter(Boolean).join(' ') || 'Chat user';
  return {
    source: 'Chat',
    from: from,
    subject: str(space && space.displayName).trim() || 'Direct message',
    snippet: cleanSnippet(message.text || message.formattedText || '', SNIPPET_MAX),
    link: chatSpaceLink_(space),
    sourceKey: 'chat:' + str(message.name),
    categoryHint: 'Work'
  };
}

/**
 * Chat capture via the API. Returns {rows, mode, errors}: mode "api" on success (or after
 * a 429 skip), "email" when the API answered 401/403 (rows then come from the email fallback).
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
      const messages = chatListMessages_(token, space.name, cutoffIso);
      messages.forEach((message) => {
        if (!chatMessageWanted(message, space, meSet)) return;
        const row = chatMessageToInbox(message, space);
        if (existingKeys.has(row.sourceKey)) return;
        existingKeys.add(row.sourceKey);
        rows.push(row);
      });
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
