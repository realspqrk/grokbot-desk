// Token contrast: every pair in contrast-pairs.json passes in both themes.
// Desk colours are oklch(), read through the same OKLab maths as tools/contrast.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseColor, toHex, contrast } from '../tools/colour.mjs';

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
function resolve(tokens) {
  const out = { ...tokens };
  for (const [k, v] of Object.entries(out)) {
    let value = v;
    for (let i = 0; i < 10; i += 1) {
      const m = value.match(/^var\((--rs-[a-z0-9-]+)\)$/);
      if (!m || !(m[1] in out)) break;
      value = out[m[1]];
    }
    out[k] = value;
  }
  return out;
}

const light = resolve(vars(block(/:root\s*\{([^}]*)\}/)));
const darkMedia = vars(block(/html:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/));
const darkForced = vars(block(/\nhtml\[data-theme="dark"\]\s*\{([^}]*)\}/));
const dark = resolve({ ...vars(block(/:root\s*\{([^}]*)\}/)), ...darkForced });
const COLOUR = /^(#[0-9a-f]{6}|oklch\([^)]*\))$/i;

export const ratio = contrast;
const passes = (r, min) => Number.isFinite(r) && r >= min;

for (const [text, hex] of [
  ['oklch(1 0 0)', '#ffffff'],
  ['oklch(0% 0 0)', '#000000'],
  ['oklch(50% 0 0)', '#636363'],
  ['oklch(0.6279554 0.2576833 29.2338851)', '#ff0000'],
  ['oklch(0.4520137 0.3132143 264.0520206)', '#0000ff'],
  ['oklch(0.8664396 0.2948272 142.4953)', '#00ff00'],
  ['#3B4FD8', '#3b4fd8'],
]) {
  test('oklch reference vector: ' + text, () => assert.equal(toHex(parseColor(text)), hex));
}

test('out-of-gamut oklch is clipped by chroma onto the sRGB edge', () => {
  const rgb = parseColor('oklch(0.7 0.4 145)');
  assert.ok(rgb.every((c) => c >= 0 && c <= 1));
  assert.ok(Math.min(...rgb) < 1e-3 || Math.max(...rgb) > 1 - 1e-3);
});

for (const text of ['oklch(0.5 0.1 1e999)', 'oklch(0.5 1e999 20)', 'oklch(1e999% 0 0)']) {
  test('nonfinite oklch component is rejected: ' + text, () => assert.throws(() => parseColor(text)));
}

test('the gate treats a nonfinite ratio as failing', () => {
  assert.equal(passes(Number.NaN, 3), false);
  assert.equal(passes(Number.POSITIVE_INFINITY, 3), false);
  assert.equal(passes(4.5, 4.5), true);
});

test('both dark blocks are identical', () => {
  assert.deepEqual(darkMedia, darkForced);
});

test('every dark colour token overrides a light one', () => {
  const root = vars(block(/:root\s*\{([^}]*)\}/));
  for (const k of Object.keys(darkForced)) assert.ok(k in root, k + ' missing in :root');
  for (const [k, v] of Object.entries(root)) {
    if (COLOUR.test(v)) assert.ok(k in darkForced, k + ' has no dark value');
  }
});

test('colour literals are oklch() or hex token values only', () => {
  assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab)\(/);
});

for (const [name, theme] of [['light', light], ['dark', dark]]) {
  test('contrast pairs pass: ' + name, () => {
    const fails = [];
    for (const p of pairs.pairs) {
      assert.ok(theme[p.fg], name + ': unknown token ' + p.fg);
      assert.ok(theme[p.bg], name + ': unknown token ' + p.bg);
      const r = contrast(theme[p.fg], theme[p.bg]);
      if (!passes(r, p.min)) fails.push(`${p.fg} on ${p.bg}: ${r.toFixed(2)} < ${p.min} (${p.use})`);
    }
    assert.deepEqual(fails, []);
  });
}
