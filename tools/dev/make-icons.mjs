// Rasterizes core/static/icons/icon.svg with headless Edge (Chrome on macOS)
// into the served app icons: icon-32.png, icon-192.png, icon-512.png and
// favicon.ico (16, 32 and 48 px PNG entries). No server is started.
//   --preview <png>  instead writes a check sheet: the SVG at 16, 32 and 192
//       px on light and dark taskbar colours, plus the 16 and 32 px renders
//       enlarged 8x (pixelated) so the small sizes can be judged.
// Usage: node tools/dev/make-icons.mjs [--preview <png>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, loadChromium, ROOT } from './rs-server.mjs';

const ICONS = path.join(ROOT, 'core', 'static', 'icons');
const dataUrl = (name) => `data:image/svg+xml;base64,${readFileSync(path.join(ICONS, name)).toString('base64')}`;
const svgUrl = dataUrl('icon.svg');
const smallUrl = dataUrl('icon-small.svg');

const args = process.argv.slice(2);
const previewIndex = args.indexOf('--preview');
const preview = previewIndex >= 0 ? path.resolve(args[previewIndex + 1]) : null;

async function render(page, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">`
    + `<img id="i" src="${size <= 32 ? smallUrl : svgUrl}" width="${size}" height="${size}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.getElementById('i').complete);
  if (!await page.evaluate(() => document.getElementById('i').naturalWidth)) throw new Error('icon.svg did not load');
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

// ICO with PNG-compressed entries (supported by Windows Vista+ and all browsers)
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size % 256, at);
    directory.writeUInt8(size % 256, at + 1);
    directory.writeUInt8(0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

async function previewSheet(page) {
  const small = {};
  for (const size of [16, 32]) small[size] = (await render(page, size)).toString('base64');
  const backgrounds = [['light', '#f3f3f3'], ['white', '#ffffff'], ['dark', '#202020'], ['black', '#000000']];
  const row = ([name, colour]) => `
    <div style="display:flex;align-items:center;gap:24px;padding:16px;background:${colour}">
      <code style="width:48px;color:${name === 'dark' || name === 'black' ? '#ffffff' : '#000000'}">${name}</code>
      <img src="${smallUrl}" width="16" height="16">
      <img src="${smallUrl}" width="32" height="32">
      <img src="${svgUrl}" width="192" height="192">
      <img src="data:image/png;base64,${small[16]}" width="128" height="128" style="image-rendering:pixelated">
      <img src="data:image/png;base64,${small[32]}" width="128" height="128" style="image-rendering:pixelated">
    </div>`;
  await page.setViewportSize({ width: 700, height: 900 });
  await page.setContent(`<html><body style="margin:0;font:12px sans-serif">${backgrounds.map(row).join('')}</body></html>`);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  if (!await page.evaluate(() => [...document.images].every((image) => image.naturalWidth))) throw new Error('icon.svg did not load');
  mkdirSync(path.dirname(preview), { recursive: true });
  writeFileSync(preview, await page.screenshot({ fullPage: true }));
  console.log(preview);
}

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const browser = await chromium.launch({ headless: true, channel: browserChannel() });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  if (preview) {
    await previewSheet(page);
  } else {
    for (const size of [32, 192, 512]) {
      const file = path.join(ICONS, `icon-${size}.png`);
      writeFileSync(file, await render(page, size));
      console.log(file);
    }
    const entries = [];
    for (const size of [16, 32, 48]) entries.push({ size, png: await render(page, size) });
    writeFileSync(path.join(ICONS, 'favicon.ico'), ico(entries));
    console.log(path.join(ICONS, 'favicon.ico'));
  }
} finally {
  await browser.close();
}
