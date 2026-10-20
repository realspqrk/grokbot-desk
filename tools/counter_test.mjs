#!/usr/bin/env node
// C6: the page's character counter (core/static/count.js) against the
// pinned upstream twitter-text corpus (tests_js/fixtures): every case's X
// weight equals the upstream count, and none is over the limit.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(
  process.env.RS_TOOL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
const FIXTURES = path.join(root, 'tests_js', 'fixtures');

try {
  const round4 = JSON.parse(readFileSync(path.join(FIXTURES, 'twitter-text-round4.json'), 'utf8'));
  const round5 = (await import(pathToFileURL(path.join(FIXTURES, 'twitter-text-round5.mjs')).href)).default;
  const cases = [...round4.cases, ...round5.cases].map((item) => ({
    name: item.name, platform: 'x', text: item.text, count: item.upstream_count, over: false,
  }));
  const require = createRequire(import.meta.url);
  const counter = require(path.join(root, 'core', 'static', 'count.js'));
  const results = cases.map((item, index) => {
    const actual = counter.count(item.text, item.platform);
    const failures = [];
    if (actual.count !== item.count) failures.push(`count ${actual.count} != ${item.count}`);
    if (actual.over !== item.over) failures.push(`over ${actual.over} != ${item.over}`);
    return { index, name: item.name || `case-${index + 1}`, platform: item.platform, pass: failures.length === 0, failures, actual };
  });
  const passed = results.filter((item) => item.pass).length;
  const output = {
    ok: passed === results.length && results.length >= 30,
    passed,
    total: results.length,
    ratio: results.length ? passed / results.length : 0,
    minimum_cases: 30,
    corpus: 'tests_js/fixtures/twitter-text-round4.json + twitter-text-round5.mjs',
    cases: results,
  };
  console.log(JSON.stringify(output));
  process.exitCode = output.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, passed: 0, total: 0, ratio: 0, error: error.stack || String(error) }));
  process.exitCode = 1;
}
