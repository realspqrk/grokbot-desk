// The UI string tables: German (default) and English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const de = JSON.parse(readFileSync(new URL('../core/i18n/de.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../core/i18n/en.json', import.meta.url), 'utf8'));

test('a few anchor keys keep their German wording', () => {
  const anchors = {
    approve: 'Freigeben', request_changes: 'Änderungen anfordern', copy: 'Kopieren', copied: 'Kopiert ✓',
    confirm_type: 'Zum Bestätigen „{word}“ eintippen', lint_em_dash: 'Gedankenstrich (—) gefunden',
    platform_x: 'X',
  };
  for (const [k, v] of Object.entries(anchors)) assert.equal(de[k], v, k);
});

test('German and English have the same keys and the same placeholders in every string', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  const placeholders = (v) => [...v.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(de)) assert.deepEqual(placeholders(en[k]), placeholders(de[k]), k);
});

test('no em dash except the lint badge that names it', () => {
  for (const [k, v] of Object.entries(de)) {
    if (k === 'lint_em_dash') continue;
    assert.ok(!v.includes('—'), k + ' contains an em dash');
  }
});

test('keys are English snake_case, values non-empty strings, placeholders {name}', () => {
  for (const [k, v] of Object.entries(de)) {
    assert.match(k, /^[a-z][a-z0-9_]*$/, k);
    assert.equal(typeof v, 'string', k);
    assert.ok(v.length > 0, k);
    for (const m of v.matchAll(/\{([^}]*)\}/g)) assert.match(m[1], /^[a-z][a-z0-9_]*$/, k + ': ' + m[0]);
  }
});

test('platform name keys match platforms.json name_key', () => {
  const p = JSON.parse(readFileSync(new URL('../core/static/platforms.json', import.meta.url), 'utf8'));
  for (const v of Object.values(p.platforms)) assert.ok(de[v.name_key], v.name_key);
});
