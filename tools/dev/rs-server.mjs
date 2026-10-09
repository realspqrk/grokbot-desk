// Isolated grokbot-desk server for browser tests and dev screenshots.
// Never uses port 18742 or the real %LOCALAPPDATA%\grokbot-desk:
// every server gets its own temp RS_DATA_DIR.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolvePythonExecutable(environment = process.env, run = spawnSync) {
  const command = environment.RS_PYTHON || 'py';
  const commandArgs = environment.RS_PYTHON ? [] : ['-3'];
  const result = run(
    command,
    [...commandArgs, '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8', windowsHide: true, shell: false },
  );
  const executable = result.stdout?.trim();
  if (result.status !== 0 || !executable) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`could not resolve Python interpreter ${command}: ${detail}`);
  }
  return executable;
}

export function spawnPythonProcess(executable, args, options, spawnProcess = spawn) {
  return spawnProcess(executable, args, { ...options, shell: false });
}

const PYTHON = resolvePythonExecutable();

function timeoutMs(environment, name, fallback) {
  const value = Number(environment[name]);
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.max(value, 1000), 120000)
    : fallback;
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
    throw new Error('refusing the production default port 18742');
  }
  return port;
}

export async function startServer({ port, mediaRoots = [], env: environment = {} }) {
  validateServerPort(port);
  if (await hello(port)) throw new Error(`a grokbot-desk server is already running on ${port}`);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rs-test-'));
  if (mediaRoots.length) {
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      port,
      media_roots: mediaRoots,
      window: { x: 0, y: 0, width: 1500, height: 1000 },
    }), 'utf8');
  }
  const env = {
    ...process.env,
    ...environment,
    RS_CLI_HTTP_TIMEOUT: (
      environment.RS_CLI_HTTP_TIMEOUT
      || process.env.RS_CLI_HTTP_TIMEOUT
      || '15'
    ),
    RS_DATA_DIR: dataDir,
  };
  const proc = spawnPythonProcess(PYTHON, [path.join(ROOT, 'report_shell.py'), '--port', String(port), 'serve'], {
    cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false,
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const deadline = Date.now() + timeoutMs(env, 'RS_SERVER_START_TIMEOUT_MS', 15000);
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('server exited: ' + stderr);
    if (await hello(port)) break;
    await sleep(100);
  }
  if (!(await hello(port))) { proc.kill(); throw new Error('server did not start: ' + stderr); }
  const server = {
    port, dataDir, env, proc,
    url: (q = '') => `http://127.0.0.1:${port}/${q}`,
    show(data, extra = {}) { return show(server, data, extra); },
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
    /** Cancels every open run through the real API (deterministic rail for the next test). */
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
/** Registers a run. `data` = template data; `extra` = envelope overrides (title, created, template, ...). */
export function show(server, data, extra = {}) {
  seq += 1;
  const template = extra.template || '_starter';
  const envelope = {
    schema: 'report-shell/payload@1',
    template,
    version: 1,
    bot: 'agent',
    title: 'Testbericht ' + seq,
    created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    data,
    ...extra,
  };
  const file = path.join(server.dataDir, `payload-${process.pid}-${seq}.json`);
  writeFileSync(file, JSON.stringify(envelope), 'utf8');
  const out = spawnSync(PYTHON, [path.join(ROOT, 'report_shell.py'), '--port', String(server.port), 'show', template, '--data', file, '--no-window'], {
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

export async function stopServer(server) {
  if (!server) return;
  if (!server.stopPromise) {
    server.stopPromise = (async () => {
      const hasExited = () => (
        server.proc.exitCode !== null || server.proc.signalCode !== null
      );
      const awaitExit = async (milliseconds) => {
        const deadline = Date.now() + milliseconds;
        while (!hasExited() && Date.now() < deadline) await sleep(50);
        return hasExited();
      };
      try {
        const state = JSON.parse(readFileSync(path.join(server.dataDir, 'state.json'), 'utf8'));
        const response = await fetch(`http://127.0.0.1:${server.port}/stop`, {
          method: 'POST', headers: { 'X-RS-Token': state.token, 'Content-Type': 'application/json' }, body: '{}',
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error(`server stop returned ${response.status}`);
      } catch { /* fall through to retained-handle cleanup */ }
      if (!(await awaitExit(4000))) {
        try { server.proc.kill(); } catch { /* verify exit below */ }
        await awaitExit(4000);
      }
      if (!hasExited()) {
        throw new Error(
          `retained server process ${server.proc.pid} did not exit; `
          + `keeping temporary state at ${server.dataDir}`,
        );
      }
      try { rmSync(server.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    })();
  }
  await server.stopPromise;
}
