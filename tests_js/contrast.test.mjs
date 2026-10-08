// Token contrast (spec 5.2): every pair in contrast-pairs.json passes in both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../core/static/tokens.css', import.meta.url), 'utf8');
const pairs = JSON.parse(readFileSync(new URL('../core/static/contrast-pairs.json', import.meta.url), 'utf8'));

function block(re) {
  const m = css.match(re);
  assert.ok(m, 'block not found: ' + re);
  return m[1];
}
function vars(text) {
  const out = {};
  for (const m of text.matchAll(/(--rs-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = vars(block(/:root\s*\{([^}]*)\}/));
const darkMedia = vars(block(/html:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/));
const darkForced = vars(block(/\nhtml\[data-theme="dark"\]\s*\{([^}]*)\}/));
const dark = { ...light, ...darkForced };

function lum(hex) {
  const v = hex.replace('#', '');
  assert.equal(v.length, 6, 'opaque 6-digit hex expected, got ' + hex);
  const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test('both dark blocks are identical', () => {
  assert.deepEqual(darkMedia, darkForced);
});

test('every dark colour token overrides a light one', () => {
  for (const k of Object.keys(darkForced)) assert.ok(k in light, k + ' missing in :root');
  for (const [k, v] of Object.entries(light)) {
    if (/^#[0-9a-f]{6}$/i.test(v)) assert.ok(k in darkForced, k + ' has no dark value');
  }
});

test('colour literals appear only as hex token values', () => {
  assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/);
});

for (const [name, theme] of [['light', light], ['dark', dark]]) {
  test('contrast pairs pass: ' + name, () => {
    const fails = [];
    for (const p of pairs.pairs) {
      assert.ok(theme[p.fg], name + ': unknown token ' + p.fg);
      assert.ok(theme[p.bg], name + ': unknown token ' + p.bg);
      const r = ratio(theme[p.fg], theme[p.bg]);
      if (r < p.min) fails.push(`${p.fg} on ${p.bg}: ${r.toFixed(2)} < ${p.min} (${p.use})`);
    }
    assert.deepEqual(fails, []);
  });
}
