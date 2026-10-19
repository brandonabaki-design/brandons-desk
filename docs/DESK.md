# The Desk page (web app home)

Brandon prefers the layout of the Desk that his Claude routine ("Brandon's Desk morning build", see `docs/routines.md`) publishes as a claude.ai artifact. The web app shows the same Desk, from the same data, as its home page, and ticks and new tasks save straight into the tracker sheet. This file is the contract between the routine, the sheet and the web app. It extends `docs/SPEC.md`; where they differ for the Desk, this file wins.

## 1. Sheet: `Desk` tab (sheetId 6) — 3 columns

| Col | Header | Content |
|---|---|---|
| A | Key | one of `meta`, `strip`, `items`, `items2`, `items3`, …, `cleared`, `priorities`, `coming`, `agenda`, `llt`, `quick` |
| B | JSON | that part of the Desk's `desk-data`, as compact JSON text (column formatted as plain text) |
| C | Built | when the routine wrote it, `yyyy-MM-dd HH:mm` (Asia/Dubai) — same value on every row |

- `meta` = `{"built", "eyebrow", "sources", "lanes", "rebuild"}` copied from `desk-data`. Every other key holds the `desk-data` field of the same name (`agenda` and `llt` may be `null`).
- A Google Sheets cell holds at most 50 000 characters. `items` is split by whole items into `items`, `items2`, `items3`, … so that every cell stays under 45 000 characters; the web app concatenates them in key order (`items`, `items2`, `items3`, … numerically).
- The routine rewrites rows 2+ on every build (clear `Desk!A2:C`, then write all rows in one call). Nothing else writes this tab: the weekly agenda review (`docs/AGENDA.md`) writes only the Agenda tab and one Log row, and the Desk shows its agenda by reading that tab (section 3). Row order does not matter; keys are unique.
- Every value starts with `{`, `[`, `"`, or is `null`, so Sheets never parses it as a formula or a number.
- `setup()` / `ensureSchema()` create the tab with this header row and column B formatted as text when it is missing; `getDesk` creates it too on its first read. The tab must exist before the routine's first write to `Desk!A2:C`, so after the release that adds the Desk, open the web app once (or run `setup`) before the next morning build. `healSheet` never touches it.

### `desk-data` shapes (as produced by the routine; the web app must tolerate missing fields)

```
meta.lanes      [{"key":"now"|"reply"|"later","title":string}]            (usually 3)
meta.rebuild    {"trigger": string}                                        (ignored by the web app)
strip           [{"cls":"now"|"brk"|"pd"|"","d":string,"t":string,"s":string,"href":string}]
items           [{"id":string,"lane":string,"title":string,"why":string,
                  "tags":[[kind,text],…],"links":[[label,target],…],"task":"W-…"|"P-…"|undefined,
                  "prompt":string|undefined,"outcome":string|undefined}]
cleared         [string]
priorities      [{"title":string,"tag":[kind,text]|undefined,"points":[string],"links":[[label,target]]}]
coming          [{"when":string,"hl":bool|undefined,"title":string,"detail":string,"href":string|undefined}]
agenda          null | {"title":string,"open":bool,"meeting":"yyyy-MM-dd","sections":[{"name":string,"items":[{"t":string,"d":string}]}]}
llt             null | {"title","padlet","working":[string],"great":[string],"night":[string],"raise":[{"t","d"}]}
quick           [[title, subtitle, url]]
```

An item's `prompt` (more context a fresh Claude needs) and `outcome` (what "done" looks like) are optional; only the Prompt Claude button reads them (section 3), and getDesk passes them on as `""` when missing.

`agenda.meeting` is the date of the meeting the agenda is for (`docs/AGENDA.md` section 2); the morning build writes it, and the web app keeps it only when it is a real `yyyy-MM-dd` date.

Tag kinds: `late`, `due`, `new`, `home`, `gh`, `list`, `` (source). Link targets: a full `https://` URL, or `wt:<thread id>` (AISA Gmail thread) → `https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#all/<id>`, `w:<search>` (AISA Gmail search) → `https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#search/<encodeURIComponent(search) with %20 → +>`, `p:<decimal id>` (personal Gmail thread) → `https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:<id>`. After expansion every link goes through the existing http/https sanitiser; anything else is rendered as plain text.

## 2. Server API additions (`Desk.gs`, entry points in `Api.gs`)

Same conventions as SPEC section 5 (one plain object in, JSON-safe object out, `guard()` first, short user errors).

