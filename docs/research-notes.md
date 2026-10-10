# Research notes (verified 2026-10-10)

Facts the implementation relies on. "Verified" means read in official docs, the API discovery document, or the clasp source; "reported" means consistent community reports. Raw research JSON lives outside the repo.

## clasp 3.4.1 (verified against `clasp --help` in this sandbox and the clasp README/releases)

- Requires Node ≥ 22. Install: `npm install -g @google/clasp`. Per-user toggle "Google Apps Script API" at https://script.google.com/home/usersettings is still required; without it: "User has not enabled the Apps Script API…".
- Command names changed in v3 (old names still work as aliases for most): `create-script` (alias `create`), `clone-script`, `push`, `pull`, `create-deployment` (alias `deploy`), `update-deployment <id>` (alias `redeploy`; replaces v2 `deploy -i`), `list-deployments`, `create-version`, `list-versions`, `open-script` (v2 `open`), `open-web-app [deploymentId]`, `run-function` (alias `run`), `show-authorized-user`.
- `clasp create-script --type webapp --title "Brandon's Desk" --rootDir ./apps-script` creates a standalone script and writes `./.clasp.json` (`{"scriptId": "...", "rootDir": "./apps-script"}`) in the current directory, not inside rootDir. `--type webapp` is an alias for standalone that prints a deployment tip. It may pull a stub `Code.gs`/`appsscript.json` into rootDir.
- `.clasp.json` optional fields: `filePushOrder` (paths relative to the `.clasp.json` directory, so they include the rootDir prefix: `apps-script/Config.gs`), `scriptExtensions` (default `.js`, `.gs`), `htmlExtensions` (default `.html`). Files not in `filePushOrder` are pushed sorted by name. Apps Script loads every file into one global scope.
- Default `.claspignore`: only `appsscript.json` and `*.gs/*.js/*.ts/*.html` under rootDir are pushed; `node_modules/**` and `.git/**` ignored. clasp 3 does not transpile TypeScript.
- `clasp push` prompts when the manifest changed; `clasp push -f` overwrites without asking. `clasp push --watch` for development. The `/dev` URL runs the latest pushed code (owner only).
- Web-app deployments: clasp's deployment create/update sends no `entryPoints`, so a deployment made purely by clasp does not get "Execute as"/"Who has access" (clasp issues #63, #1115; PR #1173 unmerged as of 2026-10). Make the first web-app deployment in the editor (Deploy → New deployment → Web app → Execute as Me → Only myself), copy the `/exec` URL and Deployment ID. Later: `clasp push -f && clasp create-deployment -i <deploymentId> -d "..."` (or `clasp create-version` + `clasp update-deployment <id> -V <n>`); verify in Manage deployments (reported: sometimes needs the browser Edit → New version → Deploy).
- `clasp list-deployments` prints `- <deploymentId> @<version> - <description>` without the URL. URL = `https://script.google.com/macros/s/<deploymentId>/exec`.
- `clasp run-function` needs a standard GCP project, Desktop OAuth client and `executionApi` manifest entry — not worth it; press Run in the editor for `setup`.
- Keep the manifest `webapp` block anyway (the editor writes it; it documents intent): `{"webapp": {"executeAs": "USER_DEPLOYING", "access": "MYSELF"}}`.
- Never commit `.clasprc.json` or `client_secret.json`. `.clasp.json` holds only scriptId/rootDir (ignored in this repo so the user's ID stays local; it may be committed if they prefer).
- Workspace admins can turn Apps Script off per OU (Admin console → Apps → Google Workspace → Drive and Docs → Google Apps Script) and restrict OAuth scopes (Security → API controls). Symptom: authorisation fails or "This app is blocked". Nothing in code fixes that; the README names the admin setting.

## Triggers (verified)

- `ScriptApp.newTrigger('fn').timeBased().atHour(6).nearMinute(15).everyDays(1).inTimezone('Asia/Dubai').create()`; `inTimezone` takes IANA names; `atHour` fires within the hour unless `nearMinute` narrows it (±15 min). There is no weekday filter on time-based triggers: run daily and return early on Saturday/Sunday in code.
- Installable triggers run as, and are only visible to, the account that created them. Idempotent installer: `ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'captureInbox').forEach(t => ScriptApp.deleteTrigger(t))` then create.
- Quotas (reported from the quotas page): 20 triggers per user per script; trigger total runtime 6 h/day (Workspace); 6 min per execution; Gmail read/write 50 000/day (Workspace); URL Fetch 100 000/day.

## Gmail from Apps Script (verified)

- `GmailApp.search(query, start, max)` max 500 per call; use `GmailApp.getMessagesForThreads(threads)` to load all messages in one call. Each call that touches Gmail counts against the daily quota.
- `GmailThread.getId()` is documented as unstable ("varies based on the messages it contains"); `GmailMessage.getId()` is immutable. Dedupe key = `gmail:` + first message's id.
- `GmailMessage.getFrom()` returns `Name <addr>`; extract the address. "Me" = `Session.getEffectiveUser().getEmail()` + `GmailApp.getAliases()`.
- Detect already-handled threads: last message from me, or `msgs.some(m => m.isDraft())`.
- Bulk detection (community practice): `List-Unsubscribe`/`List-Id` headers (`msg.getHeader(name)`), `Precedence` bulk/list/junk, `Auto-Submitted` starting `auto-`, sender matching `/noreply|no-reply|donotreply|notifications?@|mailer-daemon|calendar-notification/i`.
- Official search operators: `to:me`, `from:me`, `newer_than:2d`, `category:promotions|social|forums|updates`, `in:inbox`, `is:chat` (Chat messages mirrored into Gmail), `rfc822msgid:`, `list:`, `has:nouserlabels`.
- Links: `GmailThread.getPermalink()` hard-codes `/u/0/#inbox/` (reported) — build links instead: `https://mail.google.com/mail/u/<email>/#all/<threadId>` (the `/u/<email>/` form redirects to the right account index; community pattern). The hex thread id after `#all/` opens the conversation reliably; a message id after `#all/` is reported to fail on cold loads. Durable per-message fallback: `https://mail.google.com/mail/u/<email>/#search/` + `encodeURIComponent('rfc822msgid:' + messageIdHeaderWithoutAngleBrackets)`; `msg.getHeader('Message-ID')` works in GmailApp.
- `Range.getValues()` returns `Date` objects for date cells and booleans for checkboxes; returning a `Date` from a `google.script.run` server function makes the call fail — serialise first.
- `Sheet.getDataRange().getValues()` reads a tab in one call; batch appends with `sheet.getRange(sheet.getLastRow()+1, 1, n, cols).setValues(rows)`; `appendRow` for single rows. Build an id→row map in memory; `createTextFinder(id).matchEntireCell(true)` for a single lookup.
- `LockService.getScriptLock().waitLock(ms)` throws on timeout; wrap in try/finally; keep Gmail fetching outside the locked section.
- Write `Date` objects (not strings) into date cells so they stay dates; the spreadsheet time zone (Asia/Dubai, already set) governs how they display; the script time zone comes from the manifest `timeZone`. `Utilities.formatDate(date, 'Asia/Dubai', 'yyyy-MM-dd')` for local dates. `Session.getScriptTimeZone()` reads the manifest zone.
- Checkbox cells: `getValues()` gives `true`/`false`; write booleans (a `'TRUE'` string violates the validation).

## Google Calendar (verified; used by the Claude routine, not by Apps Script capture)

- `CalendarEvent.getId()` returns the iCalUID, not the API event id. `htmlLink` comes from the Calendar advanced service (`Calendar.Events.list('primary', {...})`) and is account-agnostic — the safest link to store.

## Google Chat email notifications (reported; templates unverified)

- Sent from `chat-noreply@google.com` only for messages unread for more than ~12 hours, and by default only for DMs and @mentions (Chat settings → Notifications → Email). So the email fallback is delayed and partial; the parser must be defensive: search `from:chat-noreply@google.com newer_than:<n>d`, take the plain body, extract the first `https://chat.google.com/...` or `https://mail.google.com/chat/...` URL as the link, the subject as the space/sender hint, and the longest quoted paragraph as the text. Source key = `chat:email:<notification message id>`.

## Pending (filled in from research round 2)

- Chat API with user auth: methods, scopes, whether a Chat app configuration is required, blocked-API error shape, permalink formats.
- Web app: manifest scopes list, `Session.getActiveUser()` behaviour under MYSELF/USER_DEPLOYING, CDN/CSP in the IFRAME sandbox, SheetJS URL, download-from-iframe behaviour, `google.script.run` payload limits.
