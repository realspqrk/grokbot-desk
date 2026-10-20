// Per-bot identity in the served shell (headless Edge): inbox + header
// avatar/initials/name and the per-report accent, light and dark. The
// inbox shows other reports' avatar, title and bot name but never their
// accent (C16/K1).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';
import { contrast, parseColor, toHex } from '../tools/colour.mjs';

const PORT = e2ePort('identity.e2e.test.mjs');
/* an approve report: its primary is enabled at once and carries the accent */
const REPORT = {
  ask: 'approve', action: 'deploy', why: 'The release passed staging.',
  blocks: [{ type: 'facts', items: [{ label: 'Version', value: '4.2.0' }] }],
};
const tokensCss = readFileSync(path.join(ROOT, 'core/static/tokens.css'), 'utf8');
const DEFAULT_ACCENT = {
  light: toHex(parseColor(tokensCss.match(/:root\s*\{[^}]*?--rs-accent:\s*(#[0-9a-f]{6}|oklch\([^)]*\))/i)[1])),
  dark: toHex(parseColor(tokensCss.match(/html\[data-theme="dark"\]\s*\{[^}]*?--rs-accent:\s*(#[0-9a-f]{6}|oklch\([^)]*\))/i)[1])),
};
const DEFAULT_HOVER = {
  light: toHex(parseColor(tokensCss.match(/:root\s*\{[^}]*?--rs-accent-hover:\s*(#[0-9a-f]{6}|oklch\([^)]*\))/i)[1])),
  dark: toHex(parseColor(tokensCss.match(/html\[data-theme="dark"\]\s*\{[^}]*?--rs-accent-hover:\s*(#[0-9a-f]{6}|oklch\([^)]*\))/i)[1])),
};
// 1x1 PNG: a valid raster avatar; CORRUPT passes the server's type sniff but
// cannot be decoded, so the page must fall back to initials on its own.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const CORRUPT = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nnot really a png').toString('base64');
const CUSTOM = '#0891b2';
const OTHER = '#a855f7';
const LOW = '#f6c945';

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

function hex(rgb) {
  if (/^\s*(#[0-9a-f]{6}|oklch\()/i.test(String(rgb))) return toHex(parseColor(rgb));
  const m = String(rgb).match(/\d+(\.\d+)?/g);
  return m ? '#' + m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('') : String(rgb);
}

describe('bot identity in inbox and header (served, headless Edge)', { skip }, () => {
  let server;
  let browser;
  const runs = {};

  before(async () => {
    server = await startServer({ port: PORT });
    // user registry next to the data: read before the shipped registry
    writeFileSync(path.join(server.dataDir, 'bots.json'), JSON.stringify({
      'example-user-bot': { name: 'Desk Agent', accent: OTHER },
    }), 'utf8');
    const show = (title, bot, identity) => server.show(REPORT, {
      title, bot, ...(identity === undefined ? {} : { identity }),
    });
    runs.initials = show('Initials report', 'operations-agent');            // shipped legacy string form
    runs.user = show('User registry report', 'example-user-bot');               // user registry accent
    runs.low = show('Low contrast report', 'example-low-bot', { name: 'Travel Agent', accent: LOW });
    runs.broken = show('Broken avatar report', 'example-broken-bot', { name: 'Calendar Agent', avatar: 'avatars/missing.png' });
    runs.corrupt = show('Corrupt avatar report', 'example-corrupt-bot', { name: 'Notes Agent', avatar: CORRUPT });
    runs.markup = show('Markup name report', 'example-markup-bot', { name: '<b>Bold</b> Agent' });
    runs.inbox = show('Default report', 'inbox-agent');                    // shipped name only, default accent
    runs.custom = show('Custom accent report', 'example-custom-bot', { name: 'Research Agent', accent: CUSTOM, avatar: PNG });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

  async function open(runId, theme) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
      colorScheme: theme, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url(`?client=test&run=${runId}`));
    /* ready alone can belong to a first render of another open run; wait
       for the requested run, as the inbox switches below do */
    await page.waitForFunction((id) => window.RS?.activeRun === id && document.documentElement.dataset.rsReady === '1', runId, { timeout: 8000 });
    return { ctx, page, errors };
  }

  const accentOf = async (page) => hex(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rs-accent').trim()));

  async function header(page) {
    return page.evaluate(() => {
      const box = document.querySelector('#rs-bot [data-rs-avatar]');
      const img = box && box.querySelector('img');
      const rect = box.getBoundingClientRect();
      const style = getComputedStyle(box);
      return {
        name: document.querySelector('#rs-bot-name').textContent,
        nameHtml: document.querySelector('#rs-bot-name').innerHTML,
        width: rect.width, height: rect.height,
        radius: style.borderRadius,
        img: img ? { alt: img.getAttribute('alt'), fit: getComputedStyle(img).objectFit, complete: img.complete, natural: img.naturalWidth, src: img.getAttribute('src') } : null,
        initials: box.getAttribute('data-initials'),
        initialsText: getComputedStyle(box, '::before').content,
        hidden: box.getAttribute('aria-hidden'),
        fg: style.color, bg: style.backgroundColor,
      };
    });
  }

  async function inboxItems(page) {
    return page.evaluate(() => [...document.querySelectorAll('#rs-inbox a[data-run-id]')].map((row) => {
      const box = row.querySelector('[data-rs-avatar]');
      const rect = box.getBoundingClientRect();
      return {
        id: row.getAttribute('data-run-id'),
        current: row.hasAttribute('aria-current'),
        unread: !!row.querySelector('.rs-inbox__dot[data-new]'),
        name: row.querySelector('.rs-inbox__bot').textContent,
        title: row.querySelector('.rs-inbox__title').textContent,
        width: rect.width, height: rect.height,
        img: Boolean(box.querySelector('img')),
        initials: box.getAttribute('data-initials'),
      };
    }));
  }

  // every colour the inbox paints (text, fills, borders, outlines, pseudo fills)
  const inboxColours = (page) => page.evaluate(() => {
    const out = new Set();
    const props = ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'outlineColor'];
    for (const el of document.querySelectorAll('#rs-inbox, #rs-inbox *')) {
      for (const pseudo of [null, '::before', '::after']) {
        const s = getComputedStyle(el, pseudo);
        for (const p of props) if (s[p] && !/rgba\(0, 0, 0, 0\)/.test(s[p])) out.add(s[p]);
      }
    }
    return [...out];
  });

  for (const theme of ['light', 'dark']) {
    test(`${theme}: custom accent applies to its own report only; header shows avatar + name`, async () => {
      const { ctx, page, errors } = await open(runs.custom.run_id, theme);
      try {
        const expectedAccent = theme === 'light' ? DEFAULT_ACCENT.light : CUSTOM;
        assert.equal(await accentOf(page), expectedAccent);
        const h = await header(page);
        assert.equal(h.name, 'Research Agent');
        assert.equal(h.width, 24, 'a small byline avatar');
        assert.equal(h.height, 24);
        assert.equal(h.radius, '50%');
        assert.equal(h.hidden, 'true');
        assert.equal(h.img.alt, '');
        assert.equal(h.img.fit, 'cover');
        assert.match(h.img.src, /^\/avatar\/[0-9a-f]{64}$/);
        await page.waitForFunction(() => document.querySelector('#rs-bot img')?.complete);
        // the primary carries the custom accent
        const fill = await page.evaluate(() => getComputedStyle(document.querySelector('#rs-submit')).backgroundColor);
        assert.equal(hex(fill), expectedAccent);
        await page.hover('#rs-submit');
        const hover = await page.evaluate(() => getComputedStyle(document.querySelector('#rs-submit')).backgroundColor);
        assert.equal(hex(hover), theme === 'light' ? DEFAULT_HOVER.light : '#2da2be');
        const fallback = await page.evaluate(async (id) => {
          const boot = JSON.parse(document.getElementById('rs-boot').textContent);
          return (await fetch(`/api/run/${id}`, {
            headers: { 'X-RS-CSRF': boot.csrf },
          })).json();
        }, runs.custom.run_id);
        assert.deepEqual(fallback.identity.accent_fallback, ['light']);
        // inbox: every open report shows a 24 px avatar, its title and its
        // bot's name, never an accent
        const items = await inboxItems(page);
        assert.ok(items.length >= 6);
        for (const item of items) {
          assert.equal(item.width, 24, item.id);
          assert.equal(item.height, 24, item.id);
          assert.ok(item.name, item.id);
        }
        const names = Object.fromEntries(items.map((item) => [item.id, item]));
        assert.equal(names[runs.inbox.run_id].name, 'Inbox Agent');
        assert.equal(names[runs.inbox.run_id].title, 'Default report');
        assert.equal(names[runs.user.run_id].title, 'User registry report');
        assert.equal(names[runs.inbox.run_id].img, false);
        assert.equal(names[runs.inbox.run_id].initials, 'IA');
        assert.equal(names[runs.initials.run_id].name, 'Operations Agent');
        assert.equal(names[runs.initials.run_id].initials, 'OA');
        assert.equal(names[runs.user.run_id].name, 'Desk Agent');
        const colours = (await inboxColours(page)).map(hex);
        for (const accent of [CUSTOM, OTHER, LOW, DEFAULT_ACCENT.light, DEFAULT_ACCENT.dark]) {
          assert.ok(!colours.includes(accent), `inbox paints accent ${accent}: ${colours.join(' ')}`);
        }
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });

    test(`${theme}: switching reports swaps the one accent (user registry accent, then default)`, async () => {
      const { ctx, page } = await open(runs.custom.run_id, theme);
      try {
        assert.equal(await accentOf(page), theme === 'light' ? DEFAULT_ACCENT.light : CUSTOM);
        await page.click(`#rs-inbox [data-run-id="${runs.user.run_id}"]`);
        await page.waitForFunction((id) => window.RS.activeRun === id && document.documentElement.dataset.rsReady === '1', runs.user.run_id);
        assert.equal(await accentOf(page), OTHER);
        assert.equal((await header(page)).name, 'Desk Agent');
        await page.click(`#rs-inbox [data-run-id="${runs.inbox.run_id}"]`);
        await page.waitForFunction((id) => window.RS.activeRun === id && document.documentElement.dataset.rsReady === '1', runs.inbox.run_id);
        assert.equal(await accentOf(page), DEFAULT_ACCENT[theme]);
        const sheets = await page.evaluate(() => document.querySelectorAll('style[data-rs-accent]').length);
        assert.ok(sheets <= 1, 'one accent style at most');
        const h = await header(page);
        assert.equal(h.name, 'Inbox Agent');
        assert.equal(h.img, null, 'the shipped registry carries no images');
        assert.equal(h.initials, 'IA');
      } finally { await ctx.close(); }
    });

    test(`${theme}: low-contrast accent falls back to the default accent where it fails`, async () => {
      const { ctx, page } = await open(runs.low.run_id, theme);
      try {
        const expected = theme === 'light' ? DEFAULT_ACCENT.light : LOW;
        assert.equal(await accentOf(page), expected);
        const detail = await page.evaluate(async (id) => {
          const boot = JSON.parse(document.getElementById('rs-boot').textContent);
          return (await fetch('/api/run/' + id, { headers: { 'X-RS-CSRF': boot.csrf } })).json();
        }, runs.low.run_id);
        assert.deepEqual(detail.identity.accent_fallback, ['light']);
        const s = await page.evaluate(() => {
          const st = getComputedStyle(document.querySelector('#rs-submit'));
          return { bg: st.backgroundColor, fg: st.color };
        });
        assert.equal(hex(s.bg), expected);
        assert.equal(hex(s.fg), theme === 'light' ? '#ffffff' : '#000000');
      } finally { await ctx.close(); }
    });

    test(`${theme}: broken and corrupt avatars fall back to readable initials`, async () => {
      for (const [run, initials, name] of [
        [runs.broken, 'CA', 'Calendar Agent'],
        [runs.corrupt, 'NA', 'Notes Agent'],
        [runs.initials, 'OA', 'Operations Agent'],
      ]) {
        const { ctx, page } = await open(run.run_id, theme);
        try {
          await page.waitForFunction(() => !document.querySelector('#rs-bot img'), null, { timeout: 3000 });
          const h = await header(page);
          assert.equal(h.name, name);
          assert.equal(h.initials, initials);
          assert.equal(h.initialsText, `"${initials}"`);
          assert.equal(h.width, 24);
          const ratio = contrast(hex(h.fg), hex(h.bg));
          assert.ok(ratio >= 4.5, `initials contrast ${ratio}`);
          // initials stay neutral: the avatar fill is not chromatic
          const [r, g, b] = parseColor(hex(h.bg)).map((c) => Math.round(c * 255));
          assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, `neutral avatar ${h.bg}`);
          const item = (await inboxItems(page)).find((x) => x.id === run.run_id);
          assert.equal(item.initials, initials);
          assert.equal(item.img, false);
        } finally { await ctx.close(); }
      }
    });
  }

  test('names render as text only', async () => {
    const { ctx, page } = await open(runs.markup.run_id, 'light');
    try {
      const h = await header(page);
      assert.equal(h.name, '<b>Bold</b> Agent');
      assert.equal(h.nameHtml, '&lt;b&gt;Bold&lt;/b&gt; Agent');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#rs-bot b, #rs-inbox b').length), 0);
      assert.match(await page.title(), /Markup name report · <b>Bold<\/b> Agent$/);
    } finally { await ctx.close(); }
  });
});
