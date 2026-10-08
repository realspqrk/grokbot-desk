// Differential URL-counter fuzzing against pinned twitter-text 3.1.0.
// Run: node tools/dev/count-differential.mjs <path-to-twitter-text-3.1.0/package>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import round5Corpus from '../../tests_js/fixtures/twitter-text-round5.mjs';

const require = createRequire(import.meta.url);
process.noDeprecation = true;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const packageRoot = process.argv[2] || process.env.RS_TWITTER_TEXT_UPSTREAM;
if (!packageRoot) {
  throw new Error('pass the pinned twitter-text package path or set RS_TWITTER_TEXT_UPSTREAM');
}
const upstreamDist = path.join(path.resolve(packageRoot), 'dist');
const cache = new Map();

function upstreamLoad(request) {
  let file = request.endsWith('.js') ? request : request + '.js';
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const load = (name) => {
    if (name.startsWith('core-js/')) return {};
    if (name === '@babel/runtime/helpers/interopRequireDefault') {
      return (value) => (value && value.__esModule ? value : { default: value });
    }
    if (name === 'punycode') return require('node:punycode');
    if (name.startsWith('.')) return upstreamLoad(path.resolve(path.dirname(file), name));
    throw new Error('unsupported upstream dependency: ' + name);
  };
  const source = readFileSync(file, 'utf8');
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename: file })(
    load,
    module,
    module.exports,
  );
  return module.exports;
}

const extract = upstreamLoad(path.join(upstreamDist, 'extractUrlsWithIndices.js'));
const counter = require(path.join(root, 'core/static/count.js'));
const twitterTextData = require(path.join(root, 'core/static/twitter-text-v3-data.js'));
const round4Corpus = JSON.parse(
  readFileSync(path.join(root, 'tests_js/fixtures/twitter-text-round4.json'), 'utf8'),
);
const sharedReviewCorpus = [...round4Corpus.cases, ...round5Corpus.cases];
const emojiRe = new RegExp(twitterTextData.emoji, 'g');

function codePointWeight(text) {
  let total = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    total += cp <= 4351
      || (cp >= 8192 && cp <= 8205)
      || (cp >= 8208 && cp <= 8223)
      || (cp >= 8242 && cp <= 8247)
      ? 1
      : 2;
  }
  return total;
}

function plainWeight(text) {
  let total = 0;
  let position = 0;
  let match;
  emojiRe.lastIndex = 0;
  while ((match = emojiRe.exec(text))) {
    total += codePointWeight(text.slice(position, match.index)) + 2;
    position = match.index + match[0].length;
  }
  return total + codePointWeight(text.slice(position));
}

function upstreamCount(text) {
  const normalized = text.normalize('NFC');
  let total = 0;
  let position = 0;
  for (const entity of extract(normalized)) {
    total += plainWeight(normalized.slice(position, entity.indices[0])) + 23;
    position = entity.indices[1];
  }
  return total + plainWeight(normalized.slice(position));
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const seedText = process.argv[3] || process.env.RS_DIFF_SEED || '0x52535032';
const seed = Number(seedText);
const fuzzCount = Number(process.argv[4] || process.env.RS_DIFF_CASES || 6000);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) {
  throw new Error('seed must be an unsigned 32-bit integer');
}
if (!Number.isSafeInteger(fuzzCount) || fuzzCount < 1) {
  throw new Error('case count must be a positive integer');
}

