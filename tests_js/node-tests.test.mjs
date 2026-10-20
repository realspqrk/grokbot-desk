import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groups, SMOKE, TIMING, E2E_PORTS, PORT_RANGE, e2ePort } from '../tools/node-tests.mjs';

test('CI groups: every browser file is in the bounded group, every e2e file starts a browser', () => {
  const g = groups();
  assert.ok(g.browser.length > 0 && g.unit.length > 0);
  for (const f of g.unit) assert.ok(!f.endsWith('.e2e.test.mjs'), `${f} is e2e but starts no browser`);
  assert.ok(g.unit.includes('node-tests.test.mjs'), 'this file is a unit file');
  assert.deepEqual([...g.unit, ...g.browser].sort(), [...new Set([...g.unit, ...g.browser])].sort(), 'no file in both');
});

test('the blocking smoke set names existing browser tests exactly once', () => {
  const { browser } = groups();
  for (const [file, names] of Object.entries(SMOKE)) {
    assert.ok(browser.includes(file), `${file} is a browser file`);
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const name of names) {
      const declared = source.split(`test('${name}'`).length - 1;
      assert.equal(declared, 1, `${file} declares "${name}" once`);
    }
  }
});

test('the timing budgets the gate skips name existing unit tests exactly once', () => {
  const { unit } = groups();
  for (const [file, names] of Object.entries(TIMING)) {
    assert.ok(unit.includes(file), `${file} is a unit file`);
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const name of names) {
      assert.equal(source.split(`test('${name}'`).length - 1, 1, `${file} declares "${name}" once`);
    }
  }
});

test('every file that starts a desk has its own ports inside 18920-18939', () => {
  const { browser } = groups();
  const offsets = Object.values(E2E_PORTS).flat();
  assert.equal(new Set(offsets).size, offsets.length, 'no offset is shared');
  assert.ok(offsets.every((o) => Number.isInteger(o) && o >= 0 && o < PORT_RANGE.size), 'offsets fit the range');
  for (const file of Object.keys(E2E_PORTS)) assert.ok(browser.includes(file), `${file} is a browser file`);
  for (const file of browser) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    if (/startServer\(/.test(source)) {
      assert.ok(E2E_PORTS[file], `${file} starts a desk and needs an E2E_PORTS entry`);
      assert.match(source, /e2ePort\(/, `${file} takes its ports from e2ePort`);
      assert.doesNotMatch(source, /RS_E2E_PORT \|\|/, `${file} computes no port of its own`);
    }
  }
  for (const base of [18920, 18921, 18930, 18939]) {
    const ports = Object.entries(E2E_PORTS).flatMap(([file, list]) => list.map((_, i) => e2ePort(file, i, { RS_E2E_PORT: String(base) })));
    assert.equal(new Set(ports).size, ports.length, `unique at base ${base}`);
    assert.ok(ports.every((p) => p >= 18920 && p <= 18939), `inside the range at base ${base}`);
  }
  assert.throws(() => e2ePort('blocks.e2e.test.mjs', 0, { RS_E2E_PORT: '18742' }), /outside/);
});
