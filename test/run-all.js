'use strict';

/**
 * Test runner: executes every test/*.test.js in its own process and fails
 * if any of them fail. Integration tests that need external resources or
 * real credentials are excluded from the automatic run (they are listed in
 * EXCLUDE and can still be run manually with `node test/<file>`).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// agy.test.js talks to the real Antigravity CLI/account — manual only.
const EXCLUDE = new Set(['agy.test.js']);

const tests = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js') && !EXCLUDE.has(f))
  .sort();

let failed = 0;
for (const t of tests) {
  process.stdout.write(`\n--- ${t} ---\n`);
  const res = spawnSync(process.execPath, [path.join(__dirname, t)], {
    stdio: 'inherit',
    timeout: 60000,
  });
  if (res.status !== 0) {
    failed++;
    console.error(`FAIL ${t} (exit ${res.status})`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
