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
function buildRemoteArgv(host, method, command, opts) {
  const o = opts || {};
  if (method === 'winrm') {
    const inner = [
      '$ErrorActionPreference = "Continue"',
      `$pw = ConvertTo-SecureString ${psQuote(o.password || '')} -AsPlainText -Force`,
      `$cred = New-Object System.Management.Automation.PSCredential(${psQuote(o.username || 'Administrator')}, $pw)`,
      `Invoke-Command -ComputerName ${psQuote(host)} -Credential $cred -ScriptBlock { [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command} } 2>&1 | Out-String`,
    ].join('; ');
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64Utf16(inner)]];
  }
  // ssh (default) — key path optional; powershell on the remote renders the command
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
  if (o.keyPath) args.push('-i', o.keyPath);
  args.push(o.username ? `${o.username}@${host}` : host, 'powershell.exe', '-NoLogo', '-NoProfile', '-Command', command);
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

      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        out += text;
        this.emit(tabId, text);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, code: -1, output: out + `\n[fejl: ${err.message}]`, timedOut });
      });
      child.on('exit', (code) => {
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
