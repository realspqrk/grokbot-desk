import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  CALM_THRESHOLDS,
  auditCopyFocus,
  calmEvaluator,
  focusedControlFacts,
  isSocialPreview,
  pngBackgroundRatio,
  settleShortAnimations,
} from '../tools/calm.mjs';
import { isSameOriginPath } from '../tools/dev/browser-safety.mjs';
import {
  browserChannel,
  loadChromium,
  resolvePythonExecutable,
  ROOT,
  serverStderrTail,
  spawnPythonProcess,
  startServer,
  validateServerPort,
} from '../tools/dev/rs-server.mjs';
import { resolvedTemplates } from '../tools/template-registry.mjs';
import { calmPage } from './fixtures/calm/pages.mjs';

const source = fs.readFileSync(path.join(ROOT, 'tools', 'e2e.mjs'), 'utf8');
const declarations = source.slice(source.indexOf('function json('), source.indexOf('const runners ='));
const serverSource = fs.readFileSync(path.join(ROOT, 'tools', 'dev', 'rs-server.mjs'), 'utf8');
const FIXTURE_CLOCK_ENV = { RS_CLOCK_ANCHOR: '2026-10-08T10:40:00Z' };
const BASE_PORT = Number(process.env.RS_E2E_PORT || 18920);
const REVIEW_PORT = BASE_PORT + 3;
const REVIEW_AUX_PORT = BASE_PORT + 4;
const REVIEW_PARALLEL_PORTS = [BASE_PORT + 4, BASE_PORT + 5, BASE_PORT + 6];
const REVIEW_FAKE_ORIGIN = `http://127.0.0.1:${BASE_PORT + 7}`;

function sandbox(overrides = {}) {
  const value = {
    ROOT,
    PORT: REVIEW_PORT,
    requestedTemplate: '--all',
    AXE: path.join(ROOT, 'vendor', 'axe.min.js'),
    AXE_SHA256: '20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878',
    path,
    createHash,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    resolvedTemplates,
    performance,
    console,
    process,
    setTimeout,
    clearTimeout,
    boundedMilliseconds: (name, fallback) => fallback,
    fetch,
    spawnSync,
    browserChannel,
    CALM_THRESHOLDS,
    focusedControlFacts,
    settleShortAnimations,
    isSocialPreview,
    isSameOriginPath,
    sleep: async () => {},
    runNetwork: { requests: [], responses: [], errors: [] },
    ...overrides,
  };
  vm.createContext(value);
  vm.runInContext(declarations, value);
  return value;
}

function stopServerSandbox(overrides = {}) {
  const removed = [];
  let now = 0;
  const value = {
    AbortSignal: { timeout: (milliseconds) => ({ milliseconds }) },
    Date: { now: () => { now += 5000; return now; } },
    fetch: async () => { throw new Error('server already unavailable'); },
    path,
    readFileSync: () => { throw new Error('state already unavailable'); },
    rmSync: (target) => { removed.push(target); },
    sleep: async () => {},
    ...overrides,
  };
  vm.createContext(value);
  const implementation = [
    serverSource.slice(
      serverSource.indexOf('function processHasExited('),
      serverSource.indexOf('async function hello('),
    ).replace(
      'export async function awaitProcessExit(',
      'async function awaitProcessExit(',
    ),
    serverSource.slice(serverSource.indexOf('export async function stopServer('))
      .replace('export async function stopServer(', 'async function stopServer('),
  ].join('\n');
  vm.runInContext(implementation, value);
  return { stopServer: value.stopServer, removed };
}

test('resolved interpreter spawn retains python itself instead of the py launcher', () => {
  const resolveCalls = [];
  const executable = resolvePythonExecutable(
    { RS_PYTHON: 'py' },
    (command, args, options) => {
      resolveCalls.push({ command, args, options });
      return {
        status: 0,
        stdout: 'C:\\Python311\\python.exe\r\n',
        stderr: '',
      };
    },
  );
  const spawnCalls = [];
  const child = {};
  const result = spawnPythonProcess(
    executable,
    ['report_shell.py', '--port', '18920', 'serve'],
    { cwd: ROOT },
    (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
  );

  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].command, 'py');
  assert.deepEqual(resolveCalls[0].args, [
    '-c',
    'import sys; print(sys.executable)',
  ]);
  assert.equal(executable, 'C:\\Python311\\python.exe');
  assert.equal(result, child);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, executable);
  assert.notEqual(spawnCalls[0].command, 'py');
  assert.equal(spawnCalls[0].options.shell, false);
});

test('server startup diagnostics use a bounded file-backed stderr tail', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-stderr-tail-'));
  const stderrPath = path.join(scratch, 'server.stderr.log');
  try {
    fs.writeFileSync(
      stderrPath,
      `${'discarded\n'.repeat(2000)}synthetic startup failure\n`,
      'utf8',
    );

    const tail = serverStderrTail(stderrPath, 256);

    assert.ok(Buffer.byteLength(tail, 'utf8') <= 256);
    assert.match(tail, /synthetic startup failure\n$/u);
    assert.match(serverSource, /serverStderrTail\(stderrPath\)/u);
    assert.match(serverSource, /server stderr tail:/u);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('stopServer authenticates with isolated state and accepts graceful exit', async () => {
  let request;
  const proc = {
    exitCode: null,
    signalCode: null,
    kill: () => { throw new Error('graceful stop must not signal'); },
  };
  const { stopServer, removed } = stopServerSandbox({
    readFileSync: () => JSON.stringify({ token: 'isolated-stop-token' }),
    fetch: async (url, options) => {
      request = { url, options };
      proc.exitCode = 0;
      return { ok: true };
    },
  });

  await stopServer({ dataDir: 'isolated-data', port: 18920, proc });

  assert.equal(request.url, 'http://127.0.0.1:18920/stop');
  assert.equal(request.options.headers['X-RS-Token'], 'isolated-stop-token');
  assert.deepEqual(removed, ['isolated-data']);
});

test('tree ownership model never widens retained-child cleanup to numeric descendants', async () => {
  const snapshot = [
    { pid: 765432, ppid: 1, started: 300, owner: 'review' },
    { pid: 880001, ppid: 765432, started: 100, owner: 'foreign-stale-ppid' },
    { pid: 880002, ppid: 880001, started: 200, owner: 'foreign-descendant' },
  ];
  const numericTreeTargets = [];
  const numericParents = [765432];
  while (numericParents.length) {
    const parent = numericParents.shift();
    for (const entry of snapshot.filter((candidate) => candidate.ppid === parent)) {
      numericTreeTargets.push(entry.owner);
      numericParents.push(entry.pid);
    }
  }
  assert.deepEqual(numericTreeTargets, [
    'foreign-stale-ppid',
    'foreign-descendant',
  ]);

  const retainedSignals = [];
  const proc = {
    exitCode: null,
    signalCode: null,
    pid: 765432,
    kill: (signal) => {
      retainedSignals.push(signal);
      if (signal === undefined) proc.signalCode = 'SIGTERM';
      return true;
    },
  };
  const { stopServer } = stopServerSandbox();

  await stopServer({ dataDir: 'already-removed', port: 18920, proc });

  assert.deepEqual(retainedSignals, [undefined]);
});

test('stopServer fails loudly and keeps temp state when retained child refuses to exit', async () => {
  let retainedKills = 0;
  const proc = {
    exitCode: null,
    signalCode: null,
    pid: 765432,
    kill: () => {
      retainedKills += 1;
      return true;
    },
  };
  const { stopServer, removed } = stopServerSandbox();

  await assert.rejects(
    stopServer({ dataDir: 'keep-for-diagnosis', port: 18920, proc }),
    /retained server process 765432 did not exit/u,
  );

  assert.equal(retainedKills, 1);
  assert.deepEqual(removed, []);
});

test('configured isolated ports outside the default allocation range are accepted', () => {
  assert.equal(validateServerPort(18930), 18930);
});

test('the production default port is refused before any server bind', () => {
  assert.throws(
    () => validateServerPort(18742),
    /refusing the product default port 18742/u,
  );
});

test('browser launch and page navigation use explicit bounded timeouts', async () => {
  let launchOptions;
  let gotoOptions;
  const page = {
    goto: async (url, options) => { gotoOptions = options; },
    on: () => {},
    route: async () => {},
    waitForFunction: async () => {},
  };
  const context = {
    newPage: async () => page,
  };
  const browser = {
    close: async () => {},
    newContext: async () => context,
  };
  const server = {
    assertOpen: async () => {},
    stop: async () => {},
  };
  const scope = sandbox({
    loadChromium: async () => ({
      launch: async (options) => {
        launchOptions = options;
        return browser;
      },
    }),
    mode: 'expect',
    reportStage: () => {},
    startServer: async () => server,
  });

  await scope.withSession(async ({ browser: launched }) => {
    await scope.openPage(launched, server, 'run-id');
  });

  assert.equal(launchOptions.timeout, 30000);
  assert.equal(gotoOptions.timeout, 30000);
});

test('round 3 finding 1: the real production keyboard runner imports its focus evaluator', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tools', 'e2e.mjs'), 'keyboard', 'decide-list'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        RS_PLAYWRIGHT_CORE: process.env.RS_PLAYWRIGHT_CORE,
        RS_E2E_RESULT_TIMEOUT_MS: '30000',
        RS_TOOL_PORT: String(BASE_PORT + 8),
      },
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    },
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.doesNotMatch(output, /focusedControlFacts is not defined/u);
  assert.equal(result.status, 0, output);
});

