#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  browserChannel,
  startServer,
  loadChromium,
  ROOT,
} from './dev/rs-server.mjs';
import { isSameOriginPath } from './dev/browser-safety.mjs';
import {
  CALM_THRESHOLDS,
  auditCopyFocus,
  auditPlatformSwitching,
  calmEvaluator,
  focusedControlFacts,
  judgeCalmFacts,
  pngBackgroundRatio,
  settleShortAnimations,
} from './calm.mjs';

const PORT = Number(process.env.RS_TOOL_PORT || 18920);
const AXE = path.join(ROOT, 'vendor', 'axe.min.js');
const AXE_SHA256 = '20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878';
const cliArguments = process.argv.slice(2);
const mode = cliArguments.shift();
let requestedTemplate = null;
let netlogDir = process.env.RS_NETLOG_DIR || null;
while (cliArguments.length) {
  const argument = cliArguments.shift();
  if (argument === '--netlog') {
    netlogDir = cliArguments.shift();
    if (!netlogDir) throw new Error('--netlog requires a directory');
  } else if (requestedTemplate === null) requestedTemplate = argument;
  else throw new Error(`unexpected argument: ${argument}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runNetwork = { requests: [], responses: [], errors: [] };

function reportStage(message) {
  if (process.env.RS_E2E_DIAGNOSTICS !== '1') return;
  console.error(message);
  if (process.env.RS_E2E_STAGE_FILE) {
    try {
      writeFileSync(process.env.RS_E2E_STAGE_FILE, message, 'utf8');
    } catch {
      // Stderr still carries diagnostics when the stage file is unavailable.
    }
  }
}

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function boundedMilliseconds(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.max(value, 1000), 120000)
    : fallback;
}

async function closeAuditContext(context, capMs = 1000) {
  let timer;
  await Promise.race([
    context.close().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, capMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const MEASUREMENT_BOT_ID = json(path.join(ROOT, 'tools', 'measurement.json')).bot_id;

function lastSunday(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

function viennaOracle(value) {
  const instant = new Date(value);
  const year = instant.getUTCFullYear();
  const summerStart = Date.UTC(year, 2, lastSunday(year, 2), 1);
  const summerEnd = Date.UTC(year, 9, lastSunday(year, 9), 1);
  const offsetHours = (
    instant.getTime() >= summerStart && instant.getTime() < summerEnd
  ) ? 2 : 1;
  const local = new Date(instant.getTime() + offsetHours * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  const weekdays = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const clock = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  const seconds = pad(local.getUTCSeconds());
  const offset = `+${pad(offsetHours)}:00`;
  return {
    display: `${weekdays[local.getUTCDay()]} ${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} · ${clock}`,
    persisted_created: `${date}T${clock}:${seconds}${offset}`,
    created_offset: offset,
  };
}

function futureTimeCases() {
  const year = new Date().getUTCFullYear() + 2;
  const march = lastSunday(year, 2);
  const october = lastSunday(year, 9);
  const values = [
    ['z-winter', `${year}-01-08T10:00:00Z`],
    ['plus-one-summer', `${year}-07-08T10:00:00+01:00`],
    ['march-before', new Date(Date.UTC(year, 2, march, 0, 59, 59)).toISOString()],
    ['march-after', new Date(Date.UTC(year, 2, march, 1, 0, 0)).toISOString()],
    ['october-before', new Date(Date.UTC(year, 9, october, 0, 59, 59)).toISOString()],
    ['october-after', new Date(Date.UTC(year, 9, october, 1, 0, 0)).toISOString()],
  ];
  return values.map(([name, created]) => Object.freeze({
    name,
    created,
    ...viennaOracle(created),
  }));
}

const TIME_BASELINE = Object.freeze({
  locale: 'de-DE',
  timeZone: 'Europe/Vienna',
  default: Object.freeze({
    created: '2026-10-08T10:39:00Z',
    clockAnchor: '2026-10-08T10:40:00Z',
    display: 'Do 08.10.2026 · 12:39',
  }),
  cases: Object.freeze(futureTimeCases()),
});

function offsetSuffix(value) {
  return String(value).match(/([+-]\d{2}:\d{2})$/u)?.[1] || null;
}

function expectedViennaOffset(value) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat(TIME_BASELINE.locale, {
      timeZone: TIME_BASELINE.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour),
    Number(fields.minute),
    Number(fields.second),
  );
  const minutes = Math.round((localAsUtc - instant.getTime()) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function templates(selected = null) {
  const found = [];
  for (const namespace of readdirSync(path.join(ROOT, 'templates'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const nsPath = path.join(ROOT, 'templates', namespace.name);
    for (const entry of readdirSync(nsPath, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const dir = path.join(nsPath, entry.name);
      const manifestPath = path.join(dir, 'template.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = json(manifestPath);
      if (!selected || selected === '--all' || manifest.id === selected) found.push({ dir, manifest });
    }
  }
  if (selected && selected !== '--all' && found.length === 0) throw new Error(`unknown template: ${selected}`);
  if (found.length === 0) throw new Error('no registered templates found');
  return found.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

function requiredGolden(template) {
  const fixturePath = path.join(template.dir, 'fixtures', 'golden.json');
  const expectPath = path.join(template.dir, 'fixtures', 'expect', 'golden.json');
  if (!existsSync(fixturePath)) throw new Error(`${template.manifest.id}: missing fixtures/golden.json`);
  if (!existsSync(expectPath)) throw new Error(`${template.manifest.id}: missing fixtures/expect/golden.json`);
  const expected = json(expectPath);
  if (!Array.isArray(expected.flow) || expected.flow.length === 0) {
    throw new Error(`${template.manifest.id}: golden expect requires nonempty flow`);
  }
  if (!Array.isArray(expected.keyboard) || expected.keyboard.length === 0) {
    throw new Error(`${template.manifest.id}: golden expect requires nonempty keyboard`);
  }
  if (!Object.hasOwn(expected, 'result')) {
    throw new Error(`${template.manifest.id}: golden expect requires result`);
  }
}

function fixtureCases(selected = null, { expectOnly = false, goldenOnly = false } = {}) {
  const cases = [];
  const registered = templates(selected);
  for (const template of registered) {
    requiredGolden(template);
    const fixtureDir = path.join(template.dir, 'fixtures');
    let names;
    if (goldenOnly) names = ['golden.json'];
    else {
      names = readdirSync(fixtureDir, { withFileTypes: true })
        .filter((entry) => !entry.isDirectory() && (entry.name === 'golden.json' || entry.name.startsWith('edge-')) && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
    }
    for (const name of names) {
      const fixture = path.basename(name, '.json');
      const expectPath = path.join(fixtureDir, 'expect', `${fixture}.json`);
      if (expectOnly && !existsSync(expectPath)) continue;
      cases.push({
        ...template,
        fixture,
        data: json(path.join(fixtureDir, name)),
        expect: existsSync(expectPath) ? json(expectPath) : null,
      });
    }
  }
  if (cases.length === 0) throw new Error('no fixture cases found');
  return cases;
}

function coverageReport(expectedCases, executedCases) {
  const templateIds = [...new Set(expectedCases.map((item) => item.manifest.id))].sort();
  return {
    expected: expectedCases.length,
    executed: executedCases.length,
    templates: templateIds.map((template) => ({
      template,
      expected: expectedCases.filter((item) => item.manifest.id === template).length,
      executed: executedCases.filter((item) => item.manifest.id === template).length,
    })),
  };
}

function resolveTemplatePaths(data, dir) {
  const text = JSON.stringify(data);
  if (!text.includes('%RS_TEMPLATE%')) return data;
  return JSON.parse(
    text.split('%RS_TEMPLATE%').join(JSON.stringify(dir).slice(1, -1)),
  );
}

function registrationEnvelope(testCase) {
  const namespace = testCase.manifest.namespace;
  return {
    template: testCase.manifest.id,
    version: testCase.manifest.version,
    bot: namespace === 'global' ? MEASUREMENT_BOT_ID : namespace,
    title: testCase.manifest.title_de,
    created: TIME_BASELINE.default.created,
  };
}

async function show(server, testCase) {
  const run = server.show(
    resolveTemplatePaths(testCase.data, testCase.dir),
    registrationEnvelope(testCase),
  );
  await server.assertOpen(run.run_id, `${testCase.manifest.id}/${testCase.fixture}`);
  return run;
}

async function withHarness(callback) {
  const chromium = await loadChromium();
  if (!chromium) throw new Error('playwright-core not found; set RS_PLAYWRIGHT_CORE');
  if (typeof reportStage === 'function') {
    reportStage('rs-e2e stage: starting server');
  }
  const server = await startServer({
    port: PORT,
    mediaRoots: [ROOT],
    env: { RS_CLOCK_ANCHOR: TIME_BASELINE.default.clockAnchor },
  });
  let browser = null;
  try {
    if (typeof reportStage === 'function') {
      reportStage('rs-e2e stage: launching browser');
    }
    browser = await chromium.launch({
      channel: browserChannel(),
      headless: true,
      timeout: boundedMilliseconds('RS_BROWSER_LAUNCH_TIMEOUT_MS', 30000),
    });
    if (typeof reportStage === 'function' && mode === 'expect') {
      reportStage('rs-e2e stage: running expect checks');
    }
    return await callback({ server, browser });
  } finally {
    try {
      if (browser) await browser.close();
    } finally { await server.stop(); }
  }
}

async function openPage(browser, server, runId, options = {}) {
  const readyTimeout = boundedMilliseconds('RS_E2E_READY_TIMEOUT_MS', 10000);
  const navigationTimeout = boundedMilliseconds(
    'RS_E2E_NAVIGATION_TIMEOUT_MS',
    30000,
  );
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1500, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: options.colorScheme || 'light',
    reducedMotion: options.reducedMotion || 'reduce',
  });
  const page = await context.newPage();
  const log = { requests: [], responses: [], errors: [] };
  page.on('request', (request) => {
    log.requests.push(request.url());
    runNetwork.requests.push(request.url());
  });
  page.on('response', (response) => {
    const item = {
      url: response.url(), status: response.status(), headers: response.headers(),
      synthetic: !options.allowRealCopy && response.url().split('?')[0].endsWith('/copy'),
    };
    log.responses.push(item);
    runNetwork.responses.push(item);
  });
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      const item = `${message.type()}: ${message.text()}`;
      log.errors.push(item);
      runNetwork.errors.push(item);
    }
  });
  page.on('pageerror', (error) => {
    const item = `pageerror: ${error.message}`;
    log.errors.push(item);
    runNetwork.errors.push(item);
  });
  if (!options.allowRealCopy) {
    await page.route((url) => isSameOriginPath(url, PORT, '/copy'), async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (options.copyHandler) options.copyHandler(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true}',
      });
    });
  }
  if (typeof reportStage === 'function') {
    reportStage('rs-e2e stage: waiting for page readiness');
  }
  await page.goto(
    `http://127.0.0.1:${PORT}/?run=${encodeURIComponent(runId)}&client=test`,
    { timeout: navigationTimeout },
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.rsReady === '1',
    null,
    { timeout: readyTimeout },
  );
  return { context, page, log };
}

