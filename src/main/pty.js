'use strict';

/**
 * Terminal session manager on top of node-pty.
 * One PTY per tab; keeps a rolling output buffer per session so the AI
 * (and tab restore) can read recent terminal context.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pty = require('node-pty');

const MAX_BUFFER = 40000; // chars kept per session for AI context

function detectDefaultShell() {
  if (process.platform !== 'win32') return process.env.SHELL || 'bash';
  if (findPwsh()) return 'pwsh';
  try {
    // Windows PowerShell lives under System32\WindowsPowerShell\v1.0 — not
    // directly in System32. The old lookup therefore fell through to cmd on
    // a perfectly normal Windows box.
    if (fs.existsSync(path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    ))) return 'powershell';
  } catch { /* ignore */ }
  return 'cmd';
}

function shellProfile(shell) {
  switch (shell) {
    case 'powershell':
      return {
        file: 'powershell.exe',
        name: 'PowerShell',
        args: ['-NoLogo'],
      };
    case 'pwsh':
      return {
        file: 'pwsh.exe',
        name: 'PowerShell 7',
        args: ['-NoLogo'],
      };
    case 'cmd':
      return {
        file: 'cmd.exe',
        name: 'Kommandoprompt',
        args: [],
      };
    case 'gitbash':
      return {
        file: 'bash.exe',
        name: 'Git Bash',
        args: ['--login', '-i'],
      };
    default:
      return {
        file: shell, // custom executable
        name: shell,
        args: [],
      };
  }
}

function findGitBash() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((c) => {
    try { return fs.existsSync(c); } catch { return false; }
  });
}

/** Find an executable in PATH (used for pwsh installed outside Program Files). */
function findOnPath(exe) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const candidate = path.join(dir, exe);
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* unreadable PATH entry */ }
  }
  return '';
}

/** PowerShell 7 can live in Program Files, the Store alias, or anywhere on PATH. */
function findPwsh() {
  if (process.platform !== 'win32') return findOnPath('pwsh');
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ];
  return candidates.find((c) => {
    try { return fs.existsSync(c); } catch { return false; }
  }) || findOnPath('pwsh.exe');
}

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  /** Which shells can actually start on this machine (UI disables the rest). */
  shellsStatus() {
    const sys32 = (exe) => {
      try {
        return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe));
      } catch { return false; }
    };
    // Windows PowerShell lives in System32\WindowsPowerShell\v1.0 — NOT
    // directly in System32, so a plain sys32('powershell.exe') always fails
    // and would grey out the shell that actually works.
    const winPowerShell = (() => {
      try {
        return fs.existsSync(path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
        ));
      } catch { return false; }
    })();
    return {
      powershell: winPowerShell || sys32('powershell.exe'),
      pwsh: Boolean(findPwsh()),
      cmd: sys32('cmd.exe'),
      gitbash: Boolean(findGitBash()),
    };
  }

  create({ shell, cwd } = {}) {
    const profile = shellProfile(shell || detectDefaultShell());
    let file = profile.file;

    if (file === 'bash.exe') {
      const gitBash = findGitBash();
      if (gitBash) {
        file = gitBash;
      } else {
        throw new Error('Git Bash blev ikke fundet — installér Git til Windows, eller vælg en anden shell');
      }
    }
    if (file === 'pwsh.exe' && !findPwsh()) {
      throw new Error('PowerShell 7 (pwsh) er ikke installeret');
    }

    const resolvedCwd = cwd || os.homedir();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.LENNART_TERMINAL = '1';

    const ptyProcess = pty.spawn(file, profile.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env,
      useConpty: true,
      conptyInheritCursor: false,
    });

    const session = {
      id: `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      shell,
      shellName: profile.name,
      shellFile: file,
      cwd: resolvedCwd,
      buffer: '',
      pty: ptyProcess,
    };

    this.sessions.set(session.id, session);

    ptyProcess.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      this.emit('data', session.id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.sessions.delete(session.id);
      this.emit('exit', session.id, exitCode);
    });

    return session;
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) s.pty.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
      try { s.pty.resize(Math.floor(cols), Math.floor(rows)); } catch { /* race on close */ }
    }
  }

  getBuffer(id) {
    return this.sessions.get(id)?.buffer || '';
  }

  listSessions() {
    return [...this.sessions.keys()];
  }

  destroy(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try { s.pty.kill(); } catch { /* already dead */ }
    this.sessions.delete(id);
  }

  destroyAll() {
    for (const id of [...this.sessions.keys()]) this.destroy(id);
  }
}

module.exports = TerminalManager;