test('keyboard flow waits for the rendered rail before replaying Tab steps', async () => {
  const events = [];
  const scope = sandbox();
  let sequence = 0;
  scope.withSession = async (callback) => callback({
    server: {
      result: (runId) => (
        runId === 'run-2'
          ? { data: { choice: 'erledigt', note: 'Passt so' } }
          : null
      ),
    },
    browser: {},
  });
  scope.fixtureCases = () => [{
    manifest: { id: '_starter' },
    fixture: 'golden',
    expect: {
      keyboard: [{ press: 'Tab' }],
      result: { choice: 'erledigt', note: 'Passt so' },
    },
  }];
  scope.cancelOpen = async () => {};
  scope.show = async () => ({ run_id: `run-${++sequence}` });
  scope.openPage = async () => ({
    context: { close: async () => {} },
    page: {},
  });
  scope.tabAudit = async () => ({ seen: ['id:starter-note'] });
  scope.waitForTabAuditReady = async () => { events.push('ready'); };
  scope.runStep = async () => { events.push('step'); };

  const result = await scope.keyboardMode();

  assert.equal(result.ok, true);
  assert.deepEqual(events, ['ready', 'step']);
});

for (const [name, page] of [
  [
    'never-settling fonts',
    {
      evaluate: async () => new Promise(() => {}),
      close: async function close() { this.closeCalls += 1; },
      closeCalls: 0,
    },
  ],
  [
    'inventory changing every frame',
    {
      evaluateCalls: 0,
      evaluate: async function evaluate() {
        this.evaluateCalls += 1;
        if (this.evaluateCalls === 1) return undefined;
        return new Promise(() => {});
      },
      waitForFunction: async () => {},
      close: async function close() { this.closeCalls += 1; },
      closeCalls: 0,
    },
  ],
]) {
  test(`keyboard readiness closes the page when ${name} exceeds its deadline`, async () => {
    const scope = sandbox();
    const watchdog = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('test watchdog elapsed')), 250);
    });

    await assert.rejects(
      Promise.race([
        scope.waitForTabAuditReady(page, {
          expectedOpenRuns: 1,
          settleTimeout: 25,
        }),
        watchdog,
      ]),
      /keyboard readiness timed out after 25 ms/u,
    );
    assert.equal(page.closeCalls, 1);
  });
}

test('finding 3: every page fulfils copy by default and C5 can explicitly opt out', async () => {
  const routes = [];
  const page = {
    on() {},
    route: async (pattern) => routes.push(pattern),
    goto: async () => {},
    waitForFunction: async () => {},
  };
  const browser = { newContext: async () => ({ newPage: async () => page }) };
  const scope = {
    PORT: REVIEW_PORT,
    boundedMilliseconds: (name, fallback) => fallback,
    isSameOriginPath,
  };
  vm.createContext(scope);
  vm.runInContext(
    source.slice(source.indexOf('async function openPage('), source.indexOf('async function runStep(')),
    scope,
  );

  await scope.openPage(browser, {}, 'safe-default');
  assert.equal(routes.length, 1);

  routes.length = 0;
  await scope.openPage(browser, {}, 'real-c5', { allowRealCopy: true });
  assert.equal(routes.length, 0);
});

test('round 5 finding 1: safe copy interception catches bare and query URLs before the server', async (t) => {
  const port = REVIEW_PORT;
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const server = await startServer({ port, mediaRoots: [ROOT], env: FIXTURE_CLOCK_ENV });
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(async () => {
    try { await browser.close(); } finally { await server.stop(); }
  });
  const ordinary = [];
  const escapedToBackupGuard = [];
  const guardedBrowser = {
    newContext: async (options) => {
      const context = await browser.newContext(options);
      await context.route(
        (url) => url.origin === `http://127.0.0.1:${port}` && url.pathname === '/copy',
        async (route) => {
          escapedToBackupGuard.push(route.request().url());
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{"ok":true}',
          });
        },
      );
      return context;
    },
  };
  const scope = sandbox({ PORT: port, requestedTemplate: 'decide-list' });
  const testCase = scope.fixtureCases('decide-list', { goldenOnly: true })[0];
  const run = await scope.show(server, testCase);
  const opened = await scope.openPage(guardedBrowser, server, run.run_id, {
    copyHandler: (body) => ordinary.push(body),
  });
  t.after(() => opened.context.close());
  const button = opened.page.locator('[data-copy-id] button').first();

  let response = opened.page.waitForResponse(
    (item) => new URL(item.url()).pathname === '/copy',
  );
  await button.focus();
  await opened.page.keyboard.press('Enter');
  await response;
  assert.equal(ordinary.length, 1);
  assert.deepEqual(escapedToBackupGuard, []);

  await opened.page.evaluate(() => {
    const originalFetch = window.fetch;
    window.fetch = (input, ...args) => originalFetch(
      typeof input === 'string' && input === '/copy' ? '/copy?review=1#ignored' : input,
      ...args,
    );
  });
  response = opened.page.waitForResponse(
    (item) => new URL(item.url()).pathname === '/copy',
  );
  await button.focus();
  await opened.page.keyboard.press('Enter');
  await response;

  assert.equal(ordinary.length, 2, 'ordinary safe handler must intercept query-bearing /copy');
  assert.deepEqual(
    escapedToBackupGuard,
    [],
    'no /copy request may escape to the backup server-write guard',
  );
});

test('finding 6: zero templates and a missing golden expect contract fail', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-e2e-coverage-'));
  try {
    fs.mkdirSync(path.join(scratch, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'tools'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'tools', 'measurement.json'),
      path.join(scratch, 'tools', 'measurement.json'),
    );
    const scope = sandbox({ ROOT: scratch, resolvedTemplates: () => [] });
    assert.throws(() => scope.fixtureCases('--all'), /no registered templates/i);

    const fixtureDir = path.join(scratch, 'templates', 'global', 'missing', 'fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, '..', 'template.json'),
      JSON.stringify({ id: 'missing', namespace: 'global', version: 1, title_de: 'Fehlt' }),
    );
    fs.writeFileSync(path.join(fixtureDir, 'golden.json'), '{}');
    scope.resolvedTemplates = () => [{
      dir: path.join(scratch, 'templates', 'global', 'missing'),
      manifest: {
        id: 'missing',
        namespace: 'global',
        version: 1,
        title_de: 'Fehlt',
      },
    }];
    assert.throws(() => scope.fixtureCases('--all'), /fixtures[/\\]expect[/\\]golden\.json/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('finding 7: empty and one-letter payloads do not admit unrelated English text', async () => {
  const scope = sandbox();
  scope.withSession = async (callback) => callback({ server: {}, browser: {} });
  scope.textMatchers = () => ({ regexes: [], bots: [] });
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'strings' });
  scope.openPage = async () => ({
    context: { close: async () => {} },
    page: { evaluate: async () => ['Click here to delete everything'] },
  });

  for (const data of [{ optional: '' }, { letter: 'e' }]) {
    scope.fixtureCases = () => [{ manifest: { id: 'test' }, fixture: 'golden', data }];
    const result = await scope.stringsMode();
    assert.equal(result.ok, false);
    assert.equal(result.findings[0].text, 'Click here to delete everything');
  }
});

test('finding 8: C14 exercises dark pages and proves CSP on a real copy response', async () => {
  const themes = [];
  const scope = sandbox({
    fetch: async (url, options) => ({
      status: 400,
      headers: new Headers({ 'content-security-policy': "default-src 'self'" }),
      url,
    }),
  });
  const testCase = {
    manifest: { id: 'template-a' },
    fixture: 'golden',
    data: {},
    expect: { copies: {}, flow: [{ press: 'Enter' }], keyboard: [{ press: 'Enter' }], result: {} },
  };
  scope.withSession = async (callback) => callback({
    server: {
      url: (suffix) => `http://127.0.0.1:${REVIEW_PORT}/${suffix}`,
      csrf: async () => 'csrf',
    },
    browser: {},
  });
  scope.fixtureCases = () => [testCase];
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'network' });
  scope.runStep = async () => {};
  scope.openPage = async (browser, server, runId, options = {}) => {
    themes.push(options.colorScheme || 'light');
    return {
      context: { close: async () => {} },
      page: {},
      log: {
        requests: [`http://127.0.0.1:${REVIEW_PORT}/`],
        responses: [{
          url: `http://127.0.0.1:${REVIEW_PORT}/`,
          status: 200,
          headers: { 'content-security-policy': "default-src 'self'" },
          synthetic: false,
        }],
      },
    };
  };

  const result = await scope.networkMode();

  assert.ok(themes.includes('dark'));
  assert.equal(result.real_copy_probe.status, 400);
  assert.equal(result.real_copy_probe.synthetic, false);
  assert.match(result.real_copy_probe.csp, /default-src/);
});

