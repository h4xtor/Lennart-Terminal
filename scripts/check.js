'use strict';

/**
 * Fast syntax gate: runs `node --check` on every JS file in src/, test/
 * and scripts/. Catches corrupted or partially-written files without
 * having to launch Electron.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) files.push(p);
  }
}

for (const dir of ['src', 'test', 'scripts']) walk(path.join(root, dir));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}`);
    console.error(String(err.stderr || err.message).trim());
    console.error('');
  }
}

if (failed) {
  console.error(`Syntax check FAILED: ${failed}/${files.length} file(s)`);
  process.exit(1);
}
console.log(`Syntax OK: ${files.length} files`);
