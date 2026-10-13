# Claude routines

Two scheduled Claude routines feed the tracker sheet:

| Routine | When | Instructions |
|---|---|---|
| **Brandon's Desk morning build** (trigger `trig_01VjWbjbnY1YSpjagSffkSNQ`) | weekdays 06:45 Asia/Dubai, and the Desk's "Rebuild now" button | `docs/routine-desk-prompt.md` |
| **Weekly agenda review** | Mondays 14:45 Asia/Dubai, or started by hand | `docs/routine-agenda-prompt.md` |

The morning build builds Brandon's daily action board, a claude.ai artifact (https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr), and since 13 Oct 2026 also syncs that board into the tracker sheet the web app uses. The weekly review reads the week's work and writes Andy's agenda for the next Tuesday 1:1 into the Agenda tab, the agenda Brandon downloads from the web app's Agenda page. Each prompt file is kept in step with its live routine; change both together.

## How the pieces fit

| When | What | Writes |
|---|---|---|
| 06:15 weekdays | Apps Script `captureInbox` trigger (this repo) reads AISA Gmail and Google Chat on the server | Inbox tab |
| 06:45 weekdays, or "Rebuild now" | Desk morning build (Claude routine): reads AISA mail and Chat in Brandon's Chrome when his computer is on, plus the Inbox tab, personal Gmail, the AISA calendar, the Desk's ticks and the tracker sheet | The Desk artifact; Work/Personal rows (new items with Source key `desk:<item id>`, Due/Link fill-ins, Done/Dropped when items leave the board); Inbox Status/Task ID; the Desk tab; on Monday builds and the meeting-day build before the meeting, a first agenda for Andy (Done, In progress, Questions tagged `claude-desk`) unless that week's agenda is already settled; one Log row |
| Mondays 14:45, or by hand | Weekly agenda review (Claude routine): reads the Work, Agenda, Desk and Inbox tabs, AISA mail, Chat and docs in Brandon's Chrome, and the calendar | Andy's agenda for the next meeting in the Agenda tab (Done, In progress, Questions, Documents tagged `claude-review`); one Log row. Not the Desk tab, and no push notification |
| Any time | The web app (this repo) | Work/Personal, Inbox, Agenda (Brandon's lines and edits) |

Rules that keep the morning build and the web app in step:

- Each Desk item carries `task` (the sheet row ID). The routine matches by `task`, then by Source key `desk:<id>`, then by the same link or thread.
- A tick on the Desk → the row becomes Done at the next build. A row ticked or dropped in the web app → the item leaves the Desk at the next build and appears under "Cleared".
- Tasks added in the web app (Source `Manual`) appear on the Desk at the next build.
- The routine never overwrites Title, Details, Project, Note, Newsletter, Discuss, Source or Source key on an existing row, never deletes task rows, and never touches Config.

## Andy's agenda: who wrote which line

Three writers share the Agenda tab, so every row's Generated cell (column H) records who wrote it. `docs/AGENDA.md` is the contract; in short:

- `yyyy-MM-dd HH:mm claude-desk` = the morning build, `… claude-review` = the weekly review, `… web-draft` = a line of the web app's automatic draft that Brandon saved unchanged. Anything else (normally the save time as a date-time) is **Brandon's line**: he typed, edited or added it. Notes are only ever his.
- **Brandon's lines are never removed or reworded by a routine.** Editing a line on the Agenda page makes it his; moving or removing lines does not change the others.
- **Morning build:** if that week's Done, In progress or Questions already hold a `claude-review` line or one of Brandon's, the agenda is settled: the build shows it on the Desk and leaves the Agenda tab alone. Otherwise it replaces those rows with its own (`claude-desk`), keeping the week's Documents and Notes. On a Monday from 14:30 on it never writes the Agenda tab: the review owns it then.
- **Weekly review:** replaces the week's Claude-written lines (all three tags) and keeps every one of Brandon's; its lines go after his in each section, without repeating what his cover, and before his "Anything from your side…" closing question if he has one. A scheduled review writes once per meeting; a run started by hand always writes, replacing its own earlier lines.
- Both routines choose the meeting the same way (the next "Andy/ Brandon" event that counts, within 8 days), add their new rows first, then delete the old Claude-written ones bottom-up, and check that nothing else went. The details are in `docs/AGENDA.md` section 3 and in the two prompt files.
- **A line removed on the Agenda page** stays removed once the review has run. Before that, the morning build refreshes its own lines each build, so a removed morning-build line can come back until Brandon edits or adds a line in Done, In progress or Questions, or the review runs.
- **Stale saves:** the Agenda page remembers a fingerprint of the week when it loads it; if a routine (or another tab) changed the week before Brandon saves, the save is refused, nothing is written, and the error toast offers **Reload agenda**. Copy any edits first (*Copy as text* copies the page as it stands). The page also reads the agenda again each time it is opened, unless there are unsaved edits.
- **The Desk's agenda block** shows the saved agenda of the meeting it names (`agenda.meeting`) as soon as one exists in the Agenda tab, so a review or an edit made in the web app shows on the Desk without waiting for the next build. Its *Copy* and *Download* then give the same text and file as the Agenda page.

## Setting up the weekly review

The morning build already exists. The weekly review is created once in the claude.ai **Routines** page (a routine created from a Claude Code session cannot carry connectors on this account):

1. Routines → New routine. Name: **Weekly agenda review**.
2. Schedule: Mondays at 14:45, time zone Asia/Dubai.
3. Connectors: **Google Calendar** and **Google Sheets** (both the work account, `bbaki@aisa.sch.ae`). The prompt also reads AISA mail, Chat and Google Docs with the Claude in Chrome tools on Brandon's computer; when that is not reachable it works from the sheet and the calendar and says so in its Log row.
4. Prompt: the contents of `docs/routine-agenda-prompt.md`, exactly.
5. Notifications: off (the review sends no push notification; its result is the agenda in the web app and one Log row).

It can also be started by hand from the Routines page (for example after a missed meeting or a late change): a run started by hand always writes, replacing its own earlier lines and keeping Brandon's.

## Earlier plan (not used)

Before the Desk routine existed, this file described two other routines ("Desk: morning capture" and "Desk: director agenda", Mondays 18:10 with a push notification). They were never created: the morning build covers the capture, and the weekly agenda review above replaces the director agenda routine.