test('finding 9: duplicate controls retain unique tab identities and outlines', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<style>button:focus{outline:2px solid black}</style>' +
    '<button class="same">Eins</button><button class="same">Zwei</button><button class="same">Drei</button>',
  );
  const scope = sandbox();

  const audit = await scope.tabAudit(page);

  assert.equal(audit.expected.length, 3);
  assert.equal(audit.seen.length, 3);
});

test('finding 9: a native radio group requires one tab stop', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<style>input:focus{outline:2px solid black}</style>' +
    '<input type="radio" name="choice" id="r1" checked><input type="radio" name="choice" id="r2">',
  );
  const scope = sandbox();

  const audit = await scope.tabAudit(page);

  assert.equal(audit.expected.length, 1);
  assert.equal(audit.seen.length, 1);
});

test('finding 9: a roving radiogroup must support arrow-key navigation', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<style>button:focus{outline:2px solid black}</style>' +
    '<div role="radiogroup"><button tabindex="0">Eins</button>' +
    '<button tabindex="-1">Zwei</button></div>',
  );
  const scope = sandbox();

  await assert.rejects(scope.tabAudit(page), /ArrowRight.*radiogroup/i);
});

test('round 3 finding 4: a multi-entry toolbar is not collapsed as roving', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>button:focus{outline:2px solid black}</style>
    <div role="toolbar" id="tools">
      <button tabindex="0">One</button>
      <button tabindex="0">Two</button>
      <button tabindex="0">Three</button>
      <button tabindex="0">Four</button>
    </div>
    <script>
      tools.onkeydown = (event) => {
        if (event.key !== 'ArrowRight') return;
        const members = [...tools.querySelectorAll('button')];
        members[(members.indexOf(document.activeElement) + 1) % members.length].focus();
      };
    </script>
  `);

  const audit = await sandbox().tabAudit(page);

  assert.equal(audit.expected.length, 4);
  assert.equal(audit.seen.length, 4);
  assert.deepEqual(audit.groups, []);
});

test('finding 10: keyboard fixture rejects mouse-only steps', async () => {
  const scope = sandbox();
  const testCase = {
    manifest: { id: 'test' },
    fixture: 'golden',
    data: {},
    expect: { keyboard: [{ click: '#submit' }], result: {} },
  };
  scope.withSession = async (callback) => callback({
    server: { result: () => ({ data: {} }) },
    browser: {},
  });
  scope.fixtureCases = () => [testCase];
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'keyboard' });
  scope.tabAudit = async () => ({ expected: [], seen: [] });
  scope.openPage = async () => ({
    context: { close: async () => {} },
    page: { click: async () => {}, keyboard: { press: async () => {} } },
  });

  await assert.rejects(scope.keyboardMode(), /keyboard.*click/i);
});

test('finding 13: submit timing starts at browser event dispatch, after action preparation', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-submit-timing-'));
  try {
    fs.mkdirSync(path.join(scratch, 'results'));
    fs.writeFileSync(path.join(scratch, 'results', 'timed.json'), '{}');
    let dispatchEpoch = null;
    const page = {
      click: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        dispatchEpoch = Date.now();
      },
      locator: () => ({
        waitFor: async () => {},
        scrollIntoViewIfNeeded: async () => {},
        click: async ({ trial } = {}) => {
          if (trial) await new Promise((resolve) => setTimeout(resolve, 25));
          else dispatchEpoch = Date.now();
        },
      }),
      evaluate: async (expression, argument) => {
        if (argument?.kind === 'install') return null;
        return dispatchEpoch;
      },
      keyboard: { press: async () => { dispatchEpoch = Date.now(); } },
    };
    const scope = sandbox();
    scope.withSession = async (callback) => callback({
      server: { dataDir: scratch },
      browser: {},
    });
    scope.fixtureCases = () => [{
      manifest: { id: 'test' },
      fixture: 'golden',
      data: {},
      expect: { flow: [{ click: '#submit' }], result: {} },
    }];
    scope.cancelOpen = async () => {};
    scope.show = () => ({ run_id: 'timed' });
    scope.openPage = async () => ({ context: { close: async () => {} }, page });
    scope.validateObservedResult = () => {};

    const result = await scope.submitMode();

    assert.ok(result.cases.every((item) => item.ms < 15), JSON.stringify(result.cases));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('finding 15: browser launch failure still stops the isolated server', async () => {
  let stopped = 0;
  const scope = {
    browserChannel,
    boundedMilliseconds: (name, fallback) => fallback,
    loadChromium: async () => ({ launch: async () => { throw new Error('Edge launch failed'); } }),
    startServer: async () => ({ stop: async () => { stopped += 1; } }),
    PORT: REVIEW_PORT,
    ROOT,
    TIME_BASELINE: { default: { clockAnchor: FIXTURE_CLOCK_ENV.RS_CLOCK_ANCHOR } },
  };
  vm.createContext(scope);
  vm.runInContext(
    source.slice(source.indexOf('async function withSession('), source.indexOf('async function openPage(')),
    scope,
  );

  await assert.rejects(scope.withSession(async () => {}), /Edge launch failed/);
  assert.equal(stopped, 1);
});

test('fixture clock anchor keeps baseline open and open assertion rejects an expired baseline', async (t) => {
  const tools = await import('../tools/dev/rs-server.mjs');
  const golden = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'templates/builtin/_starter/fixtures/golden.json'),
    'utf8',
  ));
  const created = '2026-10-08T10:39:00Z';
  const showBaseline = (server) => server.show(golden, {
    title: 'Fixture clock regression',
    created,
    expires_minutes: 240,
  });

  const openServer = await startServer({
    port: REVIEW_PORT,
    env: { RS_CLOCK_ANCHOR: '2026-10-08T10:40:00Z' },
  });
  t.after(() => openServer.stop());
  const openRun = showBaseline(openServer);
  const detail = await tools.assertRunOpen(openServer, openRun.run_id, 'clock regression');
  assert.equal(detail.state, 'open');

  const expiredServer = await startServer({
    port: REVIEW_AUX_PORT,
    env: { RS_CLOCK_ANCHOR: '2026-10-08T15:39:00Z' },
  });
  t.after(() => expiredServer.stop());
  const expiredRun = showBaseline(expiredServer);
  const deadline = Date.now() + 5000;
  while (!expiredServer.result(expiredRun.run_id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await assert.rejects(
    tools.assertRunOpen(expiredServer, expiredRun.run_id, 'clock regression'),
    /clock regression: expected run .* to be open, got expired/u,
  );
});

test('round 3 finding 2: every runner fixture is asserted open after registration', async () => {
  const calls = [];
  const scope = sandbox();
  const server = {
    show(data, envelope) {
      calls.push({ kind: 'show', data, envelope });
      return { run_id: 'open-fixture' };
    },
    async assertOpen(runId, context) {
      calls.push({ kind: 'assert', runId, context });
    },
  };
  const testCase = {
    dir: 'C:\\templates\\sample',
    fixture: 'golden',
    manifest: {
      id: 'sample',
      version: 1,
      namespace: 'global',
      title_de: 'Sample',
    },
    data: { media: '%RS_TEMPLATE%/media/hero.png' },
  };

  const run = await scope.show(server, testCase);

  assert.equal(run.run_id, 'open-fixture');
  assert.equal(calls[0].data.media, 'C:\\templates\\sample/media/hero.png');
  assert.deepEqual(
    calls.filter((call) => call.kind === 'assert'),
    [{
      kind: 'assert',
      runId: 'open-fixture',
      context: 'sample/golden',
    }],
  );
});

test('round 2 finding 1: expect awaits a 150 ms route and detects mismatching bodies', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const scope = sandbox();
  const testCase = {
    manifest: { id: 'test' },
    fixture: 'golden',
    data: {},
    expect: { copies: { first: 'expected text' }, counters: {} },
  };
  scope.withSession = async (callback) => callback({ server: {}, browser });
  scope.fixtureCases = () => [testCase];
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'expect' });
  let actual = 'expected text';
  scope.openPage = async (openedBrowser) => {
    const context = await openedBrowser.newContext();
    const page = await context.newPage();
    await page.route(REVIEW_FAKE_ORIGIN + '/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/copy') {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"ok":true}',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<div data-copy-id="first"><button class="rs-copy__btn">Copy</button></div>
          <script>document.querySelector('button').onclick = () => fetch('/copy', {
            method: 'POST',
            body: ${JSON.stringify(JSON.stringify({ run_id: 'expect', text: actual }))},
          })</script>`,
      });
    });
    await page.goto(REVIEW_FAKE_ORIGIN + '/');
    return { context, page };
  };

  const started = Date.now();
  const delayed = await scope.expectMode();
  assert.equal(delayed.ok, true);
  assert.ok(Date.now() - started >= 140);

  actual = 'wrong text';
  const mismatched = await scope.expectMode();
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.findings[0].actual, 'wrong text');
});

