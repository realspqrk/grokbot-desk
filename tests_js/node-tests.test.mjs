import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groups } from '../tools/node-tests.mjs';

test('CI groups: every browser file is in the bounded group, every e2e file starts a browser', () => {
  const g = groups();
  assert.ok(g.browser.length > 0 && g.unit.length > 0);
  for (const f of g.unit) assert.ok(!f.endsWith('.e2e.test.mjs'), `${f} is e2e but starts no browser`);
  assert.ok(g.unit.includes('node-tests.test.mjs'), 'this file is a unit file');
  assert.deepEqual([...g.unit, ...g.browser].sort(), [...new Set([...g.unit, ...g.browser])].sort(), 'no file in both');
});
