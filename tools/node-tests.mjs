// Runs the Node test files in two groups: files that start a browser with a
// bounded file concurrency, every other file with node's default. Several
// headless Edge/Chrome instances on one CI runner intermittently fail plain
// local requests with net::ERR_NO_BUFFER_SPACE (WSAENOBUFS) while the server
// and the runner's ports are fine; a desk itself runs one app window.
//   node tools/node-tests.mjs unit|browser|all [--browser-concurrency N]
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tests_js');
export const STARTS_BROWSER = /\bloadChromium\b|\bchromium\.launch/;

export function groups(dir = DIR, read = (f) => readFileSync(f, 'utf8')) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
  const browser = files.filter((f) => STARTS_BROWSER.test(read(path.join(dir, f))));
  return { unit: files.filter((f) => !browser.includes(f)), browser };
}

function run(files, extra) {
  if (!files.length) return 0;
  const args = ['--test', ...extra, ...files.map((f) => path.join('tests_js', f))];
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const which = process.argv[2] || 'all';
  const i = process.argv.indexOf('--browser-concurrency');
  const limit = i > 0 ? Number(process.argv[i + 1]) : 2;
  if (!['unit', 'browser', 'all'].includes(which) || !(limit >= 1)) {
    console.error('usage: node tools/node-tests.mjs unit|browser|all [--browser-concurrency N]');
    process.exit(2);
  }
  const g = groups();
  let code = 0;
  if (which !== 'browser') code = run(g.unit, []) || code;
  if (which !== 'unit') code = run(g.browser, [`--test-concurrency=${limit}`]) || code;
  process.exit(code);
}