test('round 2 finding 2: network accepts copy-only edge expects and rejects malformed supplied steps', async () => {
  const scope = sandbox({
    fetch: async (url) => ({
      status: 400,
      headers: new Headers({ 'content-security-policy': "default-src 'self'" }),
      url,
    }),
  });
  const edge = {
    manifest: { id: 'test' },
    fixture: 'edge-copy-only',
    data: {},
    expect: { copies: {} },
  };
  scope.withSession = async (callback) => callback({
    server: {
      url: (suffix) => `http://127.0.0.1:${REVIEW_PORT}/${suffix}`,
      csrf: async () => 'csrf',
    },
    browser: {},
  });
  scope.fixtureCases = () => [edge];
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'network' });
  scope.openPage = async () => ({
    context: { close: async () => {} },
    page: {},
    log: {
      requests: [`http://127.0.0.1:${REVIEW_PORT}/`],
      responses: [{
        url: `http://127.0.0.1:${REVIEW_PORT}/`,
        status: 200,
        headers: { 'content-security-policy': "default-src 'self'" },
        synthetic: false,
      }],
      errors: [],
    },
  });

  assert.equal((await scope.networkMode()).ok, true);

  edge.expect.flow = { press: 'Enter' };
  await assert.rejects(
    scope.networkMode(),
    /edge-copy-only.*flow.*array/i,
  );
});

test('round 2 finding 6: strings admits each exact fixture envelope title', async () => {
  const scope = sandbox();
  scope.withSession = async (callback) => callback({ server: {}, browser: {} });
  scope.textMatchers = () => ({ regexes: [], bots: [] });
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'strings' });
  scope.openPage = async () => ({
    context: { close: async () => {} },
    page: { evaluate: async () => [scope.currentTitle] },
  });
  const cases = [
    {
      manifest: {
        id: 'decide-list',
        namespace: 'global',
        version: 1,
        title_de: 'List decisions',
      },
      fixture: 'golden',
      data: {},
    },
    {
      manifest: {
        id: 'distinct',
        namespace: 'global',
        version: 1,
        title_de: 'Eigenständiger Umschlagtitel',
      },
      fixture: 'golden',
      data: {},
    },
  ];

  for (const testCase of cases) {
    scope.currentTitle = testCase.manifest.title_de;
    scope.fixtureCases = () => [testCase];
    const result = await scope.stringsMode();
    assert.equal(result.ok, true, JSON.stringify(result.findings));
  }
});

test('round 3 finding 1: every arrow-focused native radio has a visible outline and wrap is covered', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<style>input:focus{outline:2px solid black}#r2:focus{outline:none}</style>' +
    '<input type="radio" name="choice" id="r1" checked>' +
    '<input type="radio" name="choice" id="r2">' +
    '<input type="radio" name="choice" id="r3">',
  );

  await assert.rejects(
    sandbox().tabAudit(page),
    /missing focus outline.*r2|missing focus outline.*control-1/i,
  );
});

test('decide-list choice arrows are audited beyond the Tab-entry button', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const server = await startServer({ port: REVIEW_PORT });
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(async () => {
    try { await browser.close(); } finally { await server.stop(); }
  });
  const fixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'templates', 'builtin', 'decide-list', 'fixtures', 'golden.json'),
    'utf8',
  ));
  const run = server.show(fixture, {
    template: 'decide-list',
    bot: 'example-inbox-bot',
    title: 'Outline-Prüfung',
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(() => context.close());
  await page.route(`http://127.0.0.1:${REVIEW_PORT}/copy`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"ok":true}',
  }));
  await page.goto(server.url(`?run=${run.run_id}&client=test`));
  await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
  await page.addStyleTag({
    content: 'rs-action-row button:nth-child(2):focus{outline-style:none!important}',
  });

  await assert.rejects(
    sandbox().tabAudit(page),
    /missing focus outline/i,
  );
});

test('round 3 finding 1: keyboard flow actions check newly focused controls', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(() => context.close());
  await page.setContent(
    '<style>input:focus{outline:2px solid black}#r2:focus{outline:none}</style>' +
    '<input type="radio" name="choice" id="r1" checked>' +
    '<input type="radio" name="choice" id="r2">',
  );
  await page.focus('#r1');
  const scope = sandbox();
  scope.withSession = async (callback) => callback({
    server: { result: () => ({ data: {} }) },
    browser,
  });
  scope.fixtureCases = () => [{
    manifest: { id: 'test' },
    fixture: 'golden',
    data: {},
    expect: { keyboard: [{ press: 'ArrowRight' }], result: {} },
  }];
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'keyboard-outline' });
  scope.tabAudit = async () => ({ expected: [], seen: [] });
  scope.waitForTabAuditReady = async () => {};
  scope.openPage = async () => ({ context: { close: async () => {} }, page });

  await assert.rejects(
    scope.keyboardMode(),
    /missing focus outline/i,
  );
});

test('round 3 finding 2: strings accepts only the fixture exact rendered date', async () => {
  const scope = sandbox();
  scope.withSession = async (callback) => callback({ server: {}, browser: {} });
  scope.textMatchers = () => ({ regexes: [], bots: [] });
  scope.cancelOpen = async () => {};
  scope.show = () => ({ run_id: 'strings-time' });
  scope.fixtureCases = () => [{
    manifest: {
      id: 'test',
      namespace: 'global',
      version: 1,
      title_de: 'Zeitprüfung',
    },
    fixture: 'golden',
    data: {},
  }];
  scope.currentText = 'Erstellt Do 08.10.2026 · 12:39';
  scope.openPage = async () => ({
    context: { close: async () => {} },
    page: {
      evaluate: async () => [{
        text: scope.currentText,
        created_metadata: true,
      }],
    },
  });

  assert.equal((await scope.stringsMode()).ok, true);
  scope.currentText = 'Erstellt Mo 01.01.1900 · 00:00';
  const wrong = await scope.stringsMode();
  assert.equal(wrong.ok, false);
  assert.equal(wrong.findings[0].text, scope.currentText);
});

