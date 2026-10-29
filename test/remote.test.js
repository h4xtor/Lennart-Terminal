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
  assert.ok(!args.includes('Get-Date'), 'command is not passed raw to the remote shell');
  const encIdx = args.indexOf('-EncodedCommand');
  assert.ok(encIdx > 0, 'uses -EncodedCommand');
  assert.strictEqual(args[args.indexOf('-OutputFormat') + 1], 'Text', 'prevents CLIXML error output');
  const enc = args[args.indexOf('-EncodedCommand') + 1];
  assert.ok(Buffer.from(enc, 'base64').toString('utf16le').includes('Get-Date'), 'command travels encoded');
  // a huge command falls back to -Command (cmd.exe line limit on the target)
  const [, bigArgs] = buildRemoteArgv('h', 'ssh', 'x'.repeat(6000), {});
  assert.ok(bigArgs.includes('-Command'), 'long commands fall back to -Command');
  assert.ok(!args.some((a) => typeof a === 'string' && /password/i.test(a)), 'no password flags in ssh argv');
  console.log('PASS ssh argv (encoded command)');
}

async function testSshArgvWithoutUser() {
  const [file, args] = buildRemoteArgv('pc12.local', 'ssh', 'hostname', {});
  assert.strictEqual(file, 'ssh.exe');
  assert.ok(args.includes('pc12.local'));
  const encIdx = args.indexOf('-EncodedCommand');
  assert.ok(Buffer.from(args[encIdx + 1], 'base64').toString('utf16le').endsWith('hostname'), 'ends with the user command');
  console.log('PASS ssh argv without user');
}

async function testSshShellSpecialChars() {
  // Linux/macOS remote shells (and cmd.exe on Windows) must not expand
  // $variables or split on pipes before PowerShell receives the command.
  const cmd = '$PSVersionTable.PSVersion | Out-String';
  const [, args] = buildRemoteArgv('linux-box', 'ssh', cmd, {});
  const encIdx = args.indexOf('-EncodedCommand');
  assert.ok(Buffer.from(args[encIdx + 1], 'base64').toString('utf16le').endsWith(cmd), 'ends with the user command');
  assert.ok(!args.includes(cmd), 'raw command never reaches the remote shell');
  console.log('PASS ssh keeps $variables and pipes intact');
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
  assert.ok(decoded.includes('TrustedHosts'), 'decoded command explains the TrustedHosts fix');
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
  await testSshShellSpecialChars();
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
