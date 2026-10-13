# Claude routines

One scheduled Claude routine feeds the tracker: **"Brandon's Desk morning build"** (trigger `trig_01VjWbjbnY1YSpjagSffkSNQ`, weekdays 06:45 Asia/Dubai, also started by the Desk's "Rebuild now" button). It builds Brandon's daily action board, a claude.ai artifact (https://claude.ai/artifact/3mG2UW54W6WkRFMAqkqxzr), and since 13 Oct 2026 it also syncs that board into the tracker sheet the web app uses.

Its full instructions are in `docs/routine-desk-prompt.md` (kept in step with the live routine; change both together).

## How the pieces fit

| When | What | Writes |
|---|---|---|
| 06:15 weekdays | Apps Script `captureInbox` trigger (this repo) reads AISA Gmail and Google Chat on the server | Inbox tab |
| 06:45 weekdays, or "Rebuild now" | Desk morning build (Claude routine): reads AISA mail and Chat in Brandon's Chrome when his computer is on, plus the Inbox tab, personal Gmail, the AISA calendar, the Desk's ticks and the tracker sheet | The Desk artifact; Work/Personal rows (new items with Source key `desk:<item id>`, Due/Link fill-ins, Done/Dropped when items leave the board); Inbox Status/Task ID; Agenda rows for Andy's next meeting; one Log row (`claude-desk`) |
| Any time | The web app (this repo) | Work/Personal, Inbox, Agenda (Brandon's edits) |

Rules that keep the two in step:

- Each Desk item carries `task` (the sheet row ID). The routine matches by `task`, then by Source key `desk:<id>`, then by the same link or thread.
- A tick on the Desk → the row becomes Done at the next build. A row ticked or dropped in the web app → the item leaves the Desk at the next build and appears under "Cleared".
- Tasks added in the web app (Source `Manual`) appear on the Desk at the next build.
- The routine never overwrites Title, Details, Project, Note, Newsletter, Discuss, Source or Source key on an existing row, never deletes task rows, and never touches Config.
- Andy's agenda: the routine writes Done / In progress / Questions rows for the week of the meeting it targets; Documents and Notes rows written in the web app are kept. The web app's Agenda page and **Download .xlsx** then show that agenda (pick the meeting date at the top if it is not the coming Tuesday).

## Earlier plan (not used)

Before the Desk routine existed, this file described two separate routines ("Desk: morning capture" and "Desk: director agenda"). They were never created, and the Desk morning build now covers both jobs, so nothing needs to be set up in the claude.ai Routines page.
