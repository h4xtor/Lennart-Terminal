'use strict';

/**
 * GitHub updater for Lennart Terminal.
 *
 * Official releases are portable Windows EXEs (electron-builder `portable`
 * target), not NSIS installers, so electron-updater cannot be used. This
 * module:
 *
 *   1. reads the newest stable release from the public GitHub repo,
 *   2. compares its semver tag with the running version,
 *   3. collects a readable "what's new" list from the commits since the
 *      newest tag the user already has,
 *   4. downloads the portable EXE and verifies its SHA-256 checksum,
 *   5. hands the replacement to a detached PowerShell helper that waits for
 *      this process to exit, swaps the EXE, launches the new one and deletes
 *      the old file.
 *
 * The helper is detached on purpose: Windows cannot replace a running EXE,
 * and the app must be completely gone before the swap. It is written with a
 * UTF-8 BOM so Windows PowerShell 5.1 reads it correctly.
 *
 * None of the network or install code is imported by the renderer. The
 * renderer only sees the sanitised info object through IPC.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const OWNER = 'h4xtor';
const REPO = 'Lennart-Terminal';
const USER_AGENT = 'Lennart-Terminal-Updater';
const MAX_CHANGES = 24;
const RELEASE_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Semver compare without pre-release support (release tags are stable). */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function normaliseVersion(value) {
  const p = parseVersion(value);
  return p ? p.join('.') : '';
}

/** PowerShell single-quoted literal: 'it''s'. */
function psQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol === 'https:') return true;
    // Plain HTTP is only acceptable for the local GitHub stub used by the
    // tests; a real download must never travel unencrypted.
    return u.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Prefer the stable, unversioned portable asset, then a versioned one. */
function pickPortableAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const exes = assets.filter((a) => a && /\.exe$/i.test(String(a.name || '')));
  return exes.find((a) => a.name === 'LennartTerminal-portable.exe')
    || exes.find((a) => /-portable\.exe$/i.test(a.name))
    || exes.find((a) => /portable/i.test(a.name))
    || null;
}

function pickChecksumAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  return assets.find((a) => a && /^SHA256SUMS\.txt$/i.test(String(a.name || ''))) || null;
}

function parseChecksums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m) map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

function cleanSubject(message) {
  let subject = String(message || '').split('\n')[0].trim();
  // Release commits are prefixed with their version ("v0.4.2: …"); the
  // version is already shown as a heading, so drop the prefix.
  subject = subject.replace(/^v?\d+\.\d+\.\d+:\s*/i, '');
  return subject;
}

function releaseVersion(release) {
  return parseVersion(release && (release.tag_name || release.name));
}

function newestRelease(releases) {
  return (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.draft && !r.prerelease && releaseVersion(r))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] || null;
}

/**
 * The newest tag the user already has. Current versions without a tag of
 * their own (this branch is 0.2.0 while only v0.1.0 and v0.4.x are tagged)
 * map to the newest tag below them, so the changelog starts at the last
 * released baseline.
 */
function chooseBaseTag(tags, currentVersion, latestVersion) {
  const parsed = (Array.isArray(tags) ? tags : [])
    .map((t) => ({ tag: String(t && t.name || ''), version: parseVersion(t && t.name) }))
    .filter((t) => t.version);
  if (!parsed.length) return '';
  const older = parsed
    .filter((t) => compareVersions(t.tag, currentVersion) <= 0)
    .sort((a, b) => compareVersions(b.tag, a.tag));
  if (older.length) return older[0].tag;
  const beforeLatest = parsed
    .filter((t) => compareVersions(t.tag, latestVersion) < 0)
    .sort((a, b) => compareVersions(a.tag, b.tag));
  return beforeLatest.length ? beforeLatest[0].tag : '';
}

