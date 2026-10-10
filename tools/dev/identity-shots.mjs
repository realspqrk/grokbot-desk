// Dev screenshots for bot identity: strip + header of the served shell with
// five sample bots (isolated server, temp data dir, headless Edge, English UI).
// Scenes: default (shipped name, initials, default accent), custom (payload
// accent), lowcontrast (accent fails in light -> default accent), broken
// (avatar path missing -> initials), initials (no avatar). Each scene's title
// matches its message. Each in light + dark at
// 1280x720 and 1920x1080. /copy is answered by page.route (no real clipboard).
// Usage: node tools/dev/identity-shots.mjs <out-dir> [port]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium } from './rs-server.mjs';

const out = path.resolve(process.argv[2] || 'tools/dev/out/identity');
const port = Number(process.argv[3] || 18979);
mkdirSync(out, { recursive: true });
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const message = (text, label, copy) => ({ message: text, copy: { label, text: copy } });
const BOTS = {
  default: {
    title: '23 emails sorted · 4 need you', bot: 'inbox-agent',
    data: message('23 new emails are sorted into folders. Four need a reply from you today; drafts are ready in the Replies folder.', 'Copy folder', 'Inbox/Replies'),
  },
  custom: {
    title: 'Launch post: Harvest Blend', bot: 'research-agent', identity: { accent: '#0891b2' },
    data: message('The launch post for the Harvest Blend coffee is drafted. Please confirm it can go out on Thursday morning.', 'Copy post link', 'https://shop.example.invalid/harvest-blend'),
  },
  lowcontrast: {
    title: 'Trip plan for the Lisbon offsite', bot: 'example-travel-bot', identity: { name: 'Travel Agent', accent: '#f6c945' },
    data: message('Flights and hotel for the Lisbon offsite are on hold until Friday. Please confirm the plan, or move the decision to later.', 'Copy booking ref', 'NW-TRV-20418'),
  },
  broken: {
    title: 'Meetings to move next week', bot: 'example-calendar-bot', identity: { name: 'Calendar Agent', avatar: 'avatars/missing.png' },
    data: message('Three meetings next week clash with the offsite. New slots are proposed in the calendar; please confirm.', 'Copy calendar', 'Team calendar, week 42'),
  },
  initials: {
    title: 'Nightly backup: confirm the check', bot: 'operations-agent',
    data: message('The nightly backup finished without errors. Please confirm that the check is done, or move it to later.', 'Copy path', '\\\\files.example.invalid\\backup\\2026-10-08\\nightly.log'),
  },
};

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const server = await startServer({ port, env: { RS_LANG: 'en' } });
const browser = await chromium.launch({ channel: browserChannel(), headless: true });
const written = [];
try {
  const ids = {};
  Object.entries(BOTS).forEach(([scene, bot], index) => {
    ids[scene] = server.show(bot.data, {
      title: bot.title, bot: bot.bot, created: iso(Date.now() - (index + 1) * 600e3),
      ...(bot.identity ? { identity: bot.identity } : {}),
    }).run_id;
  });
  for (const scene of Object.keys(BOTS)) {
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [[1280, 720], [1920, 1080]]) {
        const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await page.route('**/copy', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
        await page.goto(server.url(`?client=test&run=${ids[scene]}`));
        await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
        await page.waitForFunction(() => [...document.images].every((img) => img.complete));
        // a choice enables the primary, so the report's accent is visible
        await page.click('rs-action-row button[value="erledigt"]');
        await page.mouse.move(width - 2, height / 2);
        await page.evaluate(() => document.activeElement?.blur());
        await page.waitForTimeout(250);
        const file = path.join(out, `${scene}-${theme}-${width}x${height}.png`);
        await page.screenshot({ path: file });
        written.push(file);
        await page.evaluate(() => localStorage.clear());
        if (errors.length) console.error(scene, theme, errors.join(' | '));
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.stop();
}
console.log(written.join('\n'));
