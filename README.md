# Brandon's Desk

Brandon's Desk is a private to-do tracker that lives in one Google Sheet, with a small web app on top that works on a phone and a laptop. Every school morning it reads work Gmail and Google Chat into an Inbox tab so nothing asked of you gets lost, the Claude routine that builds your daily Desk syncs its items and ticks into the sheet, and a weekly Claude review writes Andy's agenda next to your own lines, which gives you a weekly agenda for the Tuesday director meeting (downloadable as .xlsx) and material for the AI Learning Hub newsletter. Nothing is ever deleted: a task stays on one row until it is Done or Dropped.

- The sheet: https://docs.google.com/spreadsheets/d/1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w/edit (owner `brandon.abaki@gmail.com`, editor `bbaki@aisa.sch.ae`). Tabs: Work, Personal, Inbox, Agenda, Config, Log.
- The web app: an Apps Script project owned by the **work** account, deployed "Execute as me / Only myself". Its `/exec` URL is yours after step 5 below.
- The docs: `docs/SPEC.md` is the contract (schema, server functions, rules, pages); `docs/research-notes.md` holds the verified Apps Script / clasp / Gmail / Chat facts the code relies on; `docs/routines.md` explains how the two Claude routines and the web app share the sheet (`docs/routine-desk-prompt.md` and `docs/routine-agenda-prompt.md` are their full instructions); `docs/AGENDA.md` is the contract for the Agenda tab they share with you; `docs/DESK.md` covers the Desk page; `docs/UI.md` describes the web page.

```
apps-script/   the Apps Script project (pushed with clasp): *.gs server code, Index.html + Styles.html + App.html
tests/         Node test harness, a mock of the Apps Script services, fixtures, browser checks
docs/          SPEC.md, AGENDA.md, DESK.md, research-notes.md, routines.md (+ the two routine prompts), UI.md
```

## Setup, in order

Everything below happens signed in as the **work** account (`bbaki@aisa.sch.ae`). Command names are for clasp 3.4.x. Steps 1–3 and 6 are the terminal; steps 4, 5 and 7 are the browser. Paste terminal commands one line at a time: the Mac's default shell (zsh) does not treat `#` as a comment when pasting, so nothing here has inline comments.

### 1. Tools (once)

1. Install Node 22 or newer (`node --version`).
2. `npm install -g @google/clasp`, then `clasp --version` must print 3.4.x.
3. In the browser, signed in as the work account, switch on **Google Apps Script API** at https://script.google.com/home/usersettings. Without it every clasp command fails with "User has not enabled the Apps Script API".
4. `clasp login` and approve every scope it asks for.
5. `clasp show-authorized-user` must print the **work** account. If it prints another account, run `clasp logout`, then `clasp login` again and pick the work account. A project created while clasp is logged in as the wrong account belongs to that account; delete `.clasp.json` and create it again (step 3).

If `npm install` fails with `EACCES: permission denied` under `~/.npm`, an earlier `sudo npm` left root-owned files in the npm cache: `sudo chown -R $(id -u):$(id -g) ~/.npm` fixes it.

### 2. The repo

```
git clone <this repo> brandons-desk
cd brandons-desk
npm install
npx playwright install chromium     # once: the browser for the end-to-end half of npm test (or set CHROMIUM_PATH)
npm test
```

`npm test` must be green before anything is pushed. It needs no Google account: every check runs against an in-memory mock of the Apps Script services (see *Tests* below).

### 3. Create the Apps Script project and push the code

```
clasp create-script --type webapp --title "Brandon's Desk" --rootDir ./apps-script
rm -f apps-script/Code.gs
git checkout -- apps-script/appsscript.json
clasp push -f
```

- `clasp create-script` writes `./.clasp.json` in the repo root (not inside `apps-script/`). That file is git-ignored; `.clasp.json.example` is the template.
- It also pulls Google's default `appsscript.json` (and sometimes a stub `Code.gs`) into `apps-script/`, overwriting the committed manifest. The next two lines remove the stub if there is one and restore our manifest. **Do not skip the `git checkout` line**: without it the project is pushed with no scopes, no web-app settings and the wrong time zone. `git status` should show nothing changed under `apps-script/` before you push.
- `clasp push -f` uploads 15 files (`-f` overwrites the remote manifest without asking).
- The files load correctly in any order, so `filePushOrder` in `.clasp.json` is optional.

