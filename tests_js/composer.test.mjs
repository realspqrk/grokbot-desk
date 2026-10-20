// The reply chip label a bot receives (core/static/composer.js cleanRef), without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../core/static/composer.js', import.meta.url), 'utf8');
const sandbox = { self: {} };
vm.runInNewContext(source, sandbox);
const { cleanRef } = sandbox.self.RSComposer;

const label = (text) => cleanRef({ block: 'b', item: 'i', label: text }).label;
const wellFormed = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test('a chip label never carries half an emoji, wherever the cut fell', () => {
  assert.equal(label('Plan \uD83D'), 'Plan');
  assert.equal(label('\uDE00 Plan'), 'Plan');
  assert.equal(label('Pl\uD83Dan'), 'Plan');
  assert.equal(label('Pl\uDE00an'), 'Plan');
  assert.equal(label('\uDE00\uD83D'), 'i', 'nothing left: the item id stands in');
  assert.equal(label('Party 😀'), 'Party 😀', 'a whole emoji stays');
  const long = '😀'.repeat(200);
  const cut = label(long);
  assert.ok(wellFormed(cut) && cut.endsWith('…'), cut.slice(-4));
  for (const s of ['a\uD800', '\uDC00a', 'a\uDBFF\uDBFFb', 'a\uDFFF\uDC00b']) assert.ok(wellFormed(label(s)), JSON.stringify(s));
});
