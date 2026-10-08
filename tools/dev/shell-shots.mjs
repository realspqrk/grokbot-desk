// Dev screenshots of the real served shell with the _starter golden
// (isolated server on 18895, temp data dir, headless Edge 1500x1000 DPR 1).
// Writes tools/dev/out/starter-{light,dark}.png (fresh golden, second run in
// the rail) and starter-flow-{light,dark}.png (choice made, Kopiert ✓,
// note typed). /copy is answered by page.route here, so the real clipboard
// is never touched.
// Usage: node tools/dev/shell-shots.mjs
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  browserChannel,
  startServer,
  loadChromium,
  ROOT,
} from './rs-server.mjs';

const out = path.join(ROOT, 'tools/dev/out');
mkdirSync(out, { recursive: true });
const golden = JSON.parse(readFileSync(path.join(ROOT, 'templates/global/_starter/fixtures/golden.json'), 'utf8'));
const measurementBot = JSON.parse(
  readFileSync(path.join(ROOT, 'tools/measurement.json'), 'utf8'),
).bot_id;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found');
const server = await startServer({ port: 18925 });
const browser = await chromium.launch({ channel: browserChannel(), headless: true });
try {
  server.show(golden, { title: 'Wochenbericht Server', created: iso(Date.now() - 3 * 3600e3), bot: measurementBot });
  const run = server.show(golden, { title: 'Sicherung prüfen', created: iso(Date.now() - 60e3) });
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    await page.route('**/copy', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await page.goto(server.url('?client=test&run=' + run.run_id));
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
    await page.waitForTimeout(500); // POST /read for the active run
    await page.screenshot({ path: path.join(out, `starter-${theme}.png`) });
    await page.click('rs-action-row button[value="erledigt"]');
    await page.fill('#starter-note', 'Kontrolle gemacht, Log sieht gut aus.');
    await page.click('[data-copy-id="starter-copy"] .rs-copy__btn');
    await page.waitForSelector('[data-copy-id="starter-copy"][data-state="copied"]');
    await page.keyboard.press('Shift');
    await page.focus('rs-action-row button[value="erledigt"]');
    await page.screenshot({ path: path.join(out, `starter-flow-${theme}.png`) });
    await page.evaluate(() => localStorage.clear());
    console.log(theme, errors.length ? 'console: ' + errors.join(' | ') : 'no console errors');
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.stop();
}
console.log('screenshots: ' + out);
