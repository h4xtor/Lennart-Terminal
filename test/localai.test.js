'use strict';

/**
 * Offline tests for the embedded local AI engine (no downloads, no spawn):
 * server args, health polling logic, ensure() fail-fast without downloads,
 * and status path composition.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  LocalAI, LOCAL_MODEL, serverArgs, binName, healthUrl, chatUrl, httpGetJson,
} = require('../src/main/localai');

async function testServerArgs() {
  const args = serverArgs('C:\\m.gguf', 9601, 3);
  assert.strictEqual(args[0], '-m');
  assert.strictEqual(args[1], 'C:\\m.gguf');
  const portIdx = args.indexOf('--port');
  assert.ok(portIdx > 0);
  assert.strictEqual(args[portIdx + 1], '9601');
  const tIdx = args.indexOf('-t');
  assert.strictEqual(args[tIdx + 1], '3');
  console.log('PASS serverArgs');
}

async function testBinName() {
  assert.strictEqual(binName('win32'), 'llama-server.exe');
  assert.strictEqual(binName('linux'), 'llama-server');
  console.log('PASS binName');
}

async function testPathsAndStatus(tmpRoot) {
  const ai = new LocalAI({ root: path.join(tmpRoot, 'localai'), log: () => {}, emit: () => {} });
  const p = ai.paths();
  assert.ok(p.bin.endsWith(binName('win32')));
  assert.ok(p.model.endsWith(LOCAL_MODEL.file));
  const st = ai.status();
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.binary, false);
  assert.strictEqual(st.model, false);
  assert.strictEqual(st.modelId, LOCAL_MODEL.id);
  console.log('PASS paths + status');
}

async function testEnsureFailsFastWithoutDownloads(tmpRoot) {
  const ai = new LocalAI({ root: path.join(tmpRoot, 'localai'), log: () => {}, emit: () => {} });
  await assert.rejects(
    () => ai.ensure({ allowDownload: false }),
    /ikke downloadet/i,
  );
  console.log('PASS ensure fails fast with allowDownload=false');
}

async function testHttpGetJson(tmpRoot) {
  const server = http.createServer((req, res) => {
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const obj = await httpGetJson(`http://127.0.0.1:${port}/health`, 1500);
  assert.deepStrictEqual(obj, { status: 'ok' });
  await new Promise((r) => server.close(r));
  console.log('PASS httpGetJson');
}

async function testHealthAndChatUrls() {
  assert.strictEqual(healthUrl(9601), 'http://127.0.0.1:9601/health');
  assert.strictEqual(chatUrl(9601), 'http://127.0.0.1:9601/v1/chat/completions');
  console.log('PASS health/chat urls');
}

async function testStartFailsWhenBinaryMissing(tmpRoot) {
  const ai = new LocalAI({ root: path.join(tmpRoot, 'localai'), log: () => {}, emit: () => {} });
  // Ensure() with downloads disallowed fails on the FIRST missing asset —
  // simulate the binary present but model missing via the private check path:
  const bin = ai.paths().bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'dummy');
  await assert.rejects(() => ai.ensure({ allowDownload: false }), /Modellen er ikke downloadet/i);
  console.log('PASS start fails fast when model missing');
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-localai-'));
  try {
    await testServerArgs();
    await testBinName();
    await testHealthAndChatUrls();
    await testPathsAndStatus(tmpRoot);
    await testEnsureFailsFastWithoutDownloads(tmpRoot);
    await testHttpGetJson(tmpRoot);
    await testStartFailsWhenBinaryMissing(tmpRoot);
    console.log('ALL LOCALAI TESTS PASSED');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