### 4. Run `setup` in the editor (browser)

`clasp open-script` opens the project in the Apps Script editor (reload the tab if it was already open before the last push). Pick the function **`setup`** in the toolbar and press **Run**. The consent screen lists seven scopes; approve them all. If it lists fewer, or none about Google Chat, our manifest was not pushed: run `git checkout -- apps-script/appsscript.json` and `clasp push -f`, then reload the editor.

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

1. Adopts the existing sheet (ID `1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w`) when the work account can open it; otherwise it creates a fresh "Brandon's Desk" sheet in the work Drive with the identical schema.
2. Makes sure the six tabs exist with their exact headers, dropdowns, checkboxes and date formats.
3. Stores the sheet ID as the Script Property `SHEET_ID`.
4. Writes the Config defaults (keys, values and notes) into an empty Config tab.
5. Installs the daily 06:15 (Asia/Dubai) `captureInbox` trigger.

The execution log (bottom of the editor) and the sheet's Log tab show the sheet URL. Then, still in the editor:

- Run **`selfTest`** and read its log: it adds, completes and imports throwaway rows, probes Gmail and the Chat API, removes its rows and prints `ok` / `FAIL` per step.
- Run **`installTriggers`** once more, **after** the consent above, so the trigger's token carries the Chat scopes. (A trigger installed before consent runs without them and Chat falls back to email mode.)

If consent fails with **"This app is blocked"** or **"Error 400: admin_policy_enforced"**, see *Troubleshooting*.

### 5. First deployment (browser)

clasp 3 cannot set the web-app access flags, so the first deployment is a browser step. In the editor:

**Deploy → New deployment → Select type: Web app → Execute as: *Me* → Who has access: *Only myself* → Deploy.**

The confirmation dialog shows two things to copy and keep:

- the **Web app URL** ending in `/exec` — this is the app; bookmark it on your phone and laptop;
- the **Deployment ID** — needed for every later release (step 6).

To find them again later: editor → **Deploy → Manage deployments** (click the deployment to see its ID and URL), or `clasp list-deployments` in the terminal, which prints `- <deploymentId> @<version> - <description>`; the URL is then `https://script.google.com/macros/s/<deploymentId>/exec`.

Open the `/exec` URL in a Chrome profile (or an incognito window) signed in **only** as the work account. Multi-login is not supported for Apps Script web apps: if the browser's default Google account is a different one, the page redirects to a broken `/macros/u/N/…` address.

### 6. Every later release (terminal)

```
clasp push -f
clasp create-deployment -i <deploymentId> -d "what changed"
```

Then check that **Deploy → Manage deployments** in the editor shows the new version. A known clasp 3 issue sometimes leaves the deployment on the old version; if so, do it in the browser instead: Manage deployments → pencil (Edit) → Version: *New version* → Deploy. (`clasp create-version` followed by `clasp update-deployment <deploymentId> -V <n>` is the two-step equivalent.) `clasp open-web-app <deploymentId>` opens the app. The `/dev` URL (editor → Deploy → Test deployments) always runs the latest pushed code for the owner, without a new deployment, which is handy for trying a change before releasing it.

### 7. If `setup` created a new sheet

Paste the new sheet's URL to Claude so the Desk routine points at it (the spreadsheet ID appears in `docs/routine-desk-prompt.md` and in the live routine).

### 8. Google Chat (optional)

Chat needs no extra setup: the manifest's Chat advanced service switches the API on in the script's own Cloud project, and the two read scopes were approved in step 4. `selfTest` reports whether the API answers.