function resolveInstallPlan(options = {}) {
  const portable = String(options.portableExe || '').trim();
  if (portable && /\.exe$/i.test(portable)) {
    return { target: path.resolve(portable), mode: 'portable' };
  }
  const localAppData = options.localAppData
    || process.env.LOCALAPPDATA
    || path.join(os.homedir(), 'AppData', 'Local');
  return {
    target: path.join(localAppData, 'Lennart Terminal', 'LennartTerminal.exe'),
    mode: 'managed',
  };
}

/**
 * Detached replacement helper. It waits for the old PID, moves the old EXE
 * aside, copies the new one in and launches it. The old EXE remains as .old
 * for recovery. On failure the helper restores the previous EXE when possible.
 *
 * `noLaunch` exists for the Windows integration test: the file swap is real,
 * but no app window is opened during the test run.
 */
function buildInstallScript(options = {}) {
  const waitPid = Number(options.waitPid) || 0;
  const downloaded = String(options.downloaded || '');
  const target = String(options.target || '');
  const targetDir = path.dirname(target);
  const old = `${target}.old`;
  const logFile = String(options.logFile || path.join(os.tmpdir(), 'lennart-update.log'));
  const noLaunch = options.noLaunch === true;

  return `# Lennart Terminal auto-update helper (generated)
$ErrorActionPreference = 'Stop'
$logFile = ${psQuote(logFile)}

function Write-UpdateLog([string]$message) {
  try {
    ('[' + (Get-Date).ToString('o') + '] ' + $message) |
      Out-File -LiteralPath $logFile -Append -Encoding utf8
  } catch { }
}

function Wait-ForProcessGone([int]$procId, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

$movedOld = $false
try {
  Write-UpdateLog 'waiting for pid ${waitPid}'
  if (-not (Wait-ForProcessGone ${waitPid} 90)) { throw 'the old app did not exit' }
  Start-Sleep -Milliseconds 600

  # Never overwrite a backup from a previous attempt.
  if (Test-Path -LiteralPath ${psQuote(old)}) {
    throw 'a previous .old backup exists; move it before updating again'
  }

  if (Test-Path -LiteralPath ${psQuote(target)}) {
    $moved = $false
    for ($i = 0; $i -lt 40 -and -not $moved; $i++) {
      try {
        Move-Item -LiteralPath ${psQuote(target)} -Destination ${psQuote(old)} -Force -ErrorAction Stop
        $moved = $true
        $movedOld = $true
      } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $moved) { throw 'the old exe is still locked' }
  }

  $copied = $false
  for ($i = 0; $i -lt 40 -and -not $copied; $i++) {
    try {
      Copy-Item -LiteralPath ${psQuote(downloaded)} -Destination ${psQuote(target)} -Force -ErrorAction Stop
      $copied = $true
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $copied) { throw 'could not write the new exe' }

  Unblock-File -LiteralPath ${psQuote(target)} -ErrorAction SilentlyContinue
  Write-UpdateLog 'installed'

  ${noLaunch
    ? "Write-UpdateLog 'launch skipped (test)'"
    : `Start-Process -FilePath ${psQuote(target)} -WorkingDirectory ${psQuote(targetDir)}`}

  # A launcher process (or another running copy) does not prove that the new
  # application started successfully. Preserve the backup for manual recovery.
  if ($movedOld) { Write-UpdateLog 'old exe kept as .old for recovery' }
  Remove-Item -LiteralPath ${psQuote(downloaded)} -Force -ErrorAction SilentlyContinue
  Write-UpdateLog 'done'
} catch {
  Write-UpdateLog ('failed: ' + $_.Exception.Message)
  if ($movedOld -and (Test-Path -LiteralPath ${psQuote(old)})) {
    try {
      if (Test-Path -LiteralPath ${psQuote(target)}) { Remove-Item -LiteralPath ${psQuote(target)} -Force }
      Move-Item -LiteralPath ${psQuote(old)} -Destination ${psQuote(target)} -Force
    } catch { Write-UpdateLog ('rollback failed: ' + $_.Exception.Message) }
  }
  if (Test-Path -LiteralPath ${psQuote(target)}) {
    ${noLaunch
      ? "Write-UpdateLog 'rollback complete (test)'"
      : `try { Start-Process -FilePath ${psQuote(target)} -WorkingDirectory ${psQuote(targetDir)} } catch { }`}
  }
} finally {
  Start-Sleep -Seconds 1
  try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch { }
}
`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function friendlyError(err) {
  const message = String((err && err.message) || err || 'Ukendt fejl');
  if (/403|rate limit/i.test(message)) {
    return 'GitHub afviser lige nu (rate limit). Prøv igen om lidt.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return 'Kunne ikke nå GitHub. Tjek internetforbindelsen og prøv igen.';
  }
  if (/404/.test(message)) {
    return 'GitHub-releases blev ikke fundet.';
  }
  return message;
}

class Updater {
  constructor(options = {}) {
    this.owner = options.owner || OWNER;
    this.repo = options.repo || REPO;
    this.apiBase = String(
      options.apiBase || process.env.LENNART_UPDATE_API || 'https://api.github.com',
    ).replace(/\/+$/, '');
    this.currentVersion = normaliseVersion(options.currentVersion) || String(options.currentVersion || '0.0.0');
    this.dataDir = options.dataDir || path.join(os.homedir(), '.lennart-terminal');
    this.tmpDir = options.tmpDir || os.tmpdir();
    this.platform = options.platform || process.platform;
    this.isPackaged = options.isPackaged === true;
    this.portableExe = options.portableExe || '';
    this.localAppData = options.localAppData || '';
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this.log = typeof options.log === 'function' ? options.log : () => {};

    this._info = null;
    this._downloaded = null;
    this._progress = null;
    this._phase = 'idle';
    this._error = '';
    this._checking = false;
    this._downloading = false;
  }

  getStatus() {
    // A renderer reload must not resurrect a "ready" state for a temp file
    // that Windows or the user has already removed.
    if (this._downloaded && !fs.existsSync(this._downloaded.file)) {
      this._downloaded = null;
      this._progress = null;
      if (this._phase === 'ready') {
        this._phase = this._info && this._info.updateAvailable ? 'available' : 'current';
      }
    }
    return {
      phase: this._phase,
      info: this._info,
      progress: this._progress,
      downloaded: Boolean(this._downloaded),
      error: this._error,
      mode: this._installPlan().mode,
      installDir: path.dirname(this._installPlan().target),
      development: !this.isPackaged,
      currentVersion: this.currentVersion,
    };
  }

  _installPlan() {
    return resolveInstallPlan({
      portableExe: this.portableExe,
      localAppData: this.localAppData,
    });
  }

  _setPhase(phase, error = '') {
    this._phase = phase;
    this._error = error;
  }

  _fail(message) {
    const text = friendlyError(message);
    this._setPhase('error', text);
    this.log(`[update] ${text}`);
    return { ok: false, error: text };
  }

  async _json(url) {
    if (!isHttpUrl(url)) throw new Error('Ugyldig GitHub-adresse');
    const res = await this.fetchImpl(url, {
      redirect: 'follow',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`GitHub svarede ${res.status}${res.statusText ? ` (${res.statusText})` : ''}`);
    }
    return res.json();
  }

  async _text(url) {
    if (!isHttpUrl(url)) throw new Error('Ugyldig kontrolsum-adresse');
    const res = await this.fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Kontrolsum kunne ikke hentes (HTTP ${res.status})`);
    return res.text();
  }

  /**
   * Read the commits between the last tag the user has and the new one.
   * A missing changelog must never block an update, so failures are soft.
   */
  async _changes(latestTag) {
    try {
      const tags = await this._json(
        `${this.apiBase}/repos/${this.owner}/${this.repo}/tags?per_page=100`,
      );
      const base = chooseBaseTag(tags, this.currentVersion, latestTag);
      if (!base || compareVersions(base, latestTag) >= 0) return [];
      const compare = await this._json(
        `${this.apiBase}/repos/${this.owner}/${this.repo}/compare/` +
        `${encodeURIComponent(base)}...${encodeURIComponent(latestTag)}`,
      );
      const seen = new Set();
      const changes = [];
      for (const entry of (compare.commits || [])) {
        const subject = cleanSubject(entry && entry.commit && entry.commit.message);
        if (!subject || /^merge\b/i.test(subject)) continue;
        if (seen.has(subject)) continue;
        seen.add(subject);
        changes.push(subject);
      }
      return changes.slice(-MAX_CHANGES);
    } catch (err) {
      this.log(`[update] changelog skipped: ${err.message}`);
      return [];
    }
  }

  async check() {
    if (this.platform !== 'win32') {
      return this._fail('Opdatering understøttes kun på Windows.');
    }
    if (this._checking) {
      return { ok: false, error: 'Der er allerede et opdateringstjek i gang.' };
    }
    if (this._downloading || this._phase === 'installing') {
      return { ok: false, error: 'En opdatering er allerede i gang.' };
    }
    this._checking = true;
    this._setPhase('checking');
    try {
      const releases = await this._json(
        `${this.apiBase}/repos/${this.owner}/${this.repo}/releases?per_page=20`,
      );
      const latest = newestRelease(releases);
      if (!latest) return this._fail('Der blev ikke fundet nogen stabil release på GitHub.');

      const latestVersion = normaliseVersion(latest.tag_name);
      const updateAvailable = compareVersions(latestVersion, this.currentVersion) > 0;
      const newerReleases = (Array.isArray(releases) ? releases : [])
        .filter((r) => r && !r.draft && !r.prerelease && releaseVersion(r))
        .filter((r) => compareVersions(r.tag_name, this.currentVersion) > 0).length;
      const plan = this._installPlan();
      const releaseUrl = isHttpUrl(latest.html_url) ? latest.html_url : RELEASE_PAGE;
      // Every fresh check requires a fresh download and checksum. GitHub
      // assets can be replaced even when their release tag stays the same.
      this._downloaded = null;
      this._progress = null;

      if (!updateAvailable) {
        this._info = {
          updateAvailable: false,
          currentVersion: this.currentVersion,
          latestVersion,
          tagName: latest.tag_name,
          releaseUrl,
          installMode: plan.mode,
          development: !this.isPackaged,
          installDir: path.dirname(plan.target),
        };
        this._setPhase('current');
        return { ok: true, ...this._info };
      }

      const asset = pickPortableAsset(latest);
      if (!asset || !isHttpUrl(asset.browser_download_url)) {
        return this._fail('Den nyeste release har ingen portable .exe-fil.');
      }
      const checksumAsset = pickChecksumAsset(latest);
      const changes = await this._changes(latest.tag_name);

      this._info = {
        updateAvailable: true,
        currentVersion: this.currentVersion,
        latestVersion,
        tagName: latest.tag_name,
        name: String(latest.name || latest.tag_name || ''),
        publishedAt: String(latest.published_at || ''),
        size: Number(asset.size) || 0,
        assetName: String(asset.name || ''),
        downloadUrl: asset.browser_download_url,
        checksumUrl: checksumAsset && isHttpUrl(checksumAsset.browser_download_url)
          ? checksumAsset.browser_download_url
          : '',
        changes,
        releasesBehind: newerReleases,
        releaseUrl,
        installMode: plan.mode,
        installDir: path.dirname(plan.target),
        development: !this.isPackaged,
      };
      this._setPhase('available');
      this.log(`[update] ${this.currentVersion} → ${latestVersion} (${asset.name})`);
      return { ok: true, ...this._info };
    } catch (err) {
      return this._fail(err);
    } finally {
      this._checking = false;
    }
  }

  async _expectedChecksum(info) {
    if (!info.checksumUrl) {
      throw new Error('Releasen har ingen SHA-256-kontrolsum — downloadet installeres ikke automatisk.');
    }
    const sums = parseChecksums(await this._text(info.checksumUrl));
    const hash = sums.get(info.assetName) || '';
    if (!hash) {
      throw new Error('Releasens kontrolsum matcher ikke den valgte .exe-fil.');
    }
    return hash;
  }

  async download() {
    if (this.platform !== 'win32') {
      return this._fail('Opdatering understøttes kun på Windows.');
    }
    if (this._checking) {
      return { ok: false, error: 'Vent på, at opdateringstjekket er færdigt.' };
    }
    if (!this._info || !this._info.updateAvailable) {
      return this._fail('Søg efter opdatering, før du henter den.');
    }
    if (this._downloading) {
      return { ok: false, error: 'Opdateringen hentes allerede.' };
    }
    if (this._downloaded && fs.existsSync(this._downloaded.file)) {
      return {
        ok: true,
        file: this._downloaded.file,
        sha256: this._downloaded.sha256,
        size: this._downloaded.size,
        verified: true,
      };
    }

    this._downloading = true;
    this._setPhase('downloading');
    this._progress = { received: 0, total: this._info.size || 0, percent: 0 };
    const file = path.join(
      this.tmpDir,
      `LennartTerminal-${this._info.latestVersion}-portable.exe`,
    );
    try {
      const expected = await this._expectedChecksum(this._info);
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }

      const res = await this.fetchImpl(this._info.downloadUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Download fejlede (HTTP ${res.status})`);
      }

      const total = Number(res.headers.get('content-length')) || this._info.size || 0;
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastReport = 0;
      const report = (force = false) => {
        const now = Date.now();
        if (!force && now - lastReport < 150) return;
        lastReport = now;
        this._progress = {
          received,
          total,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        };
        if (this.onProgress) this.onProgress(this._progress);
      };
      report(true);

      const tap = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          received += chunk.length;
          report();
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body),
        tap,
        fs.createWriteStream(file, { mode: 0o644 }),
      );

      const actual = hash.digest('hex').toLowerCase();
      if (actual !== expected.toLowerCase()) {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
        throw new Error('Kontrolsummen stemmer ikke — filen er ikke installeret.');
      }

      this._downloaded = { file, sha256: actual, size: received, version: this._info.latestVersion };
      this._progress = { received, total: total || received, percent: 100 };
      if (this.onProgress) this.onProgress(this._progress);
      this._setPhase('ready');
      this.log(`[update] downloaded ${file} (${received} bytes, sha256 verified)`);
      return { ok: true, file, sha256: actual, size: received, verified: true };
    } catch (err) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      this._downloaded = null;
      return this._fail(err);
    } finally {
      this._downloading = false;
    }
  }

  _writeMarker(marker, dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pending-update.json'), JSON.stringify(marker, null, 2), 'utf8');
    } catch (err) {
      this.log(`[update] marker skipped for ${dir}: ${err.message}`);
    }
  }

  _copyUserData(targetDataDir) {
    try {
      if (path.resolve(targetDataDir) === path.resolve(this.dataDir)) return;
      fs.mkdirSync(targetDataDir, { recursive: true });
      for (const name of ['settings.json', 'history.jsonl']) {
        const source = path.join(this.dataDir, name);
        const target = path.join(targetDataDir, name);
        if (fs.existsSync(target) || !fs.existsSync(source)) continue;
        fs.copyFileSync(source, target);
        this.log(`[update] copied ${name} to the new portable install`);
      }
    } catch (err) {
      this.log(`[update] user-data copy skipped: ${err.message}`);
    }
  }

  async install() {
    if (this.platform !== 'win32') {
      return this._fail('Opdatering understøttes kun på Windows.');
    }
    if (this._checking || this._downloading || this._phase !== 'ready') {
      return { ok: false, error: 'Download og kontrollér opdateringen, før den installeres.' };
    }
    if (!this._downloaded || !this._info || !this._info.updateAvailable ||
        this._downloaded.version !== this._info.latestVersion || !fs.existsSync(this._downloaded.file)) {
      return this._fail('Download opdateringen, før du installerer den.');
    }
    // Lock immediately: rehashing is asynchronous and must not race a new
    // check, download or second installation request.
    this._setPhase('installing');

    const plan = this._installPlan();
    const target = plan.target;
    const targetDir = path.dirname(target);
    const downloaded = this._downloaded.file;
    const marker = {
      from: this.currentVersion,
      to: this._info ? this._info.latestVersion : '',
      installedAt: new Date().toISOString(),
      changes: Array.isArray(this._info && this._info.changes) ? this._info.changes.slice(0, MAX_CHANGES) : [],
      releaseUrl: (this._info && this._info.releaseUrl) || RELEASE_PAGE,
    };

    try {
      const actual = await sha256File(downloaded);
      if (actual !== this._downloaded.sha256) {
        return this._fail('Den hentede fil er ændret efter download — installer ikke.');
      }

      // Do not overwrite the only backup from a previous update attempt.
      if (fs.existsSync(`${target}.old`)) {
        return this._fail('En tidligere sikkerhedskopi (.old) findes allerede. Flyt den, før du opdaterer igen.');
      }
      // Fail before quitting if the destination is not writable (f.eks. a
      // per-machine install under Program Files).
      fs.mkdirSync(targetDir, { recursive: true });
      const probe = path.join(targetDir, `.lennart-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });

      const targetData = path.join(targetDir, 'Data');
      this._copyUserData(targetData);
      this._writeMarker(marker, targetData);
      // Also leave the notice in the current data dir: if the launched copy
      // cannot start, the old app restarts and can explain what happened.
      this._writeMarker(marker, this.dataDir);

      const script = path.join(
        this.tmpDir,
        `lennart-update-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.ps1`,
      );
      fs.writeFileSync(
        script,
        `\uFEFF${buildInstallScript({ waitPid: process.pid, downloaded, target })}`,
        'utf8',
      );

      const powershell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      const child = spawn(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      // spawn() reports missing executables asynchronously. Do not tell the
      // app to quit unless Windows actually started the helper process.
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();

      this._setPhase('installing');
      this.log(`[update] install helper started for ${target} (pid ${process.pid})`);
      return { ok: true, target, mode: plan.mode, installing: true };
    } catch (err) {
      return this._fail(err);
    }
  }

  /**
   * One-shot "what happened" notice for the first start after an update.
   * The marker is only consumed when the running build is at least the
   * version that was installed, so a failed launch that falls back to the
   * old build does not claim success.
   */
  takePending() {
    const file = path.join(this.dataDir, 'pending-update.json');
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      return null;
    }
    if (!data || !data.to) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      return null;
    }
    const cmp = compareVersions(this.currentVersion, data.to);
    // A failed launch can fall back to the old build: keep the marker for the
    // new build. A marker from an older update must not pop up much later.
    if (cmp < 0) return null;
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    if (cmp > 0) return null;
    return {
      from: String(data.from || ''),
      to: String(data.to || ''),
      installedAt: String(data.installedAt || ''),
      changes: Array.isArray(data.changes) ? data.changes.slice(0, MAX_CHANGES).map(String) : [],
      releaseUrl: String(data.releaseUrl || ''),
    };
  }
}

module.exports = {
  Updater,
  compareVersions,
  parseVersion,
  normaliseVersion,
  pickPortableAsset,
  pickChecksumAsset,
  parseChecksums,
  cleanSubject,
  chooseBaseTag,
  resolveInstallPlan,
  buildInstallScript,
  psQuote,
  sha256File,
};
