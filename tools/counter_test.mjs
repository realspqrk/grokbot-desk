#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvedTemplates } from './template-registry.mjs';

const root = path.resolve(
  process.env.RS_TOOL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
);

function registeredTemplate(templateId) {
  const matches = resolvedTemplates(root, templateId).map((item) => item.dir);
  if (matches.length !== 1) {
    throw new Error(`${templateId}: expected one registered template, found ${matches.length}`);
  }
  return matches[0];
}

try {
  const templateDir = registeredTemplate('preview-post');
  const casesPath = path.join(templateDir, 'fixtures', 'expect', 'counter-cases.json');
  if (!existsSync(casesPath)) throw new Error(`missing ${path.relative(root, casesPath)}`);
  const require = createRequire(import.meta.url);
  const counter = require(path.join(root, 'core', 'static', 'count.js'));
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('counter-cases.json must contain an array');
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
    template_dir: path.relative(root, templateDir),
    cases: results,
  };
  console.log(JSON.stringify(output));
  process.exitCode = output.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, passed: 0, total: 0, ratio: 0, error: error.stack || String(error) }));
  process.exitCode = 1;
}
