'use strict';

// Earliest possible breadcrumb — runs before any require, so it also proves
// that an elevated relaunch reaches main.js at all.
try {
  require('fs').appendFileSync(
    require('path').join(require('os').tmpdir(), 'lennart-terminal-main.log'),
    `[${new Date().toISOString()}] [boot] start pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))}\n`,
  );
} catch { /* ignore */ }

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const SettingsStore = require('./store');
const TerminalManager = require('./pty');
const { chat, listModels, buildAgentSystemPrompt, buildPowerShellSystemPrompt, PROVIDERS, PROVIDER_GROUPS, listAgyModels, agyAvailable, runAgyAgent } = require('./ai');
const { AgentSession } = require('./agent');
const { LocalAI, LOCAL_MODEL } = require('./localai');
const { RemoteRunner, sshSetupCommand } = require('./remote');
const { HistoryStore } = require('./history');

// Never let Chromium background the terminal: when another window fully
// covers Lennart Terminal the page flips to visibilityState "hidden", which
// freezes requestAnimationFrame + ResizeObserver — xterm then stops
// re-fitting after a resize and its bottom rows render behind the prompt box.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const settings = new SettingsStore();
const ptyManager = new TerminalManager();

let mainWindow = null;
const activeChats = new Map();          // chat id -> AbortController

// Diagnostic: proves whether a (re)launched process actually reaches main.js
logDiag(`[boot] pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))}`);

// Permanent history (portable: lives on the USB stick's Data folder)
const historyStore = new HistoryStore(path.join(settings.dataDir, 'history.jsonl'));

// Embedded offline AI (llama.cpp + hardcoded PowerShell model)
// Root lives in the data dir, so portable mode keeps it on the USB stick
const localAI = new LocalAI({
  root: path.join(settings.dataDir, 'localai'),
  log: logDiag,
  emit: (event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, payload);
  },
});
// Apply saved model settings (ctx / threads) before the first start
localAI.configure(settings.get('localAI') || {});

/**
 * First portable boot: the ~1 GB offline-AI assets may still live in the old
 * %APPDATA% location (downloaded by a previous non-portable run). Move them
 * onto the data dir (the USB stick) so nothing is downloaded twice.
 */
function migrateLocalAiAssets() {
  if (!process.env.LENNART_DATA_DIR) return;
  const target = path.join(settings.dataDir, 'localai');
  let legacyRoot;
  try {
    legacyRoot = path.join(app.getPath('userData'), 'localai');
  } catch {
    legacyRoot = path.join(process.env.APPDATA || '', 'Lennart Terminal', 'localai');
  }
  if (path.resolve(legacyRoot) === path.resolve(target)) return;
  if (!fs.existsSync(legacyRoot)) return;
  try {
    if (!fs.existsSync(path.join(target, 'models', LOCAL_MODEL.file))) {
      fs.mkdirSync(path.join(target, 'models'), { recursive: true });
      fs.mkdirSync(path.join(target, 'llama-cpp'), { recursive: true });
      const moveAll = (from, to) => {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
          const src = path.join(from, entry.name);
          const dst = path.join(to, entry.name);
          if (entry.isDirectory()) {
            fs.mkdirSync(dst, { recursive: true });
            moveAll(src, dst);
          } else {
            try { fs.renameSync(src, dst); } catch { fs.copyFileSync(src, dst); }
          }
        }
      };
      moveAll(path.join(legacyRoot, 'models'), path.join(target, 'models'));
      moveAll(path.join(legacyRoot, 'llama-cpp'), path.join(target, 'llama-cpp'));
      logDiag('[localai] legacy assets migrated into portable data dir');
    }
    // Legacy copy removed afterwards — nothing should keep using it
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  } catch (err) {
    logDiag(`[localai] asset migration skipped: ${err.message || err}`);
  }
}
migrateLocalAiAssets();

// Remote network execution (SSH / WinRM)
const remoteRunner = new RemoteRunner({
  log: logDiag,
  emit: (tabId, text) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:data', { tabId, text });
  },
});

