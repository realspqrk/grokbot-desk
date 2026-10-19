// The page's markdown parser (core/static/md.js) without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const RSMd = require('../core/static/md.js');
const { vectors } = JSON.parse(readFileSync(new URL('../tests/fixtures/section_vectors.json', import.meta.url), 'utf8'));

test('section headings match core/payload.py on every shared vector', () => {
  for (const v of vectors) assert.deepEqual(RSMd.sections(v.md), v.sections, v.name);
});

test('a task list item parses as done or open, never as a checkbox', () => {
  const [list] = RSMd.parse('- [x] Shipped\n- [ ] Waiting\n- plain');
  assert.equal(list.type, 'list');
  assert.deepEqual(list.items.map((it) => RSMd.taskOf(it.text)), [
    { done: true, text: 'Shipped' }, { done: false, text: 'Waiting' }, null,
  ]);
});