async function focusedControl(page) {
  return page.evaluate(focusedControlFacts);
}

async function assertFocusedOutline(page) {
  const settling = await settleShortAnimations(page, { focused: true });
  if (settling.blocked) {
    const focused = await focusedControl(page);
    throw new Error(`excessive focus motion: ${JSON.stringify({
      ...focused,
      motion_blocked: true,
      blocking_motion: settling.blocking,
    })}`);
  }
  // Fall back to polling for focus styles that settle without an animation.
  const deadline = Date.now() + 250;
  let focused;
  do {
    focused = await focusedControl(page);
    if (focused?.focused === false) return null;
    if (
      focused
      && focused.visible
      && focused.outline_width >= 2
      && focused.outline_style !== 'none'
      && focused.outline_visible
    ) return focused;
    if (Date.now() < deadline) await page.waitForTimeout(10);
  } while (Date.now() < deadline);
  if (focused && !focused.visible) {
    const kind = focused.copy_control ? 'copy control' : 'control';
    throw new Error(`${kind} is hidden on keyboard focus: ${JSON.stringify(focused)}`);
  }
  if (focused && (
    focused.outline_width < 2
    || focused.outline_style === 'none'
    || !focused.outline_visible
  )) {
    throw new Error(`missing focus outline: ${JSON.stringify(focused)}`);
  }
  return focused;
}

async function runStep(page, step, auditFocus = false) {
  if (step.click) await page.click(step.click);
  else if (step.fill) await page.fill(step.fill[0], step.fill[1]);
  else if (step.type !== undefined) {
    await page.keyboard.type(step.type);
    if (auditFocus) await assertFocusedOutline(page);
  }
  else if (step.press) {
    for (let index = 0; index < (step.repeat || 1); index += 1) {
      await page.keyboard.press(step.press);
      if (auditFocus) await assertFocusedOutline(page);
    }
  } else throw new Error(`unknown expect step: ${JSON.stringify(step)}`);
}

