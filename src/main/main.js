'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const SettingsStore = require('./store');
const TerminalManager = require('./pty');
const { chat, listModels, buildAgentSystemPrompt, PROVIDERS, PROVIDER_GROUPS, listAgyModels, agyAvailable, runAgyAgent } = require('./ai');
const { AgentSession } = require('./agent');

const settings = new SettingsStore();
const ptyManager = new TerminalManager();

let mainWindow = null;
const activeChats = new Map();          // chat id -> AbortController

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  buildMenu();
  const bounds = settings.get('windowBounds') || { width: 1380, height: 880 };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121317',
    title: 'Lennart Terminal',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Always start at 100% zoom (Ctrl+- accidents must not persist)
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.setZoomLevel(0);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logDiag(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logDiag(`[render-process-gone] ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on('dom-ready', () => logDiag('[dom-ready]'));

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links (AI panel citations, web links in terminal) in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function saveBounds() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
    settings.set('windowBounds', mainWindow.getBounds());
  }
}

// Native menu with accelerators — shortcuts work no matter what has focus
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => sendAction('new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendAction('close-tab') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendAction('settings') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle AI Panel', accelerator: 'CmdOrCtrl+J', click: () => sendAction('toggle-ai') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => mainWindow?.webContents.zoomIn() },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => mainWindow?.webContents.zoomOut() },
        { label: 'Reset Zoom (100%)', accelerator: 'CmdOrCtrl+0', click: () => mainWindow?.webContents.setZoomLevel(0) },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:menu-action', action);
  }
}

// ---------------------------------------------------------------------------
// PTY / terminal IPC
// ---------------------------------------------------------------------------

ipcMain.handle('terminal:create', (_e, { shell }) => {
  const session = ptyManager.create({ shell: shell || settings.get('shell') });
  return {
    id: session.id,
    shellName: session.shellName,
    cwd: session.cwd,
  };
});

ipcMain.on('terminal:write', (_e, { id, data }) => {
  ptyManager.write(id, data);
});

ipcMain.on('terminal:resize', (_e, { id, cols, rows }) => {
  ptyManager.resize(id, cols, rows);
});

ipcMain.on('terminal:destroy', (_e, { id }) => {
  ptyManager.destroy(id);
});

// Streaming terminal data -> renderer
ptyManager.on('data', (id, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:data', { id, data });
  }
});

ptyManager.on('exit', (id, code) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:exit', { id, code });
  }
});

// ---------------------------------------------------------------------------
// Settings IPC
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', () => settings.getAll());

ipcMain.handle('settings:set', (_e, patch) => {
  settings.set(patch);
  return settings.getAll();
});

ipcMain.handle('settings:reset', () => {
  settings.reset();
  return settings.getAll();
});

/**
 * Effective AI config for the ACTIVE provider: base settings merged with
 * the per-provider stored key/model/baseUrl. Used by chat AND the agent —
 * previously the agent never got the API key, so cloud providers could not
 * drive it.
 */
function effectiveAiConfig() {
  const all = settings.getAll();
  const ai = all.ai || {};
  const stored = (all.providers || {})[ai.provider] || {};
  return {
    provider: ai.provider || 'ollama',
    model: ai.model || stored.model || '',
    baseUrl: ai.baseUrl || stored.baseUrl || '',
    apiKey: stored.apiKey || '',
    temperature: ai.temperature ?? 0.4,
  };
}

// ---------------------------------------------------------------------------
// AI IPC
// ---------------------------------------------------------------------------

ipcMain.handle('ai:listModels', async (_e, cfg) => {
  try {
    const models = await listModels(cfg);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.on('ai:chat', async (event, { id, messages, agentMode }) => {
  const cfg = effectiveAiConfig();
  const safeMessages = Array.isArray(messages)
    ? messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
        content: typeof m.content === 'string' ? String(m.content).slice(0, 24000) : '',
      }))
    : [];

  const ctrl = new AbortController();
  activeChats.set(id, ctrl);

  try {
    const system = agentMode ? buildAgentSystemPrompt() : null;
    await chat(cfg, safeMessages, {
      system,
      signal: ctrl.signal,
      onToken: (token) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:chat:chunk', { id, token });
        }
      },
    });
    event.sender.send('ai:chat:done', { id });
  } catch (err) {
    const aborted = err.name === 'AbortError';
    event.sender.send(aborted ? 'ai:chat:done' : 'ai:chat:error', {
      id,
      ...(aborted ? {} : { error: String(err.message || err) }),
    });
  } finally {
    activeChats.delete(id);
  }
});

ipcMain.on('ai:chat:cancel', (_e, { id }) => {
  const ctrl = activeChats.get(id);
  if (ctrl) ctrl.abort();
});

ipcMain.handle('ai:checkConnection', async (_e, cfg) => {
  try {
    const models = await listModels(cfg || settings.get('ai'), { timeout: 2500 });
    return { ok: true, count: models.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('ai:providers', () => ({ providers: PROVIDERS, groups: PROVIDER_GROUPS }));

ipcMain.handle('ai:agyAvailable', async () => agyAvailable());

ipcMain.handle('ai:agyModels', async () => {
  try {
    const models = await listAgyModels();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Agent (autopilot) IPC
// ---------------------------------------------------------------------------

const agentSessions = new Map(); // id -> AgentSession

function runInPty(sessionId, cmd, timeoutMs) {
  return new Promise((resolve) => {
    const s = ptyManager.sessions.get(sessionId);
    if (!s) {
      resolve(`[error: terminal session ${sessionId} not found — is the tab still open?]`);
      return;
    }
    const before = s.buffer.length;
    let lastLen = -1;
    let lastChange = Date.now();
    const start = Date.now();

    s.pty.write(cmd + '\r');

    const timer = setInterval(() => {
      const len = s.buffer.length;
      if (len !== lastLen) {
        lastLen = len;
        lastChange = Date.now();
      }
      const quietFor = Date.now() - lastChange;
      const elapsed = Date.now() - start;
      // done when: output quiet for 1.2s after at least 1.5s, or timeout
      if ((elapsed > 1500 && quietFor > 1200) || elapsed > timeoutMs) {
        clearInterval(timer);
        const raw = s.buffer.slice(before);
        resolve(raw
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
          .replace(/\r/g, '')
          .trim());
      }
    }, 250);
  });
}

ipcMain.handle('agent:start', (_e, { sessionId, job }) => {
  const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const cleanJob = String(job || '').slice(0, 4000).trim();
  if (!cleanJob) return { ok: false, error: 'tomt job' };

  const session = new AgentSession({
    id,
    job: cleanJob,
    aiConfig: effectiveAiConfig(),
    settings: settings.getAll(),
    deps: {
      emit: (agentId, event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:event', { id: agentId, event });
        }
      },
      run: (cmd, timeout) => runInPty(sessionId, cmd, timeout || 120000),
      confirm: (cmd) => Promise.resolve(confirmDestructiveDialog(cmd)),
      log: (msg) => logDiag(msg),
    },
  });

  agentSessions.set(id, session);
  session.run().finally(() => agentSessions.delete(id));
  return { ok: true, id };
});

ipcMain.on('agent:stop', (_e, { id }) => {
  const s = agentSessions.get(id);
  if (s) s.abort();
});

// ---------------------------------------------------------------------------
// Safety confirmation (AI-proposed destructive commands)
// ---------------------------------------------------------------------------

function confirmDestructiveDialog(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Afvist', 'Kør alligevel'],
    defaultId: 0,
    cancelId: 0,
    title: 'Kør kommando?',
    message: 'AI-en vil køre en potentielt destruktiv kommando:',
    detail: command,
    noLink: true,
  });
  return choice === 1;
}

ipcMain.handle('terminal:confirmCommand', (_e, { command }) => confirmDestructiveDialog(String(command || '')));

// ---------------------------------------------------------------------------
// Misc IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:getPaths', () => ({
  home: os.homedir(),
  settingsFile: settings.file,
  temp: os.tmpdir(),
  version: app.getVersion(),
  platform: process.platform,
}));

ipcMain.handle('app:openPath', async (_e, target) => {
  let p = String(target || '');
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  try {
    await shell.openPath(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('app:revealSettingFile', async () => {
  await shell.showItemInFolder(settings.file);
  return { ok: true };
});

ipcMain.on('app:devtools', () => {
  if (mainWindow) mainWindow.webContents.toggleDevTools();
});

// Custom window controls (frameless window)
ipcMain.on('app:minimize', () => mainWindow?.minimize());
ipcMain.on('app:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('app:close', () => mainWindow?.close());

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', () => {
    ptyManager.destroyAll();
  });

  app.on('window-all-closed', () => {
    ptyManager.destroyAll();
    app.quit();
  });
}

function logDiag(msg) {
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), 'lennart-terminal-main.log'),
      `[${new Date().toISOString()}] ${String(msg)}\n`,
    );
  } catch { /* ignore */ }
}

ipcMain.on('app:log', (_e, msg) => {
  logDiag(`[renderer] ${String(msg)}`);
});

// Log uncaught main-process errors so smoke tests can detect them
process.on('uncaughtException', (err) => {
  fs.appendFileSync(
    path.join(os.tmpdir(), 'lennart-terminal-main.log'),
    `[${new Date().toISOString()}] ${err.stack || err}\n`,
  );
});
