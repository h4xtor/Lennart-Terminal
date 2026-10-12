'use strict';

/**
 * Network execution: run commands on remote Windows PCs over the LAN.
 *
 * Two transports:
 *  - ssh   (recommended): Windows OpenSSH client (`ssh user@host powershell …`),
 *          works with a key file for fully non-interactive runs.
 *  - winrm: PowerShell Remoting (`Invoke-Command … -Credential …`), requires
 *          WinRM to be enabled on the target. Password is passed via an
 *          EncodedCommand so it never scrolls by in the visible terminal.
 *
 * Output is streamed to the renderer through an injected emit callback and
 * recorded in the permanent history.
 */

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;

function b64Utf16(s) {
  return Buffer.from(s, 'utf16le').toString('base64');
}

/** Escape a string for embedding inside a single-quoted PowerShell literal. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Build the argv for a one-shot remote PowerShell command.
 * Pure function — unit-tested without spawning anything.
 */
// Max length of an -EncodedCommand argument for SSH: OpenSSH on Windows runs
// the remote command through cmd.exe, whose command line is capped at 8191.
const SSH_ENCODED_MAX = 7000;

/**
 * Friendly Danish hints appended to WinRM output when the classic setup
 * mistakes show up in the error text (English and Danish Windows).
 */
function winrmHintScript(host) {
  return [
    "if ($out -match 'TrustedHosts') {",
    "  Write-Output '[Lennart] Denne PC stoler ikke på værten endnu. Kør som administrator på DENNE PC:'",
    `  Write-Output ${psQuote(`Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value '${host}' -Concatenate -Force`)}`,
    "} elseif ($out -match 'Access is denied|Adgang nægtet|Adgang er nægtet') {",
    "  Write-Output '[Lennart] Adgang nægtet: tjek brugernavn/adgangskode. Ved lokale konti kør på MÅL-PC''en (admin):'",
    "  Write-Output 'New-ItemProperty -Path \"HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\" -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force'",
    "} elseif ($out -match 'WinRM cannot complete|cannot connect|kan ikke fuldføre|kan ikke oprette forbindelse|The client cannot connect') {",
    "  Write-Output '[Lennart] Kunne ikke få forbindelse. Slå WinRM til på MÅL-PC''en (admin): Enable-PSRemoting -Force -SkipNetworkProfileCheck'",
    "}",
  ].join('\n');
}

/**
 * Build the argv for a one-shot remote PowerShell command.
 * Pure function — unit-tested without spawning anything.
 */
function buildRemoteArgv(host, method, command, opts) {
  const o = opts || {};
  if (method === 'winrm') {
    const inner = [
      // UTF-8 back to Node, so æ/ø/å in output survive
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      '$ErrorActionPreference = "Continue"',
      `$pw = ConvertTo-SecureString ${psQuote(o.password || '')} -AsPlainText -Force`,
      `$cred = New-Object System.Management.Automation.PSCredential(${psQuote(o.username || 'Administrator')}, $pw)`,
      `$out = Invoke-Command -ComputerName ${psQuote(host)} -Credential $cred -ScriptBlock { ${command} } -ErrorVariable remErr 2>&1 | Out-String -Width 220`,
      'Write-Output $out',
      winrmHintScript(host),
      // Connection problems (not errors inside the command) → exit 1, so
      // the "Test" button and the history report a failure in any language
      'if ($remErr | Where-Object { $_.Exception -is [System.Management.Automation.Remoting.PSRemotingTransportException] }) { exit 1 }',
    ].join('\n');
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64Utf16(inner)]];
  }
  // ssh (default) — key path optional. The command travels as an encoded
  // PowerShell blob: plain arguments get re-split by the remote cmd.exe and
  // break quotes, pipes and $variables.
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
  if (o.keyPath) args.push('-i', o.keyPath);
  args.push(o.username ? `${o.username}@${host}` : host);
  const encoded = b64Utf16(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${command}`);
  if (encoded.length <= SSH_ENCODED_MAX) {
    args.push('powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded);
  } else {
    args.push('powershell.exe', '-NoLogo', '-NoProfile', '-Command', command);
  }
  return ['ssh.exe', args];
}

/** One-time setup command to enable SSH server on a target PC (run once there). */
function sshSetupCommand() {
  return 'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; ' +
    'Start-Service sshd; Set-Service sshd -StartupType Automatic; ' +
    'New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22';
}

class RemoteRunner {
  constructor({ log = () => {}, emit = () => {} } = {}) {
    this.log = log;
    this.emit = emit; // (tabId, chunk) -> renderer stream
  }

  /**
   * Run `command` on `hostCfg` ({ id, host, method, username, password, keyPath }).
   * Streams output chunks via emit(tabId, text) and resolves with
   * { ok, code, output, timedOut }.
   */
  run(tabId, hostCfg, command, timeoutMs) {
    const limit = timeoutMs || DEFAULT_TIMEOUT_MS;
    const [file, argv] = buildRemoteArgv(
      hostCfg.host,
      hostCfg.method || 'ssh',
      command,
      { username: hostCfg.username, password: hostCfg.password, keyPath: hostCfg.keyPath },
    );

    return new Promise((resolve) => {
      let out = '';
      let timedOut = false;
      this.log(`remote: ${hostCfg.method || 'ssh'} ${hostCfg.host}: ${command.slice(0, 120)}`);

      let child;
      try {
        child = spawn(file, argv, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, code: -1, output: `Kunne ikke starte: ${err.message}`, timedOut: false });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* already dead */ }
      }, limit);

      // Decode across chunk boundaries (a multi-byte æ/ø/å may be split)
      const { StringDecoder } = require('string_decoder');
      const dec = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
      const onData = (which) => (chunk) => {
        const text = dec[which].write(chunk);
        if (!text) return;
        out += text;
        this.emit(tabId, text);
      };
      child.stdout.on('data', onData('out'));
      child.stderr.on('data', onData('err'));

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, code: -1, output: out + `\n[fejl: ${err.message}]`, timedOut });
      });
      // 'close' (not 'exit'): fires after stdout/stderr are fully drained,
      // so the last lines of output are never lost
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: !timedOut && code === 0, code: code === null ? -1 : code, output: out, timedOut });
      });
    });
  }

  /** Quick reachability test for the add/edit host dialog. */
  test(hostCfg) {
    return this.run(`test_${Date.now()}`, hostCfg, '$env:COMPUTERNAME', 15000);
  }
}

module.exports = { RemoteRunner, buildRemoteArgv, sshSetupCommand, psQuote, b64Utf16, DEFAULT_TIMEOUT_MS };
