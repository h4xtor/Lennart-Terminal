'use strict';

/**
 * Terminal tab management: one xterm.js instance + PTY session per tab.
 * Depends on globals: XTerm (xterm.js), FitAddon, WebLinksAddon, SearchAddon,
 * and window.lennart (preload bridge).
 */

const XTerm = globalThis; // xterm.js UMD bundle exposes Terminal on globalThis

const termTabs = new Map(); // tabId -> Tab
let activeTabId = null;
let tabCounter = 0;

const TERM_THEME = {
  background: '#121317',
  foreground: '#d6dae2',
  cursor: '#7c6cff',
  cursorAccent: '#121317',
  selectionBackground: 'rgba(124, 108, 255, 0.30)',
  black: '#1b1d23',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d6dae2',
  brightBlack: '#5c616e',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f3f4f6',
};

function fontScale() {
  return window.__lennartFontScale || 1;
}

class TerminalTab {
  constructor(shell) {
    this.tabId = `tab_${++tabCounter}`;
    this.shell = shell;
    this.sessionId = null;
    this.dead = false;
    this.xterm = null;
    this.fitAddon = null;
    this.el = null;
    this.tabEl = null;
  }

  async open() {
    const container = document.getElementById('terminal-container');

    // DOM
    this.el = document.createElement('div');
    this.el.className = 'term-tab';
    this.el.style.height = '100%';
    container.appendChild(this.el);

    // xterm
    this.xterm = new XTerm.Terminal({
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
      fontSize: Math.round(13 * fontScale()),
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      theme: TERM_THEME,
    });
    this.fitAddon = new FitAddon.FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    try { this.xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch { /* optional */ }
    try { this.xterm.loadAddon(new SearchAddon.SearchAddon()); } catch { /* optional */ }
    this.xterm.open(this.el);
    this.xterm.onData((data) => {
      if (this.sessionId && !this.dead) window.lennart.writeTerminal(this.sessionId, data);
    });
    this.xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      // Ctrl+Shift+C = copy selection
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
        const sel = this.xterm.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); return false; }
      }
      // App shortcuts must NOT be swallowed by xterm — let them bubble
      if (ev.ctrlKey && !ev.altKey) {
        const k = (ev.key || '').toLowerCase();
        const c = ev.code || '';
        if (k === ',' || c === 'Comma' || k === 'j' || c === 'KeyJ' ||
            k === 'w' || c === 'KeyW' || c === 'KeyT') {
          return false;
        }
      }
      return true;
    });

    // PTY session
    try {
      const session = await window.lennart.createTerminal({ shell: this.shell });
      this.sessionId = session.id;
      this.shellName = session.shellName;
      this.xterm.writeln(`\x1b[38;5;245m-- Lennart Terminal | ${session.shellName} ---------------------------\x1b[0m`);
    } catch (err) {
      this.dead = true;
      this.xterm.writeln(`\x1b[31mFailed to start shell: ${err.message || err}\x1b[0m`);
    }

    // Tab strip entry
    const tabs = document.getElementById('tabs');
    this.tabEl = document.createElement('div');
    this.tabEl.className = 'tab';
    this.tabEl.innerHTML = `<span class="tab-title">${escapeHtml(this.shellName || this.shell || 'Shell')}</span>
      <button class="tab-close" title="Close tab">&#10005;</button>`;
    this.tabEl.addEventListener('click', () => activateTab(this.tabId));
    this.tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(this.tabId);
    });
    tabs.appendChild(this.tabEl);

    termTabs.set(this.tabId, this);

    // PTY -> xterm (+ rolling buffer for AI context)
    this.outputBuf = '';
    window.lennart.onTerminalData(({ id, data }) => {
      if (id !== this.sessionId) return;
      this.outputBuf = (this.outputBuf + data).slice(-8000);
      this.xterm?.write(data);
    });
    window.lennart.onTerminalExit(({ id, code }) => {
      if (id !== this.sessionId || this.dead) return;
      this.dead = true;
      this.xterm.writeln(`\r\n\x1b[38;5;245m[process exited with code ${code} — tab stays open]\x1b[0m`);
    });

    this.fit();
    return this;
  }

  setTitle(title) {
    if (this.tabEl) {
      this.tabEl.querySelector('.tab-title').textContent = title;
    }
  }

  fit() {
    if (!this.xterm || this.dead) return;
    try {
      this.fitAddon.fit();
      const { cols, rows } = this.xterm;
      if (this.sessionId) window.lennart.resizeTerminal(this.sessionId, cols, rows);
    } catch { /* not visible yet */ }
  }

  writeLine(text) {
    if (this.sessionId && !this.dead) {
      window.lennart.writeTerminal(this.sessionId, text);
      this.xterm?.focus();
    }
  }

  runCommand(text) {
    if (this.sessionId && !this.dead) {
      window.lennart.writeTerminal(this.sessionId, text + '\r');
      this.xterm?.focus();
    }
  }

  destroy() {
    this.dead = true;
    if (this.sessionId) window.lennart.destroyTerminal(this.sessionId);
    this.xterm?.dispose();
    this.el?.remove();
    this.tabEl?.remove();
    termTabs.delete(this.tabId);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function newTab(shell) {
  const tab = new TerminalTab(shell);
  tab.open().then(() => activateTab(tab.tabId));
  return tab;
}

function activateTab(tabId) {
  const tab = termTabs.get(tabId);
  if (!tab) return;
  activeTabId = tabId;

  for (const [id, t] of termTabs) {
    t.el.style.display = id === tabId ? 'block' : 'none';
    t.tabEl?.classList.toggle('active', id === tabId);
  }
  // Give the DOM a tick to lay out before fitting
  requestAnimationFrame(() => tab.fit());
  const input = document.getElementById('prompt-input');
  if (input) input.focus();
}

function closeTab(tabId) {
  const tab = termTabs.get(tabId);
  if (!tab) return;
  tab.destroy();

  if (termTabs.size === 0) {
    newTab();
    return;
  }
  if (activeTabId === tabId) {
    activateTab([...termTabs.keys()].pop());
  }
}

function activeTab() {
  return termTabs.get(activeTabId) || null;
}

// Refit all tabs on window resize
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const t of termTabs.values()) if (t.tabId === activeTabId) t.fit();
  }, 80);
});