async function cancelOpen(server) {
  await server.clearRuns();
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function clipboardText() {
  const result = spawnSync('py', ['-3', path.join(ROOT, 'tools', 'clipread.py')], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'clipread.py failed');
  const value = JSON.parse(result.stdout);
  if (!value.available) throw new Error(value.error || 'CF_UNICODETEXT unavailable');
  return value.text;
}

async function copyMode() {
  if (process.env.RS_ALLOW_CLIPBOARD !== '1') {
    throw new Error('copy mode may only be run by tools/measure_copy.py');
  }
  return withHarness(async ({ server, browser }) => {
    const cases = [];
    const network = { requests: [], responses: [], errors: [] };
    const expectedCases = fixtureCases(requestedTemplate, { expectOnly: true });
    const executedCases = [];
    for (const testCase of expectedCases) {
      const copies = testCase.expect?.copies || {};
      if (!Object.keys(copies).length) continue;
      executedCases.push(testCase);
      await cancelOpen(server);
      const run = await show(server, testCase);
      const { context, page, log } = await openPage(
        browser, server, run.run_id, { allowRealCopy: true },
      );
      try {
        for (const [copyId, expected] of Object.entries(copies)) {
          const response = page.waitForResponse((item) => item.url().endsWith('/copy'));
          await reveal(page, copySelector(copyId));
          await activateCopy(page, copySelector(copyId));
          const status = (await response).status();
          if (status !== 200) throw new Error(`${testCase.manifest.id}/${testCase.fixture}/${copyId}: /copy returned ${status}`);
          const actual = clipboardText();
          cases.push({
            template: testCase.manifest.id, fixture: testCase.fixture, copy_id: copyId,
            expected_sha256: sha256(expected), actual_sha256: sha256(actual),
            pass: actual === expected,
          });
        }
      } finally {
        await context.close();
        network.requests.push(...log.requests);
        network.responses.push(...log.responses);
        network.errors.push(...log.errors);
      }
    }
    const passed = cases.filter((item) => item.pass).length;
    return {
      mode: 'copy',
      passed,
      total: cases.length,
      ok: passed === cases.length && cases.length >= 20,
      cases,
      coverage: coverageReport(expectedCases, executedCases),
      network,
    };
  });
}

function CSSescape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function copySelector(copyId) {
  return `[data-copy-id="${CSSescape(copyId)}"] .rs-copy__btn, [data-copy-id="${CSSescape(copyId)}"] button`;
}

async function activateCopy(page, selector) {
  await page.$eval(selector, (element) => element.click());
}

async function reveal(page, selector, options = {}) {
  const settleRevealWork = async (opener) => {
    await opener.evaluate(async () => {
      await new Promise((resolve) => {
        let settled = false;
        let timeout;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          queueMicrotask(resolve);
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        timeout = setTimeout(finish, 100);
      });
      await Promise.resolve();
    });
  };
  if (options.all || !(await page.$(selector))) {
    const marker = `reveal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const markerAttribute = 'data-rs-calm-reveal-marker';
    const discover = async () => {
      const found = [];
      for (const query of [
        '[aria-expanded]:not(#rs-more-btn),details > summary',
        '[role="tab"][aria-selected]',
      ]) {
        for (const opener of await page.$$(query)) {
          if (!(await opener.isVisible())) continue;
          const queued = await opener.evaluate((element, state) => {
            if (element.getAttribute(state.attribute) === state.marker) return false;
            element.setAttribute(state.attribute, state.marker);
            if (element.matches('[role=tab]')) {
              return element.getAttribute('aria-selected') === 'false';
            }
            if (element.tagName === 'SUMMARY') {
              return element.parentElement?.tagName === 'DETAILS'
                && !element.parentElement.open;
            }
            return element.getAttribute('aria-expanded') === 'false';
          }, { attribute: markerAttribute, marker });
          if (queued) found.push(opener);
        }
      }
      return found;
    };
    const pending = (await discover()).reverse();
    try {
      for (let steps = 0; pending.length && steps < 64; steps += 1) {
        const opener = pending.pop();
        if (!(await opener.isVisible())) continue;
        await opener.click();
        await settleRevealWork(opener);
        if (options.visit) await options.visit();
        if (!options.all && await page.$(selector)) break;
        pending.push(...(await discover()).reverse());
      }
    } finally {
      await page.$$eval(
        `[${markerAttribute}]`,
        (elements, state) => {
          for (const element of elements) {
            if (element.getAttribute(state.attribute) === state.marker) {
              element.removeAttribute(state.attribute);
            }
          }
        },
        { attribute: markerAttribute, marker },
      );
    }
  }
  const changed = !options.all && await page.evaluate((selected) => {
    const element = document.querySelector(selected);
    if (!element) return false;
    const hidden = [];
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (node.tagName === 'DETAILS' && !node.open) node.open = true;
      if (node.id && getComputedStyle(node).display === 'none') hidden.push(node.id);
    }
    let activated = false;
    for (const id of hidden.reverse()) {
      const opener = document.querySelector(`[aria-controls~="${CSS.escape(id)}"]`);
      if (opener) {
        opener.click();
        activated = true;
      }
    }
    return activated;
  }, selector);
  if (changed && options.visit) await options.visit();
}

async function clickAndCaptureCopy(page, selector, timeout = 5000) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return response.url().split('?')[0].endsWith('/copy') && request.method() === 'POST';
  }, { timeout });
  await activateCopy(page, selector);
  const response = await responsePromise;
  const raw = response.request().postData();
  try {
    return JSON.parse(raw || '{}');
  } catch (error) {
    throw new Error(`invalid /copy request body: ${error.message}`);
  }
}

async function expectMode() {
  if (!requestedTemplate) throw new Error('expect mode requires a template id');
  return withHarness(async ({ server, browser }) => {
    const findings = [];
    const expectedCases = fixtureCases(requestedTemplate, { expectOnly: true });
    const executedCases = [];
    for (const testCase of expectedCases) {
      await cancelOpen(server);
      const run = await show(server, testCase);
      const { context, page } = await openPage(browser, server, run.run_id);
      try {
        let capturedCopies = 0;
        for (const [copyId, expected] of Object.entries(testCase.expect.copies || {})) {
          const selector = copySelector(copyId);
          await reveal(page, selector);
          let body;
          try {
            body = await clickAndCaptureCopy(page, selector);
          } catch (error) {
            throw new Error(
              `${testCase.manifest.id}/${testCase.fixture}/${copyId}: ${error.message}`,
            );
          }
          capturedCopies += 1;
          if (body.text !== expected) {
            findings.push({ fixture: testCase.fixture, copy_id: copyId, expected, actual: body.text });
          }
        }
        const expectedCopies = Object.keys(testCase.expect.copies || {}).length;
        if (capturedCopies !== expectedCopies) {
          findings.push({
            fixture: testCase.fixture,
            error: 'copy request count mismatch',
            expected: expectedCopies,
            actual: capturedCopies,
          });
        }
        for (const [counterId, expected] of Object.entries(testCase.expect.counters || {})) {
          await reveal(page, `[data-counter-id="${CSSescape(counterId)}"]`);
          const actual = await page.$eval(`[data-counter-id="${CSSescape(counterId)}"]`, (element) => {
            const result = element.result || {};
            const hashtags = element.getAttribute('kind') === 'hashtags';
            return {
              count: hashtags ? result.hashtags : result.count,
              limit: hashtags ? result.hashtagLimit : result.limit,
              over: element.hasAttribute('over'),
            };
          });
          for (const key of ['count', 'limit', 'over']) {
            if (actual[key] !== expected[key]) findings.push({
              fixture: testCase.fixture, counter_id: counterId, field: key,
              expected: expected[key], actual: actual[key],
            });
          }
        }
        executedCases.push(testCase);
      } finally { await context.close(); }
    }
    return {
      mode: 'expect',
      template: requestedTemplate,
      ok: findings.length === 0 && executedCases.length === expectedCases.length,
      findings,
      coverage: coverageReport(expectedCases, executedCases),
    };
  });
}

async function timedFinalStep(page, step) {
  const actions = ['click', 'press'].filter((key) => Object.hasOwn(step, key));
  if (actions.length !== 1) {
    throw new Error(`final flow step must contain exactly one click or press: ${JSON.stringify(step)}`);
  }
  const action = actions[0];
  let dispatch;
  if (action === 'click') {
    const locator = page.locator(step.click);
    await locator.waitFor({ state: 'visible' });
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ trial: true });
    await page.evaluate(({ selector, kind }) => {
      window.__rsSubmitDispatchEpoch = null;
      document.addEventListener('click', (event) => {
        if (event.target.closest(selector)) {
          window.__rsSubmitDispatchEpoch = performance.timeOrigin + performance.now();
        }
      }, { capture: true, once: true });
    }, { selector: step.click, kind: 'install' });
    dispatch = () => locator.click();
  } else {
    await page.evaluate(({ key, kind }) => {
      window.__rsSubmitDispatchEpoch = null;
      document.addEventListener('keydown', (event) => {
        if (event.key || key) {
          window.__rsSubmitDispatchEpoch = performance.timeOrigin + performance.now();
        }
      }, { capture: true, once: true });
    }, { key: step.press, kind: 'install' });
    dispatch = () => page.keyboard.press(step.press);
  }
  await dispatch();
  const dispatchEpoch = await page.evaluate(() => window.__rsSubmitDispatchEpoch);
  if (!Number.isFinite(dispatchEpoch)) throw new Error('submit dispatch event was not observed');
  return dispatchEpoch;
}

function validateObservedResult(testCase, result) {
  const executable = process.env.RS_PYTHON || 'py';
  const arguments_ = process.env.RS_PYTHON ? [] : ['-3'];
  const validated = spawnSync(
    executable,
    [...arguments_, path.join(ROOT, 'tools', 'validate_result.py')],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      input: JSON.stringify({
        template: testCase.manifest.id,
        result,
        expected: testCase.expect.result,
      }),
    },
  );
  if (validated.status !== 0) {
    throw new Error(
      validated.stderr.trim() || validated.stdout.trim() || 'result validation failed',
    );
  }
}

async function submitMode() {
  return withHarness(async ({ server, browser }) => {
    const source = fixtureCases(
      requestedTemplate, { expectOnly: true, goldenOnly: true },
    );
    if (!source.length) throw new Error('no expect files with flow steps');
    if (source.length > 20) throw new Error('more than 20 registered templates cannot fit C10');
    const schedule = Array.from({ length: 20 }, (_, index) => source[index % source.length]);
    const cases = [];
    const executedCases = [];
    for (const testCase of schedule) {
      await cancelOpen(server);
      const run = await show(server, testCase);
      const { context, page } = await openPage(browser, server, run.run_id);
      try {
        const steps = testCase.expect.flow;
        for (const step of steps.slice(0, -1)) await runStep(page, step);
        const dispatchEpoch = await timedFinalStep(page, steps.at(-1));
        const resultPath = path.join(server.dataDir, 'results', `${run.run_id}.json`);
        const deadline = Date.now() + 3000;
        while (!existsSync(resultPath) && Date.now() < deadline) await sleep(2);
        if (!existsSync(resultPath)) throw new Error(`result timeout for ${run.run_id}`);
        const result = json(resultPath);
        validateObservedResult(testCase, result);
        const observedEpoch = Date.now();
        cases.push({
          template: testCase.manifest.id, fixture: testCase.fixture, run_id: run.run_id,
          ms: Math.max(0, observedEpoch - dispatchEpoch),
          dispatch_epoch_ms: dispatchEpoch,
          observed_epoch_ms: observedEpoch,
          validation_epoch_ms: observedEpoch,
          validation_ok: true,
          result,
          expected: testCase.expect.result,
        });
        executedCases.push(testCase);
      } finally { await context.close(); }
    }
    return {
      mode: 'submit',
      ok: cases.length === 20,
      total: cases.length,
      max_ms: Math.max(...cases.map((item) => item.ms)),
      cases,
      coverage: coverageReport(schedule, executedCases),
    };
  });
}

async function waitForTabAuditReady(page, options = {}) {
  const configuredTimeout = typeof process === 'undefined'
    ? NaN
    : Number(process.env.RS_E2E_READY_TIMEOUT_MS);
  const requestedTimeout = options.settleTimeout === undefined
    ? null
    : Number(options.settleTimeout);
  if (
    requestedTimeout !== null
    && (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)
  ) {
    throw new Error('keyboard readiness timeout must be a positive finite number');
  }
  const timeout = requestedTimeout ?? (
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(Math.max(configuredTimeout, 1000), 120000)
      : 10000
  );
  let timeoutHandle;
  const timeoutError = new Error(`keyboard readiness timed out after ${timeout} ms`);
  timeoutError.code = 'RS_E2E_READY_TIMEOUT';
  const deadline = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(timeoutError), timeout);
  });
  const readiness = (async () => {
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    if (Number.isInteger(options.expectedOpenRuns)) {
      await page.waitForFunction((expected) => {
        if (document.documentElement.dataset.rsReady === '0') return false;
        const rail = document.querySelector(
          '.rs-rail,[data-rs-rail],#rs-rail,nav[aria-label*="run" i]',
        );
        if (!rail) return expected === 0;
        const entries = rail.querySelectorAll(
          '.rs-rail__run,[data-run-id]',
        );
        return entries.length === Math.min(expected, 12);
      }, options.expectedOpenRuns, { timeout: 0 });
    }
    await page.evaluate(async () => {
      const signature = () => [...document.querySelectorAll(
        '.rs-rail__run,[data-run-id],button,input,select,textarea,a[href],summary,[tabindex]',
      )].map((element) => (
        element.dataset.runId
        || element.id
        || element.getAttribute('aria-label')
        || `${element.tagName}:${element.tabIndex}:${element.textContent?.trim().slice(0, 40)}`
      )).join('|');
      let previous = signature();
      let stableFrames = 0;
      while (stableFrames < 2) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const current = signature();
        stableFrames = current === previous ? stableFrames + 1 : 0;
        previous = current;
      }
    });
  })();
  try {
    await Promise.race([readiness, deadline]);
  } catch (error) {
    if (error?.code === 'RS_E2E_READY_TIMEOUT') {
      try { await page.close(); } catch { /* timeout result remains authoritative */ }
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function tabAudit(page, options = {}) {
  await waitForTabAuditReady(page, options);
  const scan = await page.evaluate(() => {
    const selector = 'button,input,select,textarea,a[href],summary,[tabindex]';
    const candidates = [...document.querySelectorAll(selector)].filter((element) => {
      const style = getComputedStyle(element);
      const closed = element.closest('details:not([open])');
      if (closed && !(element.tagName === 'SUMMARY' && element.parentElement === closed)) {
        return false;
      }
      return !element.disabled && !element.closest('[inert]') &&
        style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length;
    });
    candidates.forEach((element, index) => {
      element.dataset.rsTabAuditId = `control-${index}`;
    });
    const GROUPS = '[role="radiogroup"],[role="toolbar"],[role="tablist"]';
    const allCompositeGroups = [...document.querySelectorAll(GROUPS)];
    const compositeMembers = new Map();
    for (const element of candidates) {
      const group = element.closest(GROUPS);
      if (!group) continue;
      if (!compositeMembers.has(group)) compositeMembers.set(group, []);
      compositeMembers.get(group).push(element);
    }
    const rovingGroups = new Set(
      [...compositeMembers].filter(([, members]) => (
        members.length > 1
        && members.filter((element) => element.tabIndex === 0).length === 1
        && members.every((element) => element.tabIndex <= 0)
      )).map(([group]) => group),
    );
    const controls = candidates.filter((element) => element.tabIndex >= 0);
    const keys = [];
    controls.forEach((element) => {
      let key = element.id ? `id:${element.id}` :
        element.dataset.runId ? `run:${element.dataset.runId}` :
          element.closest('[data-copy-id]') ? `copy:${element.closest('[data-copy-id]').dataset.copyId}` :
            element.dataset.rsTabAuditId;
      if (element.matches('input[type="radio"][name]')) {
        const form = element.form?.id || 'no-form';
        key = `radio:${form}:${element.name}`;
      } else {
        const group = element.closest(GROUPS);
        if (group && rovingGroups.has(group)) {
          group.dataset.rsTabAuditGroup = `group-${allCompositeGroups.indexOf(group)}`;
          key = `${group.getAttribute('role')}:${group.dataset.rsTabAuditGroup}`;
        }
      }
      element.dataset.rsTabAuditKey = key;
      if (!keys.includes(key)) keys.push(key);
    });
    const groups = [];
    for (const group of rovingGroups) {
      const members = compositeMembers.get(group)
        .map((element) => element.dataset.rsTabAuditId);
      const entry = compositeMembers.get(group)
        .find((element) => element.tabIndex === 0)?.dataset.rsTabAuditId;
      if (entry) {
        groups.push({
          identity: `group-${allCompositeGroups.indexOf(group)}`,
          kind: group.getAttribute('role'),
          members,
          entry,
        });
      }
    }
    groups.sort((left, right) => (
      Number(left.kind === 'tablist') - Number(right.kind === 'tablist')
    ));
    const native = new Map();
    for (const element of candidates.filter((item) => item.matches('input[type="radio"][name]'))) {
      const key = `${element.form?.id || 'no-form'}:${element.name}`;
      if (!native.has(key)) native.set(key, []);
      native.get(key).push(element);
    }
    for (const members of native.values()) {
      if (members.length > 1) groups.push({
        kind: 'radio group',
        members: members.map((element) => element.dataset.rsTabAuditId),
        entry: (members.find((element) => element.tabIndex >= 0) || members[0]).dataset.rsTabAuditId,
      });
    }
    return { keys, groups };
  });
  const expected = scan.keys;
  const seen = [];
  let firstIdentity = null;
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    if (document.activeElement !== document.body) {
      throw new Error('could not establish keyboard audit start');
    }
  });
  for (let index = 0; index < expected.length * 3 + 6; index += 1) {
    await page.keyboard.press('Tab');
    const focused = await assertFocusedOutline(page);
    if (!focused) {
      if (expected.every((key) => seen.includes(key))) break;
      await page.evaluate(() => document.body.focus());
      continue;
    }
    if (!focused.key) {
      focused.key = await page.evaluate(() => {
        const element = document.activeElement;
        return element.id ? `id:${element.id}` :
          element.dataset?.runId ? `run:${element.dataset.runId}` :
            element.closest?.('[data-copy-id]') ? `copy:${element.closest('[data-copy-id]').dataset.copyId}` :
              null;
      });
    }
    if (focused.tag === 'BODY') break;
    if (!focused.key) throw new Error(`unexpected Tab stop: ${JSON.stringify(focused)}`);
    if (firstIdentity === null) firstIdentity = focused.identity;
    else if (
      focused.identity === firstIdentity
      && expected.every((key) => seen.includes(key))
    ) break;
    if (!seen.includes(focused.key)) seen.push(focused.key);
  }
  const missing = expected.filter((key) => !seen.includes(key));
  if (missing.length) {
    throw new Error(
      `Tab sequence missed: ${missing.join(', ')}; expected ${expected.join(', ')}; saw ${seen.join(', ')}`,
    );
  }
  await page.evaluate(() => document.body.removeAttribute('tabindex'));
  for (const group of scan.groups) {
    const entry = await page.evaluate((identity) => {
      const element = document.querySelector(`[data-rs-tab-audit-id="${identity}"]`);
      element.focus();
      return document.activeElement.dataset.rsTabAuditId;
    }, group.entry);
    await assertFocusedOutline(page);
    const arrowSeen = new Set([entry]);
    let previous = entry;
    for (let index = 0; index < group.members.length; index += 1) {
      await page.keyboard.press('ArrowRight');
      const focused = await assertFocusedOutline(page);
      const after = focused?.identity || null;
      if (!group.members.includes(after)) {
        throw new Error(`ArrowRight left ${group.kind}`);
      }
      if (index < group.members.length - 1 && after === previous) {
        throw new Error(`ArrowRight did not move within ${group.kind}`);
      }
      arrowSeen.add(after);
      previous = after;
    }
    const missingMembers = group.members.filter((identity) => !arrowSeen.has(identity));
    if (missingMembers.length) {
      throw new Error(`${group.kind} arrow navigation missed: ${missingMembers.join(', ')}`);
    }
    if (previous !== entry) {
      throw new Error(`ArrowRight did not wrap within ${group.kind}`);
    }
  }
  return { expected, seen, groups: scan.groups };
}

function validateKeyboardSteps(templateId, steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${templateId}: golden expect has no keyboard steps`);
  }
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${templateId}: keyboard step must be an object`);
    }
    const actions = ['press', 'type', 'click', 'fill'].filter((key) => Object.hasOwn(step, key));
    if (actions.length !== 1 || !['press', 'type'].includes(actions[0])) {
      throw new Error(`${templateId}: keyboard step may use only press/repeat/type, not ${actions.join('/') || 'unknown'}`);
    }
    const allowed = actions[0] === 'press' ? ['press', 'repeat'] : ['type'];
    const unknown = Object.keys(step).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new Error(`${templateId}: unknown keyboard fields: ${unknown.join(', ')}`);
    if (actions[0] === 'press' && (
      typeof step.press !== 'string' || !step.press ||
      (step.repeat !== undefined && (!Number.isInteger(step.repeat) || step.repeat < 1))
    )) {
      throw new Error(`${templateId}: invalid keyboard press step`);
    }
    if (actions[0] === 'type' && typeof step.type !== 'string') {
      throw new Error(`${templateId}: invalid keyboard type step`);
    }
  }
}

function validateFlowSteps(testCase, modeName, steps) {
  if (steps === undefined) return false;
  const label = `${testCase.manifest.id}/${testCase.fixture}`;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${label}: supplied ${modeName} steps must be a nonempty array`);
  }
  if (modeName === 'keyboard') {
    validateKeyboardSteps(label, steps);
    return true;
  }
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${label}: flow step must be an object`);
    }
    const actions = ['click', 'fill', 'press', 'type'].filter((key) => Object.hasOwn(step, key));
    if (actions.length !== 1) {
      throw new Error(`${label}: flow step must contain exactly one action`);
    }
  }
  return true;
}

async function keyboardMode() {
  const configuredResultTimeout = typeof process === 'undefined'
    ? NaN
    : Number(process.env.RS_E2E_RESULT_TIMEOUT_MS);
  const resultTimeout = Number.isFinite(configuredResultTimeout) && configuredResultTimeout > 0
    ? Math.min(Math.max(configuredResultTimeout, 1000), 120000)
    : 10000;
  return withHarness(async ({ server, browser }) => {
    const cases = [];
    const expectedCases = fixtureCases(
      requestedTemplate, { expectOnly: true, goldenOnly: true },
    );
    for (const testCase of expectedCases) {
      validateKeyboardSteps(testCase.manifest.id, testCase.expect.keyboard);
      await cancelOpen(server);
      let run = await show(server, testCase);
      let opened = await openPage(browser, server, run.run_id, { copyHandler: () => {} });
      let tab;
      try {
        tab = await tabAudit(opened.page, { expectedOpenRuns: 1 });
      } finally { await closeAuditContext(opened.context); }
      await cancelOpen(server);
      run = await show(server, testCase);
      opened = await openPage(browser, server, run.run_id, { copyHandler: () => {} });
      try {
        await waitForTabAuditReady(opened.page, { expectedOpenRuns: 1 });
        for (const step of testCase.expect.keyboard) await runStep(opened.page, step, true);
        const deadline = Date.now() + resultTimeout;
        while (!server.result(run.run_id) && Date.now() < deadline) await sleep(5);
        const result = server.result(run.run_id);
        if (!result) throw new Error(`${testCase.manifest.id}: keyboard flow produced no result`);
        if (testCase.expect.result && JSON.stringify(result.data) !== JSON.stringify(testCase.expect.result)) {
          throw new Error(`${testCase.manifest.id}: keyboard result mismatch`);
        }
        cases.push({ template: testCase.manifest.id, fixture: testCase.fixture, tab_stops: tab.seen.length, result: result.data });
      } finally { await closeAuditContext(opened.context); }
    }
    return {
      mode: 'keyboard',
      ok: cases.length === expectedCases.length,
      passed: cases.length,
      total: expectedCases.length,
      cases,
      coverage: coverageReport(
        expectedCases,
        expectedCases.filter((item) => cases.some((done) => done.template === item.manifest.id)),
      ),
    };
  });
}

async function a11yBasicMode() {
  return withHarness(async ({ server, browser }) => {
    const findings = [];
    let pages = 0;
    const expectedCases = fixtureCases(requestedTemplate, { goldenOnly: true });
    const executedCases = [];
    for (const testCase of expectedCases) {
      await cancelOpen(server);
      const run = await show(server, testCase);
      const { context, page } = await openPage(browser, server, run.run_id);
      try {
        pages += 1;
        if (await page.getAttribute('html', 'lang') !== 'de') findings.push({ template: testCase.manifest.id, error: 'html lang is not de' });
        const positive = await page.$$eval('[tabindex]', (items) => items.filter((item) => item.tabIndex > 0).map((item) => item.outerHTML));
        if (positive.length) findings.push({ template: testCase.manifest.id, error: 'positive tabindex', nodes: positive });
        const session = await context.newCDPSession(page);
        const tree = await session.send('Accessibility.getFullAXTree');
        for (const node of tree.nodes) {
          if (!['button', 'textbox', 'checkbox', 'radio'].includes(node.role?.value)) continue;
          if (!String(node.name?.value || '').trim()) findings.push({
            template: testCase.manifest.id, error: 'unnamed control', role: node.role.value, node_id: node.nodeId,
          });
        }
        executedCases.push(testCase);
      } finally { await context.close(); }
    }
    return {
      mode: 'a11y-basic',
      ok: findings.length === 0 && executedCases.length === expectedCases.length,
      pages,
      findings,
      coverage: coverageReport(expectedCases, executedCases),
    };
  });
}

async function axeMode() {
  if (!existsSync(AXE)) throw new Error('vendor/axe.min.js is missing');
  const actualHash = createHash('sha256').update(readFileSync(AXE)).digest('hex');
  if (actualHash !== AXE_SHA256) throw new Error(`axe.min.js SHA-256 mismatch: ${actualHash}`);
  return withHarness(async ({ server, browser }) => {
    const violations = [];
    let pages = 0;
    const expectedCases = fixtureCases(requestedTemplate, { goldenOnly: true });
    const executedCases = [];
    for (const testCase of expectedCases) {
      await cancelOpen(server);
      const run = await show(server, testCase);
      for (const theme of ['light', 'dark']) {
        const { context, page } = await openPage(browser, server, run.run_id, { colorScheme: theme });
        try {
          pages += 1;
          await page.addScriptTag({ path: AXE });
          const found = await page.evaluate(async () => (await window.axe.run(document)).violations
            .filter((item) => ['serious', 'critical'].includes(item.impact))
            .map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.map((node) => node.target) })));
          for (const violation of found) violations.push({ template: testCase.manifest.id, fixture: testCase.fixture, theme, ...violation });
        } finally { await context.close(); }
      }
      executedCases.push(testCase);
    }
    return {
      mode: 'axe',
      ok: violations.length === 0 && pages === expectedCases.length * 2,
      pages,
      serious_critical: violations.length,
      violations,
      axe_sha256: actualHash,
      coverage: coverageReport(expectedCases, executedCases),
    };
  });
}

async function networkMode() {
  return withHarness(async ({ server, browser }) => {
    const findings = [];
    const requests = [];
    const responses = [];
    const scenarios = [];
    const absorb = (log, scenario) => {
      requests.push(...log.requests);
      responses.push(...log.responses);
      scenarios.push(scenario);
    };
    const allCases = fixtureCases(requestedTemplate);
    const expectedCases = fixtureCases(requestedTemplate, { expectOnly: true });
    const executedCases = [];
    for (const testCase of allCases) {
      for (const theme of ['light', 'dark']) {
        await cancelOpen(server);
        const run = await show(server, testCase);
        const { context, log } = await openPage(
          browser, server, run.run_id, { colorScheme: theme },
        );
        await sleep(50);
        await context.close();
        absorb(log, {
          template: testCase.manifest.id,
          fixture: testCase.fixture,
          mode: 'load/a11y/axe/strings/visual',
          theme,
        });
      }
      executedCases.push(testCase);
    }
    for (const testCase of expectedCases) {
      const copies = Object.keys(testCase.expect.copies || {});
      for (const theme of ['light', 'dark']) {
        if (copies.length) {
          await cancelOpen(server);
          const run = await show(server, testCase);
          const opened = await openPage(
            browser, server, run.run_id, { colorScheme: theme },
          );
          for (const copyId of copies) {
            await reveal(opened.page, copySelector(copyId));
            await activateCopy(opened.page, copySelector(copyId));
          }
          await opened.context.close();
          absorb(opened.log, {
            template: testCase.manifest.id,
            fixture: testCase.fixture,
            mode: 'copy-synthetic',
            theme,
          });
        }
        for (const [modeName, steps] of [
          ['flow', testCase.expect.flow],
          ['keyboard', testCase.expect.keyboard],
        ]) {
          if (!validateFlowSteps(testCase, modeName, steps)) continue;
          await cancelOpen(server);
          const run = await show(server, testCase);
          const opened = await openPage(
            browser, server, run.run_id, { colorScheme: theme },
          );
          for (const step of steps) await runStep(opened.page, step);
          await sleep(20);
          await opened.context.close();
          absorb(opened.log, {
            template: testCase.manifest.id,
            fixture: testCase.fixture,
            mode: modeName,
            theme,
          });
        }
      }
    }
    const csrf = await server.csrf();
    const realCopyResponse = await fetch(server.url('copy'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RS-CSRF': csrf,
        Origin: `http://127.0.0.1:${PORT}`,
      },
      body: '{}',
    });
    const realCopyProbe = {
      url: realCopyResponse.url || server.url('copy'),
      status: realCopyResponse.status,
      csp: realCopyResponse.headers.get('content-security-policy'),
      synthetic: false,
    };
    requests.push(realCopyProbe.url);
    responses.push({
      url: realCopyProbe.url,
      status: realCopyProbe.status,
      headers: { 'content-security-policy': realCopyProbe.csp },
      synthetic: false,
    });
    if (realCopyProbe.status !== 400) {
      findings.push({ type: 'real_copy_probe_status', status: realCopyProbe.status });
    }
    for (const url of requests) {
      if (!(url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:') || url.startsWith('blob:'))) {
        findings.push({ type: 'external_request', url });
      }
    }
    for (const response of responses) {
      if (response.synthetic) continue;
      if (!response.headers['content-security-policy']) findings.push({ type: 'missing_csp', url: response.url, status: response.status });
    }
    return {
      mode: 'network', ok: findings.length === 0, request_count: requests.length,
      response_count: responses.length, requests: [...new Set(requests)],
      responses, scenarios, real_copy_probe: realCopyProbe, findings,
      coverage: coverageReport(allCases, executedCases),
    };
  });
}

function flattenStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => flattenStrings(item, output));
  return output;
}

function textMatchers() {
  const de = json(path.join(ROOT, 'core', 'i18n', 'de.json'));
  const bots = Object.values(json(path.join(ROOT, 'core', 'bots.json')));
  const regexes = Object.values(de).map((value) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '.+?');
    return new RegExp(`^${escaped}$`, 'u');
  });
  return { regexes, bots };
}

async function stringsMode() {
  const { regexes, bots } = textMatchers();
  return withHarness(async ({ server, browser }) => {
    const findings = [];
    let nodes = 0;
    const expectedCases = fixtureCases(requestedTemplate);
    const executedCases = [];
    for (const testCase of expectedCases) {
      await cancelOpen(server);
      const run = await show(server, testCase);
      const { context, page } = await openPage(browser, server, run.run_id);
      try {
        const visible = await page.evaluate(() => {
          const hasArea = (rect) => rect.width > 0 && rect.height > 0;
          const clipsAxis = (value) => value === 'hidden' || value === 'clip';
          const fullyClipped = (style) => {
            if (style.clip !== 'auto') {
              const lengths = style.clip.match(/-?\d+(?:\.\d+)?/gu);
              if (lengths?.length === 4 && lengths.every((value) => Number(value) === 0)) {
                return true;
              }
            }
            const inset = style.clipPath.match(/^inset\(([^)]+)\)/u);
            if (inset) {
              const values = inset[1].split(/\s+/u).filter(Boolean);
              const expanded = values.length === 1 ? values.concat(values, values, values)
                : values.length === 2 ? [values[0], values[1], values[0], values[1]]
                  : values.length === 3 ? [values[0], values[1], values[2], values[1]]
                    : values;
              const percentages = expanded.map((value) => (
                value.endsWith('%') ? Number.parseFloat(value) : null
              ));
              if (
                percentages.length === 4
                && (
                  percentages[0] + percentages[2] >= 100
                  || percentages[1] + percentages[3] >= 100
                )
              ) return true;
            }
            return /^circle\(0(?:px)?(?:\s+at\b|\))/u.test(style.clipPath)
              || /^ellipse\(0(?:px)?\s+0(?:px)?(?:\s+at\b|\))/u.test(style.clipPath);
          };
          const renderedRects = (textNode) => {
            const range = document.createRange();
            range.selectNodeContents(textNode);
            let rects = [...range.getClientRects()].filter(hasArea);
            if (!rects.length) return [];
            const parentStyle = getComputedStyle(textNode.parentElement);
            if (parentStyle.visibility === 'hidden' || parentStyle.visibility === 'collapse') {
              return [];
            }
            for (
              let element = textNode.parentElement;
              element && rects.length;
              element = element.parentElement
            ) {
              const style = getComputedStyle(element);
              if (
                style.display === 'none'
                || style.contentVisibility === 'hidden'
                || Number.parseFloat(style.opacity) === 0
                || fullyClipped(style)
              ) return [];
              const clipX = clipsAxis(style.overflowX);
              const clipY = clipsAxis(style.overflowY);
              if (clipX || clipY) {
                const box = element.getBoundingClientRect();
                rects = rects.filter((rect) => (
                  (!clipX || (rect.right > box.left && rect.left < box.right))
                  && (!clipY || (rect.bottom > box.top && rect.top < box.bottom))
                ));
              }
            }
            return rects;
          };
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const result = [];
          let node;
          while ((node = walker.nextNode())) {
            const text = node.textContent.replace(/\s+/g, ' ').trim();
            const parent = node.parentElement;
            if (!text || !parent) continue;
            if (!renderedRects(node).length) continue;
            result.push({
              text,
              created_metadata: Boolean(parent.closest('#rs-meta span:last-child')),
            });
          }
          return result;
        });
        const payload = flattenStrings(testCase.data)
          .map((item) => item.replace(/\s+/g, ' ').trim())
          .filter((item) => item.length > 1);
        const envelope = flattenStrings(registrationEnvelope(testCase))
          .map((item) => item.replace(/\s+/g, ' ').trim())
          .filter((item) => item.length > 1);
        const expectedDateTexts = new Set([
          TIME_BASELINE.default.display,
          `Erstellt ${TIME_BASELINE.default.display}`,
        ]);
        for (const observed of visible) {
          const text = typeof observed === 'string' ? observed : observed.text;
          const createdMetadata = (
            typeof observed === 'object' && observed.created_metadata === true
          );
          nodes += 1;
          const exactDate = expectedDateTexts.has(text);
          const fromPayload = payload.some((item) => item === text || item.includes(text));
          if (
            (createdMetadata && !exactDate) ||
            (!createdMetadata && !fromPayload && !envelope.includes(text) &&
              !bots.includes(text) && !regexes.some((pattern) => pattern.test(text)))
          ) {
            findings.push({ template: testCase.manifest.id, fixture: testCase.fixture, text });
          }
        }
        executedCases.push(testCase);
      } finally { await context.close(); }
    }
    return {
      mode: 'strings',
      ok: findings.length === 0 && nodes > 0 && executedCases.length === expectedCases.length,
      nodes,
      findings,
      coverage: coverageReport(expectedCases, executedCases),
    };
  });
}

