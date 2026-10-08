// Isolated grokbot-desk server for browser tests and dev screenshots.
// Never uses port 18742 or the real %LOCALAPPDATA%\grokbot-desk:
// every server gets its own temp RS_DATA_DIR.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.RS_PYTHON || 'py';
const PY_ARGS = process.env.RS_PYTHON ? [] : ['-3'];

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

export async function startServer({ port, mediaRoots = [], env: environment = {} }) {
  if (port === 18742) throw new Error('refusing to use the production port 18742');
  if (await hello(port)) throw new Error(`a grokbot-desk server is already running on ${port}`);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rs-test-'));
  if (mediaRoots.length) {
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      port,
      media_roots: mediaRoots,
      window: { x: 0, y: 0, width: 1500, height: 1000 },
    }), 'utf8');
  }
  const env = { ...process.env, ...environment, RS_DATA_DIR: dataDir };
  const proc = spawn(PY, [...PY_ARGS, path.join(ROOT, 'report_shell.py'), '--port', String(port), 'serve'], {
    cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const deadline = Date.now() + 8000;
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
  const out = spawnSync(PY, [...PY_ARGS, path.join(ROOT, 'report_shell.py'), '--port', String(server.port), 'show', template, '--data', file, '--no-window'], {
    cwd: ROOT, env: server.env, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  if (out.status !== 0) throw new Error(`show failed (${out.status}): ${out.stderr}`);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

export async function stopServer(server) {
  if (!server) return;
  try {
    const state = JSON.parse(readFileSync(path.join(server.dataDir, 'state.json'), 'utf8'));
    await fetch(`http://127.0.0.1:${server.port}/stop`, {
      method: 'POST', headers: { 'X-RS-Token': state.token, 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* fall through to kill */ }
  const deadline = Date.now() + 4000;
  while (server.proc.exitCode === null && Date.now() < deadline) await sleep(50);
  if (server.proc.exitCode === null) {
    server.proc.kill();
    // py.exe launcher: make sure the python child is gone too
    spawnSync('taskkill', ['/PID', String(server.proc.pid), '/T', '/F'], { windowsHide: true });
  }
  try { rmSync(server.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
