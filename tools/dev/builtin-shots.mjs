// Screenshots of the shipped built-in templates on the real served shell
// (isolated server, temp data dir, headless Edge, English UI by default).
// One open report per shot (no strip), at rest: no hover, no focus. Each
// fixture in light + dark at 1280x720 and 1920x1080. /copy is answered by
// page.route, so the real clipboard is never touched.
// Writes <out>/<template>/<fixture>-<theme>-<w>x<h>.png and prints console
// errors and whether the content scrolls.
// Usage: node tools/dev/builtin-shots.mjs <out-dir> [port] [template[:fixture,...] ...]
//   RS_LANG=de selects the German table.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from './rs-server.mjs';

const out = path.resolve(process.argv[2] || 'tools/dev/out/builtin');
const port = Number(process.argv[3] || 18979);
const lang = process.env.RS_LANG || 'en';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/* neutral sample identities and titles that match the fixtures */
const SHOTS = {
  'decide-list': {
    bot: 'example-inbox-bot',
    identity: { name: 'Inbox Agent', avatar_shape: 'blob', avatar_color: 'orange' },
    fixtures: {
      golden: '5 requests waiting for you',
      'edge-single': '2027 holiday calendar',
    },
  },
  'approve-one': {
    bot: 'example-release-bot',
    identity: { name: 'Release Agent' },
    fixtures: {
      golden: 'Deploy web shop v2.4.0 to production?',
      'edge-access': 'Read access to the reporting database',
    },
  },
  'preview-post': {
    bot: 'example-content-bot',
    identity: { name: 'Content Agent' },
    fixtures: {
      golden: 'Autumn menu launch post',
      'edge-no-image': 'Bread class announcement',
    },
  },
};

function selection(args) {
  if (!args.length) return Object.entries(SHOTS).map(([id, shot]) => [id, Object.keys(shot.fixtures)]);
  return args.map((arg) => {
    const [id, list] = arg.split(':');
    return [id, list ? list.split(',') : Object.keys(SHOTS[id].fixtures)];
  });
}

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const server = await startServer({ port, mediaRoots: [ROOT], env: { RS_LANG: lang } });
const browser = await chromium.launch({ channel: browserChannel(), headless: true });
const written = [];
try {
  for (const [id, fixtures] of selection(process.argv.slice(4))) {
    const shot = SHOTS[id];
    const dir = path.join(ROOT, 'templates', 'builtin', id);
    mkdirSync(path.join(out, id), { recursive: true });
    for (const fixture of fixtures) {
      await server.clearRuns();
      const raw = readFileSync(path.join(dir, 'fixtures', `${fixture}.json`), 'utf8');
      const data = JSON.parse(raw.split('%RS_TEMPLATE%').join(JSON.stringify(dir).slice(1, -1)));
      const run = server.show(data, {
        template: id,
        bot: shot.bot,
        identity: shot.identity,
        title: shot.fixtures[fixture] || fixture,
        created: iso(Date.now() - 120e3),
      });
      for (const theme of ['light', 'dark']) {
        for (const [width, height] of [[1280, 720], [1920, 1080]]) {
          const ctx = await browser.newContext({
            viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce',
          });
          const page = await ctx.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
          await page.route('**/copy', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
          await page.goto(server.url(`?client=test&run=${run.run_id}`));
          await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
          await page.waitForFunction(() => [...document.images].every((img) => img.complete));
          await page.evaluate(() => document.fonts.ready);
          await page.mouse.move(width - 2, height - 2);
          await page.evaluate(() => document.activeElement?.blur());
          await page.waitForTimeout(300);
          const scroll = await page.evaluate(() => {
            const mount = document.getElementById('rs-mount');
            return mount ? { scroll: mount.scrollHeight, client: mount.clientHeight } : null;
          });
          const file = path.join(out, id, `${fixture}-${theme}-${width}x${height}.png`);
          await page.screenshot({ path: file });
          written.push(file);
          console.error(`${id}/${fixture} ${theme} ${width}x${height}: `
            + (scroll ? `content ${scroll.scroll}/${scroll.client}${scroll.scroll > scroll.client ? ' scrolls' : ''}` : 'no mount')
            + (errors.length ? ` console: ${errors.join(' | ')}` : ''));
          await page.evaluate(() => localStorage.clear());
          await ctx.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  await server.stop();
}
console.log(written.join('\n'));
