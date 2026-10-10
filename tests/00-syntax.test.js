'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HEADERS, TAB_ORDER } = require('./gas-mock');

const GS_DIR = path.join(__dirname, '..', 'apps-script');

const API_FUNCTIONS = ['getBootstrap', 'listTasks', 'addTask', 'updateTask', 'completeTask', 'reopenTask', 'dropTask',
  'moveTask', 'importText', 'importHtml', 'listInbox', 'promoteInbox', 'ignoreInbox', 'getAgenda', 'saveAgenda',
  'regenerateAgenda', 'getNewsletter', 'runCaptureNow', 'getLog'];

const EXPECTED_FILES = ['Agenda.gs', 'Api.gs', 'Capture.gs', 'Chat.gs', 'Config.gs', 'Import.gs', 'Newsletter.gs',
  'Setup.gs', 'Sheet.gs', 'Tasks.gs', 'Util.gs'];

module.exports = async function (t) {
  await t.test('exactly the spec-listed .gs files exist', (sb, assert) => {
    const files = fs.readdirSync(GS_DIR).filter((f) => f.endsWith('.gs')).sort();
    assert.deepEqual(files, EXPECTED_FILES);
  });

  await t.test('no optional chaining, nullish coalescing, import/export/require in .gs files', (sb, assert) => {
    const problems = [];
    fs.readdirSync(GS_DIR).filter((f) => f.endsWith('.gs')).forEach((f) => {
      const code = fs.readFileSync(path.join(GS_DIR, f), 'utf8');
      code.split('\n').forEach((line, i) => {
        const where = f + ':' + (i + 1);
        if (/\?\.(?![0-9])/.test(line)) problems.push(where + ' optional chaining: ' + line.trim());
        if (/\?\?/.test(line)) problems.push(where + ' nullish coalescing: ' + line.trim());
        if (/^\s*(import|export)\b/.test(line)) problems.push(where + ' import/export: ' + line.trim());
        if (/\brequire\s*\(/.test(line)) problems.push(where + ' require(): ' + line.trim());
      });
    });
    assert.deepEqual(problems, []);
  });

  await t.test('no top-level Google service calls (every file loads in the sandbox)', (sb, assert) => {
    // createSandbox() already loaded every file without touching a service; make sure the
    // mock recorded no reads/writes during load.
    assert.equal(sb.mock.writes, 0);
    assert.equal(sb.mock.gmail.searches.length, 0);
    assert.equal(sb.mock.urlFetch.calls.length, 0);
  });

  await t.test('every API entry point and its implementation exist', (sb, assert) => {
    API_FUNCTIONS.forEach((name) => {
      assert.equal(typeof sb.gs[name], 'function', name + ' missing');
    });
    API_FUNCTIONS.filter((n) => n !== 'getBootstrap' && n !== 'getLog').forEach((name) => {
      assert.equal(typeof sb.gs[name + '_'], 'function', name + '_ implementation missing');
    });
    ['doGet', 'include', 'guard', 'captureInbox', 'installTriggers', 'removeTriggers', 'setup', 'createFreshSheet',
      'selfTest', 'healSheet', 'ensureSchema', 'readConfig', 'getSheetId', 'openSpreadsheet', 'getTab', 'readRows',
      'writeRow', 'appendRows', 'withLock', 'todayDubai', 'formatDate', 'parseDate', 'addDays', 'mondayOf',
      'nextMeetingDate', 'newId', 'normaliseTitle', 'diceSimilarity', 'isSimilarTitle', 'sha1Hex', 'keywordHit',
      'log', 'extractEmail', 'stripQuotedReply', 'sanitiseLink'].forEach((name) => {
      assert.equal(typeof sb.gs[name], 'function', name + ' missing');
    });
  });

  await t.test('mock headers and tab order match Config.gs', (sb, assert) => {
    assert.deepEqual(sb.eval('TAB_ORDER'), TAB_ORDER);
    TAB_ORDER.forEach((tab) => {
      assert.deepEqual(sb.eval('HEADERS[' + JSON.stringify(tab) + ']'), HEADERS[tab], tab);
    });
    const COLUMN = sb.eval('COLUMN');
    assert.equal(Object.keys(COLUMN.TASK).length, 16);
    assert.equal(COLUMN.TASK.sourceKey, 14);
    assert.equal(COLUMN.TASK.updated, 15);
    assert.equal(Object.keys(COLUMN.INBOX).length, 11);
    assert.equal(COLUMN.INBOX.categoryHint, 10);
    assert.equal(Object.keys(COLUMN.AGENDA).length, 8);
    assert.equal(sb.eval('DEFAULT_SHEET_ID'), '1012Dbz6HB4dXD12Q5ClKm9LytSqgLHDIVz5_n6bHZ6w');
  });

  await t.test('appsscript.json manifest matches the spec', (sb, assert) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(GS_DIR, 'appsscript.json'), 'utf8'));
    assert.equal(manifest.timeZone, 'Asia/Dubai');
    assert.equal(manifest.runtimeVersion, 'V8');
    assert.equal(manifest.exceptionLogging, 'STACKDRIVER');
    assert.deepEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
    assert.deepEqual(manifest.oauthScopes, [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'https://www.googleapis.com/auth/chat.messages.readonly'
    ]);
    assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: 'Chat', serviceId: 'chat', version: 'v1' }]);
    assert.equal(manifest.chat, undefined, 'no "chat" key (that would register a Chat app)');
  });

  await t.test('package.json and .clasp.json.example', (sb, assert) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.private, true);
    assert.equal(pkg.scripts.test, 'node tests/run.js && node tests/e2e.js', 'npm test = unit tests then the e2e test');
    assert.equal(pkg.scripts['test:unit'], 'node tests/run.js');
    assert.equal(pkg.scripts['test:e2e'], 'node tests/e2e.js');
    assert.equal(pkg.scripts.ui, 'node tests/ui/render.js');
    assert.equal(pkg.scripts['ui:build'], 'node tests/ui/assemble.js');
    assert.equal(pkg.engines.node, '>=22');
    assert.equal(pkg.dependencies, undefined, 'runtime dependencies: none (Apps Script has no npm)');
    assert.equal(pkg.devDependencies.playwright, '1.56.1', 'pinned: tests/ui/README.md');
    assert.equal(pkg.devDependencies.xlsx, '0.18.5', 'pinned: the cdnjs build the page loads');
    const clasp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.clasp.json.example'), 'utf8'));
    assert.equal(clasp.rootDir, './apps-script');
    assert.deepEqual(clasp.filePushOrder, ['apps-script/Config.gs', 'apps-script/Util.gs']);
    const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert.ok(/^\.clasp\.json$/m.test(ignore), '.clasp.json is git-ignored');
  });
};
