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
- The routine rewrites rows 2+ on every build (clear `Desk!A2:C`, then write all rows in one call). Nothing else writes this tab. Row order does not matter; keys are unique.
- Every value starts with `{`, `[`, `"`, or is `null`, so Sheets never parses it as a formula or a number.
- `setup()` / `ensureSchema()` create the tab with this header row and column B formatted as text when it is missing; `getDesk` creates it too on its first read. The tab must exist before the routine's first write to `Desk!A2:C`, so after the release that adds the Desk, open the web app once (or run `setup`) before the next morning build. `healSheet` never touches it.

### `desk-data` shapes (as produced by the routine; the web app must tolerate missing fields)

```
meta.lanes      [{"key":"now"|"reply"|"later","title":string}]            (usually 3)
meta.rebuild    {"trigger": string}                                        (ignored by the web app)
strip           [{"cls":"now"|"brk"|"pd"|"","d":string,"t":string,"s":string,"href":string}]
items           [{"id":string,"lane":string,"title":string,"why":string,
                  "tags":[[kind,text],…],"links":[[label,target],…],"task":"W-…"|"P-…"|undefined}]
cleared         [string]
priorities      [{"title":string,"tag":[kind,text]|undefined,"points":[string],"links":[[label,target]]}]
coming          [{"when":string,"hl":bool|undefined,"title":string,"detail":string,"href":string|undefined}]
agenda          null | {"title":string,"open":bool,"sections":[{"name":string,"items":[{"t":string,"d":string}]}]}
llt             null | {"title","padlet","working":[string],"great":[string],"night":[string],"raise":[{"t","d"}]}
quick           [[title, subtitle, url]]
```

Tag kinds: `late`, `due`, `new`, `home`, `gh`, `list`, `` (source). Link targets: a full `https://` URL, or `wt:<thread id>` (AISA Gmail thread) → `https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#all/<id>`, `w:<search>` (AISA Gmail search) → `https://mail.google.com/mail/?authuser=bbaki%40aisa.sch.ae#search/<encodeURIComponent(search) with %20 → +>`, `p:<decimal id>` (personal Gmail thread) → `https://mail.google.com/mail/?authuser=brandon.abaki@gmail.com#all/thread-f:<id>`. After expansion every link goes through the existing http/https sanitiser; anything else is rendered as plain text.

## 2. Server API additions (`Desk.gs`, entry points in `Api.gs`)

Same conventions as SPEC section 5 (one plain object in, JSON-safe object out, `guard()` first, short user errors).

| Function | Input | Output | Behaviour |
|---|---|---|---|
| `getDesk` | `{}` | `{ok:true, desk:{built, eyebrow, sources, lanes, strip, items, cleared, priorities, coming, agenda, llt, quick}, added:[Task], builtAt:"yyyy-MM-dd HH:mm", builtDate:"yyyy-MM-dd", stale:boolean, deskUrl}` or `{ok:false, reason:"empty"\|"invalid", message}` | Reads the Desk tab and assembles `desk`. Each item gains `category` (`Work`/`Personal`: from the `task` prefix `W-`/`P-`, else `Personal` when a tag kind is `home`, else `Work`), `taskId` (the matched row's ID or `""`), `status` (the row's Status or `""`) and `done` (`true` when that Status is Done or Dropped). A row matches by `task` ID in its tab first, then by Source key `desk:<item id>` in either tab. `added` = Open tasks in either tab with Source `Manual` whose ID is not the `taskId` of any item, newest Created first, at most 20. `stale` = `builtDate` is not today (Dubai). `deskUrl` = `https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr` (constant in Config.gs). `reason:"empty"` when the tab has no data rows; `reason:"invalid"` when a JSON cell does not parse (message names the key; the error goes to the Log). |
| `setDeskItemDone` | `{itemId, done:boolean, note?}` | `{task}` | Finds the item in the Desk tab by `itemId` (user error "That Desk item is no longer on the Desk" if absent). Resolves its row like `getDesk`. If there is no row, creates one first with `createTasks` semantics: category as above, Title = item title, Details = item why, Link = first link expanded and sanitised, Source = `Gmail` for a `["","Email"]` tag, `Chat`, `Calendar`, `Manual` for `Added by you`, else `Claude`; Due from a `due`/`late` tag resolved against today like the routine does (blank if not resolvable); Priority High when lane `now` and tagged late or due today, else Normal; Source key `desk:<itemId>`. Then `done:true` → `completeTask` (note optional), `done:false` → `reopenTask`. Returns the task. |

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
- Layout and visual design follow the routine's Desk page (reference HTML is provided to the build agents outside the repo): header with eyebrow and "Brandon's Desk" title plus a done meter (`done / total` and bar); date strip; three-lane board (`Do today` / `Reply & follow up` / later lane titles come from `meta.lanes`), first lane headed by the add box (Work/Personal toggle defaulting to Work, Enter to add); item cards with checkbox, bold title, `why`, tags as small mono chips with the same colour meanings, links as pill buttons; "Cleared since last build" chips; two columns "Top priorities" and "Coming up"; the director agenda block (collapsible, open when `agenda.open`), with **Copy agenda as text** and **Download .xlsx** (one sheet "Agenda": Section / Item / Detail, title rows with the agenda title and the director's name, using the existing SheetJS + CSV fallback helpers); the LLT padlet block when `llt` is not null (paste text + Copy + Open padlet + "Raise with the whole team" list); Quick links grid; footer "Built <built> from <sources>." plus, when `stale`, a visible note "This Desk is from <weekday d Mon>; the next build is at 6:45 on school days." and a link "Open the Desk page" to `deskUrl` (for Rebuild now).
- Fonts and colour tokens as in the reference (Bricolage Grotesque for display, DM Sans body, JetBrains Mono for eyebrows/tags; purple accent; light and dark themes), scoped to the Desk page so the other pages keep their current look. No horizontal scroll at 360 px; lanes stack on mobile like the reference.
- Ticking an item: optimistic UI (card dims and strikes through, meter updates), then `setDeskItemDone`; on failure revert and show the error toast. Unticking reopens. After a tick, an optional one-line note field appears under the card (Enter saves via `updateTask` patch `note`, Escape dismisses), matching the Tasks page behaviour. Items whose `done` is true render ticked. `added` tasks render at the top of the first lane with an "Added by you" chip and tick through the existing `completeTask`/`reopenTask`.
- Empty state (`reason:"empty"`): a calm panel "Your Desk appears here after the next morning build (6:45 on school days), or press Rebuild now on the Desk page." with the `deskUrl` link, and the add box still works. Invalid data: the message plus the same link.
- All text from the sheet is rendered with `textContent`; links only through the sanitiser; no `innerHTML` with data.

## 4. Routine (step 6 j, see `docs/routine-desk-prompt.md`)

After step 6 d (each item has its `task`), write the final `desk-data` into the Desk tab as in section 1: clear `Desk!A2:C`, then one `update_values` call for `Desk!A2:C<n>` with `[key, json, built]` rows, splitting `items` so no JSON cell exceeds 45 000 characters. The JSON written is exactly what step 7 publishes.