| Function | Input | Output | Behaviour |
|---|---|---|---|
| `getDesk` | `{}` | `{ok:true, desk:{built, eyebrow, sources, lanes, strip, items, cleared, priorities, coming, agenda, llt, quick}, added:[Task], builtAt:"yyyy-MM-dd HH:mm", builtDate:"yyyy-MM-dd", stale:boolean, deskUrl, rebuildNow}` or `{ok:false, reason:"empty"\|"invalid", message, rebuildNow}` | Reads the Desk tab and assembles `desk`. Each item gains `category` (`Work`/`Personal`: from the `task` prefix `W-`/`P-`, else `Personal` when a tag kind is `home`, else `Work`), `taskId` (the matched row's ID or `""`), `status` (the row's Status or `""`) and `done` (`true` when that Status is Done or Dropped). A row matches by `task` ID in its tab first, then by Source key `desk:<item id>` in either tab. `added` = Open tasks in either tab with Source `Manual` whose ID is not the `taskId` of any item, newest Created first, at most 20. `stale` = `builtDate` is not today (Dubai). `deskUrl` = `https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr` (constant in Config.gs). `reason:"empty"` when the tab has no data rows; `reason:"invalid"` when a JSON cell does not parse (message names the key; the error goes to the Log). |
| `setDeskItemDone` | `{itemId, done:boolean, note?}` | `{task}` | Finds the item in the Desk tab by `itemId` (user error "That Desk item is no longer on the Desk" if absent). Resolves its row like `getDesk`. If there is no row, creates one first with `createTasks` semantics: category as above, Title = item title, Details = item why, Link = first link expanded and sanitised, Source = `Gmail` for a `["","Email"]` tag, `Chat`, `Calendar`, `Manual` for `Added by you`, else `Claude`; Due from a `due`/`late` tag resolved against today like the routine does (blank if not resolvable); Priority High when lane `now` and tagged late or due today, else Normal; Source key `desk:<itemId>`. Then `done:true` → `completeTask` (note optional), `done:false` → `reopenTask`. Returns the task. |
| `getDeskStatus` | `{}` | `{builtAt, rebuildNow}` | The newest Built in the Desk tab (`""` when it has no data rows), read without parsing or logging, and Rebuild now's state. The page polls it while a rebuild runs (section 5). |
| `rebuildDesk` | `{}` | `{started:true, sessionUrl, rebuildNow}` | Starts the morning build routine now through its API trigger (section 5). User errors: not set up (no `DESK_ROUTINE_TOKEN`), a rebuild still running, the routine API refusing (401/403 token, 404, 429, other HTTP), the service unreachable. |

`rebuildNow` = `{ready, running, startedAt:"yyyy-MM-dd HH:mm"|"", sessionUrl}`: `ready` when the token is saved; `running` while the last rebuild started less than 20 minutes ago and the Desk tab holds no build newer than its start (`startedAt` and `sessionUrl`, a claude.ai link to the run, are `""` otherwise).

The Desk's own add box calls the existing `addTask({category, title})` (Source `Manual`), so the routine folds the task onto the Desk at its next build, and `getDesk` shows it under `added` right away.

Details settled during the build (they refine the table above; `tests/desk.test.js` and `tests/e2e.js` pin them):

- `{ok:false}` answers also carry `deskUrl` and `added`, so the empty and invalid panels keep the Desk page link and the tasks added since the build.
- When a row matches, the item's `category` is the tab that row is in (a `desk:<id>` row found in the other tab gives that tab). A row that `moveTask` dropped ("Moved to <id>") stands for its copy, so a task moved to the other list does not read as done.
- `added` is sorted by Created, then Updated, then row, newest first. When the client lists more of them locally (a task reopened on another page), it applies the same filter (Open, Source `Manual` in any case, not an item's row) and the same cap of 20 open tasks.
- Create-on-tick goes through `createTasks`, so its dedupe applies: a similar Open task without a Source key becomes the item's row and is given `desk:<itemId>`. A similar task that already belongs to something else (another Source key, or another Desk item's row) is never claimed; the item gets a row of its own. Link = the first link that `expandDeskLink` turns into a URL. Due: "Today", "Tomorrow", "Yesterday" and `yyyy-MM-dd` directly; otherwise the weekday, day of the month and optional month in the tag (times and durations ignored) are matched against the dates within 7 days of today (Dubai), nearest first; a weekday alone prefers today or later for `due` and today or earlier for `late`. Nothing matching (e.g. "Overdue", or a date more than 7 days away) leaves Due blank.
- Column C (Built) is formatted as plain text too, so it reads back exactly as written; a Built cell that Sheets turned into a date-time is read in Dubai time.
- Only rows whose Built is the newest one are read (all rows when no row has a Built), so rows left by a build whose clear did not run never mix in; a key written twice (`items` and `items1` count as one) keeps its first row, and an item whose id an earlier item already has is left out. Skipped rows are logged as a WARN by key and row. The ERROR for a JSON cell that does not parse names the key, row and length, never the cell's text.
- A `task` ID is matched with its prefix upper-cased (`p-…` finds `P-…`). Numbers glued to a letter or after words such as "period" or "grade" ("Thu P3", "Grade 7 reports Thu") are not the day of the month in a due tag.
- `setDeskItemDone` wants `itemId` as text (at most 200 characters), `done` as true/false (or the "true"/"false" text every other boolean input accepts) and `note`, when given, as text.
- `expandDeskLink` exists on both sides with identical output for every input (the server's in `Desk.gs`, the client's in the `App.html` pure block). Both sanitise with the server's `sanitiseLink` rule: an http(s) URL with whitespace, control characters, quotes and angle brackets removed, else `''`; a `w:` search that cannot be encoded gives `''`.

