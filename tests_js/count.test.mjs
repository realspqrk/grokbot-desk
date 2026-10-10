// RS.count tests (spec 4.7, C6). Run: node --test tests_js/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import round5Corpus from './fixtures/twitter-text-round5.mjs';

const require = createRequire(import.meta.url);
const RS_COUNT = require('../core/static/count.js');
const platforms = JSON.parse(readFileSync(new URL('../core/static/platforms.json', import.meta.url), 'utf8'));
const twitterTextConformance = JSON.parse(
  readFileSync(new URL('./fixtures/twitter-text-3.1.0.json', import.meta.url), 'utf8'),
);
const round4Corpus = JSON.parse(
  readFileSync(new URL('./fixtures/twitter-text-round4.json', import.meta.url), 'utf8'),
);
const sharedReviewCorpus = [...round4Corpus.cases, ...round5Corpus.cases];
const count = RS_COUNT.count;

const rep = (s, n) => s.repeat(n);

function xCodePointWeight(text) {
  return [...text].reduce((total, char) => {
    const cp = char.codePointAt(0);
    const weight = platforms.platforms.x.ranges.find(([start, end]) => cp >= start && cp <= end)?.[2]
      ?? platforms.platforms.x.default_weight;
    return total + weight;
  }, 0);
}

function expectedUrlWeight(text, urls) {
  const normalized = text.normalize('NFC');
  let total = 0;
  let position = 0;
  for (const originalUrl of urls) {
    const url = originalUrl.normalize('NFC');
    const start = normalized.indexOf(url, position);
    assert.notEqual(start, -1, `fixture URL not found after index ${position}: ${url}`);
    total += xCodePointWeight(normalized.slice(position, start));
    total += platforms.platforms.x.url_weight;
    position = start + url.length;
  }
  return total + xCodePointWeight(normalized.slice(position));
}

