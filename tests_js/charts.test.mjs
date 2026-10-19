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
