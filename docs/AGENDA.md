# Andy's agenda: who wrote which line (Agenda tab contract)

Three writers fill the Agenda tab for Brandon's 1:1 with his director (Andy, Tuesdays 10:00):

| Writer | When | Lines it writes |
|---|---|---|
| Morning build (Claude routine, `docs/routine-desk-prompt.md`) | weekdays 06:45; on Monday builds and the Tuesday morning build it writes a first agenda | Done, In progress, Questions |
| Weekly agenda review (Claude routine, `docs/routine-agenda-prompt.md`) | Mondays 14:45 (or by hand) | Done, In progress, Questions, Documents |
| Brandon, on the web app's Agenda page | any time | any section; Notes only he writes |

This file is the contract between them. It extends `docs/SPEC.md` (Agenda tab, `getAgenda` / `regenerateAgenda` / `saveAgenda`) and `docs/DESK.md` (the Desk's agenda block); where they differ for the agenda, this file wins.

## 1. Provenance: the Generated column (H)

Every Agenda row's Generated cell says who wrote the line:

| Generated | Meaning |
|---|---|
| text `yyyy-MM-dd HH:mm claude-desk` | written by the morning build |
| text `yyyy-MM-dd HH:mm claude-review` | written by the weekly review |
| text `yyyy-MM-dd HH:mm web-draft` | a line of the web app's automatic draft that Brandon saved without changing it |
| anything else (a date-time, or text without one of those endings) | Brandon's line: he typed or edited it (or it predates these tags) |

- The tag is the last space-separated word of the cell text when it is exactly `claude-desk`, `claude-review` or `web-draft`. The leading stamp is `yyyy-MM-dd HH:mm` or `yyyy-MM-dd HH:mm:ss` (Dubai time).
- "Claude-written" below means any of the three tags. Brandon's lines are never removed or reworded by a routine.
- Tags are plain text in a column whose number format is a date-time; Sheets keeps them as text. Nothing may "heal", validate or reformat column H.

## 2. Web app changes

### Server (`Agenda.gs`)

- `readSavedSections_` returns, on each row, `generated`: the cell as text (a Date is formatted `yyyy-MM-dd HH:mm:ss` in Asia/Dubai; text is trimmed, after `unguardCell`). `getAgenda` and `regenerateAgenda` pass it to the client on every saved row.
- `buildAgendaDraft` rows carry `generated: "web-draft"`.
- `saveAgenda` accepts `generated` on each row and decides column H per row:
  - matches `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? (claude-desk|claude-review|web-draft)$` → written back exactly (text);
  - exactly `web-draft` → written as `<now yyyy-MM-dd HH:mm> web-draft` (text);
  - anything else → the save time as a Date (Brandon's line).
  It never trusts any other client value for column H. Item/detail/link/taskId rules are unchanged.
- Stale-save protection. `getAgenda`, `regenerateAgenda` and `saveAgenda` return `stamp`: a fingerprint of all of that week's rows as they are in the sheet (all sections, sheet order; per row section, order, item, detail, link, taskId and generated as text; plus the row count), as a short hex string (any deterministic string hash; it only has to change when a row changes). `saveAgenda({meetingDate, sections, stamp})`: inside the lock, before deleting anything, it recomputes the stamp from the sheet; when the input `stamp` is a string and differs, it writes nothing and throws the user error **"This agenda changed since you opened it (Claude's weekly review or another tab saved it). Copy any edits you want to keep, then reload the agenda."** Without `stamp` (old clients, tests) it saves as before. After writing it re-reads the week and returns `{ok, rows, stamp}` with the new stamp.

### Client (`App.html`)

- Agenda rows keep `generated` (`normaliseAgenda`) and send it back (`agendaSectionsForSave`). Editing a row's Item, Detail or link sets its `generated` to `''`; a row added with **+ Add** has `''`. Moving or removing rows does not change other rows' `generated`.
- Every section is editable, reorderable and removable (Done and In progress were read-only): textarea for Item, input for Detail, as Questions has today. Labels: "Done item", "In progress item", "Question", "Note"; add buttons "+ Add item" (Done, In progress), "+ Add question", "+ Add note", "+ Add document". A non-Documents row with a link still shows its "Open ↗" link next to the fields. Empty sections say "Nothing yet."
- Opening the Agenda page re-reads the agenda (same meeting date) unless there are unsaved edits: `loadPage('agenda')` calls `loadAgenda(state.agenda ? state.agenda.meetingDate : '')` when `!state.agendaDirty`. A regenerated draft counts as unsaved edits (`state.agendaDirty = true` after Regenerate), so the existing "Discard edits" guard protects it.
- The client stores `stamp` from `getAgenda` / `regenerateAgenda`, sends it with `saveAgenda`, and stores the new one on success. When the save fails with the "changed since you opened it" error, the error toast offers **Reload agenda** (discards the edits and reloads that meeting date).
- The "Window: …" line (page header, `.xlsx`, Copy as text) shows only for an unsaved draft (`agenda.window && !agenda.saved`): a saved agenda may cover more than meeting − 7 … meeting − 1 (after a missed meeting it covers two weeks).

### Desk page (`App.html`, `docs/DESK.md`)

- The `agenda` object in `desk-data` gains `"meeting": "yyyy-MM-dd"` (the meeting's date); both routines write it. `normaliseDesk` keeps it when it is a valid date, else `''`.
- When the Desk's agenda has a `meeting`, the Desk loads that meeting's saved agenda (`getAgenda({meetingDate: meeting})`) after the Desk itself loads, and again each time the Desk page is opened. When the answer is `saved: true`, the agenda block shows those rows instead of the Desk JSON's sections: Done, In progress, "Decisions & questions" (from Questions) and Documents (each a link pill to its URL when it has one); Notes are not shown on the Desk. **Copy agenda as text** and **Download .xlsx** then use `agendaToText` / `buildAgendaWorkbookRows` on that saved agenda (with documents, links and Notes, the same file as the Agenda page). Otherwise (no `meeting`, not saved, or the call fails) the block and its buttons use the Desk JSON as today. The block's title and open state always come from the Desk JSON. A link **Full agenda** next to the buttons opens the Agenda page at that meeting date.
- Nothing else on the Desk changes. The weekly review does not write the Desk tab.

## 3. Rules for the routines (both prompts implement these)

- Week of = the Monday of the meeting's week (`yyyy-MM-dd`), the same as the web app's `agendaWindow().weekOf`.
- **Morning build** (Monday builds and the Tuesday morning build, or the builds before a moved meeting): it looks at that week's Done, In progress and Questions rows. If any of them is tagged `claude-review` or is Brandon's, the agenda is settled: it fills the Desk's `agenda` from those rows and does not touch the Agenda tab. Otherwise (none, or only `claude-desk` / `web-draft`) it replaces those rows with its own, tagged `claude-desk`, keeping the week's Documents and Notes rows. It re-checks right before deleting.
- **Weekly review**: it replaces that week's Claude-written rows (all three tags; Notes are never Claude-written) and keeps every one of Brandon's rows. Its lines go after his in each section, never repeating what his cover; if his Questions contain an "Anything from your side…" closing line, its questions go before that line and it adds no second one. It re-reads and re-classifies right before writing.
- Both write the new rows first (below the last filled row, adding grid rows with `insert_dimension` when the sheet is too short), then delete the old ones bottom-up with `deleteDimension` (0-based, end-exclusive: sheet rows r–s are `startIndex r−1, endIndex s`), then check that only those rows went. No Item or Detail starts with `=`, `+`, `-` or `@`.
- Removing a Claude line on the Agenda page is honoured once the weekly review has run (the Tuesday build leaves a reviewed agenda alone). Before the review, the morning build refreshes its own lines each build, so a removed morning-build line can come back until Brandon edits or adds a line in Done, In progress or Questions, or the review runs. Running the review again by hand replaces its own lines (keeping Brandon's).
