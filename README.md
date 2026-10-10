# Brandon's Desk

Private task tracker: Work and Personal tasks in one Google Sheet, an Apps Script web app on top, daily capture from work Gmail and Google Chat, a weekly agenda for the director meeting (downloadable as .xlsx) and material for the AI Learning Hub newsletter.

`docs/SPEC.md` is the contract (schema, API, rules, UI). `docs/research-notes.md` holds the verified Apps Script / clasp / Gmail / Chat facts the code relies on. `docs/routines.md` has the two Claude routines that write into the sheet. `docs/UI.md` describes the web page.

```
apps-script/   the Apps Script project (pushed with clasp): *.gs server code, Index.html + Styles.html + App.html
tests/         Node test harness, mock of the Apps Script services, fixtures, browser checks
docs/          SPEC.md, research-notes.md, routines.md, UI.md
```

## Setup

Everything below happens in the **work** account (`bbaki@aisa.sch.ae`), which owns the Apps Script project and the web app. Command names are clasp 3.4.x.

### 1. Tools

1. Install Node 22 or newer.
2. `npm install -g @google/clasp`, then `clasp --version` must print 3.4.x.
3. In the browser, sign in as the work account and switch on **Google Apps Script API** at https://script.google.com/home/usersettings (without it clasp fails with "User has not enabled the Apps Script API").
4. `clasp login` and approve every scope it asks for.

### 2. The repo

```
git clone <this repo> brandons-desk
cd brandons-desk
npm install
npx playwright install chromium     # once: the browser for the end-to-end check (see Tests)
npm test
```

`npm test` must be green before anything is pushed. It needs no Google account: every check runs against an in-memory mock of the Apps Script services.

### 3. Create the Apps Script project and push the code

```
clasp create-script --type webapp --title "Brandon's Desk" --rootDir ./apps-script
```

- The command writes `./.clasp.json` in the repo root (not inside `apps-script/`). The file is git-ignored; `.clasp.json.example` is the template.
- It always pulls a stub `Code.gs` and a default `appsscript.json` into `apps-script/`, overwriting the committed manifest. Restore ours:

  ```
  rm apps-script/Code.gs && git checkout -- apps-script/appsscript.json
  ```

- Copy the `filePushOrder` line from `.clasp.json.example` into `.clasp.json`, so it reads `{"scriptId": "<your id>", "rootDir": "./apps-script", "filePushOrder": ["apps-script/Config.gs", "apps-script/Util.gs"]}` (Apps Script loads every file into one global scope; `Config.gs` and `Util.gs` must load first).
- Then `clasp push -f` (`-f` overwrites the manifest without asking).

### 4. Run `setup` in the editor

`clasp open-script` opens the project. In the editor pick the function `setup` and press Run. The consent screen lists seven scopes; approve them all:

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/spreadsheets` | read/write the sheet |
| `https://www.googleapis.com/auth/gmail.readonly` | Gmail capture |
| `https://www.googleapis.com/auth/script.external_request` | Chat REST API through UrlFetchApp |
| `https://www.googleapis.com/auth/script.scriptapp` | install the daily trigger |
| `https://www.googleapis.com/auth/userinfo.email` | the `guard()` check on every call |
| `https://www.googleapis.com/auth/chat.spaces.readonly` | list Chat spaces |
| `https://www.googleapis.com/auth/chat.messages.readonly` | read Chat messages |

What `setup()` does, once:

1. Adopts the existing sheet `1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w` when the work account can open it (it is an editor on it); otherwise it creates a fresh "Brandon's Desk" sheet in the work Drive with the identical schema.
2. Ensures the six tabs (Work, Personal, Inbox, Agenda, Config, Log) with their exact headers, data validation and date formats.
3. Stores the sheet ID as the Script Property `SHEET_ID`.
4. Writes the Config defaults (keys, values and notes) into an empty Config tab.
5. Installs the daily 06:15 (Asia/Dubai) `captureInbox` trigger.

The execution log and the Log tab show the sheet URL. Then:

- Run `selfTest` and read its log: it adds, completes and imports throwaway rows, probes Gmail and the Chat API, removes its rows and prints a report (`ok`/`FAIL` per step).
- Run `installTriggers` once more **after** the consent above, so the trigger's token carries the Chat scopes (a trigger installed before consent runs without them and Chat falls back to email mode).

If consent fails with **"This app is blocked"** or **"Error 400: admin_policy_enforced"**, the Workspace admin has restricted a scope (the two Chat scopes are Google "restricted" scopes). Remove the two Chat scopes and the Chat advanced service (`dependencies.enabledAdvancedServices`) from `apps-script/appsscript.json`, `clasp push -f`, and run `setup` again. Chat then runs in email mode (see step 8).

### 5. First deployment (browser)