## 3. Web UI

- New page `desk`, first tab, label **Desk**, and the page shown when the URL has no hash. The existing tabs stay; **Today** is renamed **Tasks** (hash `#today` unchanged).
- Layout and visual design follow the routine's Desk page (reference HTML is provided to the build agents outside the repo): header with eyebrow and "Brandon's Desk" title plus a done meter (`done / total` and bar); date strip; three-lane board (`Do today` / `Reply & follow up` / later lane titles come from `meta.lanes`), first lane headed by the add box (Work/Personal toggle defaulting to Work, Enter to add); item cards with checkbox, bold title, `why`, tags as small mono chips with the same colour meanings, links as pill buttons; "Cleared since last build" chips; two columns "Top priorities" and "Coming up"; the director agenda block (collapsible, open when `agenda.open`, titled from `agenda.title`), with **Copy agenda as text**, **Download .xlsx** and a **Full agenda** link (see *The agenda block* below); the LLT padlet block when `llt` is not null (paste text + Copy + Open padlet + "Raise with the whole team" list); Quick links grid; footer "Built <built> from <sources>." plus, when `stale`, a visible note "This Desk is from <weekday d Mon>; the next build is at 6:45 on school days." and a link "Open the Desk page" to `deskUrl` (for Rebuild now).
- Fonts and colour tokens as in the reference (Bricolage Grotesque for display, DM Sans body, JetBrains Mono for eyebrows/tags; purple accent; light and dark themes), scoped to the Desk page so the other pages keep their current look. No horizontal scroll at 360 px; lanes stack on mobile like the reference.
- Ticking an item: optimistic UI (card dims and strikes through, meter updates), then `setDeskItemDone`; on failure revert and show the error toast. Unticking reopens. After a tick, an optional one-line note field appears under the card (Enter saves via `updateTask` patch `note`, Escape dismisses), matching the Tasks page behaviour. Items whose `done` is true render ticked. `added` tasks render at the top of the first lane with an "Added by you" chip and tick through the existing `completeTask`/`reopenTask`.
- Empty state (`reason:"empty"`): a calm panel "Your Desk appears here after the next morning build (6:45 on school days), or press Rebuild now." with the `deskUrl` link, Refresh and Rebuild now, and the add box still works. Invalid data: the message plus the same link and buttons.
- **Prompt Claude** (the routine page's button, same wording): a "✦ Prompt Claude" pill after each card's links, "Added by you" cards included. It copies a self-contained work order for that card: who Brandon is, TASK, the lane with today's date and when the board was built, the tags as Status, `why` as Context, the item's `prompt` as More context, each link (an AISA thread id, an AISA search, or a note that a personal-Gmail thread needs Chrome or a paste), what Claude may use, how to work (drafts only, never send), and `outcome` (or the standard finished-piece line) as "Done looks like". The button says *Copied* for about 2 seconds. Copying tries the clipboard, then a hidden textarea with `execCommand('copy')`; where the page's sandbox blocks both, a dialog shows the prompt selected, and Escape or Close returns focus to the button. The Tasks page has the same button, with a prompt built from the task's row (`docs/UI.md`).
- **Refresh and Rebuild now** sit under the meter (section 5).
- All text from the sheet is rendered with `textContent`; links only through the sanitiser; no `innerHTML` with data.

### The agenda block (`docs/AGENDA.md` section 2)

- When `agenda.meeting` is set, the Desk reads that meeting's saved agenda with `getAgenda({meetingDate: meeting})` after the Desk loads and again on every visit to the Desk page. Only the agenda block is redrawn when the answer arrives (ticks on their way, an open note field and the add box are not touched), and only the answer to the latest read for the meeting the Desk still shows counts.
- `saved: true`: the block shows the sheet's rows, Done, In progress, "Decisions & questions" (from Questions) and, when there are any, Documents (each a link pill to its document); Notes stay on the Agenda page. **Copy agenda as text** and **Download .xlsx** then give exactly what the Agenda page gives for that meeting (`agendaToText` / `buildAgendaWorkbookRows`: documents, links and Notes, file `agenda-<meeting date>`).
- No `meeting`, `saved: false`, or the read fails: the block and both buttons use the Desk JSON's `agenda` as before (the routine page's text format; file `desk-agenda-<build date>` with Section / Item / Detail, title rows with the agenda title and the director's name).
- The title and the open state always come from the Desk JSON. **Full agenda** opens the Agenda page at the meeting's date; unsaved edits of another week on the Agenda page are kept and the usual *Discard edits* toast asks first.

## 4. Routine (step 6 j, see `docs/routine-desk-prompt.md`)

Step 3 may give an item `prompt` and `outcome` (section 1) when a fresh Claude would need more than `why` to take the task on; most items have neither.

After step 6 d (each item has its `task`), write the final `desk-data` into the Desk tab as in section 1: clear `Desk!A2:C`, then one `update_values` call for `Desk!A2:C<n>` with `[key, json, built]` rows, splitting `items` so no JSON cell exceeds 45 000 characters. The JSON written is exactly what step 7 publishes. Only the morning build writes the Desk tab; the weekly agenda review (Mondays 14:45, `docs/routine-agenda-prompt.md`) does not, so after a review the Desk shows the reviewed agenda by reading the Agenda tab (section 3), not from its own JSON.

## 5. Refresh and Rebuild now

- **Refresh** reads the Desk tab again (`getDesk`) without reloading the page and says whether it found a newer build ("Loaded the latest Desk (built …)" or "Your Desk is up to date (built …)"). A read that would land on top of a tick or an add on its way waits for it, and the agenda block keeps the open or shut state Brandon gave it.
- **Rebuild now** starts the morning build routine on demand, the same full build as the 06:45 one, the way the routine page's own Rebuild now button does. Apps Script cannot use Claude's connectors, so it goes through the routine's **API trigger** (Claude Code routines, research preview): `rebuildDesk` POSTs to `https://api.anthropic.com/v1/claude_code/routines/<DESK_ROUTINE_ID>/fire` with `Authorization: Bearer <token>`, `anthropic-beta: experimental-cc-routine-2026-04-01`, `anthropic-version: 2023-06-01` and `{"text": "Manual rebuild requested from the web app's Rebuild now button at HH:mm Gulf time. Do a full build."}`. `DESK_ROUTINE_ID` is in Config.gs; the token lives only in the Script Property `DESK_ROUTINE_TOKEN` (never in the sheet, the Log or the page).
- **One-time setup** (README, setup step 10): on claude.ai/code/routines, edit "Brandon's Desk morning build", add an **API** trigger, generate its token (shown once), and save it in the Apps Script editor under Project Settings → Script Properties as `DESK_ROUTINE_TOKEN`. Until then the button explains this instead of starting anything.
- **While it runs**: the start is kept in Script Property `DESK_REBUILD` (`{startedAt, ms, sessionUrl}`). For 20 minutes, or until the Desk tab holds a build newer than the start, `rebuildNow.running` is true, the button reads *Rebuilding…*, a second start is refused (two builds would write the sheet at once), and the line under it says since when, with *Open the build* (the run's claude.ai session). The page asks `getDeskStatus` every 45 seconds; when a newer build lands it reads the Desk again by itself ("Your Desk was rebuilt (built …)"), unless a note field is open, in which case it says a new Desk is ready and leaves Refresh to Brandon. If nothing lands within the window it stops asking and says so, with the run's link.
- **The routine page.** A run started through the API trigger may stop to ask before republishing the routine's claude.ai page (routines publish without asking only for scheduled and Run now runs). The run writes the Desk tab (step 6 j) before it publishes (step 7), so the web app gets the new Desk either way; the routine page may stay on the older build until the next scheduled build or an approval in the run's session.
