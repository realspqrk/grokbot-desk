#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from './dev/rs-server.mjs';
import { isSameOriginPath } from './dev/browser-safety.mjs';
import { resolvedTemplates } from './template-registry.mjs';

const PORT = Number(process.env.RS_TOOL_PORT || 18920);
const FIXTURE_CREATED = '2026-10-08T10:39:00Z';
const FIXTURE_CLOCK_ANCHOR = '2026-10-08T10:40:00Z';
const cliArguments = process.argv.slice(2);
const action = cliArguments.shift();
const argument = cliArguments.shift();
let netlogDir = process.env.RS_NETLOG_DIR || null;
while (cliArguments.length) {
  const option = cliArguments.shift();
  if (option !== '--netlog') throw new Error(`unexpected argument: ${option}`);
  netlogDir = cliArguments.shift();
  if (!netlogDir) throw new Error('--netlog requires a directory');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runNetwork = { requests: [], responses: [], errors: [] };

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const MEASUREMENT_BOT_ID = readJson(
  path.join(ROOT, 'tools', 'measurement.json'),
).bot_id;

function discover(selected, goldenOnly = false) {
  const output = [];
  for (const { dir, manifest } of resolvedTemplates(ROOT, selected)) {
    const names = goldenOnly ? ['golden.json'] : readdirSync(path.join(dir, 'fixtures'))
      .filter((name) => name === 'golden.json' || /^edge-.*\.json$/.test(name))
      .sort();
    for (const name of names) output.push({
      dir, manifest, fixture: path.basename(name, '.json'),
      data: readJson(path.join(dir, 'fixtures', name)),
    });
  }
  if (!output.length) throw new Error(`no visual fixtures found for ${selected || '--all'}`);
  return output;
}

async function shot(browser, server, item, theme, destination) {
  await server.clearRuns();
  const namespace = item.manifest.namespace;
  const run = server.show(item.data, {
    template: item.manifest.id,
    version: item.manifest.version,
    bot: namespace === 'global' ? MEASUREMENT_BOT_ID : namespace,
    title: `${item.manifest.title_de} ${item.fixture}`.slice(0, 80),
    created: FIXTURE_CREATED,
  });
  await server.assertOpen(run.run_id, `${item.manifest.id}/${item.fixture}/${theme}`);
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1,
    colorScheme: theme, reducedMotion: 'reduce',
  });
  await context.addInitScript(() => localStorage.clear());
  const page = await context.newPage();
  page.on('request', (request) => runNetwork.requests.push(request.url()));
  page.on('response', (response) => runNetwork.responses.push({
    url: response.url(),
    status: response.status(),
    headers: response.headers(),
    synthetic: response.url().split('?')[0].endsWith('/copy'),
  }));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      runNetwork.errors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => runNetwork.errors.push(`pageerror: ${error.message}`));
  await page.route((url) => isSameOriginPath(url, PORT, '/copy'), (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"ok":true}',
    headers: { 'Content-Security-Policy': "default-src 'self'" },
  }));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?run=${encodeURIComponent(run.run_id)}&client=test`);
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await sleep(50);
    await page.screenshot({ path: destination, animations: 'disabled' });
  } finally {
    await context.close();
  }
}

function compare(baseline, actual) {
  const result = spawnSync('py', ['-3', path.join(ROOT, 'tools', 'pngdiff.py'), baseline, actual], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  let body;
  try { body = JSON.parse((result.stdout || '').trim()); } catch { body = { pass: false, error: result.stderr || result.stdout }; }
  return body;
}

function persistNetworkLog() {
  if (!netlogDir) return null;
  mkdirSync(netlogDir, { recursive: true });
  const destination = path.join(
    netlogDir,
    `${Date.now()}-${process.pid}-visual-${randomUUID()}.json`,
  );
  writeFileSync(destination, `${JSON.stringify({
    schema: 'report-shell/netlog@1',
    mode: `visual:${action?.slice(2)}`,
    template: argument,
    ...runNetwork,
  })}\n`, 'utf8');
  return destination;
}

if (!['--update', '--check', '--shots'].includes(action) || !argument) {
  console.error('usage: node tools/visual.mjs --update <id|--all> | --check <id|--all> | --shots <dir>');
  process.exit(2);
}

let server;
let browser;
let output;
try {
  const chromium = await loadChromium();
  if (!chromium) throw new Error('playwright-core not found; set RS_PLAYWRIGHT_CORE');
  server = await startServer({
    port: PORT,
    mediaRoots: [ROOT],
    env: { RS_CLOCK_ANCHOR: FIXTURE_CLOCK_ANCHOR },
  });
  browser = await chromium.launch({ channel: browserChannel(), headless: true });
  const isShots = action === '--shots';
  const items = discover(isShots ? '--all' : argument, isShots);
  const results = [];
  const temp = path.join(server.dataDir, 'visual');
  mkdirSync(temp, { recursive: true });
  if (isShots) mkdirSync(path.resolve(argument), { recursive: true });
  for (const item of items) {
    for (const theme of ['light', 'dark']) {
      const filename = isShots
        ? `${item.manifest.id}.${theme}.png`
        : `${item.fixture}.${theme}.png`;
      const target = isShots
        ? path.join(path.resolve(argument), filename)
        : path.join(item.dir, 'golden', filename);
      if (action === '--update' || isShots) {
        mkdirSync(path.dirname(target), { recursive: true });
        await shot(browser, server, item, theme, target);
        results.push({ template: item.manifest.id, fixture: item.fixture, theme, path: target, pass: true });
      } else {
        if (!existsSync(target)) {
          results.push({ template: item.manifest.id, fixture: item.fixture, theme, path: target, pass: false, error: 'golden image missing' });
          continue;
        }
        const actual = path.join(temp, `${item.manifest.id}.${item.fixture}.${theme}.png`);
        await shot(browser, server, item, theme, actual);
        results.push({ template: item.manifest.id, fixture: item.fixture, theme, path: target, ...compare(target, actual) });
      }
    }
  }
  const passed = results.filter((item) => item.pass).length;
  output = { mode: action.slice(2), ok: passed === results.length, passed, total: results.length, results };
} catch (error) {
  output = { mode: action?.slice(2), ok: false, error: error.stack || String(error) };
} finally {
  try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
}
try {
  output.netlog = persistNetworkLog();
} catch (error) {
  output.ok = false;
  output.netlog_error = error.stack || String(error);
}
console.log(JSON.stringify(output));
process.exitCode = output.ok ? 0 : 1;