clasp 3 cannot set the web-app access flags, so the first deployment is a browser step: in the editor, **Deploy → New deployment → type Web app → Execute as *Me* → Who has access *Only myself* → Deploy**. Copy the `/exec` URL (the app) and the **Deployment ID** (needed for later releases).

### 6. Later releases

```
clasp push -f && clasp create-deployment -i <deploymentId> -d "what changed"
```

Check that **Deploy → Manage deployments** shows the new version (`clasp list-deployments` prints `- <deploymentId> @<version> - <description>`; a known clasp 3 issue sometimes needs the browser Edit → New version → Deploy instead). `clasp open-web-app <deploymentId>` opens the app. The `/dev` URL (editor → Deploy → Test deployments) always runs the latest pushed code for the owner, without a new deployment.

### 7. If `setup` created a new sheet

Paste the new sheet's URL to Claude so the routines point at it, and replace the spreadsheet ID in both prompts in `docs/routines.md`.

### 8. Google Chat (optional)

Chat needs no extra setup: the manifest's Chat advanced service switches the API on and the two read scopes are approved in step 4. If `selfTest` or the Log shows `CHAT_API_BLOCKED … SERVICE_DISABLED`, remove and re-add the **Google Chat API** under *Services* in the editor and run `selfTest` again. If it persists, the fallback is a standard GCP project with the Chat API enabled (Project Settings → Change project), which the school may not allow; Chat then runs in **email mode**: the capture parses the reminder emails Google sends from `chat-noreply@google.com`, which only exist for direct messages and @mentions left unread for more than 12 hours, so it is delayed and partial (the Inbox page says so). Config `CHAT_ENABLED = FALSE` turns Chat capture off entirely.

If `GmailApp` ever reports insufficient permissions after consent, replace `https://www.googleapis.com/auth/gmail.readonly` in `appsscript.json` with `https://mail.google.com/`, `clasp push -f`, and re-run any function from the editor to re-consent.

### 9. One-time checks

- Open the `/exec` URL in a Chrome profile (or incognito window) signed in **only** as the work account: multi-login is unsupported for Apps Script web apps and redirects to a broken `/macros/u/N/` URL.
- Compare one Chat link that the capture wrote into the Inbox tab with the real space.
- Search work Gmail for `from:chat-noreply@google.com`; if a reminder exists, check that the Inbox row the email fallback would create looks right. To see the fallback actually run: temporarily remove the two Chat scopes and the Chat advanced service from `apps-script/appsscript.json`, `clasp push -f`, run `runCaptureNow` from the editor (the Log shows `CHAT_API_BLOCKED` and the row lands in Inbox with Source key `chat:email:…`), then restore the manifest and push again. Otherwise compare the row with the format in `docs/SPEC.md` section 3.

## Everyday use

- **Changing Config**: edit the *Value* column of the Config tab. The keys and the *Notes* column are written by `setup()`; the app reads the tab on every request (12 rows, no cache across executions), so a change applies to the next call. `TIMEZONE` must be an IANA id such as `Asia/Dubai`; anything else falls back to Asia/Dubai with a WARN in the Log.
- **Re-running capture**: Inbox page → *Run capture now*, or run `runCaptureNow` from the editor. `captureInbox` is the trigger entry point and skips Saturdays and Sundays regardless of how it is started; *Run capture now* / `runCaptureNow` always run.
- **Where to look when something is off**: the Log tab (trigger runs, heals, errors with stack traces) and the editor's Executions page.
- **Newsletter and History date ranges** default to today and the 28 days before it, inclusive.
- **Downloads**: the Agenda and Newsletter `.xlsx` files have real hyperlinks and column widths; the header row is plain text because the pinned SheetJS 0.18.5 community build cannot write cell styles. If the SheetJS CDN does not load, the same rows download as a UTF-8 CSV and a toast says so.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | `tests/run.js` (unit tests over the Apps Script mock) and then `tests/e2e.js` (the real page in headless Chromium talking to the real server code) |
| `npm run test:unit` | only `tests/run.js`; `node tests/run.js <filter>` runs matching test files |
| `npm run test:e2e` | only the end-to-end check |
| `npm run ui` | `tests/ui/render.js`: the page against a fixture shim (HTML file import, dark mode, downloads read back, boot failure); screenshots under `/tmp/claude-0/brandons-desk-ui/` |

The browser checks need a Chromium. After `npm install`, run `npx playwright install chromium` once (Playwright downloads its own build, about 150 MB); or set `CHROMIUM_PATH` to a Chrome/Chromium binary. A pre-installed Chromium at `/opt/pw-browsers/chromium` is used automatically when it exists. Nothing in the tests calls Google.

## Claude routines

The morning capture (weekdays 06:45 Dubai) and the director agenda (Mondays 18:10 Dubai) are Claude routines created in the claude.ai Routines page, not in this repo. `docs/routines.md` has the schedules, the connectors to attach and the exact prompts.