function calmFixtureCases(selected) {
  const all = fixtureCases(selected);
  const cases = all.filter((item) => ['golden', 'edge-max'].includes(item.fixture));
  for (const template of templates(selected)) {
    const fixtures = new Set(
      cases.filter((item) => item.manifest.id === template.manifest.id)
        .map((item) => item.fixture),
    );
    for (const required of ['golden', 'edge-max']) {
      if (!fixtures.has(required)) {
        throw new Error(`${template.manifest.id}: calm mode requires fixtures/${required}.json`);
      }
    }
  }
  return cases;
}

async function calmRestingFacts(
  page,
  testCase,
  openRuns,
  verifiedRovingGroups = [],
  settleTransitions = false,
) {
  await page.mouse.move(-1, -1);
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.body.focus();
  });
  if (settleTransitions) {
    await settleShortAnimations(page);
  }
  return page.evaluate(calmEvaluator, {
    thresholds: CALM_THRESHOLDS,
    templateId: testCase.manifest.id,
    openRuns,
    verifiedRovingGroups,
  });
}

async function calmScene(browser, server, testCase, scene) {
  await cancelOpen(server);
  const runs = await Promise.all(Array.from(
    { length: scene.openRuns },
    () => show(server, testCase),
  ));
  const active = runs.at(-1);
  const opened = await openPage(browser, server, active.run_id, {
    colorScheme: scene.theme,
    viewport: scene.viewport,
    reducedMotion: 'no-preference',
    copyHandler: () => {},
  });
  try {
    const facts = await calmRestingFacts(opened.page, testCase, scene.openRuns);
    if (
      testCase.fixture === 'golden'
      && scene.viewport.width === 1500
      && scene.viewport.height === 1000
    ) {
      const screenshot = await opened.page.screenshot({ type: 'png' });
      facts.K7.background_ratio = pngBackgroundRatio(
        screenshot,
        facts.K7.page_background,
        CALM_THRESHOLDS.backgroundChannelTolerance,
      );
    }
    let keyboard = { pass: true, error: null };
    try {
      const tab = await tabAudit(opened.page, {
        expectedOpenRuns: scene.openRuns,
      });
      const verifiedRovingGroups = tab.groups.map((group) => group.identity);
      const recounted = await calmRestingFacts(
        opened.page,
        testCase,
        scene.openRuns,
        verifiedRovingGroups,
        true,
      );
      facts.K2 = recounted.K2;
      facts.K9 = recounted.K9;
    } catch (error) {
      if (error?.code === 'RS_ANIMATION_SETTLE_TIMEOUT') throw error;
      keyboard = { pass: false, error: String(error) };
    }
    const copyFocus = await auditCopyFocus(
      opened.page,
      (visit) => reveal(
        opened.page,
        'rs-copy button,[data-copy-id] button,button[data-copy-id],[data-rs-copy]',
        { all: true, visit },
      ),
    );
    const platformSwitching = testCase.manifest.id === 'synthetic-platform-preview'
      ? await auditPlatformSwitching(opened.page)
      : null;
    let accessibility;
    try {
      await opened.page.addScriptTag({ path: AXE });
      accessibility = await opened.page.evaluate(async () => {
        const unnamed = [...document.querySelectorAll(
          'button,input,select,textarea,[role=button],[role=tab],[role=radio],[role=checkbox],[role=switch],[role=menuitem]',
        )].filter((element) => {
          if (element.closest('[inert],details:not([open])')) return false;
          const name = [
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.labels?.[0]?.textContent,
            element.textContent,
            element.value,
          ].find((value) => String(value || '').trim());
          return !name;
        }).length;
        const positiveTabindex = [...document.querySelectorAll('[tabindex]')]
          .filter((element) => element.tabIndex > 0).length;
        const violations = (await window.axe.run(document)).violations
          .filter((item) => ['serious', 'critical'].includes(item.impact))
          .map((item) => item.id);
        return {
          pass: document.documentElement.lang === 'de'
            && unnamed === 0
            && positiveTabindex === 0
            && violations.length === 0,
          unnamed,
          positive_tabindex: positiveTabindex,
          violations,
        };
      });
    } catch (error) {
      accessibility = { pass: false, error: String(error) };
    }
    facts.K9.measured = testCase.fixture === 'golden'
      && scene.viewport.width === 1280
      && scene.viewport.height === 720;
    if (platformSwitching) facts.K10.interaction = platformSwitching;
    await opened.page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await calmRestingFacts(
      opened.page,
      testCase,
      scene.openRuns,
    );
    facts.K12 = { normal: facts.K12, reduced: reduced.K12 };
    facts.K13 = {
      copy_focus: copyFocus,
      keyboard,
      accessibility,
      dependency: 'C16 requires C12 and C13 evidence',
    };
    return facts;
  } finally {
    await closeAuditContext(opened.context);
  }
}

