# Brandon's Desk — build spec

Private task tracker for Brandon Abaki. Tracks Work and Personal tasks separately in one Google Sheet, with an Apps Script web app on top, daily capture from work Gmail and Google Chat, and two outputs: a weekly agenda for the Tuesday meeting with the director (downloadable as .xlsx) and material for the AI Learning Hub newsletter.

This file is the contract. Code, tests and setup docs are checked against it.

## 1. Accounts and ownership

| Thing | Account | Notes |
|---|---|---|
| Apps Script project + web app | `bbaki@aisa.sch.ae` (work) | Deployed "Execute as me", "Only myself". |
| Google Sheet `Brandon's Desk` | Owner `brandon.abaki@gmail.com`; editor `bbaki@aisa.sch.ae` | ID `1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w`. The script opens it with `SpreadsheetApp.openById`. `setup()` can also create a fresh sheet in work Drive with the identical schema. |
| Claude connectors | Gmail + Drive = personal; Calendar + Sheets = work | Claude's scheduled routines read personal Gmail and work Calendar, and read/write the Sheet through the work account. |
| Work Gmail and Google Chat | work | Read by the Apps Script capture trigger, not by Claude. |

## 2. Data flow

```
work Gmail  ─┐
work Chat   ─┴─▶ Apps Script trigger (06:15 Dubai, weekdays) ─▶ Inbox tab
                                                                  │
personal Gmail ─┐                                                 ▼
work Calendar ──┴─▶ Claude daily routine (06:45 Dubai) ─▶ Work / Personal tabs (new tasks, Inbox rows promoted or ignored)
                                                                  │
web app (Today / Inbox / Add / Import / Agenda / Newsletter) ◀────┘  ← Brandon ticks off, adds, imports, edits
                                                                  │
Claude weekly routine (Mon 18:10 Dubai) ─▶ Agenda tab ◀───────────┘  → web app "Download .xlsx"
```

Nothing is deleted. Tasks are carried over as one row until Done or Dropped.

## 3. Sheet schema (exact; already built in the live sheet)

Spreadsheet time zone: `Asia/Dubai`. Header row 1 is frozen on every tab. All date columns hold real Date values (midnight Dubai for date-only columns). Checkbox columns hold booleans.

### `Work` (sheetId 0) and `Personal` (sheetId 1) — identical, 16 columns

| Col | Header | Type | Rules |
|---|---|---|---|
| A | ID | text | `W-xxxxxxxx` / `P-xxxxxxxx` (prefix by tab, 8 lowercase base36 chars). Unique within the tab. The app fills blank IDs on read. |
| B | Created | date | Date the task first appeared. Default today. |
| C | Title | text | ≤ 140 chars, in Brandon's words. Required. |
| D | Details | text | Optional. |
| E | Source | text (dropdown, non-strict) | `Gmail`, `Chat`, `Calendar`, `Manual`, `Import`, `Claude`. |
| F | Link | url | Email, Chat, Calendar or Drive link, if any. |
| G | Status | dropdown (strict) | `Open`, `Done`, `Dropped`. Default `Open`. |
| H | Done | date | Set when Status becomes Done; cleared on reopen. |
| I | Note | text | One-line outcome note, optional. |
| J | Project | text | Free text; suggestions from Config `PROJECTS`. |
| K | Newsletter | checkbox | Auto-ticked when Title/Details match `NEWSLETTER_KEYWORDS`; user can untick. |
| L | Discuss | checkbox | "Discuss with director". Brings the task and its link into the agenda. |
| M | Due | date | Optional. |
| N | Priority | dropdown (strict) | `High`, `Normal`, `Low`. Default `Normal`. |
| O | Source key | text | Dedupe key: `gmail:<id of the first message in the thread>` (Gmail thread IDs change as messages arrive; message IDs are immutable), `chat:<message name>`, `cal:<eventId>`, `import:<sha1 of normalised title+date>`, blank for manual. Unique when present. |
| P | Updated | datetime | Set on every write by the app. |

Conditional formatting: Done rows grey + strikethrough, Dropped rows light grey, High priority red bold. Banding header purple `#21076C`.

### `Inbox` (sheetId 2) — 11 columns

