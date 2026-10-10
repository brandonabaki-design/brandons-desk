# UI render check

Local, mock-backed checks for the web UI (`apps-script/Index.html`, `Styles.html`, `App.html`). Nothing here calls Google.

## npm scripts

`package.json` carries `"ui": "node tests/ui/render.js"` and `"ui:build": "node tests/ui/assemble.js"`, and pins the dev dependencies `playwright@1.56.1` and `xlsx@0.18.5`. `npm install` adds them without downloading a browser: run `npx playwright install chromium` once afterwards (Playwright's own Chromium build), or set `CHROMIUM_PATH` to a Chrome/Chromium binary; a pre-installed Chromium at `/opt/pw-browsers/chromium` is picked up automatically when it exists. The server-backed end-to-end check, `tests/e2e.js`, reuses `assemble.js` and runs as part of `npm test`.

`xlsx` serves two purposes: when `node_modules/xlsx/dist/xlsx.full.min.js` is present and its sha384 matches the pinned cdnjs build, the checks serve it in place of the CDN so the real `.xlsx` download path runs (otherwise only the CSV fallback is exercised), and the render check reads the downloaded workbooks back with it.

## Files

| File | What it does |
|---|---|
| `mock-server.js` | Browser shim: `window.google.script.run` (plus `google.script.url` / `google.script.history`) with `withSuccessHandler` / `withFailureHandler` and every function from SPEC.md section 5, backed by fixtures: 27 tasks (overdue, due today, High, Newsletter, Discuss, Done today, Dropped, a `javascript:` link that must not render), 6 new + 2 handled inbox items, a saved agenda for the next Tuesday, Config. Hooks on `window.__mock`: `state`, `latency`, `calls`, `failNext(fn, message)`, `chatMode`. |
| `assemble.js` | Inlines the `<?!= include('Styles') ?>` / `<?!= include('App') ?>` tags and the viewport meta tag that `doGet()` adds server-side; writes `/tmp/claude-0/brandons-desk-ui/index.html` (`$UI_OUT` overrides the folder). `--mock` also inlines the shim so the file runs in any browser: `node tests/ui/assemble.js --mock` then open `index.mock.html`. |
| `pure-check.js` | Evals the `/* pure:start */ … /* pure:end */` block of `App.html` in a bare `node:vm` context and checks `esc`, `sanitiseLink`, date labels, `groupTasks`, `formulaGuard`/CSV, `buildAgendaWorkbookRows`, `buildNewsletterWorkbookRows`, `agendaToText`, every text-import syntax and the `previewRowsToText` round-trip. |
| `render.js` | Playwright + headless Chromium. Runs `pure-check`, assembles, then at 390×844 and 1280×900 (plus a dark-mode pass and a "SheetJS missing" pass): loading state, tab counts, every page (no horizontal overflow, screenshot), quick-add (success, duplicate, server error), tick with note, undo, untick, inline editor save, search, move, drop + undo, inbox promote / ignore / capture (api and email chat modes), import preview from pasted text and an uploaded `.html` (edits, the regenerated `importText` payload, link patching), agenda edit / save / copy / download / regenerate / week change, newsletter copy and download, history reopen and filters, hash navigation on load, boot failure and retry. Fails on any console error, uncaught exception or unexpected network request. |

## Running

```
node tests/ui/render.js
```

Prints `ok` / `FAIL` per step, then the screenshot paths under `/tmp/claude-0/brandons-desk-ui/screenshots/` and the downloads under `.../downloads/`. Exit code 1 on any failure; exit code 2 when Playwright or a Chromium is missing (the message says what to install). External requests are intercepted: Google Fonts is stubbed, SheetJS is served from `node_modules` (or blocked on purpose), anything else fails the run.