/**
 * If the active provider is the embedded local AI, make sure the llama.cpp
 * server is up and rewrite cfg to point at it (OpenAI protocol).
 */
async function resolveLocalProvider(cfg) {
  if (cfg.provider !== 'lennart-local') return cfg;
  // Honour a model the user picked in Settings (any GGUF under models/)
  try {
    const wanted = settings.get('ai')?.model ||
      (settings.get('providers') || {})['lennart-local']?.model || '';
    if (wanted) localAI.selectModel(wanted);
  } catch { /* keep the builtin model */ }
  const ensured = await localAI.ensure();
  return {
    ...cfg,
    provider: 'openai-compatible',
    baseUrl: ensured.baseUrl,
    model: localAI.model.id,
    apiKey: 'local',
  };
}

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

  // Everything should run as administrator — offer elevation on startup
  // (skipped for automated runs via LENNART_NO_ELEVATE=1)
  setTimeout(maybeOfferElevation, 1200);
}

// ---------------------------------------------------------------------------
// Administrator: Lennart Terminal wants ALL shells/commands elevated.
// Detect the token once; offer a relaunch with -Verb RunAs (UAC).
// ---------------------------------------------------------------------------

let cachedAdmin = null;
function isAdminSession() {
  if (cachedAdmin !== null) return cachedAdmin;
  try {
    // `net session` exits 0 only for an elevated administrator token
    // eslint-disable-next-line global-require
    const { execFileSync } = require('child_process');
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    cachedAdmin = true;
  } catch {
    cachedAdmin = false;
  }
  return cachedAdmin;
}