test('round 3 finding 2: C15 measures rendered and persisted time conversion around both DST boundaries', () => {
  const result = spawnSync(
    'node',
    [path.join(ROOT, 'tools', 'e2e.mjs'), 'time'],
    {
      cwd: ROOT,
      env: { ...process.env, RS_TOOL_PORT: String(REVIEW_PORT) },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const body = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(body.ok, true, JSON.stringify(body.findings));
  assert.equal(body.total, 6);
  assert.deepEqual(
    body.cases.map((item) => [
      item.name,
      item.created_offset,
    ]),
    [
      ['z-winter', '+01:00'],
      ['plus-one-summer', '+02:00'],
      ['march-before', '+01:00'],
      ['march-after', '+02:00'],
      ['october-before', '+02:00'],
      ['october-after', '+01:00'],
    ],
  );
  assert.match(body.cases[2].display, /01:59$/u);
  assert.match(body.cases[3].display, /03:00$/u);
  assert.match(body.cases[4].display, /02:59$/u);
  assert.match(body.cases[5].display, /02:00$/u);
  assert.ok(body.cases.every((item) => (
    item.decided_offset === item.expected_decided_offset &&
    ['+01:00', '+02:00'].includes(item.expected_decided_offset)
  )));
});

test('round 4 finding 3: strings audits visible aria-hidden text but ignores visually hidden text', async (t) => {
  const port = REVIEW_PORT;
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const server = await startServer({ port, env: FIXTURE_CLOCK_ENV });
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(async () => {
    try { await browser.close(); } finally { await server.stop(); }
  });

  async function audit(style) {
    const scope = sandbox({ PORT: port, requestedTemplate: 'decide-list' });
    scope.withSession = async (callback) => callback({ server, browser });
    const openPage = scope.openPage;
    scope.openPage = async (...args) => {
      const opened = await openPage(...args);
      await opened.page.evaluate((injectedStyle) => {
        const node = document.createElement('div');
        node.id = 'round-4-visible-text';
        node.setAttribute('aria-hidden', 'true');
        node.setAttribute('style', injectedStyle);
        node.textContent = 'Click here to delete everything';
        document.body.append(node);
      }, style);
      return opened;
    };
    return scope.stringsMode();
  }

  const visible = await audit('');
  assert.equal(visible.ok, false);
  assert.ok(visible.findings.some((item) => item.text === 'Click here to delete everything'));

  const visuallyHidden = await audit('display:none');
  assert.equal(visuallyHidden.ok, true, JSON.stringify(visuallyHidden.findings));
});

test('round 5 finding 2: strings uses text geometry for display contents and excludes display none', async (t) => {
  const port = REVIEW_PORT;
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const server = await startServer({ port, env: FIXTURE_CLOCK_ENV });
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(async () => {
    try { await browser.close(); } finally { await server.stop(); }
  });

  async function audit({ nodeStyle = '', hostStyle = '' }) {
    const scope = sandbox({ PORT: port, requestedTemplate: 'decide-list' });
    const cases = scope.fixtureCases('decide-list', { goldenOnly: true });
    scope.fixtureCases = () => cases;
    scope.withSession = async (callback) => callback({ server, browser });
    const openPage = scope.openPage;
    let geometry;
    scope.openPage = async (...args) => {
      const opened = await openPage(...args);
      geometry = await opened.page.evaluate((styles) => {
        const host = document.createElement('div');
        host.style.cssText = [
          'position:fixed',
          'top:0',
          'left:0',
          'z-index:100000',
          'background:white',
          'color:black',
          'font-size:24px',
          styles.hostStyle,
        ].join(';');
        const node = document.createElement('span');
        node.style.cssText = styles.nodeStyle;
        node.textContent = 'Click here to delete everything';
        host.append(node);
        document.body.append(host);
        const range = document.createRange();
        range.selectNodeContents(node);
        return {
          element_rects: node.getClientRects().length,
          text_rects: [...range.getClientRects()].map((rect) => ({
            width: rect.width,
            height: rect.height,
          })),
        };
      }, { nodeStyle, hostStyle });
      return opened;
    };
    const result = await scope.stringsMode();
    return { geometry, result };
  }

  const displayed = await audit({ nodeStyle: 'display:contents' });
  assert.equal(displayed.geometry.element_rects, 0);
  assert.ok(displayed.geometry.text_rects.some(
    (rect) => rect.width > 0 && rect.height > 0,
  ));
  assert.equal(displayed.result.ok, false, JSON.stringify(displayed));
  assert.ok(displayed.result.findings.some(
    (item) => item.text === 'Click here to delete everything',
  ));

  const hidden = await audit({ nodeStyle: 'display:none' });
  assert.equal(hidden.geometry.text_rects.length, 0);
  assert.equal(hidden.result.ok, true, JSON.stringify(hidden));

  for (const control of [
    { name: 'visibility', nodeStyle: 'visibility:hidden' },
    { name: 'opacity ancestor', hostStyle: 'opacity:0' },
    {
      name: 'clipped zero-size ancestor',
      hostStyle: 'width:0;height:0;overflow:hidden;white-space:nowrap',
    },
    {
      name: 'legacy clipped ancestor',
      hostStyle: 'position:absolute;clip:rect(0,0,0,0)',
    },
  ]) {
    const visuallyHidden = await audit(control);
    assert.ok(
      visuallyHidden.geometry.text_rects.some((rect) => rect.width > 0 && rect.height > 0),
      `${control.name} control must have text geometry`,
    );
    assert.equal(
      visuallyHidden.result.ok,
      true,
      `${control.name}: ${JSON.stringify(visuallyHidden)}`,
    );
  }
});

test('round 4 finding 4: date-shaped payload text is not mistaken for envelope metadata', async (t) => {
  const port = REVIEW_PORT;
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const server = await startServer({ port, env: FIXTURE_CLOCK_ENV });
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(async () => {
    try { await browser.close(); } finally { await server.stop(); }
  });
  const scope = sandbox({ PORT: port, requestedTemplate: 'decide-list' });
  const cases = scope.fixtureCases('decide-list', { goldenOnly: true });
  cases[0].data.items[0].title = 'Mo 01.01.1900 · 00:00';
  scope.fixtureCases = () => cases;
  scope.withSession = async (callback) => callback({ server, browser });

  const result = await scope.stringsMode();

  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test('round 4 finding 5: time rejects missing and empty decided timestamps', async () => {
  for (const decided of [undefined, '']) {
    let index = 0;
    const scope = sandbox({
      fetch: async () => ({ status: 200 }),
    });
    const baseline = vm.runInContext('TIME_BASELINE', scope);
    const testCase = {
      manifest: {
        id: '_starter',
        namespace: 'global',
        version: 1,
        title_de: 'Starter',
      },
      fixture: 'golden',
      data: {},
      expect: { result: {} },
    };
    scope.withSession = async (callback) => callback({
      server: {
        csrf: async () => 'csrf',
        url: (suffix) => `http://127.0.0.1:${REVIEW_PORT}/${suffix}`,
        show: () => ({ run_id: `time-${index++}` }),
        assertOpen: async () => ({ state: 'open' }),
        result: (runId) => {
          const expected = baseline.cases[Number(runId.split('-').at(-1))];
          return {
            schema: 'report-shell/result@1',
            run_id: runId,
            template: '_starter',
            template_version: 1,
            bot: 'report-shell-test',
            status: 'submitted',
            created: expected.persisted_created,
            decided,
            duration_s: 0,
            log: 'test.jsonl',
            data: {},
          };
        },
      },
      browser: {},
    });
    scope.fixtureCases = () => [testCase];
    scope.cancelOpen = async () => {};
    scope.openPage = async (browser, server, runId) => {
      const expected = baseline.cases[Number(runId.split('-').at(-1))];
      return {
        context: { close: async () => {} },
        page: { textContent: async () => `Erstellt ${expected.display}` },
      };
    };

    const result = await scope.timeMode();

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((item) => item.field === 'decided'));
  }
});

test('round 4 finding 6: C10 stop time includes per-case schema and equality validation', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-submit-validation-timing-'));
  try {
    fs.mkdirSync(path.join(scratch, 'results'));
    let run = 0;
    let validation = 0;
    const page = {
      locator: () => ({
        waitFor: async () => {},
        scrollIntoViewIfNeeded: async () => {},
        click: async () => { page.dispatched = Date.now(); },
      }),
      evaluate: async (expression, argument) => (
        argument?.kind === 'install' ? null : page.dispatched
      ),
      keyboard: { press: async () => { page.dispatched = Date.now(); } },
    };
    const scope = sandbox();
    scope.withSession = async (callback) => callback({
      server: { dataDir: scratch },
      browser: {},
    });
    scope.fixtureCases = () => [{
      manifest: { id: '_starter' },
      fixture: 'golden',
      data: {},
      expect: { flow: [{ click: '#submit' }], result: {} },
    }];
    scope.cancelOpen = async () => {};
    scope.show = () => {
      const runId = `validation-${run++}`;
      fs.writeFileSync(
        path.join(scratch, 'results', `${runId}.json`),
        JSON.stringify({ data: {} }),
      );
      return { run_id: runId };
    };
    scope.openPage = async () => ({ context: { close: async () => {} }, page });
    scope.validateObservedResult = () => {
      if (validation++ === 0) {
        const deadline = Date.now() + 600;
        while (Date.now() < deadline) {
          // Deliberately simulate one slow schema/equality validation.
        }
      }
    };

    const result = await scope.submitMode();

    assert.ok(result.cases[0].ms >= 600, JSON.stringify(result.cases[0]));
    assert.ok(result.cases.every((item) => item.validation_ok === true));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('flake 8: time mode is repeatable back to back and under parallel load', async () => {
  const scope = sandbox();
  const baseline = vm.runInContext('TIME_BASELINE', scope);
  assert.ok(
    baseline.cases.every((item) => Date.parse(item.created) > Date.now()),
    'time fixtures must not race server expiry maintenance',
  );

  const runTime = (port) => new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [path.join(ROOT, 'tools', 'e2e.mjs'), 'time'],
      {
        cwd: ROOT,
        env: { ...process.env, RS_TOOL_PORT: String(port) },
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) {
        reject(new Error(stderr || stdout || `time mode exited ${status}`));
        return;
      }
      const body = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
      if (!body.ok || body.passed !== body.total) {
        reject(new Error(JSON.stringify(body)));
        return;
      }
      resolve(body);
    });
  });

  await runTime(REVIEW_PORT);
  await runTime(REVIEW_PORT);
  const parallel = await Promise.all(REVIEW_PARALLEL_PORTS.map(runTime));
  assert.ok(parallel.every((result) => result.total === 6));
});

test('round 3 finding 4: generic envelopes are neutral while real templates keep manifest ownership', () => {
  const scope = sandbox();

  assert.equal(scope.registrationEnvelope({
    manifest: {
      id: '_starter',
      namespace: 'global',
      version: 1,
      title_de: 'Starter',
    },
  }).bot, 'report-shell-test');
  assert.equal(scope.registrationEnvelope({
    manifest: {
      id: 'owned-template',
      namespace: 'acme-report-bot',
      version: 1,
      title_de: 'Eigene Vorlage',
    },
  }).bot, 'acme-report-bot');
});

test('counter cases use the resolved user template id', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-counter-registry-'));
  try {
    const template = path.join(scratch, 'templates', 'preview-post');
    fs.cpSync(
      path.join(ROOT, 'templates', 'builtin', 'preview-post'),
      template,
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(template, 'fixtures', 'expect', 'counter-cases.json'),
      JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
        name: `case-${index + 1}`,
        platform: 'linkedin',
        text: 'abc',
        count: 3,
        over: false,
      }))),
    );

    const result = spawnSync(
      'node',
      [path.join(ROOT, 'tools', 'counter_test.mjs')],
      {
        cwd: ROOT,
        env: { ...process.env, RS_DATA_DIR: scratch },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout.trim());
    assert.equal(body.ok, true);
    assert.equal(body.total, 30);
    assert.match(body.template_dir, /templates[\\/]preview-post$/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('fixture media paths resolve against the registered template directory', () => {
  const scope = sandbox();
  const payload = {
    image: '%RS_TEMPLATE%/media/hero.png',
    nested: ['%RS_TEMPLATE%/media/other.png'],
  };
  const resolved = scope.resolveTemplatePaths(payload, 'C:\\repo\\templates\\example');

  assert.equal(resolved.image, 'C:\\repo\\templates\\example/media/hero.png');
  assert.equal(resolved.nested[0], 'C:\\repo\\templates\\example/media/other.png');
  assert.equal(payload.image, '%RS_TEMPLATE%/media/hero.png');
});

test('reveal opens lazy tabs and collapsed details before copy and counter lookup', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="tab" aria-selected="false" id="lazy">Lazy</button>
    <div id="mount"></div>
    <details id="collapsed"><summary>More</summary><div data-counter-id="inside"></div></details>
    <script>
      lazy.onclick = () => {
        lazy.setAttribute('aria-selected', 'true');
        mount.innerHTML = '<span data-copy-id="late"><button>Copy</button></span>';
      };
    </script>
  `);
  const scope = sandbox();

  await scope.reveal(page, '[data-copy-id="late"] button');
  assert.ok(await page.$('[data-copy-id="late"] button'));
  await scope.reveal(page, '[data-counter-id="inside"]');
  assert.equal(await page.$eval('#collapsed', (element) => element.open), true);
});

test('round 3 finding 7: calm reveal audits copies created for every reachable tab', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>button:focus{outline:2px solid black}</style>
    <div role="tablist">
      <button role="tab" aria-selected="true" data-copy="first">First</button>
      <button role="tab" aria-selected="false" data-copy="second">Second</button>
    </div>
    <div id="mount"></div>
    <script>
      const render = (id) => {
        document.querySelector('#mount').innerHTML =
          '<span data-copy-id="' + id + '"><button aria-label="Copy ' + id + '">Copy</button></span>';
      };
      document.querySelectorAll('[role=tab]').forEach((tab) => {
        tab.onclick = () => {
          document.querySelectorAll('[role=tab]').forEach((peer) => {
            peer.setAttribute('aria-selected', String(peer === tab));
          });
          render(tab.dataset.copy);
        };
      });
      render('first');
    </script>
  `);
  const scope = sandbox();

  const audit = await auditCopyFocus(
    page,
    (visit) => scope.reveal(
      page,
      'rs-copy button,[data-copy-id] button,button[data-copy-id],[data-rs-copy]',
      { all: true, visit },
    ),
  );

  assert.equal(audit.pass, true, JSON.stringify(audit));
  assert.equal(audit.controls.length, 2);
});

