'use strict';

/**
 * Offline tests for the GitHub updater: semver ordering, release/asset and
 * checksum selection, changelog parsing, a real download against a local
 * HTTP stub, the pending-update notice, and the detached PowerShell helper
 * (including a real file swap on Windows).
 *
 * No test downloads the 70 MB production EXE or contacts GitHub.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  Updater,
  compareVersions,
  parseVersion,
  parseChecksums,
  cleanSubject,
  chooseBaseTag,
  pickPortableAsset,
  resolveInstallPlan,
  buildInstallScript,
} = require('../src/main/updater');

const ASSET = Buffer.from(`MZ fake portable exe ${'x'.repeat(256)}`);
const ASSET_HASH = crypto.createHash('sha256').update(ASSET).digest('hex');

function startServer(options = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const release = {
      tag_name: 'v9.9.9',
      name: 'Lennart Terminal v9.9.9',
      published_at: '2026-10-29T10:00:00Z',
      body: 'Test release',
      draft: false,
      prerelease: false,
      html_url: `${base}/releases/v9.9.9`,
      assets: [
        {
          name: 'LennartTerminal-9.9.9-portable.exe',
          size: ASSET.length,
          browser_download_url: `${base}/download/LennartTerminal-9.9.9-portable.exe`,
        },
        ...(options.noChecksum ? [] : [{
          name: 'SHA256SUMS.txt',
          size: 200,
          browser_download_url: `${base}/${options.badChecksum ? 'bad-sums.txt' : 'SHA256SUMS.txt'}`,
        }]),
      ],
    };

    if (url.pathname === '/repos/h4xtor/Lennart-Terminal/releases') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([release]));
      return;
    }
    if (url.pathname === '/repos/h4xtor/Lennart-Terminal/tags') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ name: 'v0.1.0' }, { name: 'v9.9.9' }]));
      return;
    }
    if (url.pathname === '/repos/h4xtor/Lennart-Terminal/compare/v0.1.0...v9.9.9') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        commits: [
          { commit: { message: 'Tilføj glowing version\n\nbody' } },
          { commit: { message: 'Ret knapper' } },
          { commit: { message: 'Merge branch main' } },
        ],
      }));
      return;
    }
    if (url.pathname === '/SHA256SUMS.txt') {
      res.end(`${ASSET_HASH}  LennartTerminal-9.9.9-portable.exe\r\n`);
      return;
    }
    if (url.pathname === '/bad-sums.txt') {
      res.end(`${'0'.repeat(64)}  LennartTerminal-9.9.9-portable.exe\r\n`);
      return;
    }
    if (url.pathname === '/download/LennartTerminal-9.9.9-portable.exe') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(ASSET.length));
      res.end(ASSET);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeUpdater(server, extra = {}) {
  const base = `http://127.0.0.1:${server.address().port}`;
  return new Updater({
    currentVersion: '0.2.0',
    apiBase: base,
    platform: 'win32',
    dataDir: extra.dataDir,
    tmpDir: extra.tmpDir,
    fetchImpl: fetch,
    ...extra,
  });
}

async function testSemver() {
  assert.deepStrictEqual(parseVersion('v0.4.2'), [0, 4, 2]);
  assert.strictEqual(compareVersions('0.2.0', '0.4.2'), -1);
  assert.strictEqual(compareVersions('v0.4.2', '0.4.2'), 0);
  assert.strictEqual(compareVersions('1.0.0', '0.9.9'), 1);
  assert.strictEqual(compareVersions('not-a-version', '0.1.0'), 0);
  console.log('PASS semver-sammenligning');
}

async function testReleaseParsing() {
  const release = {
    assets: [
      { name: 'LennartTerminal-win-x64.zip' },
      { name: 'LennartTerminal-1.2.3-portable.exe' },
    ],
  };
  assert.strictEqual(pickPortableAsset(release).name, 'LennartTerminal-1.2.3-portable.exe');
  assert.strictEqual(pickPortableAsset({ assets: [{ name: 'readme.txt' }] }), null);
  assert.strictEqual(pickPortableAsset({ assets: [{ name: 'Setup.exe' }] }), null, 'en installer er ikke en portable build');

  const sums = parseChecksums(
    `${'a'.repeat(64)}  one.exe\r\n${'b'.repeat(64)} *two.exe\n`,
  );
  assert.strictEqual(sums.get('one.exe'), 'a'.repeat(64));
  assert.strictEqual(sums.get('two.exe'), 'b'.repeat(64));
  assert.strictEqual(cleanSubject('v0.4.2: one stable link\n\nbody'), 'one stable link');

  assert.strictEqual(
    chooseBaseTag([{ name: 'v0.1.0' }, { name: 'v0.4.0' }, { name: 'v0.4.2' }], '0.2.0', 'v0.4.2'),
    'v0.1.0',
  );
  console.log('PASS release-, asset- og changelog-parsing');
}

async function testCheckAndDownload() {
  const server = await startServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lennart-updater-test-'));
  const progress = [];
  try {
    const updater = makeUpdater(server, {
      tmpDir: tmp,
      dataDir: path.join(tmp, 'data'),
      onProgress: (p) => progress.push(p),
    });

    const check = await updater.check();
    assert.strictEqual(check.ok, true);
    assert.strictEqual(check.updateAvailable, true);
    assert.strictEqual(check.latestVersion, '9.9.9');
    assert.strictEqual(check.releasesBehind, 1);
    assert.deepStrictEqual(check.changes, ['Tilføj glowing version', 'Ret knapper']);
    assert.strictEqual(check.installMode, 'managed');
    assert.ok(check.downloadUrl.includes('/download/'));
    assert.ok(check.checksumUrl.endsWith('/SHA256SUMS.txt'));

    const download = await updater.download();
    assert.strictEqual(download.ok, true, download.error);
    assert.strictEqual(download.sha256, ASSET_HASH);
    assert.ok(download.size === ASSET.length);
    assert.ok(fs.existsSync(download.file));
    assert.ok(progress.length >= 1);
    assert.strictEqual(progress[progress.length - 1].percent, 100);

    const status = updater.getStatus();
    assert.strictEqual(status.phase, 'ready');
    assert.strictEqual(status.downloaded, true);
    // A later check must not allow the verified file to masquerade as a
    // different release (or install the old file under its version marker).
    const originalJson = updater._json.bind(updater);
    updater._json = async (url) => {
      const result = await originalJson(url);
      if (url.includes('/releases?')) result[0].tag_name = 'v9.9.10';
      return result;
    };
    const next = await updater.check();
    assert.strictEqual(next.latestVersion, '9.9.10');
    assert.strictEqual(updater.getStatus().downloaded, false);
    assert.strictEqual((await updater.install()).ok, false, 'gammelt download må ikke installeres som ny version');
    console.log('PASS tjek + download med SHA-256 og progress');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testUpToDate() {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const updater = new Updater({
      currentVersion: '9.9.9',
      apiBase: base,
      platform: 'win32',
      dataDir: os.tmpdir(),
    });
    const res = await updater.check();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.updateAvailable, false);
    assert.strictEqual(res.currentVersion, '9.9.9');
    console.log('PASS nyeste version genkendes');
  } finally {
    server.close();
  }
}

async function testBadChecksum() {
  const server = await startServer({ badChecksum: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lennart-updater-bad-'));
  try {
    const updater = makeUpdater(server, { tmpDir: tmp, dataDir: path.join(tmp, 'data') });
    const check = await updater.check();
    assert.strictEqual(check.ok, true);
    const download = await updater.download();
    assert.strictEqual(download.ok, false);
    assert.ok(/kontrolsum/i.test(download.error), download.error);
    const leftovers = fs.readdirSync(tmp).filter((f) => f.endsWith('.exe'));
    assert.deepStrictEqual(leftovers, [], 'en forkert kontrolsum efterlader ingen .exe');
    console.log('PASS forkert kontrolsum afvises');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testMissingChecksum() {
  const server = await startServer({ noChecksum: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lennart-updater-nosums-'));
  try {
    const updater = makeUpdater(server, { tmpDir: tmp, dataDir: path.join(tmp, 'data') });
    await updater.check();
    const download = await updater.download();
    assert.strictEqual(download.ok, false);
    assert.ok(/kontrolsum/i.test(download.error), download.error);
    console.log('PASS download uden kontrolsum afvises');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testInstallPlan() {
  const portable = resolveInstallPlan({ portableExe: path.join(os.tmpdir(), 'Lennart Terminal.exe') });
  assert.strictEqual(portable.mode, 'portable');
  assert.ok(portable.target.endsWith('Lennart Terminal.exe'));

  const managed = resolveInstallPlan({ localAppData: path.join(os.tmpdir(), 'LocalAppData') });
  assert.strictEqual(managed.mode, 'managed');
  assert.ok(managed.target.includes('Lennart Terminal'));
  assert.ok(managed.target.endsWith('LennartTerminal.exe'));
  console.log('PASS installationsmål (portable vs. administreret)');
}

async function testPendingMarker() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lennart-pending-'));
  const file = path.join(dataDir, 'pending-update.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      from: '0.2.0',
      to: '0.2.0',
      installedAt: '2026-10-29T10:00:00Z',
      changes: ['Ny version'],
      releaseUrl: 'https://example.test/release',
    }));
    const updater = new Updater({ currentVersion: '0.2.0', platform: 'win32', dataDir });
    const pending = updater.takePending();
    assert.strictEqual(pending.to, '0.2.0');
    assert.deepStrictEqual(pending.changes, ['Ny version']);
    assert.ok(!fs.existsSync(file), 'markøren forbruges kun én gang');

    fs.writeFileSync(file, JSON.stringify({ from: '0.2.0', to: '9.9.9' }));
    assert.strictEqual(updater.takePending(), null, 'gammel build viser ikke en falsk succes');
    assert.ok(fs.existsSync(file), 'markøren gemmes til den nye build');

    fs.writeFileSync(file, JSON.stringify({ from: '0.1.0', to: '0.1.0' }));
    assert.strictEqual(updater.takePending(), null, 'forældet markør ignoreres');
    assert.ok(!fs.existsSync(file), 'forældet markør ryddes');
    console.log('PASS opdateret-markør (kun én gang, kun præcis ny version)');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testHelperScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lennart-helper-test's "));
  try {
    const target = path.join(dir, 'Lennart Terminal.exe');
    const downloaded = path.join(dir, 'download.exe');
    const logFile = path.join(dir, 'update.log');
    const script = buildInstallScript({
      waitPid: 424242,
      downloaded,
      target,
      logFile,
      noLaunch: true,
    });
    assert.ok(script.includes('Wait-ForProcessGone 424242'));
    assert.ok(script.includes("test''s"), 'apostroffer escapes korrekt i PowerShell');
    assert.ok(!script.includes('Start-Process -FilePath'), 'testtilstand starter ikke appen');

    if (process.platform === 'win32') {
      fs.writeFileSync(target, 'old');
      fs.writeFileSync(downloaded, 'new');
      const file = path.join(dir, 'helper.ps1');
      fs.writeFileSync(file, `\uFEFF${script}`, 'utf8');

      const parse = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[void][scriptblock]::Create((Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}'))`,
      ], { timeout: 15000 });
      assert.strictEqual(parse.status, 0, String(parse.stderr));

      const run = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        file,
      ], { timeout: 30000 });
      assert.strictEqual(run.status, 0, String(run.stderr));
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
      assert.ok(!fs.existsSync(downloaded), 'det hentede temp-download slettes');
      assert.strictEqual(fs.readFileSync(`${target}.old`, 'utf8'), 'old', 'den gamle .exe bevares som sikkerhedskopi');
      assert.ok(fs.existsSync(logFile));
      assert.ok(fs.readFileSync(logFile, 'utf8').includes('done'));
      console.log('PASS PowerShell-hjælper: rigtig filudskiftning og oprydning');
    } else {
      console.log('PASS PowerShell-hjælper (filudskiftning testes kun på Windows)');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testSemver();
  await testReleaseParsing();
  await testCheckAndDownload();
  await testUpToDate();
  await testBadChecksum();
  await testMissingChecksum();
  await testInstallPlan();
  await testPendingMarker();
  await testHelperScript();
  console.log('\nUpdater-tests bestået.');
}

main().catch((err) => {
  console.error(`\nUPDATER-TEST FEJLEDE: ${err.stack || err}`);
  process.exitCode = 1;
});
