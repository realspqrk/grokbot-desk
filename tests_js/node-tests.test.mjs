import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groups, SMOKE, TIMING } from '../tools/node-tests.mjs';

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