test('round 4 finding 4: retained inactive tabpanel copies are required only when active', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>button:focus{outline:2px solid black}</style>
    <div role="tablist">
      <button role="tab" aria-selected="true" aria-controls="first-panel">First</button>
      <button role="tab" aria-selected="false" aria-controls="second-panel">Second</button>
    </div>
    <section role="tabpanel" id="first-panel">
      <span data-copy-id="first"><button aria-label="Copy first">Copy</button></span>
    </section>
    <section role="tabpanel" id="second-panel" hidden>
      <span data-copy-id="second"><button aria-label="Copy second">Copy</button></span>
    </section>
    <script>
      document.querySelectorAll('[role=tab]').forEach((tab) => {
        tab.onclick = () => {
          document.querySelectorAll('[role=tab]').forEach((peer) => {
            const selected = peer === tab;
            peer.setAttribute('aria-selected', String(selected));
            document.getElementById(peer.getAttribute('aria-controls')).hidden = !selected;
          });
        };
      });
    </script>
  `);
  const scope = sandbox();

  const audit = await auditCopyFocus(
    page,
    (visit) => scope.reveal(
      page,
      'rs-copy button,[data-copy-id] button,button[data-copy-id],[data-rs-copy]',
      { all: true, visit },
    ),
  );

  assert.equal(audit.pass, true, JSON.stringify(audit));
  assert.equal(audit.controls.length, 2);
});

test('round 4 finding 5: calm reveal reaches nested and native lazy disclosures', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());

  for (const html of [
    `
      <style>button:focus{outline:2px solid black}.invisible{opacity:0}</style>
      <button id="outer" aria-expanded="false">Details</button>
      <div id="mount"></div>
      <script>
        outer.onclick = () => {
          outer.setAttribute('aria-expanded', 'true');
          mount.innerHTML = '<button id="inner" aria-expanded="false">Reference</button><div id="nested"></div>';
          inner.onclick = () => {
            inner.setAttribute('aria-expanded', 'true');
            nested.innerHTML = '<span data-copy-id="nested"><button class="invisible" aria-label="Copy nested">Copy</button></span>';
          };
        };
      </script>
    `,
    `
      <style>button:focus{outline:2px solid black}.invisible{opacity:0}</style>
      <details id="lazy-details"><summary>Reference</summary><div id="mount"></div></details>
      <script>
        document.querySelector('summary').onclick = () => {
          mount.innerHTML = '<span data-copy-id="summary"><button class="invisible" aria-label="Copy summary">Copy</button></span>';
        };
      </script>
    `,
  ]) {
    const page = await browser.newPage();
    await page.setContent(html);
    const scope = sandbox();
    const audit = await auditCopyFocus(
      page,
      (visit) => scope.reveal(
        page,
        'rs-copy button,[data-copy-id] button,button[data-copy-id],[data-rs-copy]',
        { all: true, visit },
      ),
    );
    assert.equal(audit.pass, false, JSON.stringify(audit));
    assert.equal(audit.controls.length, 1, JSON.stringify(audit));
    await page.close();
  }
});

test('round 5 finding 1: calmScene catches copies created by native details toggle handlers', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const rows = [];

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1500, height: 1000 },
  ]) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const context = await browser.newContext({
        viewport,
        reducedMotion: 'no-preference',
      });
      const page = await context.newPage();
      try {
        const html = calmPage()
          .replace('<html>', '<html lang="de">')
          .replace('<head>', '<head><title>Calm scene</title>')
          .replace(
            '<button data-copy-id="item-copy" class="copy" aria-label="Copy item">C</button>',
            '',
          )
          .replace('aria-selected="false"', 'aria-selected="true"')
          .replace(
            '</main>',
            `<details id="toggle-lazy">
              <summary tabindex="0">Reference</summary>
              <div id="toggle-lazy-mount"></div>
            </details></main>`,
          )
          .replace(
            '</body>',
            `<script>
              document.getElementById('toggle-lazy').addEventListener('toggle', (event) => {
                if (!event.currentTarget.open) return;
                document.getElementById('toggle-lazy-mount').innerHTML =
                  '<button data-rs-copy aria-label="Copy reference" style="opacity:0">C</button>';
              });
            </script></body>`,
          );
        await page.setContent(html);
        await page.evaluate(() => {
          const rail = document.querySelector('.rail');
          rail.setAttribute('data-rs-rail', '');
          const readyEntry = document.createElement('i');
          readyEntry.className = 'rs-rail__run';
          readyEntry.hidden = true;
          rail.append(readyEntry);
        });
        const scope = sandbox({
          CALM_THRESHOLDS,
          auditCopyFocus,
          calmEvaluator,
          pngBackgroundRatio,
        });
        scope.cancelOpen = async () => {};
        scope.show = () => ({ run_id: `toggle-${viewport.width}-${attempt}` });
        scope.openPage = async () => ({
          page,
          context: { close: async () => {} },
        });

        const facts = await scope.calmScene(
          {},
          {},
          { fixture: 'golden', manifest: { id: 'decide-list' } },
          { openRuns: 1, theme: 'light', viewport },
        );
        rows.push({
          viewport: `${viewport.width}x${viewport.height}`,
          attempt,
          copyFocus: facts.K13.copy_focus,
        });
        assert.equal(
          facts.K13.copy_focus.pass,
          false,
          JSON.stringify(rows.at(-1)),
        );
        assert.ok(
          facts.K13.copy_focus.controls.some(
            (control) => control.identity === 'Copy reference' && !control.visible,
          ),
          JSON.stringify(rows.at(-1)),
        );
      } finally {
        await context.close();
      }
    }
  }

  assert.equal(rows.length, 12);
  assert.deepEqual(
    Object.fromEntries(
      ['1280x720', '1500x1000'].map((viewport) => [
        viewport,
        rows.filter((row) => row.viewport === viewport).length,
      ]),
    ),
    { '1280x720': 6, '1500x1000': 6 },
  );
  t.diagnostic('native toggle K13 negatives: 6/6 at 1280x720, 6/6 at 1500x1000');
});

async function assertAnimationSettleFailsWithinCap(operation) {
  const started = Date.now();
  const outcome = await Promise.race([
    Promise.resolve().then(operation).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => setTimeout(
      () => resolve({ externalTimeout: true }),
      6000,
    )),
  ]);
  assert.equal(outcome.externalTimeout, undefined, 'audit exceeded the external 6 s test guard');
  assert.ok(outcome.error, `audit unexpectedly passed: ${JSON.stringify(outcome.value)}`);
  assert.match(String(outcome.error), /animation settling exceeded 5000ms/i);
  assert.ok(Date.now() - started < 6000, `audit took ${Date.now() - started} ms`);
}

async function frozenAnimationPage(browser, { focusOnly = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  await page.setContent(`
    <style>button:focus{outline:2px solid black}</style>
    <button data-copy-id="frozen" aria-label="Frozen copy">Copy</button>
    <script>
      const startFrozenAnimation = () => {
        if (window.frozenAnimation) return;
        window.frozenAnimation = document.querySelector('button').animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(1px)' }],
          { duration: 150 },
        );
        window.frozenAnimation.playbackRate = 0;
      };
      if (${focusOnly}) document.querySelector('button').addEventListener('focus', startFrozenAnimation);
      else startFrozenAnimation();
      window.setTimeout = () => 0;
    </script>
  `);
  return { context, page };
}

test('introduced finding 1: template timers cannot defeat any animation settle deadline', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());

  {
    const { context, page } = await frozenAnimationPage(browser);
    try {
      await assertAnimationSettleFailsWithinCap(() => auditCopyFocus(page));
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await frozenAnimationPage(browser);
    try {
      await assertAnimationSettleFailsWithinCap(() => sandbox().tabAudit(page));
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await frozenAnimationPage(browser, { focusOnly: false });
    try {
      const scope = sandbox({ calmEvaluator });
      vm.runInContext(
        source.slice(
          source.indexOf('async function calmRestingFacts('),
          source.indexOf('const IDENTITY_FOREIGN = ['),
        ),
        scope,
      );
      await assertAnimationSettleFailsWithinCap(() => scope.calmRestingFacts(
        page,
        { manifest: { id: 'decide-list' } },
        1,
        [],
        true,
      ));
    } finally {
      await context.close();
    }
  }
});

test('introduced finding 2: short waits preserve a simultaneous long focus fade failure', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  for (const delay of ['0ms', '-900ms']) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      reducedMotion: 'no-preference',
    });
    try {
      const page = await context.newPage();
      await page.setContent(`
        <style>
          button { opacity: 0 }
          button:focus {
            opacity: 1;
            outline: 2px solid black;
            transition: opacity 1000ms steps(1, end) ${delay};
          }
        </style>
        <button data-copy-id="slow-fade" aria-label="Slow fade copy">Copy</button>
        <script>
          document.querySelector('button').addEventListener('focus', () => {
            const short = document.querySelector('button').animate(
              [{ transform: 'translateX(0)' }, { transform: 'translateX(1px)' }],
              { duration: 150 },
            );
            short.playbackRate = 0;
          });
        </script>
      `);

      const started = Date.now();
      const audit = await auditCopyFocus(page);

      assert.equal(audit.pass, false, `${delay}: ${JSON.stringify(audit)}`);
      assert.equal(audit.controls.length, 1, `${delay}: ${JSON.stringify(audit)}`);
      assert.equal(audit.controls[0].visible, false, `${delay}: ${JSON.stringify(audit)}`);
      assert.equal(audit.controls[0].motion_blocked, true, `${delay}: ${JSON.stringify(audit)}`);
      assert.ok(Date.now() - started < 500, `${delay} focus audit took ${Date.now() - started} ms`);
    } finally {
      await context.close();
    }
  }
});

async function runCalmFadeScene(browser, playbackRate = 1) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    reducedMotion: 'no-preference',
  });
  try {
    const page = await context.newPage();
    if (playbackRate !== 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Animation.enable');
      await cdp.send('Animation.setPlaybackRate', { playbackRate });
    }
    await page.setContent(
      calmPage()
        .replace('<html>', '<html lang="de">')
        .replace('<head>', '<head><title>Calm scene</title>'),
    );
    const scope = {
      AXE: path.join(ROOT, 'vendor', 'axe.min.js'),
      CALM_THRESHOLDS,
      auditCopyFocus,
      auditPlatformSwitching: async () => null,
      isSocialPreview,
      calmEvaluator,
      closeAuditContext: async (contextToClose) => contextToClose.close(),
      pngBackgroundRatio,
      cancelOpen: async () => {},
      reveal: async () => {},
      show: () => ({ run_id: 'resting' }),
      settleShortAnimations,
      openPage: async () => ({ page, context: { close: async () => {} } }),
      tabAudit: async () => {
        await page.evaluate(() => {
          document.body.tabIndex = -1;
          document.body.focus();
        });
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => (
          Number.parseFloat(getComputedStyle(
            document.querySelector('[data-copy-id="item-copy"]'),
          ).opacity) > 0.95
        ));
        await page.evaluate(() => {
          document.activeElement?.blur();
          document.body.removeAttribute('tabindex');
        });
        return { groups: [] };
      },
    };
    vm.createContext(scope);
    vm.runInContext(
      source.slice(
        source.indexOf('async function calmRestingFacts('),
        source.indexOf('async function calmMode('),
      ),
      scope,
    );
    return await scope.calmScene(
      {},
      {},
      { fixture: 'edge-max', manifest: { id: 'decide-list' } },
      {
        openRuns: 1,
        theme: 'light',
        viewport: { width: 1280, height: 720 },
      },
    );
  } finally {
    await context.close();
  }
}

function assertCalmFadeResult(result) {
  assert.deepEqual(
    result.K2.items[0].non_icon_copy_controls,
    [],
    JSON.stringify(result.K2),
  );
  assert.equal(result.K13.copy_focus.pass, true, JSON.stringify(result.K13));
  assert.equal(result.K13.keyboard.pass, true, JSON.stringify(result.K13));
  assert.equal(result.K13.accessibility.pass, true, JSON.stringify(result.K13));
}

test('round 4 finding 3: calmScene keeps the initial inventory after a 150 ms copy fade', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const repeat = Math.max(1, Number.parseInt(process.env.RS_CALM_FADE_REPEAT || '1', 10) || 1);
  const failures = [];
  for (let iteration = 1; iteration <= repeat; iteration += 1) {
    try {
      assertCalmFadeResult(await runCalmFadeScene(browser));
      t.diagnostic(`150 ms copy fade iteration ${iteration}/${repeat}: pass`);
    } catch (error) {
      failures.push(error);
      t.diagnostic(`150 ms copy fade iteration ${iteration}/${repeat}: fail: ${error}`);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length}/${repeat} iterations failed`);
});