| Col | Header | Type |
|---|---|---|
| A | ID | text `I-xxxxxxxx` |
| B | Captured | datetime |
| C | Source | `Gmail` / `Chat` |
| D | From | sender display name + email |
| E | Subject | subject or space name |
| F | Snippet | ≤ 400 chars plain text |
| G | Link | permalink |
| H | Source key | `gmail:<first message id>` / `chat:<message name>` — unique |
| I | Status | `New` / `Promoted` / `Ignored` |
| J | Task ID | task created from this row, if any |
| K | Category hint | `Work` / `Personal` |

### `Agenda` (sheetId 3) — 8 columns

| Col | Header | Type |
|---|---|---|
| A | Week of | date (Monday of the meeting week) |
| B | Section | `Done` / `In progress` / `Questions` / `Documents` / `Notes` |
| C | Order | integer, display order within section |
| D | Item | text (the task title, question, or document name) |
| E | Detail | text (note, project, why it matters) |
| F | Link | url |
| G | Task ID | linked task, if any |
| H | Generated | datetime |

### `Config` (sheetId 4) — Key / Value / Notes

Keys: `ALLOWED_EMAILS`, `TIMEZONE`, `MEETING_DAY`, `GMAIL_QUERY`, `GMAIL_LOOKBACK_DAYS`, `CHAT_ENABLED`, `CHAT_LOOKBACK_DAYS`, `NEWSLETTER_KEYWORDS`, `DEFAULT_QUICKADD_CATEGORY`, `PROJECTS`, `DIRECTOR_NAME`. Comma-separated lists where plural. The app reads Config on every request (cheap, 12 rows) and never caches across executions.

### `Log` (sheetId 5) — Time / Function / Level / Message

Trigger runs and errors. The app trims the tab to the newest 1 500 rows when it exceeds 2 000.

### Rows written by other tools

Claude's routines append rows with the Sheets API. They always write the same column order, but may leave ID, Created, Status, Priority or Updated blank. `healSheet(category)` runs at the start of every web-app read and in the capture trigger: fills ID, Created = today, Status = Open, Priority = Normal, Updated = now, trims whitespace, and reports what it fixed in the Log.

## 4. Apps Script project layout (`apps-script/`)

```
apps-script/
  appsscript.json      manifest: timeZone Asia/Dubai, V8, exceptionLogging STACKDRIVER, webapp {access: MYSELF, executeAs: USER_DEPLOYING}, the Chat advanced service (userSymbol Chat, serviceId chat, v1 — switches the API on; the code never references the Chat symbol), explicit oauthScopes (exactly: spreadsheets, gmail.readonly, script.external_request, script.scriptapp, userinfo.email, chat.spaces.readonly, chat.messages.readonly). No "chat" key.
  Config.gs            SHEET_ID (Script Property, fallback constant), column maps, enums, readConfig()
  Sheet.gs             open/ensure tabs, row <-> object mapping, healSheet, ids, find/append/update with LockService
  Tasks.gs             task operations (add/update/complete/reopen/drop/move/list), dedupe, auto-tagging
  Capture.gs           captureInbox(): Gmail + Chat -> Inbox, installTriggers(), removeTriggers()
  Chat.gs              Chat API (user auth, UrlFetchApp) + email-notification fallback parser
  Import.gs            importText(), importHtml()
  Agenda.gs            week maths, agenda draft builder, rule-based questions, save/load Agenda tab
  Newsletter.gs        newsletter selection + markdown
  Api.gs               doGet(), the google.script.run entry points, auth guard, input validation, error wrapping
  Setup.gs             setup(): create or adopt sheet, apply schema, store SHEET_ID, install triggers; selfTest()
  Util.gs              dates (Dubai), text normalisation, similarity, id generation, logging
  Index.html           page shell (template), includes Styles.html and App.html
  Styles.html          CSS
  App.html             client JS (single-page app, google.script.run calls, SheetJS export)
```

