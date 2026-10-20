// Static UI rules: no colour literals outside tokens.css,
// no URLs (the SVG namespace string is the only exception).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

/* every page file but tokens.css (the one home of colour values) */
const files = [
  'core/static/twitter-text-v3-data.js',
  'core/static/platforms.json', 'core/static/contrast-pairs.json', 'core/i18n/de.json', 'core/i18n/en.json',
  ...readdirSync(new URL('../core/static/', import.meta.url))
    .filter((f) => /\.(js|css|html)$/.test(f) && f !== 'tokens.css' && f !== 'twitter-text-v3-data.js')
    .map((f) => 'core/static/' + f),
];
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
// the SVG namespace is a name, not a link
const SVG_NS = "'http://www.w3.org/2000/svg'";

for (const f of files) {
  test('no colour literals: ' + f, () => {
    const hits = read(f).split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/.test(l));
    assert.deepEqual(hits, []);
  });
  test('no URLs: ' + f, () => {
    const hits = read(f).split('\n').map((l) => l.split(SVG_NS).join(''))
      .filter((l) => /\b[a-z][a-z0-9+.-]*:\/\//i.test(l) || /(src|href)\s*=\s*["']\/\//i.test(l));
    assert.deepEqual(hits, []);
  });
}

test('components use only var(--rs-*) and var(--space-*) custom properties', () => {
  for (const f of ['core/static/components.js', 'core/static/shell.css']) {
    const bad = [...read(f).matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]).filter((v) => !v.startsWith('--rs-') && !v.startsWith('--space-'));
    assert.deepEqual(bad, [], f);
  }
});

test('no shadow DOM, no positive tabindex in components', () => {
  const js = read('core/static/components.js');
  assert.doesNotMatch(js, /attachShadow/);
  assert.doesNotMatch(js, /tabIndex\s*=\s*[1-9]/);
});

// publishable examples are fictional: example domains, shipped sample bots
test('payload fixtures and shipped bots use fictional neutral identities', () => {
  const bots = read('core/bots.json');
  assert.match(bots, /Operations Agent/);
  assert.match(bots, /Inbox Agent/);
  const dir = new URL('../tests/fixtures/payloads/', import.meta.url);
  const names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(names.length >= 10);
  for (const name of names) {
    const text = read('tests/fixtures/payloads/' + name);
    for (const [url] of text.matchAll(/https?:\/\/[^"\s/]+/g)) {
      assert.match(url, /^https:\/\/([a-z0-9-]+\.)*example\.(com|org|net|invalid)$/, `${name}: ${url}`);
    }
  }
});

test('counter examples and verification notes are fictional and role-based', () => {
  const counterTests = read('tests_js/count.test.mjs');
  const platforms = read('core/static/platforms.json');
  const oldProjectPrefix = ['spq', 'rk'].join('');
  const privateNames = new RegExp(`${oldProjectPrefix}|Research`, 'i');
  assert.doesNotMatch(counterTests, privateNames);
  assert.doesNotMatch(platforms, privateNames);
  assert.match(counterTests, /Example Coffee/);
  assert.match(platforms, /template author verifies them/);
});

test('twitter-text and twemoji-parser redistribution licenses are complete', () => {
  const normalizedHash = (file) => createHash('sha256')
    .update(read(file).replace(/\r\n/g, '\n').replace(/\n*$/, '\n'))
    .digest('hex');
  assert.equal(
    normalizedHash('vendor/twitter-text.LICENSE'),
    'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  );
  assert.equal(
    normalizedHash('vendor/twemoji-parser.LICENSE'),
    '3c47cf47073640b47cb430747716a9d07769322bfa4804af932f7ef94bfa315c',
  );
  const dataHeader = read('core/static/twitter-text-v3-data.js').slice(0, 700);
  assert.match(dataHeader, /vendor\/twitter-text\.LICENSE/);
  assert.match(dataHeader, /vendor\/twemoji-parser\.LICENSE/);
  const vendorReadme = read('vendor/README.md');
  assert.match(vendorReadme, /dist\/lib\/idna\.js/);
  assert.match(vendorReadme, /Apache-2\.0/);
});
