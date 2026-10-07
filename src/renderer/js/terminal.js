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

// Live theme used by NEW tabs; applyTerminalTheme() re-themes existing ones
let CURRENT_TERM_THEME = { ...TERM_THEME };

function terminalThemeFor(preset, accent) {
  const base = {
    ...TERM_THEME,
    cursor: accent || TERM_THEME.cursor,
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent || '')
      ? `${accent}4d`
      : TERM_THEME.selectionBackground,
  };
  if (preset === 'lys') {
    return {
      ...base,
      background: '#f4f5f7', foreground: '#1c2027', cursorAccent: '#f4f5f7',
      black: '#2b2f36', red: '#b91c1c', green: '#15803d', yellow: '#a16207',
      blue: '#1d4ed8', magenta: '#7e22ce', cyan: '#0e7490', white: '#e5e7eb',
      brightBlack: '#6b7280', brightRed: '#dc2626', brightGreen: '#16a34a',
      brightYellow: '#ca8a04', brightBlue: '#2563eb', brightMagenta: '#9333ea',
      brightCyan: '#0891b2', brightWhite: '#f9fafb',
    };
  }
  return base;
}

function applyTerminalTheme(preset, accent) {
  CURRENT_TERM_THEME = terminalThemeFor(preset, accent);
  for (const t of termTabs.values()) {
    t.xterm?.setOptions({ theme: CURRENT_TERM_THEME });
  }
}

// ---------------------------------------------------------------------------
// Copy: button, Ctrl+C (when something is selected) and right-click
// ---------------------------------------------------------------------------

function flashCopyButton(ok, label) {
  const btn = document.getElementById('btn-copy-term');
  if (!btn) return;
  btn.classList.toggle('ok', !!ok);
  btn.textContent = label;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.classList.remove('ok');
    btn.textContent = '\u29C9 Kopiér';
  }, 1500);
}

function copySelectionToClipboard(sel) {
  if (!sel) return false;
  navigator.clipboard.writeText(sel);
  flashCopyButton(true, '\u2713 Kopieret');
  return true;
}