- If `selfTest` or the Log tab shows `CHAT_API_BLOCKED … SERVICE_DISABLED`: in the editor, under **Services** (the `+` next to Services in the left bar), remove **Google Chat API** and add it again, then run `selfTest` again.
- If it still fails, the remaining option is a standard Google Cloud project with the Chat API enabled (editor → Project Settings → Change project), which the school may not allow. Chat then runs in **email mode**: the capture parses the reminder emails Google sends from `chat-noreply@google.com`. Those only exist for direct messages and @mentions left unread for more than 12 hours, so email mode is delayed and partial; the Inbox page shows a banner saying so.
- Config `CHAT_ENABLED = FALSE` turns Chat capture off entirely.

### 9. One-time checks in the work account

- Open the `/exec` URL in a Chrome profile signed in only as the work account (see step 5).
- Compare one Chat link that the capture wrote into the Inbox tab with the real space.
- Search work Gmail for `from:chat-noreply@google.com`. If a reminder exists, check that the Inbox row the email fallback would create looks right: Source `Chat`, From = the sender named in the subject, Subject = the space name plus "(email notification)", Snippet = the quoted message, Link = the first chat.google.com link in the mail, Source key `chat:email:<message id>`. To watch the fallback actually run: temporarily remove the two Chat scopes and the Chat advanced service from `apps-script/appsscript.json`, `clasp push -f`, run `runCaptureNow` from the editor (the Log shows `CHAT_API_BLOCKED` and the row lands in Inbox), then restore the manifest (`git checkout -- apps-script/appsscript.json`) and push again.

### 10. Rebuild now in the web app (optional, once)

The Desk page's **Rebuild now** starts the "Brandon's Desk morning build" routine straight away, through the routine's API trigger. It needs a token, which only you can create:

1. Open https://claude.ai/code/routines, click **Brandon's Desk morning build**, open the menu next to its name and choose **Edit**.
2. Under **Select a trigger**, click **Add another trigger**, choose **API**, then **Generate token** and copy the token at once (it is shown only once). Save the routine. Keep its schedule trigger as it is.
3. In the Apps Script editor (`clasp open-script`): **Project Settings** (the gear) → **Script Properties** → **Add script property**: property `DESK_ROUTINE_TOKEN`, value the token. Save.

Nothing needs redeploying: the next press of Rebuild now uses it. Until then the button says it is not set up. To turn it off, delete the token on the routine's API trigger (or the Script Property). The token stays on the server; it never goes into the sheet, the Log or the page.

## Everyday use

- **The pages.** Desk (the home page: the morning build's Desk in the same layout as the routine's page; ticks and the add box save straight to the Work/Personal tabs), Tasks (was Today: quick-add, tick off, edit), Inbox (promote or ignore captured mail and chat, *Run capture now*), Import (paste a list or choose an .html/.txt file), Agenda (Andy's agenda for the next meeting: the routines' lines and yours, every section editable, Save, Download .xlsx, Copy as text; it re-reads the sheet each time you open it, and a save is refused with *Reload agenda* if a routine changed the week after you opened it), Newsletter (Copy as Markdown, Download .xlsx), History (Done/Dropped, reopen).
- **On the Desk page.** *Refresh* reads the latest Desk from the sheet without reloading. *Rebuild now* (after step 10) runs the morning build now; the page says it is rebuilding, links to the run, and shows the new Desk by itself when it lands, usually in 5–10 minutes. Only one rebuild runs at a time.
- **Prompt Claude.** Every card on the Desk and on the Tasks page has a *✦ Prompt Claude* pill. It copies a ready-made prompt for that task (what it is, its dates and notes, where the email, chat or doc lives, and how Claude should work: drafts only, never send, never pay or enter passwords) to paste into a new Claude chat. Where the browser blocks copying, a box opens with the prompt selected; press Ctrl+C (⌘C on a Mac).
- **Changing Config.** Edit the *Value* column of the Config tab in the sheet. The keys and the *Notes* column are written by `setup()`; the app reads the tab on every request (12 rows, nothing cached between requests), so a change applies to the next click. Keys: `ALLOWED_EMAILS`, `TIMEZONE`, `MEETING_DAY`, `GMAIL_QUERY`, `GMAIL_LOOKBACK_DAYS`, `CHAT_ENABLED`, `CHAT_LOOKBACK_DAYS`, `NEWSLETTER_KEYWORDS`, `DEFAULT_QUICKADD_CATEGORY`, `PROJECTS`, `DIRECTOR_NAME`. Comma-separated where plural. `TIMEZONE` must be an IANA id such as `Asia/Dubai`; anything else falls back to Asia/Dubai with a WARN in the Log.
- **Running capture by hand.** Inbox page → **Run capture now** (the toast shows how many Gmail threads and Chat conversations it added, and the Chat mode: `api`, `email` or `off`; each Chat conversation is one Inbox row holding its new messages, and one-word replies, greetings and phone numbers are left out), or in the editor run `runCaptureNow`. The scheduled `captureInbox` skips Saturdays and Sundays; *Run capture now* always runs.
- **Releasing a code change.** `npm test`, then step 6.
- **Where to look when something is off.** The Log tab (trigger runs, healed rows, errors with stack traces) and the editor's **Executions** page.
- **Rows added by Claude or by hand.** The app fills in a blank ID, Created, Status, Priority or Updated on every read (`healSheet`) and notes what it fixed in the Log, so a row typed straight into the sheet is fine.
- **Downloads.** The Agenda and Newsletter `.xlsx` files have real hyperlinks and column widths; the header row is plain text because the pinned SheetJS build cannot write cell styles. If the SheetJS CDN does not load, the same rows download as a UTF-8 CSV and a toast says so.

## Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| clasp says **"User has not enabled the Apps Script API"** | The per-user toggle is off. | Signed in as the work account, switch on Google Apps Script API at https://script.google.com/home/usersettings, then retry. |
| `clasp create-script` or `clasp push` fails with a permission error, or the editor will not open | The Workspace admin may have Apps Script switched off for your organisational unit. | Ask the admin to enable it under **Admin console → Apps → Google Workspace → Drive and Docs → Google Apps Script** (on by default since Apps Script became a core service in June 2026). Nothing in the code can work around that setting. |
| Consent screen says **"This app is blocked"** or **"Error 400: admin_policy_enforced"** | The admin has restricted one of the requested scopes. The two Chat scopes are Google "restricted" scopes, so they are the usual cause; the block stops Sheets and Gmail too. | Remove the two Chat scopes (`chat.spaces.readonly`, `chat.messages.readonly`) and the `dependencies.enabledAdvancedServices` block from `apps-script/appsscript.json`, `clasp push -f`, run `setup` again and approve the remaining five scopes. Chat then runs in email mode (step 8). |
| Log tab shows **`CHAT_API_BLOCKED … SERVICE_DISABLED`** | The Chat API is not enabled in the script's Cloud project. | Step 8: remove and re-add the Google Chat API under Services, run `selfTest`. |
| Log tab shows **`CHAT_API_BLOCKED … ACCESS_TOKEN_SCOPE_INSUFFICIENT`** (usually only in trigger runs) | The trigger was installed before the Chat scopes were approved, so its token lacks them. | Run any function from the editor to re-consent if asked, then run `installTriggers` again. |
| Log tab shows **`CHAT_API_BLOCKED`** with another reason, or HTTP 401 | The Chat API refused the token for this run. | Capture carried on in email mode for that run. If it persists, check step 8; otherwise `CHAT_ENABLED = FALSE` in Config. |
| **"You do not have permission to call …"** / "Specified permissions are not sufficient" at run time | The manifest's `oauthScopes` list was changed after consent (declaring scopes turns auto-detection off). | Run any function from the editor to re-consent, then `installTriggers`. If it is `GmailApp` after consent, replace `https://www.googleapis.com/auth/gmail.readonly` in `appsscript.json` with `https://mail.google.com/`, `clasp push -f`, re-consent. |
| The `/exec` page says "Sorry, unable to open the file at this time" or redirects to `/macros/u/1/…` | You are not the deployer, or the browser is signed in to several Google accounts. | Use a Chrome profile or incognito window signed in only as the work account. |
| **"Not allowed"** (in the editor when running `setup`, or on the page) | The account running the script is not in Config `ALLOWED_EMAILS`, or Google returned no email at all. The line `guard: Not allowed because …` just above the error in the editor's execution log says which, and names the account. | No email: the manifest was not pushed — `git checkout -- apps-script/appsscript.json`, `clasp push -f`, reload the editor. Wrong account: the script must belong to the work account — `clasp show-authorized-user`; if it is another account, `clasp logout`, `clasp login` as the work account, `rm .clasp.json`, and redo step 3. Only add an address to `ALLOWED_EMAILS` if it really is one of your accounts. |
| A release does not show up in the app | The deployment stayed on the old version (known clasp 3 issue). | Deploy → Manage deployments → Edit → New version → Deploy. |
| **Rebuild now** says it is not set up | No `DESK_ROUTINE_TOKEN` Script Property. | Setup step 10. |
| **Rebuild now** says the routine refused the saved token, or was not found | The token was regenerated or deleted on the routine, or the routine's API trigger was removed. | Generate a new token on the routine's API trigger and replace the Script Property (step 10). The Log tab has a `rebuildDesk` WARN row with the HTTP status. |
| The rebuild ran but the routine's own Desk page did not change | A run started through the API trigger may stop to ask before republishing the routine's page. | The web app already has the new Desk (the routine writes the Desk tab before it publishes). Open the run from *Open the build* to approve the publish, or let the next scheduled build update the page. |
| `npm test` says it cannot find a browser | Playwright's Chromium is not installed. | `npx playwright install chromium`, or set `CHROMIUM_PATH` to a Chrome/Chromium binary. |
| Capture ran but the Inbox is empty | Normal on a weekend, or everything in the lookback window was from you, automated, or already captured. | The Log row for `captureInbox` says what happened; `GMAIL_QUERY` and the lookback days are in Config. |