function relaunchElevated() {
  // eslint-disable-next-line global-require
  const { spawn } = require('child_process');
  const exe = process.execPath;
  // Elevated processes may start in a different working directory
  // (C:\Windows\system32), so "." as the app path would resolve to the
  // wrong folder and the new instance dies silently. Always pass the
  // absolute app directory and pin -WorkingDirectory.
  const appDir = path.join(__dirname, '..', '..');
  // Drop the CDP debugging flag: the old process still holds that port when
  // the elevated one starts, and Electron exits when it cannot bind it.
  const args = process.argv.slice(1)
    .filter((a) => !String(a).includes('--remote-debugging-port'))
    .map((a, i) => (i === 0 && String(a) === '.' ? appDir : String(a)));
  // Tell the elevated instance to wait for THIS process to exit before it
  // takes the single-instance lock (otherwise it loses the race and quits).
  args.push(`--elevated-wait-pid=${process.pid}`);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const argList = args.map(q).join(',');
  // Run the elevation through a generated .ps1 file: embedding the script in
  // `powershell -Command "…"` mangles the nested quotes, so PowerShell exits
  // before it can report anything about the process it created.
  const scriptFile = path.join(os.tmpdir(), 'lennart-elev.ps1');
  const markerFile = path.join(os.tmpdir(), 'lennart-elev-marker.log');
  const mark = (s) => `'${s}' | Out-File -FilePath ${q(markerFile)} -Append -Encoding utf8`;
  // NB: -Verb cannot be combined with -RedirectStandardOutput/-Error — that
  // is a parameter-set conflict and Start-Process would fail every time.
  const script = [
    mark(`start ${new Date().toISOString()}`),
    'try {',
    `  $p = Start-Process -FilePath ${q(exe)} -ArgumentList @(${argList}) -WorkingDirectory ${q(appDir)} -Verb RunAs -PassThru -ErrorAction Stop`,
    '} catch {',
    `  ('failed: ' + $_.Exception.Message) | Out-File -FilePath ${q(markerFile)} -Append -Encoding utf8`,
    '  exit 1',
    '}',
    mark('elevated process created'),
    'Start-Sleep -Seconds 2',
    '$p.Refresh()',
    `'elev pid=' + $p.Id + ' hasExited=' + $p.HasExited | Out-File -FilePath ${q(markerFile)} -Append -Encoding utf8`,
    `if ($p.HasExited) { 'elev exit=' + $p.ExitCode | Out-File -FilePath ${q(markerFile)} -Append -Encoding utf8 }`,
    mark('script end'),
    '',
  ].join('\r\n');
  try {
    fs.writeFileSync(scriptFile, script, 'utf8');
  } catch (err) {
    logDiag(`[admin] could not write elev script: ${err.message}`);
    return false;
  }
  let child;
  try {
    // NOTE: no `detached: true` here — with a detached console PowerShell
    // exits 0 immediately WITHOUT executing the -File script, so the
    // elevation silently reported success and nothing was ever launched.
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      windowsHide: true,
    });
  } catch (err) {
    logDiag(`[admin] relaunch failed: ${err.message}`);
    return false;
  }
  logDiag(`[admin] spawn: ${script.replace(/\r?\n/g, ' | ')}`);
  logDiag(`[admin] ps pid=${child.pid} script=${scriptFile}`);
  const spawnAt = Date.now();
  let psOut = '';
  if (child.stdout) child.stdout.on('data', (d) => { psOut += d; });
  if (child.stderr) child.stderr.on('data', (d) => { psOut += d; });
  // ONLY quit when PowerShell confirms the elevated process started —
  // a cancelled/denied UAC prompt exits non-zero and we must keep running.
  child.on('exit', (code) => {
    const tail = psOut.trim().replace(/\s+/g, ' ').slice(0, 400);
    logDiag(`[admin] ps exited after ${Date.now() - spawnAt}ms code=${code} outLen=${psOut.length}`);
    if (code === 0) {
      logDiag(`[admin] elevated relaunch started (UAC accepted)${tail ? ` | ps: ${tail}` : ''}`);
      setTimeout(() => app.quit(), 300);
    } else {
      logDiag(`[admin] elevated relaunch NOT started (powershell exit ${code}) — continuing unelevated${tail ? ` | ps: ${tail}` : ''}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['OK'],
          title: 'Lennart Terminal',
          message: 'Kunne ikke genstarte som administrator.',
          detail: 'Administrator-rettigheder blev afvist (UAC). Programmet kører videre uden — menuerne viser “kræver administrator” ved de kommandoer, der kræver det.',
          noLink: true,
        }).catch(() => {});
      }
    }
  });
  child.on('error', (err) => logDiag(`[admin] relaunch spawn error: ${err.message}`));
  return true;
}

function maybeOfferElevation() {
  if (isAdminSession()) return;
  if (process.env.LENNART_NO_ELEVATE) return;
  // Automated/debug runs (CDP) must never pop a UAC dialog
  if (process.argv.some((a) => String(a).includes('--remote-debugging-port'))) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Ja, genstart som administrator', 'Nej, kør uden administrator'],
    defaultId: 0,
    cancelId: 1,
    title: 'Lennart Terminal',
    message: 'Alt i Lennart Terminal skal køres som administrator.',
    detail: 'Uden administrator-rettigheder viser menuerne “kræver administrator” ved de kommandoer, der kræver det.\n\nGenstart med administrator-rettigheder (UAC)?',
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) relaunchElevated();
  }).catch((err) => logDiag(`[admin] dialog failed: ${err.message}`));
}

ipcMain.handle('app:elevation', () => ({ admin: isAdminSession() }));
ipcMain.handle('app:relaunchAdmin', () => {
  logDiag('[admin] relaunch requested by renderer');
  return { started: relaunchElevated() };
});

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
        { label: 'Historik', accelerator: 'CmdOrCtrl+H', click: () => sendAction('history') },
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

ipcMain.handle('terminal:shells', () => ptyManager.shellsStatus());

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
  // Permanent history: full lines written to the PTY (prompt box, AI Run,
  // pasted commands). Single keystrokes are ignored.
  if (typeof data === 'string' && data.length > 2 && data.endsWith('\r')) {
    historyStore.add({ type: 'local', command: data.slice(0, -1).replace(/\r\n/g, '') });
  }
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
  // Model settings changed → apply to the embedded AI server; stop it so
  // the next chat restarts llama-server with the new ctx/threads.
  if (patch && patch.localAI) {
    localAI.configure(settings.get('localAI') || {});
    localAI.stop();
  }
  return settings.getAll();
});

ipcMain.handle('app:openExternal', (_e, url) => {
  const u = String(url || '');
  if (!/^https:\/\//i.test(u)) return false;
  shell.openExternal(u);
  return true;
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
    // Model settings: 0 = provider default
    maxTokens: Number(ai.maxTokens) > 0 ? Number(ai.maxTokens) : 0,
    topP: Number(ai.topP) > 0 ? Number(ai.topP) : 1,
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
  let cfg = effectiveAiConfig();
  const isEmbeddedLocal = cfg.provider === 'lennart-local';
  try {
    cfg = await resolveLocalProvider(cfg);
  } catch (err) {
    event.sender.send('ai:chat:error', {
      id,
      error: `Lokal AI kunne ikke starte: ${err.message || err}`,
    });
    return;
  }
  const safeMessages = Array.isArray(messages)
    ? messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
        content: typeof m.content === 'string' ? String(m.content).slice(0, 24000) : '',
      }))
    : [];

  const ctrl = new AbortController();
  activeChats.set(id, ctrl);

  try {
    // The embedded model IS the PowerShell assistant — always use its prompt
    // in chat mode; other providers keep the terminal agent prompt.
    const system = isEmbeddedLocal
      ? buildPowerShellSystemPrompt()
      : (agentMode ? buildAgentSystemPrompt() : null);
    let acc = ''; // full assistant answer, for the permanent history
    const lastUser = [...safeMessages].reverse().find((m) => m.role === 'user');
    await chat(cfg, safeMessages, {
      system,
      signal: ctrl.signal,
      onToken: (token) => {
        acc += token;
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:chat:chunk', { id, token });
        }
      },
    });
    if (lastUser) {
      historyStore.add({ type: 'ai', command: lastUser.content, output: acc });
    }
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
  const target = cfg || settings.get('ai');
  if ((target.provider || 'ollama') === 'lennart-local') {
    try {
      await localAI.ensure();
      return { ok: true, count: 1 };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
  try {
    const models = await listModels(target, { timeout: 2500 });
    return { ok: true, count: models.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Embedded local AI IPC
// ---------------------------------------------------------------------------

ipcMain.handle('localai:status', () => localAI.status());

// Model catalogue: GGUF files on disk + downloadable extras ("Hent modeller")
ipcMain.handle('localai:listModels', () => ({
  models: localAI.listLocalModels(),
  catalog: localAI.modelCatalog(),
  active: localAI.model.id,
}));

ipcMain.handle('localai:downloadModel', async (_e, spec) => {
  try {
    await localAI.downloadModelTo(spec);
    return { ok: true, models: localAI.listLocalModels() };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('localai:ensure', async () => {
  try {
    const res = await localAI.ensure();
    return { ok: true, ...res, status: localAI.status() };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: localAI.status() };
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

ipcMain.handle('agent:start', async (_e, { sessionId, job }) => {
  const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const cleanJob = String(job || '').slice(0, 4000).trim();
  if (!cleanJob) return { ok: false, error: 'tomt job' };

  let aiConfig;
  try {
    aiConfig = await resolveLocalProvider(effectiveAiConfig());
  } catch (err) {
    return { ok: false, error: `Lokal AI kunne ikke starte: ${err.message || err}` };
  }

  const session = new AgentSession({
    id,
    job: cleanJob,
    aiConfig,
    settings: settings.getAll(),
    deps: {
      emit: (agentId, event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:event', { id: agentId, event });
        }
      },
      run: async (cmd, timeout) => {
        const out = await runInPty(sessionId, cmd, timeout || 120000);
        historyStore.add({ type: 'agent', command: cmd, output: out, ok: !/^\[error/.test(out.trim()) });
        return out;
      },
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
// Network hosts + remote execution IPC
// ---------------------------------------------------------------------------

ipcMain.handle('hosts:list', () => settings.get('hosts') || []);

ipcMain.handle('hosts:save', (_e, host) => {
  const clean = {
    id: String(host.id || `host_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
    name: String(host.name || '').slice(0, 60),
    host: String(host.host || '').trim(),
    method: host.method === 'winrm' ? 'winrm' : 'ssh',
    username: String(host.username || '').slice(0, 60),
    password: String(host.password || ''),
    keyPath: String(host.keyPath || ''),
  };
  if (!clean.host) return { ok: false, error: 'Vært (IP eller navn) mangler' };
  const hosts = (settings.get('hosts') || []).slice();
  const i = hosts.findIndex((h) => h.id === clean.id);
  if (i >= 0) hosts[i] = clean;
  else hosts.push(clean);
  settings.set({ hosts });
  return { ok: true };
});

ipcMain.handle('hosts:delete', (_e, id) => {
  settings.set({ hosts: (settings.get('hosts') || []).filter((h) => h.id !== id) });
  return { ok: true };
});

ipcMain.handle('hosts:sshSetupCommand', () => ({ command: sshSetupCommand() }));

ipcMain.handle('remote:test', async (_e, hostCfg) => {
  const res = await remoteRunner.test(hostCfg);
  return { ok: res.ok, output: res.output };
});

ipcMain.handle('remote:run', async (_e, { hostId, command, tabId }) => {
  const host = (settings.get('hosts') || []).find((h) => h.id === hostId);
  if (!host) return { ok: false, code: -1, output: 'Ukendt vært' };
  const cmd = String(command || '').slice(0, 8000);
  const res = await remoteRunner.run(tabId || `remote_${host.id}_${Date.now()}`, host, cmd);
  historyStore.add({ type: 'remote', host: host.name || host.host, command: cmd, output: res.output, ok: res.ok });
  return { ok: res.ok, code: res.code, output: res.output, timedOut: res.timedOut };
});

// ---------------------------------------------------------------------------
// Permanent history IPC
// ---------------------------------------------------------------------------

ipcMain.handle('history:query', (_e, opts) => historyStore.query(opts));
ipcMain.handle('history:clear', () => historyStore.clear());

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
  dataDir: settings.dataDir,
  portable: Boolean(process.env.LENNART_DATA_DIR),
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

// The elevated relaunch starts a NEW process while this one is still alive.
// Wait until the previous instance is gone before taking the lock — otherwise
// requestSingleInstanceLock() fails, app.quit() runs and the user is left with
// NO window at all (the old instance quits right after the UAC consent).
const waitPidArg = process.argv.find((a) => String(a).startsWith('--elevated-wait-pid='));
if (waitPidArg) waitForProcessExit(Number(String(waitPidArg).split('=')[1]), 15000);

function waitForProcessExit(pid, timeoutMs) {
  if (!pid) return;
  // eslint-disable-next-line global-require
  const { execFileSync } = require('child_process');
  const started = Date.now();
  const alive = () => {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`], {
        windowsHide: true,
        encoding: 'utf8',
      });
      return !out.includes('No tasks are running');
    } catch { return false; }
  };
  while (alive() && Date.now() - started < timeoutMs) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    } catch { break; }
  }
  logDiag(`[admin] elevated instance waited ${Date.now() - started}ms for pid ${pid} (still alive: ${alive()})`);
}

const gotLock = app.requestSingleInstanceLock();
logDiag(`[boot] pid=${process.pid} admin=${isAdminSession()} gotLock=${gotLock}`);
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
    localAI.stop();
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

/**
 * The USB/troubleshooting promise: the app must ALWAYS answer in chat, even
 * on a machine where the previous provider (f.eks. Antigravity CLI) is not
 * installed. If the active provider is agy but the CLI is missing, switch to
 * the embedded offline AI once and persist the choice.
 */
function ensureUsableProvider() {
  const ai = settings.get('ai') || {};
  if (ai.provider === 'antigravity-cli') {
    agyAvailable().then((ok) => {
      if (ok) return;
      logDiag('[provider] agy CLI not found — switching to embedded offline AI');
      settings.set({ ai: { provider: 'lennart-local', model: '' } });
    });
  }
}
ensureUsableProvider();

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
