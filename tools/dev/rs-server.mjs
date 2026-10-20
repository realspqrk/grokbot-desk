// Isolated grokbot-desk server for browser tests and dev screenshots.
// Never uses the product port or the real data folder:
// every server gets its own temp RS_DATA_DIR.
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// RS_PYTHON wins; otherwise the py launcher on Windows. Elsewhere, like the
// report-shell launcher: macOS's /usr/bin/python3 is 3.9 and Homebrew adds
// only versioned names, so try those first.
const POSIX_NAMES = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3'];

export function pythonCandidates(environment = process.env, platform = process.platform) {
  if (environment.RS_PYTHON) return [{ command: environment.RS_PYTHON, args: [] }];
  if (platform === 'win32') return [{ command: 'py', args: ['-3'] }];
  return POSIX_NAMES.flatMap((name) => [name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`])
    .map((command) => ({ command, args: [] }));
}

const PROBE = [
  'import sys',
  'if sys.version_info < (3, 11): raise SystemExit("Python " + sys.version.split()[0])',
  'print(sys.executable)',
].join('\n');

export function resolvePythonExecutable(environment = process.env, run = spawnSync, platform = process.platform) {
  const tried = [];
  for (const { command, args } of pythonCandidates(environment, platform)) {
    const result = run(command, [...args, '-c', PROBE], { encoding: 'utf8', windowsHide: true, shell: false });
    const executable = result.stdout?.trim();
    if (result.status === 0 && executable) return executable;
    tried.push(`${command}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  throw new Error(`no Python 3.11 or later found; set RS_PYTHON (${tried.join('; ')})`);
}

export function spawnPythonProcess(executable, args, options, spawnProcess = spawn) {
  return spawnProcess(executable, args, { ...options, shell: false });
}

export const PYTHON = resolvePythonExecutable();
const MEASUREMENT_BOT_ID = JSON.parse(
  readFileSync(path.join(ROOT, 'tools', 'measurement.json'), 'utf8'),
).bot_id;

function timeoutMs(environment, name, fallback) {
  const value = Number(environment[name]);
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.max(value, 1000), 120000)
    : fallback;
}

export function serverStderrTail(stderrPath, maxBytes = 8192) {
  try {
    const content = readFileSync(stderrPath);
    return content.subarray(Math.max(0, content.length - maxBytes)).toString('utf8');
  } catch {
    return '';
  }
}

function serverStartupError(message, proc, stderrPath) {
  const status = proc.exitCode !== null
    ? `exit code ${proc.exitCode}`
    : proc.signalCode !== null
      ? `signal ${proc.signalCode}`
      : 'process still running';
  const tail = serverStderrTail(stderrPath).trimEnd() || '<empty>';
  return new Error(`${message} (${status}); server stderr tail:\n${tail}`);
}

export function playwrightPath(environment = process.env) {
  return environment.RS_PLAYWRIGHT_CORE || null;
}

export function browserChannel(platform = process.platform, environment = process.env) {
  return environment.RS_BROWSER_CHANNEL || (platform === 'win32' ? 'msedge' : 'chrome');
}

export async function loadChromium() {
  const p = playwrightPath();
  if (p) {
    if (!existsSync(p)) {
      throw new Error(`RS_PLAYWRIGHT_CORE does not exist: ${p}`);
    }
    return (await import(pathToFileURL(p).href)).chromium;
  }
  try {
    return (await import('playwright-core')).chromium;
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processHasExited(proc) {
  return proc.exitCode !== null || proc.signalCode != null;
}

export async function awaitProcessExit(proc, timeoutMs, sleepFn = sleep) {
  const deadline = Date.now() + timeoutMs;
  while (!processHasExited(proc) && Date.now() < deadline) await sleepFn(50);
  return processHasExited(proc);
}

async function hello(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hello`, { signal: AbortSignal.timeout(500) });
    const body = await res.json();
    return body.runner === 'grokbot-desk/1' ? body : null;
  } catch {
    return null;
  }
}

export function validateServerPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('isolated server port must be a valid TCP port');
  }
  if (port === 18742) {
    throw new Error('refusing the product default port 18742');
  }
  return port;
}

export async function startServer({ port, mediaRoots = [], env: environment = {}, dataDir = null }) {
  validateServerPort(port);
  if (await hello(port)) throw new Error(`a report-shell server is already running on ${port}`);
  const ownsDataDir = dataDir == null;
  if (ownsDataDir) {
    dataDir = mkdtempSync(path.join(tmpdir(), 'rs-test-'));
    if (mediaRoots.length) {
      writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
        port,
        media_roots: mediaRoots,
        window: { x: 0, y: 0, width: 1500, height: 1000 },
      }), 'utf8');
    }
  }
  const env = {
    ...process.env,
    ...environment,
    RS_CLI_HTTP_TIMEOUT: (
      environment.RS_CLI_HTTP_TIMEOUT
      || process.env.RS_CLI_HTTP_TIMEOUT
      || '15'
    ),
    /* times follow the machine's zone; tests and screenshots pin one */
    RS_TZ: environment.RS_TZ || process.env.RS_TZ || 'Europe/Vienna',
    RS_DATA_DIR: dataDir,
  };
  const stderrPath = path.join(dataDir, 'server.stderr.log');
  const stderrFd = openSync(stderrPath, 'w');
  let proc;
  try {
    try {
      proc = spawnPythonProcess(PYTHON, [path.join(ROOT, 'report_shell.py'), '--port', String(port), 'serve'], {
        cwd: ROOT, env, stdio: ['ignore', 'ignore', stderrFd], windowsHide: true, shell: false,
      });
    } finally {
      closeSync(stderrFd);
    }
  } catch (error) {
    if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const deadline = Date.now() + timeoutMs(env, 'RS_SERVER_START_TIMEOUT_MS', 15000);
  while (Date.now() < deadline) {
    if (processHasExited(proc)) {
      const error = serverStartupError('server exited before becoming ready', proc, stderrPath);
      if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
      throw error;
    }
    if (await hello(port)) break;
    await sleep(100);
  }
  if (!(await hello(port))) {
    try { proc.kill(); } catch { /* report retained process status below */ }
    await awaitProcessExit(proc, 2000);
    const error = serverStartupError('server did not start', proc, stderrPath);
    if (processHasExited(proc) && ownsDataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    throw error;
  }
  const server = {
    port, dataDir, env, proc,
    url: (q = '') => `http://127.0.0.1:${port}/${q}`,
    show(payload, extra = {}) { return show(server, payload, extra); },
    assertOpen(runId, context) { return assertRunOpen(server, runId, context); },
    result(runId) {
      const p = path.join(dataDir, 'results', runId + '.json');
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    },
    async stop() { await stopServer(server); },
    async csrf() {
      const page = await (await fetch(server.url())).text();
      const m = page.match(/<script id="rs-boot" type="application\/json">([\s\S]*?)<\/script>/);
      return JSON.parse(m[1]).csrf;
    },
    /** Cancels every open run through the real API (deterministic strip for the next test). */
    async clearRuns() {
      const csrf = await server.csrf();
      const headers = { 'X-RS-CSRF': csrf, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` };
      const runs = (await (await fetch(server.url('api/runs'), { headers })).json()).runs;
      for (const r of runs) {
        await fetch(server.url('cancel'), { method: 'POST', headers, body: JSON.stringify({ run_id: r.run_id }) });
      }
      return runs.length;
    },
  };
  return server;
}

export async function assertRunOpen(server, runId, context = 'fixture') {
  const response = await fetch(server.url(`api/run/${encodeURIComponent(runId)}`), {
    headers: { 'X-RS-CSRF': await server.csrf() },
  });
  if (!response.ok) {
    throw new Error(`${context}: could not read run ${runId} (${response.status})`);
  }
  const detail = await response.json();
  if (detail.state !== 'open') {
    throw new Error(`${context}: expected run ${runId} to be open, got ${detail.state}`);
  }
  return detail;
}

let seq = 0;
/* A small read report: what a test registers when only the envelope matters. */
export const PLAIN_REPORT = Object.freeze({
  ask: 'read',
  why: 'The nightly check finished.',
  blocks: [{ type: 'facts', items: [{ label: 'Duration', value: '42 min' }] }],
});

/** Registers a payload@2 report through the CLI (`show --data`), as a bot
 *  does. `payload` = a payload or a fixture (tests/fixtures/payloads);
 *  `extra` = envelope overrides (title, bot, identity, created, ...). The
 *  report is created now unless `extra.created` says otherwise, and a
 *  fixture's dedupe key is dropped, so the same fixture can be shown twice. */
export function show(server, payload = PLAIN_REPORT, extra = {}) {
  seq += 1;
  const { dedupe_key: _key, dedupe_hours: _hours, ...body } = payload;
  const envelope = {
    schema: 'grokbot-desk/payload@2',
    bot: MEASUREMENT_BOT_ID,
    title: 'Testbericht ' + seq,
    ...body,
    created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    ...extra,
  };
  const file = path.join(server.dataDir, `payload-${process.pid}-${seq}.json`);
  writeFileSync(file, JSON.stringify(envelope), 'utf8');
  const out = spawnSync(PYTHON, [path.join(ROOT, 'report_shell.py'), '--port', String(server.port), 'show', '--data', file, '--no-window'], {
    cwd: ROOT,
    env: server.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: timeoutMs(server.env, 'RS_SHOW_PROCESS_TIMEOUT_MS', 30000),
  });
  if (out.status !== 0) throw new Error(`show failed (${out.status}): ${out.stderr}`);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

export const PAYLOAD_FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'payloads');

/** A payload fixture from tests/fixtures/payloads by name. */
export function payloadFixture(name) {
  return JSON.parse(readFileSync(path.join(PAYLOAD_FIXTURES, `${name}.json`), 'utf8'));
}

/** The names of the valid payload fixtures (one per ask row, plus report-long). */
export function payloadFixtureNames() {
  return readdirSync(PAYLOAD_FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/* a small real PNG (a soft gradient), so fixture images load without errors */
export function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = 120 + Math.round(60 * x / width);
      row[2 + x * 3] = 140 + Math.round(50 * y / height);
      row[3 + x * 3] = 170;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The media of the payload fixtures (/srv/media/...) in a temp folder:
 *  images are small PNGs, a video is a stub no browser can play (the page
 *  must stay calm). `map(payload)` points a fixture's paths into it; pass
 *  `dir` as a media root to startServer. */
export function fixtureMedia() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-fixture-media-'));
  const names = new Set();
  for (const name of payloadFixtureNames()) {
    JSON.stringify(payloadFixture(name), (key, value) => {
      if (typeof value === 'string' && value.startsWith('/srv/media/')) names.add(path.posix.basename(value));
      return value;
    });
  }
  for (const name of names) {
    writeFileSync(path.join(dir, name), /\.(webm|mp4)$/i.test(name) ? Buffer.from('1a45dfa3', 'hex') : png(480, 270));
  }
  return {
    dir,
    map(payload) {
      return JSON.parse(JSON.stringify(payload), (key, value) => (
        typeof value === 'string' && value.startsWith('/srv/media/') ? path.join(dir, path.posix.basename(value)) : value
      ));
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function stopServer(
  server,
  { waitForExit = awaitProcessExit } = {},
) {
  if (!server) return;
  if (!server.stopPromise) {
    server.stopPromise = (async () => {
      try {
        const state = JSON.parse(readFileSync(path.join(server.dataDir, 'state.json'), 'utf8'));
        const response = await fetch(`http://127.0.0.1:${server.port}/stop`, {
          method: 'POST', headers: { 'X-RS-Token': state.token, 'Content-Type': 'application/json' }, body: '{}',
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error(`server stop returned ${response.status}`);
      } catch { /* fall through to retained-handle cleanup */ }
      if (!(await waitForExit(server.proc, 4000))) {
        try { server.proc.kill(); } catch { /* verify exit below */ }
        await waitForExit(server.proc, 4000);
      }
      if (!processHasExited(server.proc)) {
        throw new Error(
          `retained server process ${server.proc.pid} did not exit; `
          + `keeping temporary state at ${server.dataDir}`,
        );
      }
      if (!server.preserveData) {
        try { rmSync(server.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    })();
  }
  await server.stopPromise;
}