function timedWorkerCount(text, timeout = 2000) {
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { performance } = require('node:perf_hooks');
    const count = require(workerData.module).count;
    const started = performance.now();
    const result = count(workerData.text, 'x');
    parentPort.postMessage({ result, elapsed: performance.now() - started });
  `;
  const module = require.resolve('../core/static/count.js');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { module, text } });
    const timer = setTimeout(async () => {
      await worker.terminate();
      reject(new Error(`counter exceeded ${timeout} ms`));
    }, timeout);
    worker.once('message', async (message) => {
      clearTimeout(timer);
      await worker.terminate();
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('platforms.json carries the spec limits', () => {
  const p = platforms.platforms;
  assert.equal(p.x.limit, 280);
  assert.equal(p.linkedin.limit, 3000);
  assert.equal(p.linkedin.fold, 210);
  assert.equal(p.linkedin_comment.limit, 1250);
  assert.equal(p.instagram.limit, 2200);
  assert.equal(p.instagram.fold, 125);
  assert.equal(p.instagram.hashtag_limit, 30);
  assert.equal(p.facebook.limit, 63206);
  assert.equal(p.x.url_weight, 23);
  assert.equal(p.x.emoji_weight, 2);
  assert.deepEqual(p.x.ranges, [[0, 4351, 1], [8192, 8205, 1], [8208, 8223, 1], [8242, 8247, 1]]);
  assert.ok(Array.isArray(platforms.notes) && platforms.notes.length > 0);
});

test('result shape', () => {
  assert.deepEqual(count('abc', 'x'), { count: 3, limit: 280, over: false });
  assert.deepEqual(count('abc', 'linkedin'), { count: 3, limit: 3000, over: false, fold: 210 });
  assert.deepEqual(count('abc #a', 'instagram'), { count: 6, limit: 2200, over: false, fold: 125, hashtags: 1, hashtagLimit: 30 });
  assert.deepEqual(count('', 'facebook'), { count: 0, limit: 63206, over: false });
});

test('unknown platform throws', () => {
  assert.throws(() => count('a', 'myspace'), /unknown platform/);
});

test('non-string input counts as empty / String()', () => {
  assert.equal(count(null, 'x').count, 0);
  assert.equal(count(undefined, 'linkedin').count, 0);
});

// ---- exact boundaries, every platform ----
test('X boundary 280 / 281 (ASCII)', () => {
  assert.deepEqual(count(rep('a', 280), 'x'), { count: 280, limit: 280, over: false });
  assert.deepEqual(count(rep('a', 281), 'x'), { count: 281, limit: 280, over: true });
});

test('X boundary 280 / 281 with weight-2 characters', () => {
  assert.equal(count(rep('日', 140), 'x').count, 280);
  assert.equal(count(rep('日', 140), 'x').over, false);
  const r = count(rep('日', 140) + 'a', 'x');
  assert.equal(r.count, 281);
  assert.equal(r.over, true);
});

test('LinkedIn boundary 3000 / 3001', () => {
  assert.equal(count(rep('a', 3000), 'linkedin').over, false);
  assert.equal(count(rep('a', 3001), 'linkedin').over, true);
  assert.equal(count(rep('a', 3001), 'linkedin').count, 3001);
});

test('LinkedIn first comment boundary 1250 / 1251', () => {
  assert.deepEqual(count(rep('ä', 1250), 'linkedin_comment'), { count: 1250, limit: 1250, over: false });
  assert.deepEqual(count(rep('ä', 1251), 'linkedin_comment'), { count: 1251, limit: 1250, over: true });
});

test('Instagram boundary 2200 / 2201', () => {
  assert.equal(count(rep('a', 2200), 'instagram').over, false);
  assert.equal(count(rep('a', 2201), 'instagram').over, true);
  assert.equal(count(rep('a', 2201), 'instagram').count, 2201);
});

test('Facebook boundary 63206 / 63207', () => {
  assert.equal(count(rep('a', 63206), 'facebook').over, false);
  assert.equal(count(rep('a', 63207), 'facebook').over, true);
  assert.equal(count(rep('a', 63207), 'facebook').count, 63207);
});

// ---- X weighting ranges ----
test('X weight ranges: edges of each weight-1 range', () => {
  const cp = (n) => String.fromCodePoint(n);
  assert.equal(count(cp(4351), 'x').count, 1); // U+10FF last of range 1
  assert.equal(count(cp(4352), 'x').count, 2); // U+1100 Hangul Jamo
  assert.equal(count(cp(8191), 'x').count, 2);
  assert.equal(count(cp(8192), 'x').count, 1);
  assert.equal(count(cp(8205), 'x').count, 1);
  assert.equal(count(cp(8206), 'x').count, 2);
  assert.equal(count(cp(8207), 'x').count, 2);
  assert.equal(count(cp(8208), 'x').count, 1);
  assert.equal(count('—', 'x').count, 1); // em dash 8212 is in 8208-8223
  assert.equal(count(cp(8223), 'x').count, 1);
  assert.equal(count(cp(8224), 'x').count, 2);
  assert.equal(count(cp(8241), 'x').count, 2);
  assert.equal(count(cp(8242), 'x').count, 1);
  assert.equal(count(cp(8247), 'x').count, 1);
  assert.equal(count(cp(8248), 'x').count, 2);
});

test('X: Latin with umlauts weigh 1, newlines weigh 1', () => {
  assert.equal(count('Grüße aus Österreich', 'x').count, 20);
  assert.equal(count('a\nb\r\nc', 'x').count, 6);
});

test('X: CJK weighs 2, Hangul weighs 2', () => {
  assert.equal(count('日本語', 'x').count, 6);
  assert.equal(count('한국어', 'x').count, 6);
  assert.equal(count('日本語', 'linkedin').count, 3);
});

test('X: astral non-emoji code point weighs 2', () => {
  assert.equal(count('\u{1D400}', 'x').count, 2); // MATHEMATICAL BOLD CAPITAL A
  assert.equal(count('\u{20000}', 'x').count, 2); // CJK Ext B
});

// ---- emoji ----
test('X: simple emoji weighs 2', () => {
  assert.equal(count('😀', 'x').count, 2);
  assert.equal(count('a😀b', 'x').count, 4);
});

test('X: ZWJ family sequence weighs 2 in total', () => {
  const fam = '👨‍👩‍👧‍👦';
  assert.equal(count(fam, 'x').count, 2);
  assert.equal(count(fam, 'linkedin').count, 7); // 4 people + 3 ZWJ
});

test('X: flag (regional indicator pair) weighs 2', () => {
  assert.equal(count('🇦🇹', 'x').count, 2);
  assert.equal(count('🇦🇹🇩🇪', 'x').count, 4);
  assert.equal(count('🇦🇹', 'instagram').count, 2);
});

test('X: skin tone modifier sequence weighs 2', () => {
  assert.equal(count('👍🏽', 'x').count, 2);
  assert.equal(count('👍🏽', 'facebook').count, 2);
  assert.equal(count('🧑🏽‍💻', 'x').count, 2);
});

test('X: emoji with variation selector and keycap weigh 2', () => {
  assert.equal(count('❤️', 'x').count, 2);
  assert.equal(count('#️⃣', 'x').count, 2);
  assert.equal(count('1️⃣2️⃣', 'x').count, 4);
});

test('X: 140 emoji = 280 (boundary), 141 = over', () => {
  assert.equal(count(rep('👨‍👩‍👧', 140), 'x').count, 280);
  assert.equal(count(rep('👨‍👩‍👧', 140), 'x').over, false);
  assert.equal(count(rep('👨‍👩‍👧', 140) + '.', 'x').over, true);
});

// review round 1, finding 2: only emoji sequences weigh 2; text-presentation
// characters without U+FE0F use the per-code-point rule (spec 4.7)
test('X: text-presentation characters without U+FE0F use the code-point weight', () => {
  assert.equal(count('\u00A9', 'x').count, 1); // © in 0-4351
  assert.equal(count('\u00AE', 'x').count, 1); // ®
  assert.equal(count('\u2122', 'x').count, 2); // ™ 8482: outside the weight-1 ranges
  assert.equal(count('\u203C', 'x').count, 2); // ‼ 8252: outside the weight-1 ranges
  assert.equal(count('\u2764', 'x').count, 2); // ❤ 10084 per code point
  assert.equal(count('#', 'x').count, 1);
  assert.equal(count('1', 'x').count, 1);
  assert.equal(count('\u00A9 2026 Example Coffee', 'x').count, 21);
});

test('X: the same characters followed by U+FE0F are one emoji (weight 2)', () => {
  assert.equal(count('\u00A9\uFE0F', 'x').count, 2);
  assert.equal(count('\u00AE\uFE0F', 'x').count, 2);
  assert.equal(count('\u2122\uFE0F', 'x').count, 2);
  assert.equal(count('\u203C\uFE0F', 'x').count, 2);
  assert.equal(count('\u2764\uFE0F', 'x').count, 2);
  assert.equal(count('a\u00A9\uFE0Fb', 'x').count, 4);
});

test('X: 279 + plain \u00A9 = 280 (not over); with U+FE0F = 281 (over)', () => {
  assert.deepEqual(count(rep('a', 279) + '\u00A9', 'x'), { count: 280, limit: 280, over: false });
  assert.deepEqual(count(rep('a', 279) + '\u00AE', 'x'), { count: 280, limit: 280, over: false });
  assert.deepEqual(count(rep('a', 279) + '\u00A9\uFE0F', 'x'), { count: 281, limit: 280, over: true });
  assert.deepEqual(count(rep('a', 278) + '\u00A9\uFE0F', 'x'), { count: 280, limit: 280, over: false });
});

test('X: emoji sequences stay weight 2 (RGI, keycap, flag, tag, skin tone, ZWJ)', () => {
  assert.equal(count('#\uFE0F\u20E3', 'x').count, 2);
  assert.equal(count('#\u20E3', 'x').count, 2); // keycap without U+FE0F
  assert.equal(count('\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 'x').count, 2); // England tag sequence
  assert.equal(count('\u{1F3F3}\uFE0F\u200D\u{1F308}', 'x').count, 2); // rainbow flag
  assert.equal(count('\u{1F469}\u{1F3FD}\u200D\u{1F680}', 'x').count, 2); // woman astronaut, medium skin tone
  assert.equal(count('\u{1F600}\u{1F600}', 'x').count, 4);
});

// review round 2, finding 1: only recognized emoji entities collapse to weight 2
test('X: non-RGI emoji-like sequences use the per-code-point fallback', () => {
  const cases = [
    ['arbitrary ZWJ sequence', '😀\u200D😀', 5],
    ['invalid regional-indicator pair', '🇦🇦', 4],
    ['variation selector without an emoji entity', '1\uFE0F', 3],
    ['non-RGI ZWJ sequence', '❤️\u200D☀️', 5],
  ];
  for (const [name, text, expected] of cases) {
    assert.equal(count(text, 'x').count, expected, name);
    assert.deepEqual(count(rep('a', 279 - expected) + ' ' + text, 'x'), { count: 280, limit: 280, over: false }, name + ' at 280');
    assert.deepEqual(count(rep('a', 280 - expected) + ' ' + text, 'x'), { count: 281, limit: 280, over: true }, name + ' at 281');
  }
});

// ---- URLs ----
test('X: https URL weighs 23 regardless of length', () => {
  assert.equal(count('https://example.org', 'x').count, 23);
  assert.equal(count('https://example.com/a/very/long/path?with=query&and=more#frag', 'x').count, 23);
  assert.equal(count('http://x.co', 'x').count, 23);
});

test('X: URL inside text', () => {
  assert.equal(count('Mehr: https://example.org/blog', 'x').count, 6 + 23);
  assert.equal(count('a https://a.example.com b https://b.example.org', 'x').count, 2 + 23 + 3 + 23); // "a " + url + " b " + url
});

test('X: bare domains with a common TLD weigh 23', () => {
  assert.equal(count('example.org', 'x').count, 23);
  assert.equal(count('example.com', 'x').count, 23);
  assert.equal(count('Siehe www.example.org/kontakt heute', 'x').count, 6 + 23 + 6);
});

test('X: trailing punctuation is not part of the URL', () => {
  assert.equal(count('Siehe example.org.', 'x').count, 6 + 23 + 1);
  assert.equal(count('(https://example.org)', 'x').count, 1 + 23 + 1);
  assert.equal(count('https://example.org, danke!', 'x').count, 23 + 8);
});

// review round 1, finding 3: balanced parentheses belong to the URL path,
// unmatched surrounding punctuation does not
test('X: balanced parentheses inside a URL path are part of the URL', () => {
  assert.equal(count('http://en.wikipedia.org/wiki/Primer_(film)', 'x').count, 23);
  assert.equal(count('Film: http://en.wikipedia.org/wiki/Primer_(film).', 'x').count, 6 + 23 + 1);
  assert.equal(count('(http://en.wikipedia.org/wiki/Primer_(film))', 'x').count, 1 + 23 + 1);
  assert.equal(count('en.wikipedia.org/wiki/Primer_(film)', 'x').count, 23);
});

test('X: unmatched surrounding parentheses are counted as text', () => {
  assert.equal(count('(http://example.com)', 'x').count, 23 + 2);
  assert.equal(count('(example.com)', 'x').count, 23 + 2);
  assert.equal(count('http://example.com))', 'x').count, 23 + 2);
});

test('X: 280/281 boundary with a parenthesised path URL', () => {
  const t = rep('a', 256) + ' http://en.wikipedia.org/wiki/Primer_(film)';
  assert.deepEqual(count(t, 'x'), { count: 280, limit: 280, over: false });
  assert.deepEqual(count('b' + t, 'x'), { count: 281, limit: 280, over: true });
  const u = rep('a', 255) + '(http://example.com)';
  assert.deepEqual(count(u, 'x'), { count: 280, limit: 280, over: false });
  assert.deepEqual(count('b' + u, 'x'), { count: 281, limit: 280, over: true });
});

test('X: things that are not URLs', () => {
  assert.equal(count('bericht.pdf', 'x').count, 11);
  assert.equal(count('z.B. heute', 'x').count, 10);
  assert.equal(count('person@example.org', 'x').count, 18); // synthetic e-mail: no URL
  assert.equal(count('version 1.2.3', 'x').count, 13);
});

// review round 2, finding 2: table derived from twitter-text v3 extract.yml
test('X: twitter-text v3 URL extraction conformance and 280/281 boundaries', () => {
  const cases = [
    ['scheme needs a recognized TLD', 'http://no-tld', 13],
    ['one-character TLD is not recognized', 'http://tld-too-short.x', 22],
    ['hashtag excludes a bare domain', '#test.com', 9],
    ['hashtag excludes a scheme URL', '#http://test.com', 16],
    ['mention excludes a scheme URL', '@http://test.com', 16],
    ['recognized ccTLD', 'it.so', 23],
    ['accented Latin domain', 'ELPAÍS.com', 23],
    ['CJK ends a bare URL', 'example.comてすとです', 33],
    ['t.co apostrophe ends the URL', "http://t.co/pbY2NfTZ's", 25],
    ['Unicode gTLD', 'twitter.みんな', 23],
    ['dollar excludes a scheme URL', '$http://twitter.com', 19],
    ['unknown bare TLD', 'foo.baz', 7],
    ['path is part of a bare URL', 'example.com/path', 23],
    ['trailing path period is text', 'http://twitter.com/.', 24],
    ['punycode and ccTLD', 'http://xn--ls8h.XN--ls8h.la/', 23],
  ];
  for (const [name, text, expected] of cases) {
    assert.equal(count(text, 'x').count, expected, name);
    assert.deepEqual(count(rep('a', 279 - expected) + ' ' + text, 'x'), { count: 280, limit: 280, over: false }, name + ' at 280');
    assert.deepEqual(count(rep('a', 280 - expected) + ' ' + text, 'x'), { count: 281, limit: 280, over: true }, name + ' at 281');
  }
});

test('X: every twitter-text 3.1.0 URL extraction case has the upstream weighted length', () => {
  for (const { description, text, expected: urls } of twitterTextConformance.urls) {
    assert.equal(
      count(text, 'x').count,
      expectedUrlWeight(text, urls),
      description,
    );
  }
});

test('X: every discounted-emoji parseTweet weighting case has the upstream weighted length', () => {
  for (const { description, text, weightedLength } of twitterTextConformance.weighted_tweets) {
    assert.equal(count(text, 'x').count, weightedLength, description);
  }
});

test('X: shared review URL and IDNA corpus equals twitter-text at base and 280/281 boundaries', () => {
  for (const { name, text, upstream_count: expected } of sharedReviewCorpus) {
    assert.equal(count(text, 'x').count, expected, name);
    assert.deepEqual(
      count(rep('a', 279 - expected) + ' ' + text, 'x'),
      { count: 280, limit: 280, over: false },
      name + ' at 280',
    );
    assert.deepEqual(
      count(rep('a', 280 - expected) + ' ' + text, 'x'),
      { count: 281, limit: 280, over: true },
      name + ' at 281',
    );
  }
});

test('X: IDN labels and total URL length use upstream validation', () => {
  const cases = [
    ['invalid mixed punycode', 'Hello http://xn--はじめよう.com/index.html', 42],
    ['64-character ASCII label', 'http://' + rep('a', 64) + '.com', 75],
    ['URL above 4096 encoded characters', 'http://example.com/' + rep('a', 4096), 4115],
  ];
  for (const [name, text, expected] of cases) {
    assert.equal(count(text, 'x').count, expected, name);
  }
});

test('X: CJK boundaries split adjacent bare URLs and preserve 280/281', () => {
  assert.equal(count('日本語example.com', 'x').count, 29);
  assert.equal(count('example.com日本語example.com', 'x').count, 52);
  assert.deepEqual(
    count(rep('a', 250) + ' 日本語example.com', 'x'),
    { count: 280, limit: 280, over: false },
  );
  assert.deepEqual(
    count(rep('a', 251) + ' 日本語example.com', 'x'),
    { count: 281, limit: 280, over: true },
  );
});

test('X: failed non-ASCII TLD matching stays below 50 ms in Node', async () => {
  for (const length of [30, 10000]) {
    const { result, elapsed } = await timedWorkerCount(rep('あ', length) + '.invalid');
    assert.deepEqual(result, { count: (length * 2) + 8, limit: 280, over: length > 136 });
    assert.ok(elapsed < 50, `${length}-character counter took ${elapsed.toFixed(1)} ms`);
  }
});

test('X: adversarial URL parentheses stay bounded in Node', async () => {
  const prefix = 'http://example.com/';
  const cases = [
    ['30,000 unmatched closing parentheses', prefix + rep(')', 30000), 30023, 50],
    ['mixed balanced and unmatched parentheses', prefix + rep('(a)', 5000) + rep(')', 15000), 30019, 50],
    ['maximum spec text length of URL-like punctuation', prefix + rep(')', 63206 - prefix.length), 63210, 100],
  ];
  for (const [name, text, expected, limit] of cases) {
    const { result, elapsed } = await timedWorkerCount(text, 1000);
    assert.equal(result.count, expected, name);
    assert.ok(elapsed < limit, `${name} took ${elapsed.toFixed(1)} ms`);
  }
});

test('X: URL makes a long text fit (boundary with URL)', () => {
  const t = rep('a', 256) + ' https://example.org/' + rep('x', 100);
  assert.equal(count(t, 'x').count, 280);
  assert.equal(count('b' + t, 'x').count, 281); // appending would extend the URL
});

test('code-point platforms count URLs literally', () => {
  assert.equal(count('https://example.org', 'linkedin').count, 19);
  assert.equal(count('example.org', 'instagram').count, 11);
});

// ---- NFC ----
test('text is NFC-normalised before counting', () => {
  const decomposed = 'Grüße'; // u + combining diaeresis
  assert.equal(count(decomposed, 'linkedin').count, 5);
  assert.equal(count(decomposed, 'x').count, 5);
});

// ---- hashtags (Instagram) ----
test('Instagram: hashtag count and 30/31 boundary', () => {
  const tags = (n) => Array.from({ length: n }, (_, i) => '#tag' + i).join(' ');
  const r30 = count('Text\n\n' + tags(30), 'instagram');
  assert.equal(r30.hashtags, 30);
  assert.equal(r30.hashtagLimit, 30);
  assert.equal(r30.over, false);
  const r31 = count('Text\n\n' + tags(31), 'instagram');
  assert.equal(r31.hashtags, 31);
  assert.equal(r31.over, true);
});

test('Instagram: hashtags with umlauts, no false positives', () => {
  assert.equal(count('#Café #Übergröße #österreich', 'instagram').hashtags, 3);
  assert.equal(count('Preis 5 # Stück, a#b, #', 'instagram').hashtags, 0);
  assert.equal(count('##doppelt', 'instagram').hashtags, 1);
});

test('foldIndex: LinkedIn 210 and Instagram 125 code points', () => {
  const t = rep('a', 300);
  assert.equal(RS_COUNT.foldIndex(t, 'linkedin'), 210);
  assert.equal(RS_COUNT.foldIndex(t, 'instagram'), 125);
  assert.equal(RS_COUNT.foldIndex(rep('a', 210), 'linkedin'), -1);
  assert.equal(RS_COUNT.foldIndex(rep('😀', 130), 'instagram'), 250); // UTF-16 index after 125 code points
  assert.equal(RS_COUNT.foldIndex(t, 'x'), -1);
});
