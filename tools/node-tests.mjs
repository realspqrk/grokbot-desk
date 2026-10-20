// Runs the Node test files in two groups: files that start a browser with a
// bounded file concurrency, every other file with node's default. Several
// headless Edge/Chrome instances on one CI runner intermittently fail plain
// local requests with net::ERR_NO_BUFFER_SPACE (WSAENOBUFS) while the server
// and the runner's ports are fine; a desk itself runs one app window.
//
//   node tools/node-tests.mjs gate      unit files (without their timing budgets) + the
//                                       browser smoke set (CI, blocking)
//   node tools/node-tests.mjs browser   every browser file, bounded, + the unit timing
//                                       budgets (CI, advisory)
//   node tools/node-tests.mjs all       unit + every browser file (release gate, locally)
//   [--browser-concurrency N]           default 2
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tests_js');
export const STARTS_BROWSER = /\bloadChromium\b|\bchromium\.launch/;

/* The blocking smoke set: one served page renders a template, the mouse
   and keyboard decide flows write their result, discard writes a cancel,
   the empty state, and the pop-up opens and auto-advances. Exact test
   names, so a renamed test fails the guard test instead of dropping out. */
export const SMOKE = {
  'shell.e2e.test.mjs': [
    'renders the starter golden: strings, copy text, CSP, same-origin only, no console errors',
    'expect.flow (mouse) + Ctrl+Enter writes the result file = expect.result',
    'expect.keyboard (keys only, one open run) writes the same result',
    'Verwerfen asks first, then writes a cancelled result',
    'no open runs: empty state and title',
  ],
  'popup.e2e.test.mjs': [
    '1 open: compact pop-up without an inbox; header = quiet byline, strong report title',
    'a decision auto-advances to the next open report; the last one ends in a calm done state',
  ],
  'inputs.e2e.test.mjs': [
    'half-done decide + chips survive reload, send, reopen read-only',
  ],
  'builtin-review-pick.e2e.test.mjs': [
    'review-doc: a half-done review survives a reload, sends, and reopens read-only',
  ],
};
/* Timing budgets inside unit files. They guard against super-linear
   matching, and a busy shared runner can blow them without any regression,
   so CI runs them in the advisory step, not in the gate. */
export const TIMING = {
  'count.test.mjs': [
    'X: failed non-ASCII TLD matching stays below 50 ms in Node',
    'X: adversarial URL parentheses stay bounded in Node',
  ],
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function groups(dir = DIR, read = (f) => readFileSync(f, 'utf8')) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
  const browser = files.filter((f) => STARTS_BROWSER.test(read(path.join(dir, f))));
  return { unit: files.filter((f) => !browser.includes(f)), browser };
}

const exact = (flag, set) => Object.values(set).flat().map((name) => `${flag}=^${escape(name)}$`);
export function smokeArgs() { return exact('--test-name-pattern', SMOKE); }
export function timingSkipArgs() { return exact('--test-skip-pattern', TIMING); }
export function timingOnlyArgs() { return exact('--test-name-pattern', TIMING); }

function run(files, extra) {
  if (!files.length) return 0;
  const args = ['--test', ...extra, ...files.map((f) => path.join('tests_js', f))];
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const which = process.argv[2] || 'all';
  const i = process.argv.indexOf('--browser-concurrency');
  const limit = i > 0 ? Number(process.argv[i + 1]) : 2;
  if (!['gate', 'browser', 'all'].includes(which) || !(limit >= 1)) {
    console.error('usage: node tools/node-tests.mjs gate|browser|all [--browser-concurrency N]');
    process.exit(2);
  }
  const g = groups();
  let code = 0;
  if (which === 'all') code = run(g.unit, []) || code;
  if (which === 'gate') {
    code = run(g.unit, timingSkipArgs()) || code;
    code = run(Object.keys(SMOKE), [`--test-concurrency=${limit}`, ...smokeArgs()]) || code;
  } else {
    if (which === 'browser') code = run(Object.keys(TIMING), timingOnlyArgs()) || code;
    code = run(g.browser, [`--test-concurrency=${limit}`]) || code;
  }
  process.exit(code);
}
