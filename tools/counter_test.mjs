#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  process.env.RS_TOOL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
);

try {
  const require = createRequire(import.meta.url);
  const counter = require(path.join(root, 'core', 'static', 'count.js'));
  const cases = [];
  const add = (name, platform, text, count, over, extra = {}) => {
    cases.push({ name, platform, text, count, over, ...extra });
  };
  for (const length of [0, 1, 279, 280, 281]) {
    add(`synthetic-x-ascii-${length}`, 'x', 'a'.repeat(length), length, length > 280);
  }
  for (const length of [1, 139, 140, 141]) {
    add(`synthetic-x-cjk-${length}`, 'x', '界'.repeat(length), length * 2, length > 140);
    add(`synthetic-x-emoji-${length}`, 'x', '🐝'.repeat(length), length * 2, length > 140);
  }
  for (const [platform, limit] of [
    ['linkedin', 3000],
    ['linkedin_comment', 1250],
    ['instagram', 2200],
    ['facebook', 63206],
  ]) {
    for (const length of [0, 1, limit, limit + 1]) {
      add(`synthetic-${platform}-${length}`, platform, 'n'.repeat(length), length, length > limit);
    }
  }
  for (const count of [0, 1, 30, 31]) {
    const text = Array.from({ length: count }, (_, index) => `#tag${index}`).join(' ');
    add(
      `synthetic-instagram-hashtags-${count}`,
      'instagram',
      text,
      [...text].length,
      count > 30,
      { hashtags: count },
    );
  }
  add('synthetic-x-url', 'x', 'https://example.com/a/long/path', 23, false);
  add('synthetic-x-url-boundary-280', 'x', `${'a'.repeat(256)} https://example.com/path`, 280, false);
  add('synthetic-x-url-boundary-281', 'x', `${'a'.repeat(257)} https://example.com/path`, 281, true);
  const results = cases.map((item, index) => {
    const actual = counter.count(item.text, item.platform);
    const failures = [];
    if (actual.count !== item.count) failures.push(`count ${actual.count} != ${item.count}`);
    if (actual.over !== item.over) failures.push(`over ${actual.over} != ${item.over}`);
    if (item.limit !== undefined && actual.limit !== item.limit) failures.push(`limit ${actual.limit} != ${item.limit}`);
    if (item.hashtags !== undefined && actual.hashtags !== item.hashtags) failures.push(`hashtags ${actual.hashtags} != ${item.hashtags}`);
    return { index, name: item.name || `case-${index + 1}`, platform: item.platform, pass: failures.length === 0, failures, actual };
  });
  const passed = results.filter((item) => item.pass).length;
  const output = {
    ok: passed === results.length && results.length >= 30,
    passed,
    total: results.length,
    ratio: results.length ? passed / results.length : 0,
    minimum_cases: 30,
    fixture_source: 'synthetic test-owned strings',
    cases: results,
  };
  console.log(JSON.stringify(output));
  process.exitCode = output.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, passed: 0, total: 0, ratio: 0, error: error.stack || String(error) }));
  process.exitCode = 1;
}
