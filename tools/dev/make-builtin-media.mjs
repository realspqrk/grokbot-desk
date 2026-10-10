// Renders the neutral fixture images of the preview-post built-in (SVG
// illustrations of a fictional neighbourhood bakery, drawn here and
// screenshotted by headless Edge as JPEG). No downloads, no installs.
// Output: templates/builtin/preview-post/fixtures/media/
//   loaves.jpg     1146x600  (1.91:1, golden)
//   shopfront.jpg  1280x720  (16:9, edge-two-platforms)
//   cake.jpg        864x1080 (4:5, edge-max)
//   avatar.jpg      400x400  (1:1, author avatar)
// Usage: node tools/dev/make-builtin-media.mjs
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, loadChromium, ROOT } from './rs-server.mjs';

const out = path.join(ROOT, 'templates/builtin/preview-post/fixtures/media');
mkdirSync(out, { recursive: true });

// Deterministic pseudo-random numbers, so re-running gives the same pictures.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const CRUST = `<radialGradient id="crust" cx=".38" cy=".3" r=".8">
  <stop offset="0" stop-color="#d9964a"/><stop offset=".6" stop-color="#b06a2c"/><stop offset="1" stop-color="#7c4419"/></radialGradient>`;

function boule(x, y, rx, ry) {
  return `<g transform="translate(${x} ${y})">
    <ellipse cx="0" cy="${ry * 0.82}" rx="${rx * 0.98}" ry="${ry * 0.22}" fill="#000" opacity=".18"/>
    <ellipse cx="0" cy="0" rx="${rx}" ry="${ry}" fill="url(#crust)"/>
    <path d="M${-rx * 0.55} ${-ry * 0.15} Q0 ${-ry * 0.75} ${rx * 0.55} ${-ry * 0.15}" stroke="#ecc58c" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M${-rx * 0.45} ${ry * 0.2} Q0 ${-ry * 0.3} ${rx * 0.45} ${ry * 0.2}" stroke="#ecc58c" stroke-width="6" fill="none" stroke-linecap="round" opacity=".85"/>
  </g>`;
}

function roll(x, y, r) {
  return `<g transform="translate(${x} ${y})">
    <ellipse cx="0" cy="${r * 0.8}" rx="${r}" ry="${r * 0.22}" fill="#000" opacity=".18"/>
    <circle cx="0" cy="0" r="${r}" fill="url(#crust)"/>
    <path d="M${-r * 0.5} ${-r * 0.1} L${r * 0.5} ${-r * 0.1}" stroke="#ecc58c" stroke-width="5" stroke-linecap="round"/>
  </g>`;
}

function baguette(x, y, len, rot) {
  let cuts = '';
  for (let i = -2; i <= 2; i++) {
    cuts += `<path d="M${i * len * 0.16 - 10} -8 L${i * len * 0.16 + 10} 6" stroke="#ecc58c" stroke-width="5" stroke-linecap="round"/>`;
  }
  return `<g transform="translate(${x} ${y}) rotate(${rot})">
    <ellipse cx="0" cy="0" rx="${len / 2}" ry="20" fill="url(#crust)"/>${cuts}</g>`;
}

function shelf(y, w) {
  return `<rect x="0" y="${y}" width="${w}" height="26" fill="#8a5a34"/>
    <rect x="0" y="${y}" width="${w}" height="6" fill="#a8744a"/>
    <rect x="0" y="${y + 26}" width="${w}" height="14" fill="#000" opacity=".12"/>`;
}

function scenes() {
  const r = rng(11);

  // --------------------------------------------------------- loaves 1.91:1
  let tiles = '';
  for (let y = 0; y < 600; y += 46) tiles += `<rect x="0" y="${y}" width="1146" height="2" fill="#000" opacity=".04"/>`;
  for (let y = 0; y < 600; y += 46) {
    for (let x = (y / 46) % 2 ? 0 : 46; x < 1146; x += 92) tiles += `<rect x="${x}" y="${y}" width="2" height="46" fill="#000" opacity=".035"/>`;
  }
  let basket = '';
  for (let i = 0; i < 6; i++) basket += baguette(905 + i * 22, 190 - (i % 3) * 18, 230, -62 - i * 5);
  for (let i = 0; i < 9; i++) basket += `<path d="M${815 + i * 28} 250 L${825 + i * 28} 330" stroke="#6e4a26" stroke-width="3" opacity=".6"/>`;
  const loaves = `<svg width="1146" height="600" viewBox="0 0 1146 600">
    <defs>${CRUST}
      <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4e9d6"/><stop offset="1" stop-color="#e6d3b2"/></linearGradient>
      <radialGradient id="glow" cx=".18" cy=".1" r=".7"><stop offset="0" stop-color="#fff8e8" stop-opacity=".9"/><stop offset="1" stop-color="#fff8e8" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="1146" height="600" fill="url(#wall)"/>${tiles}
    <rect width="1146" height="600" fill="url(#glow)"/>
    ${boule(150, 268, 105, 62)}${boule(380, 262, 118, 68)}${boule(612, 270, 98, 58)}
    <rect x="805" y="240" width="250" height="92" rx="14" fill="#9b6b3c"/>
    <rect x="805" y="240" width="250" height="14" rx="7" fill="#b88552"/>${basket}
    ${shelf(330, 1146)}
    ${roll(110, 512, 44)}${roll(210, 518, 40)}${roll(305, 512, 44)}
    <g transform="translate(560 506)"><ellipse cx="0" cy="34" rx="170" ry="16" fill="#000" opacity=".16"/>
      <ellipse cx="0" cy="0" rx="170" ry="48" fill="url(#crust)"/>
      <path d="M-110 -6 L-60 -20 M-40 -4 L10 -20 M30 -4 L80 -20 M100 -4 L140 -16" stroke="#ecc58c" stroke-width="7" stroke-linecap="round"/></g>
    ${roll(830, 512, 42)}${roll(930, 516, 40)}${roll(1030, 512, 44)}
    ${shelf(560, 1146)}
  </svg>`;

  // ------------------------------------------------------- shopfront 16:9
  let stripes = '';
  for (let i = 0; i < 14; i++) {
    const x = 250 + i * 56;
    stripes += `<path d="M${x} 150 L${x + 56} 150 L${x + 56} 238 Q${x + 28} 262 ${x} 238 Z" fill="${i % 2 ? '#f3efe6' : '#2f5d50'}"/>`;
  }
  let bricks = '';
  for (let y = 120; y < 640; y += 24) {
    for (let x = ((y / 24) % 2) * 30; x < 1280; x += 60) bricks += `<rect x="${x}" y="${y}" width="58" height="22" fill="#000" opacity="${(0.02 + r() * 0.04).toFixed(3)}"/>`;
  }
  const shopfront = `<svg width="1280" height="720" viewBox="0 0 1280 720">
    <defs>${CRUST}
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe2ea"/><stop offset="1" stop-color="#eef3f1"/></linearGradient>
      <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fdf3dc"/><stop offset="1" stop-color="#f1d9a8"/></linearGradient>
    </defs>
    <rect width="1280" height="720" fill="url(#sky)"/>
    <rect x="0" y="110" width="1280" height="530" fill="#d9c2a0"/>${bricks}
    <rect x="236" y="138" width="808" height="16" fill="#23463c"/>${stripes}
    <rect x="270" y="290" width="470" height="300" fill="#4a3b2c"/>
    <rect x="284" y="304" width="442" height="272" fill="url(#glass)"/>
    ${boule(370, 470, 62, 38)}${boule(510, 476, 70, 42)}${boule(640, 470, 58, 36)}
    <rect x="284" y="520" width="442" height="14" fill="#8a5a34"/>
    <rect x="790" y="290" width="200" height="300" fill="#4a3b2c"/>
    <rect x="804" y="304" width="172" height="286" fill="#2f5d50"/>
    <rect x="818" y="320" width="144" height="120" fill="url(#glass)" opacity=".85"/>
    <circle cx="952" cy="470" r="7" fill="#e4c37a"/>
    <rect x="0" y="590" width="1280" height="130" fill="#b9b2a6"/>
    <rect x="0" y="590" width="1280" height="10" fill="#9e968a"/>
    <g transform="translate(1080 520)"><rect x="-38" y="20" width="76" height="70" rx="6" fill="#a2552f"/>
      <circle cx="-18" cy="0" r="34" fill="#4f7f4a"/><circle cx="16" cy="-14" r="38" fill="#5f9358"/><circle cx="20" cy="16" r="30" fill="#477343"/></g>
    <g transform="translate(180 520)"><rect x="-38" y="20" width="76" height="70" rx="6" fill="#a2552f"/>
      <circle cx="-14" cy="-8" r="36" fill="#5f9358"/><circle cx="18" cy="4" r="32" fill="#477343"/></g>
  </svg>`;

  // ------------------------------------------------------------ cake 4:5
  let grain = '';
  for (let i = 0; i < 26; i++) {
    const y = 620 + i * 18 + r() * 8;
    grain += `<path d="M0 ${y.toFixed(0)} Q432 ${(y + (r() - 0.5) * 20).toFixed(0)} 864 ${(y + (r() - 0.5) * 10).toFixed(0)}" stroke="#8d6440" stroke-width="2" fill="none" opacity=".35"/>`;
  }
  let crumbs = '';
  for (let i = 0; i < 150; i++) {
    const x = 250 + r() * 380;
    const top = 560 + (x - 250) * 0.12;
    const y = top + r() * 50;
    crumbs += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(5 + r() * 9).toFixed(0)}" fill="${['#c98b45', '#e2b06b', '#d69c55', '#f0cf8f'][Math.floor(r() * 4)]}"/>`;
  }
  let apples = '';
  for (let i = 0; i < 6; i++) apples += `<path d="M${280 + i * 58} 655 q26 -26 52 0" stroke="#f6e7b0" stroke-width="10" fill="none" stroke-linecap="round"/>`;
  const cake = `<svg width="864" height="1080" viewBox="0 0 864 1080">
    <defs>
      <linearGradient id="wall2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3ece1"/><stop offset="1" stop-color="#e3d7c4"/></linearGradient>
      <linearGradient id="win" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".85"/><stop offset="1" stop-color="#ffffff" stop-opacity=".2"/></linearGradient>
    </defs>
    <rect width="864" height="620" fill="url(#wall2)"/>
    <rect x="80" y="70" width="300" height="380" rx="6" fill="url(#win)"/>
    <rect x="226" y="70" width="8" height="380" fill="#d8ccb8"/><rect x="80" y="256" width="300" height="8" fill="#d8ccb8"/>
    <rect x="0" y="620" width="864" height="460" fill="#b98a5e"/>${grain}
    <ellipse cx="440" cy="800" rx="330" ry="120" fill="#000" opacity=".15"/>
    <ellipse cx="432" cy="780" rx="330" ry="120" fill="#f7f4ef"/>
    <ellipse cx="432" cy="772" rx="260" ry="86" fill="#efebe4"/>
    <g transform="translate(0 34)"><path d="M240 600 L640 640 L640 760 L240 720 Z" fill="#d9a35c"/>
    <path d="M240 640 L640 680 L640 700 L240 660 Z" fill="#f0d48a"/>${apples}
    <path d="M240 720 L640 760 L640 780 L240 740 Z" fill="#b97a3a"/>
    ${crumbs}</g>
    <g transform="translate(700 470)"><ellipse cx="0" cy="96" rx="96" ry="26" fill="#000" opacity=".14"/>
      <ellipse cx="0" cy="88" rx="96" ry="24" fill="#f7f4ef"/>
      <path d="M-62 0 L62 0 L52 86 L-52 86 Z" fill="#ffffff"/><ellipse cx="0" cy="0" rx="62" ry="16" fill="#6b3f20"/>
      <path d="M62 20 q40 10 0 46" stroke="#ffffff" stroke-width="12" fill="none"/></g>
  </svg>`;

  // ---------------------------------------------------------- avatar 1:1
  let grains = '';
  for (let i = 0; i < 5; i++) {
    const y = 120 + i * 34;
    grains += `<ellipse cx="178" cy="${y}" rx="17" ry="30" fill="#f3dca0" transform="rotate(-28 178 ${y})"/>`;
    grains += `<ellipse cx="222" cy="${y}" rx="17" ry="30" fill="#f3dca0" transform="rotate(28 222 ${y})"/>`;
  }
  const avatar = `<svg width="400" height="400" viewBox="0 0 400 400">
    <rect width="400" height="400" fill="#2f5d50"/>
    <circle cx="200" cy="200" r="168" fill="none" stroke="#f3dca0" stroke-width="10" opacity=".5"/>
    <path d="M200 96 L200 330" stroke="#f3dca0" stroke-width="10" stroke-linecap="round"/>
    <ellipse cx="200" cy="92" rx="15" ry="28" fill="#f3dca0"/>${grains}
  </svg>`;

  return {
    loaves: [loaves, 1146, 600], shopfront: [shopfront, 1280, 720], cake: [cake, 864, 1080], avatar: [avatar, 400, 400],
  };
}

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found');
const browser = await chromium.launch({ channel: browserChannel(), headless: true });
try {
  for (const [name, [svg, w, h]] of Object.entries(scenes())) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    const file = path.join(out, name + '.jpg');
    await page.screenshot({ path: file, type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
    console.log(name, w + 'x' + h, Math.round(statSync(file).size / 1024) + ' KB');
  }
} finally {
  await browser.close();
}
