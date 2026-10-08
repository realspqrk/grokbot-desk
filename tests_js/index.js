// Entry for `node --test tests_js/`: Node 22 resolves a directory argument as a
// module (this file) instead of searching it, so load every *.test.mjs here.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(path.join(__dirname, f)).href);
}
