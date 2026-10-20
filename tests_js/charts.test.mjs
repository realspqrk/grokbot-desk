// The chart scale helpers (core/static/charts.js) without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RSCharts = require('../core/static/charts.js');
const de = { lang: 'de' };

test('ticks stay bounded when the step is below the float resolution', () => {
  const started = Date.now();
  const ticks = RSCharts.ticks(1e16, 1e16 + 2, 4);
  assert.ok(Date.now() - started < 100);
  assert.ok(ticks.length >= 2 && ticks.length <= 12, JSON.stringify(ticks));
  assert.ok(ticks.every(Number.isFinite));
  assert.ok(ticks[0] <= 1e16 && ticks[ticks.length - 1] >= 1e16 + 2);
  for (const [lo, hi] of [[0, 1e308], [-1e308, 1e308], [1e-300, 2e-300], [5, 5]]) {
    const t = RSCharts.ticks(lo, hi, 4);
    assert.ok(t.length >= 1 && t.length <= 12 && t.every(Number.isFinite), `${lo}..${hi}: ${t}`);
  }
});

test('axis labels take their precision from the tick step, never repeating', () => {
  for (const [lo, hi] of [[1, 2], [0.001, 0.002], [0, 1000], [-2.5, 2.5]]) {
    const ticks = RSCharts.ticks(lo, hi, 4);
    const labels = ticks.map(RSCharts.tickFormat(de, ticks));
    assert.equal(new Set(labels).size, labels.length, `${lo}..${hi}: ${labels}`);
  }
  assert.deepEqual(RSCharts.ticks(1, 2, 4).map(RSCharts.tickFormat(de, RSCharts.ticks(1, 2, 4))),
    ['1,00', '1,25', '1,50', '1,75', '2,00']);
});

test('values keep the precision of the data', () => {
  const fmt = RSCharts.format(de, [0.001, 0.002]);
  assert.deepEqual([fmt(0.001), fmt(0.002)], ['0,001', '0,002']);
  assert.equal(RSCharts.format(de, [48200, 41000])(48200), '48.200');
  assert.equal(RSCharts.format({ lang: 'en' }, [1.25, 3])(3), '3.00');
  assert.equal(RSCharts.format(de, [1e-7])(1e-7), '0,0000001');
});

/* a tiny SVG document: enough for bar/line/spark to build their trees */
function fakeDocument() {
  return {
    createElementNS(ns, tag) {
      return {
        tag, attrs: {}, children: [], textContent: '',
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        appendChild(c) { this.children.push(c); return c; },
      };
    },
  };
}
function walk(node, out = []) { out.push(node); node.children.forEach((c) => walk(c, out)); return out; }
const ctx = { lang: 'en', width: 640, t: (key, vars) => key + (vars ? ' ' + JSON.stringify(vars) : '') };
const GEOMETRY = ['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'width', 'height'];
function numbersOf(node) {
  const out = [];
  for (const k of GEOMETRY) if (k in node.attrs) out.push([k, Number(node.attrs[k])]);
  for (const k of ['d', 'points', 'viewBox']) {
    if (k in node.attrs) for (const n of String(node.attrs[k]).match(/-?[\d.]+(?:e[+-]?\d+)?|NaN|Infinity/g) || []) out.push([k, Number(n)]);
  }
  return out;
}
function assertFinite(svg, name) {
  for (const node of walk(svg)) {
    for (const [k, v] of numbersOf(node)) assert.ok(Number.isFinite(v), `${name}: <${node.tag}> ${k}=${node.attrs[k]}`);
  }
}

test('extreme and constant series keep every coordinate finite', () => {
  globalThis.document = fakeDocument();
  try {
    const series = [[1e20, 1e20], [-1e308, 1e308], [1.7e308, 1.7e308], [-1.7e308, -1.7e308], [5e-324, 5e-324], [0, 0], [0, 1e308], [3, 3]];
    for (const values of series) {
      const labels = values.map((v, i) => 'L' + i);
      const name = JSON.stringify(values);
      assertFinite(RSCharts.bar({ kind: 'bar', labels, series: [{ name: 'S', values }] }, ctx), 'bar ' + name);
      assertFinite(RSCharts.bar({ kind: 'bar', orientation: 'horizontal', labels, series: [{ name: 'S', values }] }, ctx), 'horizontal ' + name);
      assertFinite(RSCharts.line({ kind: 'line', labels, series: [{ name: 'S', values }] }, ctx), 'line ' + name);
      assertFinite(RSCharts.line({ kind: 'line', labels, series: [{ name: 'S', values }], target: values[0] }, ctx), 'line+target ' + name);
      assertFinite(RSCharts.spark(values, ctx), 'spark ' + name);
    }
  } finally { delete globalThis.document; }
});

/* a value label's box at 12px: baseline y, about 11px above it and 3px below */
function labelBoxes(svg) {
  return walk(svg).filter((n) => n.tag === 'text' && /rs-chart__value/.test(n.attrs.class || ''));
}
function targetOf(svg) { return walk(svg).find((n) => /rs-chart__target-line/.test(n.attrs.class || '')); }

test('value labels keep clear of the target line', () => {
  globalThis.document = fakeDocument();
  try {
    const cases = [
      { labels: ['Jun', 'Jul', 'Aug', 'Sep'], series: [{ name: 'Revenue', values: [41000, 43500, 45500, 48200] }], target: 45000 },
      { labels: ['A', 'B'], series: [{ name: 'S', values: [-43500, -20000] }], target: -45000 },
      { labels: ['A', 'B', 'C'], series: [{ name: 'S', values: [44800, 45200, 10000] }], target: 45000 },
    ];
    for (const spec of cases) {
      const svg = RSCharts.bar({ kind: 'bar', ...spec }, ctx);
      const ty = Number(targetOf(svg).attrs.y1);
      for (const label of labelBoxes(svg)) {
        const y = Number(label.attrs.y);
        const top = y - 11, bottom = y + 3;
        const gap = ty < top ? top - ty : (ty > bottom ? ty - bottom : -1);
        assert.ok(gap >= 3, `${label.textContent} at ${y} vs target ${ty}`);
      }
      const side = RSCharts.bar({ kind: 'bar', orientation: 'horizontal', ...spec }, ctx);
      const tx = Number(targetOf(side).attrs.x1);
      for (const label of labelBoxes(side)) {
        const x = Number(label.attrs.x);
        const w = label.textContent.length * 7;
        const [left, right] = label.attrs['text-anchor'] === 'end' ? [x - w, x] : [x, x + w];
        const gap = tx < left ? left - tx : (tx > right ? tx - right : -1);
        assert.ok(gap >= 3, `${label.textContent} at ${x} vs target ${tx}`);
      }
    }
  } finally { delete globalThis.document; }
});