const rng = random(seed);
const pick = (values) => values[Math.floor(rng() * values.length)];
const prefixes = ['', ' ', '/', '-', '_', '@', '#', '$', 'http://', 'https://', '日本語', 'a\u200D'];
const domains = ['example.com', 'x.co', 't.co', 'xn--a.com', 'xn--ls8h.la', '日本語example.com', 'foo.invalid'];
const tails = ['', '/', '?abc', '/a', '/a?b=1', '/a(b)c', '/a(b', '/a((b))', '/a))', '/foo.com?x=1', '/.(a)', '/a!(b)'];
const alphabet = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:/?#()[]!@_-$%&;=+~*|,', '日', '本', '語', '\u200D', '\u3002', '\uFF0E', '\uFF61'];
const pathPunctuation = ['.', '!', ';', ']', '*', ',', '$', '%'];
const nonAccentLatin1 = ['£', '©', '®', '±', 'µ', '¿', '×', '÷'];
const unicodeDots = ['\u3002', '\uFF0E', '\uFF61'];
const coverage = {
  general: 0,
  path_segmentation: 0,
  non_accent_latin1: 0,
  unicode_dot_labels: 0,
  near_63_labels: 0,
  random_stream: 0,
};
const cases = [];

for (const { name, text, upstream_count: recorded } of sharedReviewCorpus) {
  const expected = upstreamCount(text);
  assert.equal(recorded, expected, `recorded upstream corpus count: ${name}`);
  assert.equal(counter.count(text, 'x').count, expected, `local corpus count: ${name}`);
}

for (let i = 0; i < fuzzCount; i++) {
  const kind = i % 6;
  if (kind === 0) {
    coverage.general++;
    const urlish = pick(prefixes) + pick(domains) + pick(tails);
    const left = Array.from({ length: Math.floor(rng() * 8) }, () => pick(alphabet)).join('');
    const right = Array.from({ length: Math.floor(rng() * 8) }, () => pick(alphabet)).join('');
    cases.push('a'.repeat(Math.floor(rng() * 290)) + left + urlish + right);
  } else if (kind === 1) {
    coverage.path_segmentation++;
    const beforeGroup = (rng() < 0.5 ? '' : 'a') + pick(pathPunctuation);
    const group = pick(['(a)', '(%)', '(a(b))']);
    const suffix = pick(['', 'b', '(c)']);
    cases.push('a'.repeat(Math.floor(rng() * 270)) + ' http://example.com/' + beforeGroup + group + suffix);
  } else if (kind === 2) {
    coverage.non_accent_latin1++;
    cases.push('a'.repeat(Math.floor(rng() * 270)) + ' http://example.com/a' + pick(nonAccentLatin1) + 'b');
  } else if (kind === 3) {
    coverage.unicode_dot_labels++;
    const dot = pick(unicodeDots);
    const component = pick(['a', 'é', '日']);
    const repetitions = pick([1, 2, 7, 8, 26, 27, 28, 31]);
    cases.push('a'.repeat(Math.floor(rng() * 250)) + ' http://' + (component + dot).repeat(repetitions) + 'x.com');
  } else if (kind === 4) {
    coverage.near_63_labels++;
    const dot = pick(unicodeDots);
    const component = pick(['a', 'é', '日']);
    const center = component === 'a' ? 31 : 25;
    const left = center + pick([-2, -1, 0, 1, 2]);
    const right = center + pick([-2, -1, 0, 1, 2]);
    cases.push('a'.repeat(Math.floor(rng() * 210)) + ' http://'
      + component.repeat(left) + dot + component.repeat(right) + '.com');
  } else {
    coverage.random_stream++;
    const tokens = Array.from({ length: 1 + Math.floor(rng() * 80) }, () => (
      rng() < 0.04 ? pick(['xn--', 't.co', 'http://', 'https://']) : pick(alphabet)
    ));
    cases.push('a'.repeat(Math.floor(rng() * 290)) + tokens.join(''));
  }
}

for (let i = 0; i < cases.length; i++) {
  const expected = upstreamCount(cases[i]);
  const actual = counter.count(cases[i], 'x');
  assert.equal(actual.count, expected, `weighted length mismatch at fuzz case ${i}: ${JSON.stringify(cases[i])}`);
  assert.equal(actual.over, expected > actual.limit, `validity mismatch at fuzz case ${i}`);
}

console.log(JSON.stringify({
  ok: true,
  seed: '0x' + seed.toString(16).padStart(8, '0'),
  corpus_passed: sharedReviewCorpus.length,
  fuzz_passed: cases.length,
  coverage,
}));