/** Copy the active tab's selection (wired to the tabstrip button). */
function copyTermSelection() {
  const tab = activeTab();
  const sel = tab && tab.xterm ? tab.xterm.getSelection() : '';
  if (!sel) {
    flashCopyButton(false, 'Markér først');
    return false;
  }
  return copySelectionToClipboard(sel);
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
      theme: CURRENT_TERM_THEME,
    });
    this.fitAddon = new FitAddon.FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    try { this.xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch { /* optional */ }
    try { this.xterm.loadAddon(new SearchAddon.SearchAddon()); } catch { /* optional */ }
    this.xterm.open(this.el);
    this.xterm.onData((data) => {
      if (this.sessionId && !this.dead) window.lennart.writeTerminal(this.sessionId, data);
    });
    // Right-click: copy the current selection (Windows-terminal habit);
    // without a selection the click does nothing destructive.
    this.xterm.textarea?.addEventListener('mousedown', (ev) => {
      if (ev.button !== 2) return;
      const sel = this.xterm.getSelection();
      if (sel) {
        ev.preventDefault();
        ev.stopPropagation();
        copySelectionToClipboard(sel);
      }
    }, true);
    this.xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      // Ctrl+Shift+C = copy selection
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
        const sel = this.xterm.getSelection();
        if (sel) { copySelectionToClipboard(sel); return false; }
      }
      // Ctrl+C with a selection = copy (without selection it still
      // interrupts the shell as usual)
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyC') {
        const sel = this.xterm.getSelection();
        if (sel) { copySelectionToClipboard(sel); return false; }
      }
      // Ctrl+Insert = copy (laptop-friendly)
      if (ev.ctrlKey && ev.code === 'Insert') {
        const sel = this.xterm.getSelection();
        if (sel) { copySelectionToClipboard(sel); return false; }
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
      const raw = String(err.message || err);
      const msg = raw.replace(/^Error invoking remote method 'terminal:create': Error:\s*/, '');
      this.xterm.writeln(`\x1b[31mKunne ikke starte shell: ${msg}\x1b[0m`);
      // If it is a "not installed" shell, grey out its sidebar button
      if (/not installed|not found/i.test(msg)) {
        const b = document.querySelector(`.shell-btn[data-shell="${this.shell}"]`);
        if (b) {
          b.disabled = true;
          b.classList.add('unavailable');
          b.title = `${b.textContent} er ikke installeret på denne PC`;
        }
      }
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
    // Dead tabs (failed shell) must still re-fit: the error text is visible
    // and the pane size must track the window.
    if (!this.xterm) return;
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

/**
 * Remote host tab: a read-only-ish xterm view where commands run on a LAN
 * host over SSH/WinRM. Output streams back via 'remote:data'. The command
 * input is the shared bottom prompt box while this tab is active.
 */
function createRemoteTab(host) {
  const tab = {
    tabId: `tab_${++tabCounter}`,
    remote: true,
    host,
    sessionId: null,
    dead: false,
    busy: false,
    xterm: null,
    fitAddon: null,
    el: null,
    tabEl: null,
  };

  const container = document.getElementById('terminal-container');
  tab.el = document.createElement('div');
  tab.el.className = 'term-tab';
  tab.el.style.height = '100%';
  tab.el.style.display = 'none';
  tab.el.style.display = 'flex';
  tab.el.style.flexDirection = 'column';
  container.appendChild(tab.el);

  // banner
  const banner = document.createElement('div');
  banner.className = 'remote-banner';
  banner.innerHTML = `<span class="dot"></span>
    <span>Fjern: ${escapeHtml(host.name || host.host)} (${escapeHtml(host.host)} · ${escapeHtml(host.method)})</span>
    <span class="spacer"></span>
    <button class="rb-test" title="Test forbindelsen">Test</button>`;
  banner.querySelector('.rb-test').addEventListener('click', async () => {
    const btn = banner.querySelector('.rb-test');
    btn.textContent = 'Tester…';
    const res = await window.lennart.remoteTest(host);
    btn.textContent = res.ok ? 'OK' : 'Fejl';
    setTimeout(() => { btn.textContent = 'Test'; }, 3000);
  });
  tab.el.appendChild(banner);

  // xterm
  const termHost = document.createElement('div');
  termHost.style.flex = '1';
  termHost.style.minHeight = '0';
  tab.el.appendChild(termHost);

  tab.xterm = new XTerm.Terminal({
    fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
    fontSize: Math.round(13 * fontScale()),
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 8000,
    theme: TERM_THEME,
  });
  tab.fitAddon = new FitAddon.FitAddon();
  tab.xterm.loadAddon(tab.fitAddon);
  tab.xterm.open(termHost);
  tab.xterm.writeln(`\x1b[38;5;245m-- Fjernforbindelse: ${host.name || host.host} (${host.host}) via ${host.method.toUpperCase()} --\x1b[0m`);
  tab.xterm.writeln(`\x1b[38;5;245m   Skriv kommandoer i boksen nederst og tryk Enter — de køres på værten.\x1b[0m\r\n`);

  window.lennart.onRemoteData(({ tabId, text }) => {
    if (tabId !== tab.tabId) return;
    tab.xterm.write(text.replace(/\n/g, '\r\n'));
  });

  // run a command on the host (called by the bottom prompt box)
  tab.runCommand = async (cmd) => {
    if (tab.busy) {
      tab.xterm.writeln(`\x1b[33m[stadig i gang — vent på forrige kommando]\x1b[0m`);
      return;
    }
    tab.busy = true;
    tab.xterm.writeln(`\x1b[38;5;141mPS ${host.host}> ${cmd}\x1b[0m`);
    const res = await window.lennart.remoteRun({ hostId: host.id, command: cmd, tabId: tab.tabId });
    if (res && res.timedOut) tab.xterm.writeln(`\x1b[33m[timeout — kommandoen gav ikke svar i tide]\x1b[0m`);
    tab.xterm.write('\r\n');
    tab.busy = false;
  };
  tab.fit = () => { try { tab.fitAddon.fit(); } catch { /* hidden */ } };
  tab.destroy = () => {
    tab.dead = true;
    tab.xterm.dispose();
    tab.el.remove();
    tab.tabEl.remove();
    termTabs.delete(tab.tabId);
  };

  // tab strip entry
  const tabs = document.getElementById('tabs');
  tab.tabEl = document.createElement('div');
  tab.tabEl.className = 'tab';
  tab.tabEl.innerHTML = `<span class="tab-title">⇄ ${escapeHtml(host.name || host.host)}</span>
    <button class="tab-close" title="Luk">&#10005;</button>`;
  tab.tabEl.addEventListener('click', () => activateTab(tab.tabId));
  tab.tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.tabId);
  });
  tabs.appendChild(tab.tabEl);

  termTabs.set(tab.tabId, tab);
  activateTab(tab.tabId);
  return tab;
}

// Refit all tabs on window resize
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const t of termTabs.values()) if (t.tabId === activeTabId) t.fit();
  }, 80);
});

// Refit whenever the terminal PANE changes size for any reason (AI panel
// toggle, menubar/prompt-box changes, font scale, window zoom…). Without
// this xterm keeps its old row count and the bottom command lines render
// behind the prompt box — invisible to the user.
let paneObserver = null;
function observeTerminalPane() {
  if (paneObserver || typeof ResizeObserver === 'undefined') return;
  const container = document.getElementById('terminal-container');
  if (!container) return;
  let raf = null;
  const refit = () => {
    const t = termTabs.get(activeTabId);
    if (t) t.fit();
  };
  paneObserver = new ResizeObserver(() => {
    if (raf) cancelAnimationFrame(raf);
    // fit() immediately (rAF) AND again once layout has settled — a single
    // measurement taken mid-transition leaves the bottom rows behind the
    // prompt box.
    raf = requestAnimationFrame(refit);
    setTimeout(refit, 120);
    setTimeout(refit, 350);
  });
  paneObserver.observe(container);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observeTerminalPane);
} else {
  observeTerminalPane();
}
