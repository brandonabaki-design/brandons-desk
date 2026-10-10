#!/usr/bin/env node
/*
 * Assembles apps-script/Index.html into one standalone HTML file by inlining the
 * <?!= include('Styles') ?> / <?!= include('App') ?> template tags, exactly as the server's
 * include() does, and adds the viewport meta tag that doGet() sets with addMetaTag.
 *
 * Usage: node tests/ui/assemble.js [--mock] [--out <file>]
 *   --mock   also inlines tests/ui/mock-server.js before the app script, so the file runs in a plain browser
 *   --out    output path (default: $UI_OUT or /tmp/claude-0/brandons-desk-ui/index[.mock].html)
 * Nothing is written inside the repository.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'apps-script');
const DEFAULT_OUT_DIR = process.env.UI_OUT || '/tmp/claude-0/brandons-desk-ui';

function include(name) {
  const file = path.join(SRC, name + '.html');
  if (!fs.existsSync(file)) throw new Error('include(' + name + '): missing ' + file);
  return fs.readFileSync(file, 'utf8');
}

/** Returns the assembled HTML as a string. */
function assembleHtml(opts) {
  opts = opts || {};
  let html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8');
  const seen = [];
  html = html.replace(/<\?!=\s*include\('([A-Za-z0-9_]+)'\)\s*\?>/g, (m, name) => { seen.push(name); return include(name); });
  if (/<\?/.test(html)) throw new Error('Unresolved template tag left in Index.html');
  if (seen.indexOf('Styles') < 0 || seen.indexOf('App') < 0) throw new Error('Index.html must include Styles and App (found: ' + seen.join(', ') + ')');
  // doGet() adds this with HtmlOutput.addMetaTag; HtmlService strips a meta tag written in the file.
  html = html.replace(/<meta charset="utf-8">/i, '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">');
  if (opts.mock) {
    const shim = fs.readFileSync(path.join(__dirname, 'mock-server.js'), 'utf8');
    html = html.replace(/<script src="https:\/\/cdnjs\.cloudflare\.com/, '<script>\n' + shim + '\n</script>\n  <script src="https://cdnjs.cloudflare.com');
  }
  return html;
}

/** Writes the assembled file and returns its absolute path. */
function assemble(opts) {
  opts = opts || {};
  const out = opts.out || path.join(DEFAULT_OUT_DIR, opts.mock ? 'index.mock.html' : 'index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, assembleHtml(opts));
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const mock = args.indexOf('--mock') >= 0;
  const outIdx = args.indexOf('--out');
  const out = assemble({ mock: mock, out: outIdx >= 0 ? args[outIdx + 1] : undefined });
  console.log('Assembled ' + out + (mock ? ' (with mock google.script.run)' : ''));
}

module.exports = { assemble, assembleHtml, DEFAULT_OUT_DIR };