async function calmMode() {
  if (!requestedTemplate) throw new Error('calm mode requires a template id');
  return withHarness(async ({ server, browser }) => {
    const cases = calmFixtureCases(requestedTemplate);
    const scenes = [];
    for (const testCase of cases) {
      for (const theme of ['light', 'dark']) {
        for (const viewport of [
          { width: 1500, height: 1000 },
          { width: 1280, height: 720 },
        ]) {
          const base = {
            template: testCase.manifest.id,
            fixture: testCase.fixture,
            theme,
            viewport,
          };
          for (const openRuns of [1, 3]) {
            let facts;
            try {
              facts = await calmScene(
                browser,
                server,
                testCase,
                { ...base, openRuns },
              );
            } catch (error) {
              if (error?.code !== 'RS_ANIMATION_SETTLE_TIMEOUT') throw error;
              const reason = `audit scene did not settle: ${error.message}`;
              scenes.push({
                ...base,
                open_runs: openRuns,
                items: Object.fromEntries(Array.from(
                  { length: 13 },
                  (_, index) => [
                    `K${index + 1}`,
                    {
                      pass: false,
                      reasons: [reason],
                      raw: { audit_error: error.message },
                    },
                  ],
                )),
                ok: false,
              });
              continue;
            }
            const judged = judgeCalmFacts(facts, {
              templateId: testCase.manifest.id,
              k13: {
                keyboard: facts.K13.keyboard.pass,
                accessibility: facts.K13.accessibility.pass,
                copy_focus: facts.K13.copy_focus.pass,
              },
            });
            scenes.push({
              ...base,
              open_runs: openRuns,
              items: judged.items,
              ok: judged.ok,
            });
          }
        }
      }
    }
    const items = {};
    for (let index = 1; index <= 13; index += 1) {
      const name = `K${index}`;
      const failed = scenes.filter((scene) => !scene.items[name].pass);
      items[name] = {
        pass: failed.length === 0,
        reasons: failed.flatMap((scene) => scene.items[name].reasons.map(
          (reason) => (
            `${scene.template}/${scene.fixture}/${scene.theme}/`
            + `${scene.viewport.width}x${scene.viewport.height}: ${reason}`
          ),
        )),
        raw: scenes.map((scene) => ({
          template: scene.template,
          fixture: scene.fixture,
          theme: scene.theme,
          viewport: scene.viewport,
          open_runs: scene.open_runs,
          ...scene.items[name].raw,
        })),
      };
    }
    return {
      mode: 'calm',
      template: requestedTemplate,
      ok: Object.values(items).every((item) => item.pass),
      passed: Object.values(items).filter((item) => item.pass).length,
      total: 13,
      thresholds: CALM_THRESHOLDS,
      items,
      scenes,
      coverage: coverageReport(cases, cases),
      k13_dependency: 'C16 requires C12 and C13 evidence; score.py supplies those gate results',
    };
  });
}

