'use strict';

/**
 * Offline tests for the permanent history store: JSONL append, query with
 * filters, rotation and clear.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HistoryStore, tail } = require('../src/main/history');

async function testAddAndQuery(tmp) {
  const file = path.join(tmp, 'hist', 'history.jsonl');
  const h = new HistoryStore(file);
  h.add({ type: 'local', command: 'Get-Process', output: 'lots of processes', ok: true });
  h.add({ type: 'remote', host: 'Gaming-PC 3', command: 'ipconfig /all', output: 'IPv4 . . : 192.168.1.50', ok: true });
  h.add({ type: 'ai', command: 'hvordan finder jeg port 3000?', output: 'Brug Get-NetTCPConnection…' });

  const all = h.query({ limit: 100 });
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[0].command, 'hvordan finder jeg port 3000?', 'newest first');

  const remote = h.query({ type: 'remote' });
  assert.strictEqual(remote.length, 1);
  assert.strictEqual(remote[0].host, 'Gaming-PC 3');

  const hits = h.query({ query: '192.168.1.50' });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].command, 'ipconfig /all');
  console.log('PASS add + query');
}

async function testRotation(tmp) {
  const file = path.join(tmp, 'hist2', 'history.jsonl');
  // Tiny limit forces rotation(s) mid-run — the store keeps one generation
  // (.1) plus the live file by design, like logrotate.
  const h = new HistoryStore(file, { maxBytes: 600 });
  for (let i = 0; i < 10; i++) h.add({ command: `command number ${i} with some padding to grow the file`.repeat(2) });

  assert.ok(fs.existsSync(file + '.1'), 'rotated file exists');
  const rows = h.query({ limit: 1000 });
  assert.ok(rows.length > 0, 'rotated data readable');
  assert.ok(rows.length <= 10, 'no duplicates across generations');
  const newest = rows.find((r) => r.command.startsWith('command number 9'));
  assert.ok(newest, 'newest record survives rotation');
  console.log(`PASS rotation (${rows.length} records across 2 files)`);
}

async function testTruncation(tmp) {
  const file = path.join(tmp, 'hist3', 'history.jsonl');
  const h = new HistoryStore(file);
  const big = 'x'.repeat(50000);
  h.add({ command: big, output: big });
  const recs = h.query({ limit: 1 });
  assert.ok(recs[0].command.length <= 4001, 'command capped at 4000 + ellipsis');
  assert.ok(recs[0].output.length <= 2501, 'output capped at 2500 + ellipsis');
  assert.strictEqual(tail('abcdef', 3), '…def', 'ellipsis + last n chars');
  assert.strictEqual(tail('abcdef', 10), 'abcdef', 'short strings untouched');
  console.log('PASS truncation');
}

async function testClear(tmp) {
  const file = path.join(tmp, 'hist4', 'history.jsonl');
  const h = new HistoryStore(file);
  h.add({ command: 'dir' });
  assert.strictEqual(h.query({}).length, 1);
  assert.strictEqual(h.clear(), true);
  assert.strictEqual(h.query({}).length, 0);
  console.log('PASS clear');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-history-'));
  try {
    await testAddAndQuery(tmp);
    await testRotation(tmp);
    await testTruncation(tmp);
    await testClear(tmp);
    console.log('ALL HISTORY TESTS PASSED');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