Plain JavaScript (V8 runtime). No `import`/`export`/`require` in `.gs` files (Apps Script loads every file into one global scope; `.clasp.json` lists `Config.gs` and `Util.gs` first in `filePushOrder`, and no file may reference another file's globals at load time). Every `.gs` file must also load in the Node test harness (section 9), so no top-level calls to Google services: all service access happens inside functions.

## 5. Server API (`google.script.run.<fn>`)

All functions take one plain object and return one plain JSON-safe object. Dates in and out are strings: `yyyy-MM-dd` for dates, ISO 8601 for datetimes. `Range.getValues()` returns `Date` objects for date cells and `google.script.run` cannot return a `Date` (the call fails), so every row is converted to strings before it leaves the server; no server function may return a `Date`, `undefined` inside arrays, or a function. Every call runs `guard()` first (section 7). Errors throw `Error` with a short message the UI shows; internal details go to Log.

Task object returned everywhere:

```json
{"id":"W-k9x3q1a7","category":"Work","created":"2026-10-10","title":"...","details":"...","source":"Gmail","link":"https://...","status":"Open","done":"","note":"","project":"AI Learning Hub","newsletter":true,"discuss":false,"due":"2026-10-14","priority":"Normal","sourceKey":"gmail:18f...","updated":"2026-10-10T06:40:12+04:00","row":17}
```

| Function | Input | Output | Behaviour |
|---|---|---|---|
| `getBootstrap` | `{}` | `{user, today, config:{...}, projects:[], categories:["Work","Personal"], counts:{work:{open,dueToday,overdue}, personal:{...}, inboxNew}}` | Runs `healSheet` on both tabs. |
| `listTasks` | `{category?, status?, from?, to?, search?}` | `{tasks:[Task]}` | `category` omitted = both tabs. `from`/`to` filter on Created (Open) or Done (Done). `search` matches title/details/note/project, case-insensitive. Sorted: overdue → due today → High → others by Created desc. |
| `addTask` | `{category, title, details?, project?, due?, priority?, link?, newsletter?, discuss?, source?, created?, sourceKey?}` | `{task, duplicate:boolean}` | Validates (title required, category in enum). Dedupe: same `sourceKey` (any status) or similar title (section 6) among Open tasks → returns the existing task with `duplicate:true` and does not add. Applies newsletter auto-tag when `newsletter` is undefined. Source defaults to `Manual`. |
| `updateTask` | `{category, id, patch:{title?,details?,project?,due?,priority?,link?,newsletter?,discuss?,note?,status?}}` | `{task}` | Whitelisted fields only. `status:"Done"` sets Done = today if blank; `status:"Open"` clears Done. |
| `completeTask` | `{category, id, note?}` | `{task}` | Status Done, Done = today (Dubai), Note appended if given. |
| `reopenTask` | `{category, id}` | `{task}` | Status Open, Done cleared. |
| `dropTask` | `{category, id, note?}` | `{task}` | Status Dropped. |
| `moveTask` | `{category, id, toCategory}` | `{task}` | Copies the row to the other tab with a new ID, marks the old row Dropped with Note "Moved to <newId>". |
| `importText` | `{category, text, created?}` | `{added:[Task], skipped:[{line, reason}]}` | Section 6. |
| `importHtml` | `{html, category?, created?}` | same | Section 6. |
| `listInbox` | `{status?}` | `{items:[InboxItem]}` | Default `New`, newest first. |
| `promoteInbox` | `{inboxId, category, title?, project?, due?, priority?}` | `{task}` | Creates the task (Source = inbox Source, Link, Source key copied), marks the Inbox row Promoted with Task ID. |
| `ignoreInbox` | `{inboxId}` | `{ok:true}` | |
| `getAgenda` | `{meetingDate?}` | `{meetingDate, weekOf, window:{from,to}, saved:boolean, sections:{"Done":[Row],"In progress":[Row],"Questions":[Row],"Documents":[Row],"Notes":[Row]}}` | `meetingDate` defaults to the next `MEETING_DAY` on or after today. If the Agenda tab has rows for that `weekOf`, returns them (`saved:true`); otherwise returns a draft built from tasks (`saved:false`). Row = `{order,item,detail,link,taskId}`. |
| `saveAgenda` | `{meetingDate, sections}` | `{ok:true, rows:n}` | Replaces that week's rows in the Agenda tab. |
| `regenerateAgenda` | `{meetingDate}` | same as `getAgenda` | Rebuilds the draft from tasks, keeping any saved `Questions` and `Notes` rows. |
| `getNewsletter` | `{from?, to?}` | `{tasks:[Task], markdown}` | Work tasks with Newsletter ticked, Done in range (default: last 28 days) plus Open ones; markdown grouped by project with notes and links. |
| `runCaptureNow` | `{}` | `{gmail:n, chat:n, chatMode:"api"\|"email"\|"off", errors:[]}` | Same as the trigger, on demand. |
| `getLog` | `{limit?}` | `{rows:[{time,fn,level,message}]}` | Newest first, default 100. |

## 6. Rules

**IDs.** `W-`/`P-`/`I-` + 8 chars from base36 of `Date.now()` and random, lowercase; regenerate on collision.

**Dates.** All "today" logic uses Config `TIMEZONE` (Asia/Dubai) via `Utilities.formatDate`. Never use `new Date().toISOString().slice(0,10)` for a local date.

**Title similarity (dedupe).** `normaliseTitle(s)`: lowercase, strip punctuation, collapse whitespace, drop leading "re:", "fwd:". Two titles are duplicates when normalised strings are equal, or when the Dice coefficient of their word sets ≥ 0.8 and both have ≥ 3 words.

**Newsletter auto-tag.** Title + Details lowercased contains any `NEWSLETTER_KEYWORDS` entry as a whole word (keywords lowercased, trimmed; multi-word keywords matched as phrases).

**Agenda window.** `meetingDate` = next `MEETING_DAY` ≥ today (Dubai). `weekOf` = Monday of the meeting's week. `window.from` = meetingDate − 7 days, `window.to` = meetingDate − 1 day (inclusive). Draft sections:
- *Done*: Work tasks with Status Done and Done date in window, grouped by Project (Project as the first `detail` word group, e.g. `detail` = "AI Learning Hub · note"), ordered by project then Done date.
- *In progress*: Open Work tasks that are High priority, or Discuss-ticked, or Updated in window, or Created in window; ordered High first, then Due.
- *Questions*: rule-based (section 6a), unless saved rows exist.
- *Documents*: every distinct Link on Discuss-ticked Work tasks (Open or Done in window) and on Done-in-window tasks with a Link; `item` = task title, `link` = the link.
- *Notes*: empty in the draft.

**6a. Rule-based questions** (each fires at most once, max 8 total, ordered as listed):
1. Open Work task with Due in the past → "«{title}» is overdue (due {due}). Still a priority, or should the date move?"
2. Open Work task older than 14 days and not updated in 7 → "«{title}» has been open since {created}. What's blocking it, and is it still mine?"
3. Discuss-ticked task → "{title}: {note or details or 'what do you need from me on this?'}"
4. ≥ 3 Done tasks in the same Project this window → "{project}: {n} items closed this week. Should this be in the Hub newsletter or shared with staff?"
5. Any Done task with Newsletter ticked → "The newsletter draft includes {n} items. Is there anything you'd like added or held back?"
6. Any task with Source = Calendar in the coming 7 days (Open, Due within 7 days) → "«{title}» is coming up on {due}. Anything you want me to prepare?"
7. Open High-priority task with no Due → "«{title}» is marked high priority but has no date. When do you need it by?"
8. Always last: "Anything from your side that should go on my list for next week?"

**Import (text).** One task per non-empty line. A line starting with `#` sets the current Project. Prefix `[Work]`/`[Personal]`/`[W]`/`[P]` sets the category for that line (overrides the call's `category`). `- [x]`, `[x]`, `✓`, `✔`, `☑` at the start = Done (Done date = `created`). Strip leading bullets `-`, `*`, `•`, `☐`, `[ ]`, numbers `1.`/`1)`. Trailing `@2026-10-14` or `due: 2026-10-14` sets Due. Trailing `!` or `!!` = High. Lines ≤ 2 chars are skipped. Dedupe per section 6; duplicates are reported in `skipped` with reason `duplicate`. Source = `Import`, Source key = `import:<sha1 hex of normalisedTitle + '|' + created>`.

**Import (HTML).** Strip `<script>`/`<style>`. Walk headings (`h1`–`h4`) and lists (`li`, and any element with `type="checkbox"` + label text, and elements whose class contains `task` or `todo`). A heading whose text contains "work"/"school"/"AISA" sets category Work; "personal"/"home" sets Personal; other headings set Project. A checked checkbox or a `line-through`/`done`/`completed`/`checked` class = Done. Text is decoded (`&amp;` etc.) and whitespace-collapsed. Links inside an item (`<a href>`) become the task Link. Falls back to the text importer on the stripped text when no list items are found. Never evaluates the HTML.

**Capture (Gmail).** `GmailApp.search(GMAIL_QUERY, 0, 50)` then one `GmailApp.getMessagesForThreads(threads)` call (not `getMessages()` per thread). "Me" = `Session.getEffectiveUser().getEmail()` plus `GmailApp.getAliases()` plus `ALLOWED_EMAILS`, compared on the bare address extracted from `getFrom()` (`Name <addr>`). For each thread: skip when the last message is from me, when the thread has a draft, when `gmail:<first message id>` exists in Inbox or in Work/Personal Source key, or when the last message looks automated: sender matches `/noreply|no-reply|donotreply|notifications?@|mailer-daemon|calendar-notification/i`, or it has a `List-Unsubscribe` or `List-Id` header, or `Precedence` is bulk/list/junk, or `Auto-Submitted` starts with `auto-`. Inbox row: From = last message sender (as given), Subject, Snippet = first 400 chars of the last message's plain body with quoted replies (lines starting `>` and anything after `On … wrote:`) removed, Link = `https://mail.google.com/mail/u/<work email>/#all/<threadId>`, Source key = `gmail:<first message id>`, Category hint = Work. `GmailThread.getPermalink()` is not used (it hard-codes `/u/0/#inbox/`).

**Capture (Chat).** When `CHAT_ENABLED`: call the Chat REST API with user auth through `UrlFetchApp` (`Authorization: Bearer ScriptApp.getOAuthToken()`, `muteHttpExceptions: true`), exactly as research-notes.md describes: `GET /v1/spaces` (page through `nextPageToken`; skip `singleUserBotDm` spaces and spaces whose `lastActiveTime` is older than the cutoff), then for each remaining space `GET /v1/spaces/<id>/messages` with `filter=create_time > "<cutoff RFC-3339>"` and `pageSize=100`, paging while `nextPageToken`. Keep a message when `sender.type !== "BOT"`, the sender's email is not mine, and either the space is a `DIRECT_MESSAGE`/`GROUP_CHAT` or an annotation of type `USER_MENTION` names my email. Inbox row: Source = Chat, From = `sender.displayName` (+ email), Subject = space `displayName` or "Direct message", Snippet = `text` (≤ 400), Link = `space.spaceUri` or `https://mail.google.com/chat/u/0/#chat/space/<spaceId>`, Source key = `chat:<message.name>`, Category hint = Work. On HTTP 401 or 403 (any body): log once (`Log` level WARN, message starts `CHAT_API_BLOCKED` and includes the `error.status`/`details[0].reason` when present), set `chatMode = "email"` for this run and parse Gmail reminder emails from `chat-noreply@google.com` (or display name "Google Chat") in the lookback window instead (Source key `chat:email:<messageId>`, link = first `https://chat.google.com/…` or `https://mail.google.com/chat/…` URL in the body, tolerant parsing). On HTTP 429: wait 2 s, retry once, then skip Chat for this run (`chatMode = "api"`, with a WARN log). `chatMode` (`api` | `email` | `off`) is reported by `runCaptureNow` and shown in the UI; email mode is labelled as delayed and partial (Google only emails for DMs and @mentions unread for more than 12 hours).

**Weekday guard.** The trigger runs daily (time-based triggers cannot select weekdays). `captureInbox()` returns early, with an INFO log, when the Dubai ISO weekday is 6 or 7 (Saturday, Sunday; the UAE school week is Monday–Friday). `runCaptureNow()` bypasses the guard.

**Locking.** Every write to a tab takes `LockService.getScriptLock()` (wait ≤ 10 s). Reads don't lock.

## 7. Security

- Deployment: Execute as me, Who has access: Only myself.
- `guard()` in every API function: `Session.getActiveUser().getEmail()`, falling back to `Session.getEffectiveUser().getEmail()` when the active email is blank, must be in `ALLOWED_EMAILS` (case-insensitive, trimmed) or the function throws `Not allowed`. Blank on both → `Not allowed`. (Under "Execute as me / Only myself" the owner's active email is populated, so this passes for Brandon and nobody else reaches `doGet` anyway.)
- All strings rendered in the UI go through DOM text nodes or an `esc()` helper; no `innerHTML` of untrusted strings. Links are rendered only when, after trimming and lower-casing, they start with `https://` or `http://`; everything else (`javascript:`, `data:`, `vbscript:`, protocol-relative) is dropped. Outbound links carry `target="_blank" rel="noopener"` (the page runs in a sandboxed iframe). Exported CSV/XLSX cells that start with `=`, `+`, `-` or `@` are prefixed with a space to prevent formula injection.
- HTML import never executes content (string parsing only, no `DOMParser` on the server; client may use `DOMParser` with `text/html` on a detached document, which does not run scripts).
- Secrets: none in code. `SHEET_ID` is a Script Property set by `setup()`; `apps-script/Config.gs` holds the known ID as the default so a fresh install works.
- `.clasp.json` is git-ignored (`.clasp.json.example` is committed).

## 8. Web UI

Single page, mobile first (≥ 360 px), works on desktop. Font: DM Sans from Google Fonts with system fallback. Accent `#21076C`, highlight `#D8B664`, backgrounds white / `#F7F6FB`. No framework; plain JS, no build step. SheetJS loaded from `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js` with `integrity="sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw" crossorigin="anonymous"` and an `onerror` flag; if it fails to load, the Agenda and Newsletter pages fall back to a CSV download and say so. The viewport meta tag is set server-side with `addMetaTag` (a meta tag in the HTML is stripped by HtmlService).

Pages (top tabs; the hash in the URL selects the page):

1. **Today** — quick-add bar (title, category toggle defaulting to `DEFAULT_QUICKADD_CATEGORY`, Enter to add). Two columns on desktop, stacked on mobile: Work | Personal. Groups within a column: Overdue, Due today, Open, then a collapsed "Done today". Each task row: checkbox, title, chips (project, due, High, Newsletter, Discuss), source link icon. Tap the title to expand an inline editor (details, project with datalist, due, priority, link, Newsletter, Discuss, note, Move to other list, Drop). Ticking the checkbox opens a small note field with "Done" and "Done, no note" buttons; undo appears for 10 s. Search box filters both columns. Counts in the tab label.
2. **Inbox** — New items from capture: From, Subject, Snippet, link. Buttons: Promote (choose category Work/Personal, edit title, optional project) and Ignore. "Run capture now" button with a result toast (counts + chatMode).
3. **Import** — paste text (textarea) or choose an .html file; date picker for Created (default today); live preview table (checkbox include, category select, title, project, done?) → Import. Result summary.
4. **Agenda** — meeting date picker (default next MEETING_DAY), window shown. Sections as editable lists (Done and In progress are read-only drafts but items can be removed; Questions and Notes can be edited/added/reordered; Documents editable). Buttons: Regenerate draft, Save, Download .xlsx, Copy as text. The .xlsx has one sheet "Agenda", title rows (meeting date, window, director name if set), then Section / Item / Detail / Link columns with real hyperlinks and column widths set. The header row is plain text: the pinned SheetJS 0.18.5 community build cannot write cell styles (research-notes.md), so it is not bold.
5. **Newsletter** — from/to pickers (default last 28 days), list of items with project, note and link; "Copy as Markdown" and "Download .xlsx".
6. **History** — list of Done/Dropped tasks with filters (category, from/to, search) and reopen.

Every write shows a toast and updates the local state without a full reload. Failures show the error text.

## 9. Tests (Node, no Google services)

`npm test` runs `tests/run.js`: it builds a sandbox (`node:vm`) with a mock of the Apps Script globals (`SpreadsheetApp` in-memory with the six tabs and headers, `Utilities.formatDate` via `Intl.DateTimeFormat` with the time zone, `LockService`, `PropertiesService`, `Logger`, `Session`, `GmailApp`, `UrlFetchApp`, `ScriptApp`, `HtmlService`, `CalendarApp` stubs), loads every `apps-script/*.gs` into it, then runs the test files in `tests/*.test.js` with `node:assert`. Minimum coverage:

- id generation and uniqueness; healSheet fills blanks
- date helpers: today in Dubai across the UTC midnight boundary; weekOf/meetingDate for every weekday; window maths
- normaliseTitle / similarity thresholds; newsletter auto-tag incl. multi-word keywords
- addTask dedupe by sourceKey and by similar title; updateTask whitelist; complete/reopen/drop/move
- importText: every syntax in section 6; importHtml: a Claude-in-Chrome-style sample with Work/Personal headings, checked/unchecked items, links, and a sample with no lists (fallback)
- agenda draft: each of the 8 question rules fires on a fixture and not otherwise; Documents dedupe; saved rows win
- capture: Gmail fixture (threads where I replied last are skipped; automated senders skipped; dedupe against Inbox and tasks); Chat API fixture; Chat 403 → email fallback parses the notification fixture
- guard(): allowed email passes, other email throws, blank email behaviour
- esc() and link sanitiser (client code is also loaded into a jsdom-free check by extracting the pure helpers in `App.html` between the `/* pure:start */` and `/* pure:end */` markers, which the test harness evals)

## 10. Setup (what the README gives Brandon, in order; clasp 3.4.x command names)

1. Node ≥ 22. `npm install -g @google/clasp` → `clasp --version` shows 3.4.x. Signed in to the browser as the **work** account: turn on "Google Apps Script API" at https://script.google.com/home/usersettings. `clasp login` (approve every scope).
2. `git clone`, `cd brandons-desk`, `npm install`, `npx playwright install chromium` (once; the browser for the end-to-end half of `npm test`, or set `CHROMIUM_PATH`), `npm test`.
3. `clasp create-script --type webapp --title "Brandon's Desk" --rootDir ./apps-script` (writes `./.clasp.json` and pulls a default `appsscript.json`, sometimes also a stub `Code.gs`, into `apps-script/`, overwriting ours). Restore with two separate commands, `rm -f apps-script/Code.gs` then `git checkout -- apps-script/appsscript.json` (never chained with `&&`: when there is no stub, `rm` fails and the restore is skipped). Then `clasp push -f`. `filePushOrder` is optional: the code loads in any file order (verified by running the suite with alphabetical and reversed load order).
4. `clasp open-script` → in the editor run `setup` once (approve the scopes — the consent screen lists Sheets, Gmail read, external requests, script management, email address and the two Chat read scopes; the Log tab and the execution log show the sheet URL), run `selfTest` and read its log, then run `installTriggers` (after consent, so the trigger's token carries the Chat scopes). If consent fails with "This app is blocked" or "Error 400: admin_policy_enforced", the admin has restricted a scope: remove the two Chat scopes and the Chat advanced service from `appsscript.json`, `clasp push -f`, and run `setup` again (Chat then uses the email fallback).
5. First deployment is a browser step (clasp 3.x cannot set the web-app access flags): Deploy → New deployment → type Web app → Execute as **Me** → Who has access **Only myself** → Deploy → copy the `/exec` URL and the Deployment ID.
6. Every later release: `clasp push -f && clasp create-deployment -i <deploymentId> -d "<what changed>"`, then check Deploy → Manage deployments shows the new version (a known clasp 3 issue sometimes needs the browser Edit → New version → Deploy instead). The `/dev` URL always runs the latest pushed code for the owner.
7. If `setup` created a new sheet, paste its URL to Claude so the routines point at it.
8. Google Chat needs no extra setup since July 2026 (the manifest's Chat advanced service switches the API on and the two read scopes are approved in step 4). If `selfTest` or the Log shows `CHAT_API_BLOCKED … SERVICE_DISABLED`, remove and re-add the Google Chat API under Services in the editor and run `selfTest` again; if it persists, the fallback is a standard GCP project with the Chat API enabled (Project Settings → Change project), which the school may not allow — then Chat runs in email mode. Config `CHAT_ENABLED = FALSE` turns Chat capture off entirely.
9. One-time checks in the work account (also in the README): open the `/exec` URL in a Chrome profile signed in only as the work account (multi-login is unsupported for web apps); compare one Chat link the capture wrote with the real space; search work Gmail for `from:chat-noreply@google.com` and, if a reminder exists, check that the Inbox row the fallback would create looks right.

## 11. Claude routines (created from the Claude session, not in this repo)

- **Desk: morning capture** — weekdays 06:45 Asia/Dubai. Reads Inbox rows with Status New, personal Gmail (unanswered asks, last 2 days), work Calendar (today + tomorrow, prep items). Adds tasks to Work/Personal with Source, Link, Source key, Project guess, Newsletter per keywords; promotes/ignores Inbox rows; never duplicates (checks Source key and similar open titles first). Writes one Log row.
- **Desk: director agenda** — Mondays 18:10 Asia/Dubai. Reads Work tab, builds the agenda for the next meeting with Claude-written questions (better than the rule-based ones) and document links (searches Drive for docs mentioned by Discuss-ticked tasks), writes the Agenda tab rows for that weekOf, sends a push notification with the summary.
