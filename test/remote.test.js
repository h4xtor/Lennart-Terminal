'use strict';

/**
 * Offline tests for network remote execution: argv building for SSH and
 * WinRM (credentials must never appear in visible argv for SSH; WinRM
 * passes them inside an encoded command), quoting and runner wiring.
 */

const assert = require('assert');
const { buildRemoteArgv, psQuote, b64Utf16, sshSetupCommand, RemoteRunner } = require('../src/main/remote');

async function testSshArgv() {
  const [file, args] = buildRemoteArgv('192.168.1.50', 'ssh', 'Get-Date', { username: 'admin', keyPath: 'C:\\k.pem' });
  assert.strictEqual(file, 'ssh.exe');
  assert.ok(args.includes('admin@192.168.1.50'));
  assert.ok(args.includes('C:\\k.pem'));
  assert.ok(args.includes('Get-Date'));
  assert.ok(!args.some((a) => typeof a === 'string' && /password/i.test(a)), 'no password flags in ssh argv');
  console.log('PASS ssh argv');
}

async function testSshArgvWithoutUser() {
  const [file, args] = buildRemoteArgv('pc12.local', 'ssh', 'hostname', {});
  assert.strictEqual(file, 'ssh.exe');
  assert.ok(args.includes('pc12.local'));
  console.log('PASS ssh argv without user');
}

async function testWinrmArgv() {
  const [file, args] = buildRemoteArgv('pc13', 'winrm', 'hostname', { username: 'admin', password: 'S3cret!' });
  assert.strictEqual(file, 'powershell.exe');
  const encIdx = args.indexOf('-EncodedCommand');
  assert.ok(encIdx > 0, 'uses -EncodedCommand');
  const decoded = Buffer.from(args[encIdx + 1], 'base64').toString('utf16le');
  assert.ok(decoded.includes('Invoke-Command'), 'decoded command wraps Invoke-Command');
  assert.ok(decoded.includes("'pc13'"), 'decoded command contains host');
  assert.ok(decoded.includes("'S3cret!'"), 'password travels inside the encoded blob, not raw argv');
  assert.ok(!args.some((a) => a === 'S3cret!'), 'password never visible as plain argv');
  console.log('PASS winrm argv (encoded credentials)');
}

async function testPsQuote() {
  assert.strictEqual(psQuote("it's"), "'it''s'");
  assert.strictEqual(psQuote('plain'), "'plain'");
  assert.strictEqual(b64Utf16('ab'), Buffer.from('ab', 'utf16le').toString('base64'));
  console.log('PASS psQuote + b64Utf16');
}

async function testSshSetupCommand() {
  const cmd = sshSetupCommand();
  assert.ok(cmd.includes('OpenSSH.Server'));
  assert.ok(cmd.includes('sshd'));
  console.log('PASS ssh setup command');
}

async function testRunnerMissingSpawn() {
  // spawn of a binary that does not exist -> resolves (never throws)
  const r = new RemoteRunner({ log: () => {}, emit: () => {} });
  const res = await r.run('t1', { host: 'no-such-host.invalid', method: 'ssh' }, 'echo hi', 1500);
  assert.ok(typeof res.ok === 'boolean');
  assert.ok(typeof res.output === 'string');
  console.log('PASS runner resolves on unreachable host');
}

async function main() {
  await testSshArgv();
  await testSshArgvWithoutUser();
  await testWinrmArgv();
  await testPsQuote();
  await testSshSetupCommand();
  await testRunnerMissingSpawn();
  console.log('ALL REMOTE TESTS PASSED');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
