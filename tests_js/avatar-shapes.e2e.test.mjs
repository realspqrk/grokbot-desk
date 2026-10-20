// Shape avatars in the served shell (headless Edge): the page draws only
// shapes of the core set (boot.avatar_shapes, path data, eyes as holes), in
// the named fill per theme, in the inbox, header and "…" menu; image > shape >
// initials; unknown names fall back; the colour seeds the accent.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT, PLAIN_REPORT } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';
import { contrast, parseColor, toHex } from '../tools/colour.mjs';

const PORT = e2ePort('avatar-shapes.e2e.test.mjs');
const SET = JSON.parse(readFileSync(path.join(ROOT, 'core/static/avatar-shapes.json'), 'utf8'));
const tokensCss = readFileSync(path.join(ROOT, 'core/static/tokens.css'), 'utf8');
const token = (theme, name) => {
  const block = theme === 'light'
    ? tokensCss.match(/:root\s*\{([^}]*)\}/)[1]
    : tokensCss.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/)[1];
  const own = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6}|oklch\\([^)]*\\))`, 'i'));
  const value = (own || tokensCss.match(/:root\s*\{([^}]*)\}/)[1].match(new RegExp(`${name}:\\s*(#[0-9a-f]{6}|oklch\\([^)]*\\))`, 'i')))[1];
  return toHex(parseColor(value));
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const CORRUPT = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nnot really a png').toString('base64');
// per shape in set order (blob, squircle, pebble, hex, teardrop, tablet); the
// the inbox shows 12 reports, so all runs of this suite fit
const COLOURS = ['blue', 'orange', 'black', 'magenta', 'violet', 'yellow'];

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

function hex(rgb) {
  if (/^\s*(#[0-9a-f]{6}|oklch\()/i.test(String(rgb))) return toHex(parseColor(rgb));
  const m = String(rgb).match(/\d+(\.\d+)?/g);
  return m ? '#' + m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('') : String(rgb);
}

describe('shape avatars (served, headless Edge)', { skip }, () => {
  let server;
  let browser;
  const runs = {};
  const shapeRuns = {};

  before(async () => {
    server = await startServer({ port: PORT });
    writeFileSync(path.join(server.dataDir, 'bots.json'), JSON.stringify({
      'example-registry-bot': { name: 'Registry Agent', avatar_shape: 'tablet', avatar_color: 'green' },
      'example-photo-bot': { name: 'Photo Agent', avatar: PNG, avatar_shape: 'hex' },
    }), 'utf8');
    const show = (title, bot, identity) => server.show(PLAIN_REPORT, {
      title, bot, ...(identity === undefined ? {} : { identity }),
    });
    Object.keys(SET.shapes).forEach((shape, index) => {
      shapeRuns[shape] = show(`Shape ${shape}`, `example-${shape}-bot`, {
        name: `${shape[0].toUpperCase()}${shape.slice(1)} Agent`, avatar_shape: shape, avatar_color: COLOURS[index],
      });
    });
    runs.registry = show('Registry shape', 'example-registry-bot');
    runs.image = show('Image wins', 'example-image-bot', { name: 'Image Agent', avatar: PNG, avatar_shape: 'hex', avatar_color: 'red' });
    runs.corrupt = show('Corrupt image', 'example-corrupt-bot', { name: 'Corrupt Agent', avatar: CORRUPT, avatar_shape: 'pebble', avatar_color: 'magenta' });
    runs.unknown = show('Unknown shape', 'example-unknown-bot', { name: 'Unknown Agent', avatar_shape: 'star', avatar_color: 'blue' });
    runs.nocolour = show('No colour', 'example-nocolour-bot', { name: 'Plain Agent', avatar_shape: 'blob' });
    // fix1: a payload avatar beats a registry image; older than the rest, so
    // the inbox above stays as it is (12 entries)
    const old = (title, identity) => server.show(PLAIN_REPORT, {
      title, bot: 'example-photo-bot', created: new Date(Date.now() - 86400e3).toISOString().replace(/\.\d+Z$/, 'Z'),
      ...(identity === undefined ? {} : { identity }),
    });
    runs.photo = old('Registry image');
    runs.photoShape = old('Payload shape over registry image', { avatar_shape: 'teardrop', avatar_color: 'yellow' });
    runs.photoCleared = old('Payload clears registry image', { avatar: '' });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

  async function open(runId, theme, scale = 1) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale,
      colorScheme: theme, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url(`?client=test&run=${runId}`));
    // the first page of a cold headless Edge on a loaded CI runner once took
    // more than 8 s to get ready (Windows 3.11); later pages take < 1 s
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 20000 });
    return { ctx, page, errors };
  }

  /* every avatar on the page: where, size, what it draws */
  const avatars = (page) => page.evaluate(() => [...document.querySelectorAll('[data-rs-avatar]')]
    .filter((box) => box.getClientRects().length)
    .map((box) => {
      const rect = box.getBoundingClientRect();
      const svg = box.querySelector('svg');
      const p = svg && svg.querySelector('path');
      const row = box.closest('.rs-inbox__row');
      return {
        where: row ? `inbox:${row.dataset.runId}` : box.id === 'rs-bot-avatar' ? 'header' : box.closest('.rs-more__bot') ? 'menu' : 'other',
        width: rect.width,
        height: rect.height,
        hidden: box.getAttribute('aria-hidden'),
        shape: box.getAttribute('data-shape'),
        color: box.getAttribute('data-color'),
        initials: box.getAttribute('data-initials'),
        img: Boolean(box.querySelector('img')),
        text: box.textContent,
        svg: svg ? {
          tag: svg.namespaceURI + ' ' + svg.localName,
          attrs: [...svg.attributes].map((a) => a.name).sort(),
          children: [...svg.children].map((c) => c.localName),
          descendants: svg.querySelectorAll('*').length,
          shapeAttr: svg.getAttribute('data-rs-shape'),
          viewBox: svg.getAttribute('viewBox'),
          hidden: svg.getAttribute('aria-hidden'),
          pathAttrs: [...p.attributes].map((a) => a.name).sort(),
          d: p.getAttribute('d'),
          fill: getComputedStyle(p).fill,
          fillRule: getComputedStyle(p).fillRule,
        } : null,
      };
    }));

  for (const theme of ['light', 'dark']) {
    test(`${theme}: only core-set shapes, in their named fill, at 24 px in the inbox and the byline`, async () => {
      const { ctx, page, errors } = await open(shapeRuns.teardrop.run_id, theme);
      try {
        const all = await avatars(page);
        const drawn = all.filter((item) => item.svg);
        assert.ok(drawn.length >= 8, `drawn shapes: ${drawn.length}`);
        for (const item of drawn) {
          assert.equal(item.svg.tag, 'http://www.w3.org/2000/svg svg');
          assert.deepEqual(item.svg.attrs, ['aria-hidden', 'data-rs-shape', 'focusable', 'viewBox']);
          assert.deepEqual(item.svg.children, ['path']);
          assert.equal(item.svg.descendants, 1);
          assert.deepEqual(item.svg.pathAttrs, ['d', 'fill-rule']);
          assert.equal(item.svg.viewBox, SET.view_box);
          assert.equal(item.svg.d, SET.shapes[item.svg.shapeAttr], item.where);
          assert.equal(item.svg.shapeAttr, item.shape);
          assert.equal(item.svg.fillRule, 'evenodd');
          assert.equal(item.hidden, 'true');
          assert.equal(item.svg.hidden, 'true');
          assert.equal(item.text, '', 'no letter in a shape avatar');
          assert.equal(item.initials, null);
          const expected = token(theme, `--rs-avatar-${item.color}`);
          assert.equal(hex(item.svg.fill), expected, `${item.where} ${item.color}`);
          /* 24 px in the inbox, the header byline and the menu */
          if (item.where.startsWith('inbox:') || item.where === 'header') {
            assert.equal(item.width, 24, item.where);
            assert.equal(item.height, 24, item.where);
          }
        }
        for (const [shape, run] of Object.entries(shapeRuns)) {
          const inInbox = all.find((item) => item.where === `inbox:${run.run_id}`);
          assert.equal(inInbox.shape, shape);
        }
        const header = all.find((item) => item.where === 'header');
        assert.equal(header.shape, 'teardrop');
        assert.equal(header.color, 'violet');
        const registry = all.find((item) => item.where === `inbox:${runs.registry.run_id}`);
        assert.deepEqual([registry.shape, registry.color], ['tablet', 'green']);
        const black = all.find((item) => item.where === `inbox:${shapeRuns.pebble.run_id}`);
        assert.equal(hex(black.svg.fill), theme === 'light' ? token('light', '--rs-avatar-black') : '#ffffff');
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });

    test(`${theme}: the eyes are holes and the body is filled, for every shape`, async () => {
      const { ctx, page } = await open(shapeRuns.blob.run_id, theme);
      try {
        const result = await page.evaluate((set) => {
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.setAttribute('viewBox', set.view_box);
          svg.style.cssText = 'position:fixed;left:0;top:0;width:48px;height:48px';
          document.body.appendChild(svg);
          const out = {};
          for (const [name, d] of Object.entries(set.shapes)) {
            const whole = document.createElementNS(ns, 'path');
            whole.setAttribute('d', d);
            whole.setAttribute('fill-rule', 'evenodd');
            svg.appendChild(whole);
            const subpaths = d.split(/(?=M)/);
            const eyes = subpaths.slice(1).map((part) => {
              const piece = document.createElementNS(ns, 'path');
              piece.setAttribute('d', part);
              svg.appendChild(piece);
              const box = piece.getBBox();
              piece.remove();
              return new DOMPoint(box.x + box.width / 2, box.y + box.height / 2);
            });
            out[name] = {
              eyes: eyes.map((point) => whole.isPointInFill(point)),
              body: whole.isPointInFill(new DOMPoint(24, 40)),
            };
            whole.remove();
          }
          svg.remove();
          return out;
        }, SET);
        for (const [name, facts] of Object.entries(result)) {
          assert.deepEqual(facts.eyes, [false, false], `${name} eyes are holes`);
          assert.equal(facts.body, true, `${name} body is filled`);
        }
      } finally { await ctx.close(); }
    });

    test(`${theme}: image wins; a failing image falls back to the shape; unknown shape = initials`, async () => {
      const { ctx, page } = await open(runs.image.run_id, theme);
      try {
        await page.waitForFunction(() => document.querySelector('#rs-bot img')?.complete);
        let all = await avatars(page);
        const header = all.find((item) => item.where === 'header');
        assert.equal(header.img, true);
        assert.equal(header.svg, null);
        assert.equal(header.shape, null);
        const corrupt = all.find((item) => item.where === `inbox:${runs.corrupt.run_id}`);
        await page.waitForFunction((id) => document.querySelector(`[data-run-id="${id}"] [data-rs-avatar] svg`), runs.corrupt.run_id, { timeout: 3000 });
        all = await avatars(page);
        const fallen = all.find((item) => item.where === `inbox:${runs.corrupt.run_id}`);
        assert.ok(corrupt);
        assert.equal(fallen.img, false);
        assert.deepEqual([fallen.shape, fallen.color], ['pebble', 'magenta']);
        const unknown = all.find((item) => item.where === `inbox:${runs.unknown.run_id}`);
        assert.equal(unknown.svg, null);
        assert.equal(unknown.initials, 'UA');
        const plain = all.find((item) => item.where === `inbox:${runs.nocolour.run_id}`);
        assert.deepEqual([plain.shape, plain.color], ['blob', 'default']);
        assert.equal(hex(plain.svg.fill), token(theme, '--rs-accent'));
      } finally { await ctx.close(); }
    });

    test(`${theme}: a payload avatar beats a registry image; an empty one clears it`, async () => {
      const seen = {};
      for (const key of ['photo', 'photoShape', 'photoCleared']) {
        const { ctx, page, errors } = await open(runs[key].run_id, theme);
        try {
          if (key === 'photo') await page.waitForFunction(() => document.querySelector('#rs-bot img')?.complete);
          seen[key] = (await avatars(page)).find((item) => item.where === 'header');
          assert.deepEqual(errors, []);
        } finally { await ctx.close(); }
      }
      assert.equal(seen.photo.img, true);                                     // registry image
      assert.deepEqual([seen.photoShape.img, seen.photoShape.shape, seen.photoShape.color], [false, 'teardrop', 'yellow']);
      assert.deepEqual([seen.photoCleared.img, seen.photoCleared.shape, seen.photoCleared.initials], [false, null, 'PA']);
    });

    test(`${theme}: unknown shape keeps readable neutral initials in the header`, async () => {
      const { ctx, page } = await open(runs.unknown.run_id, theme);
      try {
        const facts = await page.evaluate(() => {
          const box = document.querySelector('#rs-bot-avatar');
          const style = getComputedStyle(box);
          return { initials: box.getAttribute('data-initials'), fg: style.color, bg: style.backgroundColor, radius: style.borderRadius };
        });
        assert.equal(facts.initials, 'UA');
        assert.equal(facts.radius, '50%');
        assert.ok(contrast(hex(facts.fg), hex(facts.bg)) >= 4.5);
      } finally { await ctx.close(); }
    });

    test(`${theme}: header and "…" menu show the shape next to the name as text`, async () => {
      const { ctx, page } = await open(runs.registry.run_id, theme);
      try {
        const header = await page.evaluate(() => ({
          name: document.querySelector('#rs-bot-name').textContent,
          weight: getComputedStyle(document.querySelector('#rs-bot-name')).fontWeight,
          nameColor: getComputedStyle(document.querySelector('#rs-bot-name')).color,
          line: document.querySelector('#rs-title').textContent,
          lineColor: getComputedStyle(document.querySelector('#rs-title')).color,
          muted: getComputedStyle(document.documentElement).getPropertyValue('--rs-muted').trim(),
          ink: getComputedStyle(document.documentElement).getPropertyValue('--rs-ink').trim(),
        }));
        assert.equal(header.name, 'Registry Agent');
        // a quiet byline: the name muted and regular, the report title in ink
        assert.equal(header.weight, '400');
        assert.equal(hex(header.nameColor), hex(header.muted));
        assert.equal(header.line, 'Registry shape');   // the report title, never a time (K11)
        assert.equal(hex(header.lineColor), hex(header.ink));
        await page.click('#rs-more-btn');
        const menu = (await avatars(page)).find((item) => item.where === 'menu');
        assert.deepEqual([menu.shape, menu.color, menu.width, menu.height], ['tablet', 'green', 24, 24]);
        const text = await page.textContent('.rs-more__bot');
        assert.match(text, /Registry Agent/);
      } finally { await ctx.close(); }
    });

    test(`${theme}: an inbox row's accessible name is the report title, then the bot name`, async () => {
      const { ctx, page } = await open(runs.registry.run_id, theme);
      try {
        const row = page.locator(`#rs-inbox a[data-run-id="${shapeRuns.hex.run_id}"]`);
        // the title first, then "bot · hint" (then "new" while unread); the avatar adds nothing
        assert.match(await row.ariaSnapshot(), /^- link "Shape hex Hex Agent · [^"]+"/);
        assert.equal(await row.evaluate((b) => b.querySelector('[data-rs-avatar]').getAttribute('aria-hidden')), 'true');
      } finally { await ctx.close(); }
    });

    test(`${theme}: the colour seeds the accent where it passes the contrast checks`, async () => {
      const { ctx, page } = await open(shapeRuns.blob.run_id, theme);
      try {
        const detail = await page.evaluate(async (id) => {
          const boot = JSON.parse(document.getElementById('rs-boot').textContent);
          return (await fetch('/api/run/' + id, { headers: { 'X-RS-CSRF': boot.csrf } })).json();
        }, shapeRuns.blob.run_id);
        const accent = hex(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rs-accent').trim()));
        const expected = detail.identity.accent_fallback.includes(theme)
          ? token(theme, '--rs-accent')
          : token(theme, '--rs-avatar-blue');
        assert.equal(accent, expected);
      } finally { await ctx.close(); }
    });
  }

  test('crisp at 2x: the byline shape stays a 24 px vector in a 2x window', async () => {
    const { ctx, page } = await open(shapeRuns.squircle.run_id, 'dark', 2);
    try {
      const facts = await page.evaluate(() => {
        const box = document.querySelector('#rs-bot-avatar');
        const svg = box.querySelector('svg');
        const rect = svg.getBoundingClientRect();
        return { w: rect.width, h: rect.height, dpr: devicePixelRatio, raster: box.querySelectorAll('img,canvas,image').length };
      });
      assert.deepEqual(facts, { w: 24, h: 24, dpr: 2, raster: 0 });
    } finally { await ctx.close(); }
  });
});