async function timeMode() {
  return withHarness(async ({ server, browser }) => {
    const testCase = fixtureCases('_starter', {
      expectOnly: true,
      goldenOnly: true,
    })[0];
    const findings = [];
    const cases = [];
    const csrf = await server.csrf();
    for (const expected of TIME_BASELINE.cases) {
      await cancelOpen(server);
      const run = server.show(testCase.data, {
        ...registrationEnvelope(testCase),
        title: `Zeitprüfung ${expected.name}`,
        created: expected.created,
      });
      await server.assertOpen(run.run_id, `time/${expected.name}`);
      const response = await fetch(server.url('submit'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RS-CSRF': csrf,
          Origin: `http://127.0.0.1:${PORT}`,
        },
        body: JSON.stringify({ run_id: run.run_id, data: testCase.expect.result }),
      });
      if (response.status !== 200) {
        findings.push({ name: expected.name, error: `submit returned ${response.status}` });
        continue;
      }
      const result = server.result(run.run_id);
      const required = {
        schema: (value) => value === 'report-shell/result@1',
        run_id: (value) => value === run.run_id,
        template: (value) => value === testCase.manifest.id,
        template_version: (value) => Number.isInteger(value),
        bot: (value) => typeof value === 'string' && value.length > 0,
        status: (value) => value === 'submitted',
        created: (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)),
        decided: (value) => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)),
        duration_s: (value) => Number.isInteger(value) && value >= 0,
        log: (value) => typeof value === 'string' && value.length > 0,
        data: (value) => value !== undefined,
      };
      for (const [field, valid] of Object.entries(required)) {
        if (!valid(result?.[field])) {
          findings.push({ name: expected.name, field, error: 'invalid result envelope field' });
        }
      }
      const { context, page } = await openPage(browser, server, run.run_id);
      try {
        const rendered = await page.textContent('#rs-meta span:last-child');
        const display = String(rendered || '').replace(/^Erstellt\s+/u, '');
        const decidedOffset = offsetSuffix(result?.decided);
        const expectedDecidedOffset = result?.decided
          ? expectedViennaOffset(result.decided)
          : null;
        if (
          !['+01:00', '+02:00'].includes(decidedOffset)
          || !['+01:00', '+02:00'].includes(expectedDecidedOffset)
        ) {
          findings.push({
            name: expected.name,
            field: 'decided',
            error: 'decided must have a concrete Vienna offset',
          });
        }
        const actual = {
          name: expected.name,
          input_created: expected.created,
          display,
          persisted_created: result?.created || null,
          created_offset: offsetSuffix(result?.created),
          decided_offset: decidedOffset,
          expected_decided_offset: expectedDecidedOffset,
        };
        cases.push(actual);
        for (const [field, wanted] of [
          ['display', expected.display],
          ['persisted_created', expected.persisted_created],
          ['created_offset', expected.created_offset],
          ['decided_offset', expectedDecidedOffset],
        ]) {
          if (actual[field] !== wanted) {
            findings.push({
              name: expected.name,
              field,
              expected: wanted,
              actual: actual[field],
            });
          }
        }
      } finally {
        await context.close();
      }
    }
    return {
      mode: 'time',
      ok: findings.length === 0 && cases.length === TIME_BASELINE.cases.length,
      passed: TIME_BASELINE.cases.filter(
        (item) => !findings.some((finding) => finding.name === item.name),
      ).length,
      total: TIME_BASELINE.cases.length,
      locale: TIME_BASELINE.locale,
      time_zone: TIME_BASELINE.timeZone,
      cases,
      findings,
    };
  });
}

function persistNetworkLog() {
  if (!netlogDir) return null;
  mkdirSync(netlogDir, { recursive: true });
  const filename = `${Date.now()}-${process.pid}-${mode}-${randomUUID()}.json`;
  const destination = path.join(netlogDir, filename);
  writeFileSync(destination, `${JSON.stringify({
    schema: 'report-shell/netlog@1',
    mode,
    template: requestedTemplate,
    ...runNetwork,
  })}\n`, 'utf8');
  return destination;
}

const runners = {
  copy: copyMode,
  expect: expectMode,
  submit: submitMode,
  keyboard: keyboardMode,
  'a11y-basic': a11yBasicMode,
  axe: axeMode,
  network: networkMode,
  strings: stringsMode,
  calm: calmMode,
  time: timeMode,
};

if (!runners[mode]) {
  console.error(`usage: node tools/e2e.mjs <${Object.keys(runners).join('|')}> [template-id|--all]`);
  process.exit(2);
}

let result;
try {
  result = await runners[mode]();
} catch (error) {
  result = { mode, ok: false, error: error.stack || String(error) };
}
try {
  result.netlog = persistNetworkLog();
} catch (error) {
  result.ok = false;
  result.netlog_error = error.stack || String(error);
}
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