test('calmScene settles a 150 ms copy fade by animation time', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  assertCalmFadeResult(await runCalmFadeScene(browser, 0.1));
});

test('Tab audit includes summary and ignores descendants of closed details', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>:focus{outline:2px solid black}</style>
    <details><summary id="summary">More</summary><button id="closed">Hidden</button></details>
    <button id="outside">Outside</button>
  `);

  const audit = await sandbox().tabAudit(page);

  assert.equal(audit.expected.length, 2);
  assert.equal(audit.seen.length, 2);
  assert.equal(await page.$eval('#closed', (element) => element.dataset.rsTabAuditId || null), null);
});

test('toolbar and tablist are one roving stop and tablists audit last', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>:focus{outline:2px solid black}</style>
    <div role="tablist" id="tabs"><button role="tab" tabindex="0">A</button><button role="tab" tabindex="-1">B</button></div>
    <div role="toolbar" id="tools"><button tabindex="0">One</button><button tabindex="-1">Two</button></div>
    <script>
      for (const group of [tabs, tools]) group.onkeydown = (event) => {
        if (event.key !== 'ArrowRight') return;
        const members = [...group.querySelectorAll('button')];
        const next = members[(members.indexOf(document.activeElement) + 1) % members.length];
        for (const member of members) member.tabIndex = member === next ? 0 : -1;
        next.focus();
      };
    </script>
  `);

  const audit = await sandbox().tabAudit(page);

  assert.equal(audit.expected.length, 2);
  assert.deepEqual(
    audit.groups.map((group) => group.kind),
    ['toolbar', 'tablist'],
  );
});