## Tests

| Command | What it runs |
|---|---|
| `npm test` | `tests/run.js` (unit tests over the Apps Script mock, no Google services) and then `tests/e2e.js` (the real page in headless Chromium talking to the real server code through a `google.script.run` shim, including the Desk home page) |
| `npm run test:unit` | only `tests/run.js`; `node tests/run.js <filter>` runs matching test files |
| `npm run test:e2e` | only the end-to-end check (`E2E_ONLY=desk` or `E2E_ONLY=tasks` runs one half) |
| `npm run ui` | `tests/ui/render.js`: the page against a fixture shim (HTML file import, dark mode, downloads read back, SheetJS missing, boot failure); screenshots under `/tmp/claude-0/brandons-desk-ui/` |

The browser checks need a Chromium: after `npm install`, run `npx playwright install chromium` once (about 150 MB), or set `CHROMIUM_PATH` to a Chrome/Chromium binary. Nothing in the tests calls Google.

## Claude routines

Two Claude routines keep the sheet in step (`docs/routines.md`):

- **Brandon's Desk morning build** (weekdays 06:45 Dubai, or "Rebuild now" on the routine's Desk page or in this web app, step 10) builds your daily Desk and syncs it with this sheet: new items appear in the web app, ticks flow both ways, and on Monday builds (and the meeting-day build before the meeting) it writes a first agenda for Andy unless that week's agenda is already settled. It exists already.
- **Weekly agenda review** (Mondays 14:45 Dubai, or started by hand) reads the week's work and writes Andy's agenda for the next meeting into the Agenda tab. It never removes or rewords your own lines, does not write the Desk tab and sends no push notification. Create it once in the claude.ai Routines page as `docs/routines.md` (*Setting up the weekly review*) describes.

Every Agenda row records who wrote it in its Generated column: `… claude-desk`, `… claude-review`, `… web-draft` (the web app's draft saved unchanged), or a date-time for your own lines; editing a line on the Agenda page makes it yours. `docs/AGENDA.md` is the full contract. The Desk's agenda block shows the saved agenda of its meeting as soon as there is one, with the same Copy and Download as the Agenda page and a *Full agenda* link.

The web app's Desk page reads the **Desk** tab, which the morning build rewrites on every run (`docs/DESK.md`). After the first release that includes the Desk page (`clasp push -f` and step 6), open the web app once, or run `setup` in the editor, so the Desk tab exists before the next 06:45 build writes to it. Until that build runs, the Desk page shows a "No Desk yet" panel with a link to the routine's Desk page, and its add box already works.