test('round 2 findings 12 and 15: every reached control must settle visibly with an outline', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<style>button:focus{outline:2px solid black}</style><button style="opacity:0">Invisible</button>',
  );

  await assert.rejects(
    sandbox().tabAudit(page),
    /hidden on keyboard focus/i,
  );
});

test('round 3 finding 6: a transparent outline is not visible focus evidence', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<style>button:focus{outline:2px solid transparent}</style><button>Invisible ring</button>',
  );

  await assert.rejects(
    sandbox().tabAudit(page),
    /focus outline/i,
  );
});

test('round 3 finding 10: Tab inventory waits for the expected rail to settle', async (t) => {
  const chromium = await loadChromium();
  assert.ok(chromium, 'playwright-core is required');
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>button:focus{outline:2px solid black}</style>
    <nav id="rs-rail">
      <button class="rs-rail__run" data-run-id="one">One</button>
    </nav>
    <button id="outside">Outside</button>
    <script>
      window.refreshCount = 0;
      document.querySelector('#rs-rail').addEventListener('keydown', (event) => {
        if (event.key !== 'Tab' || window.refreshCount || document.activeElement.dataset.runId !== 'one') return;
        event.preventDefault();
        window.refreshCount += 1;
        document.querySelector('#rs-rail').innerHTML = [
          '<button class="rs-rail__run" data-run-id="one">One</button>',
          '<button class="rs-rail__run" data-run-id="two">Two</button>',
          '<button class="rs-rail__run" data-run-id="three">Three</button>',
        ].join('');
      });
      setTimeout(() => {
        document.querySelector('#rs-rail').innerHTML = [
          '<button class="rs-rail__run" data-run-id="one">One</button>',
          '<button class="rs-rail__run" data-run-id="two">Two</button>',
          '<button class="rs-rail__run" data-run-id="three">Three</button>',
        ].join('');
      }, 500);
    </script>
  `);

  const audit = await sandbox().tabAudit(page, {
    expectedOpenRuns: 3,
    settleTimeout: 1500,
  });

  assert.equal(audit.expected.length, 4);
  assert.deepEqual([...audit.seen], [...audit.expected]);
  assert.equal(await page.evaluate(() => window.refreshCount), 1);
});

test('round 2 finding 8: calm captures the initial resting viewport before interaction audits', async () => {
  const events = [];
  const facts = {
    K7: { page_background: [255, 255, 255], background_ratio: null },
    K9: {},
    K10: {},
    K12: {},
  };
  const page = {
    screenshot: async () => {
      events.push('screenshot');
      return Buffer.from('png');
    },
    addScriptTag: async () => {},
    evaluate: async () => ({
      pass: true,
      unnamed: 0,
      positive_tabindex: 0,
      violations: [],
    }),
    emulateMedia: async () => {},
  };
  const scope = {
    AXE: 'axe.js',
    CALM_THRESHOLDS: { backgroundChannelTolerance: 2 },
    cancelOpen: async () => {},
    closeAuditContext: async (context) => context.close(),
    show: () => ({ run_id: 'resting' }),
    openPage: async () => ({ page, context: { close: async () => {} } }),
    calmRestingFacts: async () => {
      events.push('resting');
      return structuredClone(facts);
    },
    tabAudit: async () => {
      events.push('tab');
    },
    auditCopyFocus: async () => {
      events.push('copy');
      return { pass: true, controls: [] };
    },
    auditPlatformSwitching: async () => null,
    isSocialPreview,
    pngBackgroundRatio: () => 0.75,
  };
  vm.createContext(scope);
  vm.runInContext(
    source.slice(
      source.indexOf('async function calmScene('),
      source.indexOf('async function calmMode('),
    ),
    scope,
  );

  const result = await scope.calmScene(
    {},
    {},
    { fixture: 'golden', manifest: { id: 'decide-list' } },
    {
      openRuns: 1,
      theme: 'light',
      viewport: { width: 1500, height: 1000 },
    },
  );

  assert.equal(result.K7.background_ratio, 0.75);
  assert.ok(events.indexOf('screenshot') < events.indexOf('tab'), events.join(','));
});
