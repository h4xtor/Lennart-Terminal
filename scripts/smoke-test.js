'use strict';

/**
 * Windows smoke test for Lennart Terminal.
 *
 * Starts the real Electron app with a throw-away profile, so it never touches
 * the user's settings, history or the embedded AI model. A tiny local stub
 * answers the AI endpoint, which keeps the test offline and prevents a ~1 GB
 * model download. Then it verifies, through Chrome DevTools Protocol:
 *
 *   1. the app starts and the first terminal is ready
 *   2. the old provider id "qwen" is migrated to "dashscope"
 *   3. the visible UI is Danish (menubar, settings, history, prompt, ...)
 *   4. a command typed through xterm (text + Enter as separate chunks) is
 *      written to the permanent history — the main fix in this branch
 *   5. a command from the bottom prompt box is still recorded
 *   6. agent auto-approve + engine are saved and remembered
 *   7. the light theme is applied and a NEW tab inherits it
 *   8. no console errors / uncaught exceptions occurred
 *
 * Usage (Windows, Node 22+):
 *   node scripts/smoke-test.js
 *   node scripts/smoke-test.js --keep    keep the temp profile for inspection
 *   node scripts/smoke-test.js --help
 *
 * The easiest entry point is test-lennart.cmd in the project root.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;

function pass(message) {
  passed += 1;
  console.log(`PASS  ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  pass(message);
}

/** Pick a free localhost TCP port (used for CDP and the AI stub). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Minimal local stand-in for Ollama / an OpenAI-compatible endpoint. It is
 * only here so Settings and the status poll succeed instantly and offline.
 */
async function startStubAi() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const url = String(req.url || '/');
    req.resume(); // drain request bodies (connection checks may POST)
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (url.includes('/api/tags')) {
      res.end(JSON.stringify({
        models: [{ name: 'smoke:latest', size: 123456, modified_at: new Date().toISOString() }],
      }));
      return;
    }
    if (url.includes('/models')) {
      res.end(JSON.stringify({
        data: [{ id: 'smoke', object: 'model' }],
        models: [{ name: 'smoke:latest', size: 123456 }],
      }));
      return;
    }
    if (url.includes('/api/chat')) {
      res.end(JSON.stringify({
        message: { role: 'assistant', content: 'OK' },
        done: true,
      }));
      return;
    }
    if (url.includes('/chat/completions')) {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      }));
      return;
    }
    if (url.includes('/api/version')) {
      res.end(JSON.stringify({ version: '0.0.0' }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, port };
}

/** A throw-away data dir + APPDATA, so the real user profile is untouched. */
function createProfile() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lennart-smoke-'));
  const profile = {
    base,
    data: path.join(base, 'data'),
    appdata: path.join(base, 'appdata'),
    temp: path.join(base, 'tmp'),
  };
  for (const dir of Object.values(profile)) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(profile.appdata, 'Lennart Terminal'), { recursive: true });
  return profile;
}

/**
 * Write the test settings BEFORE Electron starts. The provider is deliberately
 * "qwen" (a removed id) so the migration to "dashscope" is exercised.
 */
function writeSettings(dataDir, stubPort) {
  const baseUrl = `http://127.0.0.1:${stubPort}`;
  const settings = {
    version: 3.1,
    shell: 'powershell',
    fontScale: 1,
    ai: {
      provider: 'qwen',
      model: 'smoke',
      baseUrl,
      temperature: 0.4,
      maxTokens: 0,
      topP: 1,
    },
    providers: {
      qwen: { apiKey: 'smoke', model: 'smoke', baseUrl },
    },
    localAI: { ctx: 4096, threads: 0 },
    aiAutoRun: true,
    theme: { preset: 'standard', accent: '#7c6cff' },
    agentEngine: 'builtin',
    agentAutoApprove: false,
    agyModel: '',
    hosts: [],
    chatMode: 'chat',
    agentMode: true,
    confirmDestructive: true,
    windowBounds: null,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

function electronExe() {
  let resolved = '';
  try { resolved = require('electron'); } catch { /* fall through */ }
  if (typeof resolved === 'string' && fs.existsSync(resolved)) return resolved;
  const fallback = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(fallback) ? fallback : '';
}

function launchApp(profile, port) {
  const exe = electronExe();
  if (!exe) throw new Error('Electron blev ikke fundet — kør "npm ci" først.');

  // --user-data-dir gives this instance its own single-instance lock. Setting
  // APPDATA alone does not isolate the lock on Windows, so the test used to
  // fail whenever the user already had Lennart Terminal open.
  const userDataDir = path.join(profile.appdata, 'Lennart Terminal');
  const child = spawn(exe, ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Separate profile + data dir. The temp APPDATA also means the
      // legacy-local-AI migration can only look at an empty folder.
      LENNART_DATA_DIR: profile.data,
      APPDATA: profile.appdata,
      TEMP: profile.temp,
      TMP: profile.temp,
      LENNART_NO_ELEVATE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  let output = '';
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-12000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  return { child, output: () => output };
}

async function waitForPage(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) ||
          list.find((t) => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch (err) {
      lastError = err.message;
    }
    await sleep(300);
  }
  throw new Error(
    `Electron/CDP svarede ikke på port ${port}${lastError ? ` (${lastError})` : ''}. ` +
    'Luk Lennart Terminal, hvis den allerede kører, og prøv igen.',
  );
}

/** Tiny CDP client — Node 22 has a global WebSocket. */
function connectCdp(page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    const problems = [];

    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression, awaitPromise = false) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const desc = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
        throw new Error(
          `Renderer-fejl: ${result.exceptionDetails.text}${desc ? ` ${desc}` : ''}`,
        );
      }
      return result.result.value;
    };

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.rej(new Error(msg.error.message));
        else entry.res(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value || a.description || '').join(' ');
        problems.push(`console.error: ${text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        problems.push(
          `exception: ${details.text} ${details.exception ? details.exception.description || '' : ''}`,
        );
      }
    });

    ws.addEventListener('open', () => resolve({
      ws,
      send,
      evaluate,
      problems,
      close: () => ws.close(),
    }), { once: true });
    ws.addEventListener('error', () => reject(new Error('Kunne ikke forbinde til Electron via CDP')), { once: true });
  });
}

async function waitForExpr(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(250);
  }
  throw new Error(`Timeout: ${label}${lastError ? ` (${lastError})` : ''}`);
}

async function historyRows(cdp, token) {
  return cdp.evaluate(
    `window.lennart.historyQuery({ limit: 100, query: ${JSON.stringify(token)} })`,
    true,
  );
}

async function waitForHistory(cdp, token, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await historyRows(cdp, token).catch(() => []);
    if (Array.isArray(rows) && rows.some((r) => String(r.command || '').includes(token))) {
      return rows;
    }
    await sleep(250);
  }
  return [];
}

/**
 * Send the command text through xterm itself, then press Enter as a separate
 * key event. That is exactly how a real user triggers the history parser.
 */
async function typeThroughXterm(cdp, command) {
  const started = await cdp.evaluate(`(() => {
    const tab = activeTab();
    if (!tab || !tab.xterm) return false;
    tab.xterm.focus();
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (textarea) textarea.focus();
    tab.xterm.paste(${JSON.stringify(command)});
    return true;
  })()`);
  if (!started) return false;

  await sleep(200);
  const key = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  return true;
}

/**
 * Fallback that mimics xterm exactly: the command and the Enter are two
 * separate writes, which was the situation the old history code missed.
 */
async function sendInputChunks(cdp, command) {
  const sessionId = await cdp.evaluate(`(activeTab() && activeTab().sessionId) || ''`);
  if (!sessionId) throw new Error('Ingen aktiv terminal at skrive i');
  await cdp.evaluate(
    `window.lennart.writeTerminal(${JSON.stringify(sessionId)}, ${JSON.stringify(command)})`,
  );
  await sleep(150);
  await cdp.evaluate(
    `window.lennart.writeTerminal(${JSON.stringify(sessionId)}, ${JSON.stringify('\r')})`,
  );
}

async function cancelCurrentLine(cdp) {
  const sessionId = await cdp.evaluate(`(activeTab() && activeTab().sessionId) || ''`).catch(() => '');
  if (!sessionId) return;
  await cdp.evaluate(
    `window.lennart.writeTerminal(${JSON.stringify(sessionId)}, ${JSON.stringify('\x03')})`,
  ).catch(() => {});
  await sleep(250);
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

async function main() {
  console.log('Lennart Terminal — Windows-smoketest');
  console.log(`Node ${process.version}`);

  const stub = await startStubAi();
  const profile = createProfile();
  writeSettings(profile.data, stub.port);
  console.log(`Midlertidig testprofil: ${profile.base}`);

  const cdpPort = await freePort();
  const app = launchApp(profile, cdpPort);
  let cdp = null;
  let ok = false;

  try {
    const page = await waitForPage(cdpPort);
    cdp = await connectCdp(page);
    await cdp.send('Runtime.enable');

    await waitForExpr(
      cdp,
      "document.readyState === 'complete' && !!window.lennart && !!document.getElementById('brand-row')",
      60000,
      'rendereren',
    );
    await waitForExpr(
      cdp,
      "typeof termTabs !== 'undefined' && termTabs.size >= 1 && !!activeTab() && !!activeTab().sessionId",
      45000,
      'første terminal',
    );
    pass('Appen starter, og første terminal er klar');

    // ---- 1. provider migration (qwen -> dashscope) ----
    const providerState = JSON.parse(await cdp.evaluate(`JSON.stringify({
      provider: window.__lennartSettings && window.__lennartSettings.ai && window.__lennartSettings.ai.provider,
      hasDashscope: !!(window.__lennartSettings && window.__lennartSettings.providers && window.__lennartSettings.providers.dashscope),
      hasQwen: !!(window.__lennartSettings && window.__lennartSettings.providers && window.__lennartSettings.providers.qwen)
    })`));
    assert(
      providerState.provider === 'dashscope',
      `qwen migreres til dashscope (${providerState.provider})`,
    );
    assert(
      providerState.hasDashscope && !providerState.hasQwen,
      'provider-nøglen flyttes til det nye id',
    );

    // ---- 2. visible Danish UI ----
    const ui = JSON.parse(await cdp.evaluate(`JSON.stringify({
      lang: document.documentElement.lang,
      menubarFirst: ((document.querySelector('#menubar .menu-btn') || {}).textContent || '').trim(),
      settingsTitle: ((document.querySelector('#settings-dialog h2') || {}).textContent || '').trim(),
      historyTitle: ((document.querySelector('#history-dialog h2') || {}).textContent || '').trim(),
      settingsTitleAttr: (document.getElementById('btn-settings') || {}).title || '',
      historyTitleAttr: (document.getElementById('btn-history') || {}).title || '',
      cmdLabel: ((document.querySelector('.shell-btn[data-shell="cmd"]') || {}).textContent || '').trim(),
      newTabLabel: ((document.getElementById('btn-new-tab') || {}).textContent || '').trim(),
      promptHint: ((document.getElementById('prompt-hint') || {}).textContent || '').trim(),
      copyLabel: ((document.getElementById('btn-copy-term') || {}).textContent || '').trim(),
      typeLocal: ((document.querySelector('#history-type option[value="local"]') || {}).textContent || '').trim(),
      typeRemote: ((document.querySelector('#history-type option[value="remote"]') || {}).textContent || '').trim(),
      typeAgent: ((document.querySelector('#history-type option[value="agent"]') || {}).textContent || '').trim(),
      typeAi: ((document.querySelector('#history-type option[value="ai"]') || {}).textContent || '').trim(),
      version: ((document.getElementById('version-tag') || {}).textContent || '').trim(),
      xtermHelpers: (() => { const h = document.querySelector('.xterm-helpers');
        return h ? getComputedStyle(h).position : ''; })(),
      cmdClipped: (() => { const b = document.querySelector('.shell-btn[data-shell="cmd"]');
        return b ? b.scrollWidth > b.clientWidth : true; })()
    })`));

    assert(ui.lang === 'da', `siden er markeret som dansk (lang="${ui.lang}")`);
    assert(ui.menubarFirst === 'Opsætning', `første menupunkt er "Opsætning" (${ui.menubarFirst})`);
    assert(ui.settingsTitle === 'Indstillinger', `indstillingsvinduet hedder "Indstillinger"`);
    assert(ui.historyTitle.includes('Historik'), `historikvinduet er på dansk (${ui.historyTitle})`);
    assert(ui.settingsTitleAttr === 'Indstillinger (Ctrl+,)', `tandhjulet har dansk værktøjstip`);
    assert(ui.historyTitleAttr === 'Historik (Ctrl+H)', `historik-knappen har dansk værktøjstip`);
    assert(ui.cmdLabel === 'Kommandoprompt', `cmd-knappen hedder "Kommandoprompt" (${ui.cmdLabel})`);
    assert(!ui.cmdClipped, 'kommandoprompt-label er ikke klippet');
    assert(ui.newTabLabel.includes('Ny fane'), `ny-fane-knappen er oversat (${ui.newTabLabel})`);
    assert(
      ui.promptHint.includes('Spørg AI (Ctrl+Enter)') && ui.promptHint.includes('eller skriv en kommando'),
      'prompt-hinten er dansk',
    );
    assert(ui.copyLabel.includes('Kopiér'), `kopiér-knappen er oversat (${ui.copyLabel})`);
    assert(
      ui.typeLocal === 'Lokalt' && ui.typeRemote === 'Netværk' &&
      ui.typeAgent === 'Agent' && ui.typeAi.startsWith('AI'),
      `historikkens typer er Lokalt / Netværk / Agent / AI (${ui.typeAi})`,
    );
    assert(ui.version === 'v0.2.0', `versionsmærket er korrekt (${ui.version})`);
    assert(
      ui.xtermHelpers === 'absolute',
      `xterm.css er indlæst (helpers position: ${ui.xtermHelpers || 'mangler'})`,
    );

    // ---- 3. typed history (the main fix) ----
    const typedToken = `smoke-${Date.now().toString(36)}`;
    let recordedToken = typedToken;
    let mode = 'xterm';
    let typedOk = false;

    try {
      typedOk = await typeThroughXterm(cdp, `echo ${typedToken}`);
      if (!typedOk) console.log('INFO  xterm var ikke klar; bruger terminalbroen');
    } catch (err) {
      console.log(`INFO  xterm-indsendelse fejlede (${err.message}); bruger terminalbroen`);
    }

    let rows = typedOk ? await waitForHistory(cdp, recordedToken, 8000) : [];
    if (!typedOk || !rows.length) {
      if (typedOk) {
        console.log('INFO  xterm gav ingen historik; prøver terminalbroen med to separate chunks');
        await cancelCurrentLine(cdp);
      }
      mode = 'bro';
      recordedToken = `${typedToken}b`;
      await sendInputChunks(cdp, `echo ${recordedToken}`);
      rows = await waitForHistory(cdp, recordedToken, 10000);
    }

    assert(rows.length > 0, `tastet kommando gemmes i historikken (${mode})`);
    const typedRecord = rows.find((r) => String(r.command || '').includes(recordedToken));
    assert(
      typedRecord && typedRecord.type === 'local',
      `historikposten har typen "Lokalt" (${typedRecord && typedRecord.type})`,
    );

    // ---- 4. the bottom prompt box still records commands ----
    const promptToken = `prompt-${Date.now().toString(36)}`;
    await cdp.evaluate(`(() => {
      const input = document.getElementById('prompt-input');
      input.value = ${JSON.stringify(`echo ${promptToken}`)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      }));
      return true;
    })()`);
    const promptRows = await waitForHistory(cdp, promptToken, 10000);
    assert(promptRows.length > 0, 'kommando fra prompt-boksen gemmes også');

    // ---- 5. agent settings persist ----
    await cdp.evaluate('openSettings(); true');
    await waitForExpr(
      cdp,
      "document.getElementById('settings-paths').textContent.includes('Indstillinger:')",
      15000,
      'indstillingerne indlæst',
    );
    await cdp.evaluate(`(() => {
      document.getElementById('set-agent-autoapprove').checked = true;
      const engine = document.getElementById('set-agent-engine');
      engine.value = 'antigravity';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btn-save-settings').click();
      return true;
    })()`);
    await waitForExpr(
      cdp,
      "window.__lennartSettings && window.__lennartSettings.agentAutoApprove === true && window.__lennartSettings.agentEngine === 'antigravity'",
      10000,
      'agent-indstillinger gemt',
    );
    pass('Agent-indstillinger gemmes (auto-godkend + agy-motor)');

    await cdp.evaluate('closeSettings(); true');
    await sleep(300);
    // Clear the fields first, so a successful check really means the values
    // were loaded from disk again — not just left over in the dialog.
    await cdp.evaluate(`(() => {
      document.getElementById('settings-paths').textContent = '';
      document.getElementById('set-agent-autoapprove').checked = false;
      document.getElementById('set-agent-engine').value = 'builtin';
      openSettings();
      return true;
    })()`);
    await waitForExpr(
      cdp,
      "document.getElementById('settings-paths').textContent.includes('Indstillinger:') && document.getElementById('set-agent-autoapprove').checked === true && document.getElementById('set-agent-engine').value === 'antigravity'",
      15000,
      'agent-indstillinger husket',
    );
    pass('Agent-indstillinger huskes efter genåbning');

    // Put the agent section back to defaults in the throw-away profile.
    await cdp.evaluate(`(() => {
      document.getElementById('set-agent-autoapprove').checked = false;
      const engine = document.getElementById('set-agent-engine');
      engine.value = 'builtin';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btn-save-settings').click();
      return true;
    })()`);
    await waitForExpr(
      cdp,
      "window.__lennartSettings && window.__lennartSettings.agentEngine === 'builtin' && window.__lennartSettings.agentAutoApprove === false",
      10000,
      'agent-indstillinger nulstillet',
    );

    // ---- 6. light theme + new tab inherits it ----
    // The settings dialog is still open from the agent test.
    await cdp.evaluate(`(() => {
      const theme = document.getElementById('set-theme');
      theme.value = 'lys';
      theme.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btn-save-settings').click();
      return true;
    })()`);
    await waitForExpr(cdp, "document.body.classList.contains('theme-lys')", 10000, 'lyst tema');
    pass('Lyst tema anvendes');

    const tabsBefore = await cdp.evaluate('termTabs.size');
    await cdp.evaluate("newTab('cmd'); true");
    await waitForExpr(
      cdp,
      `termTabs.size === ${tabsBefore + 1} && !!activeTab() && !!activeTab().xterm`,
      20000,
      'ny fane',
    );
    const background = await cdp.evaluate(
      "activeTab().xterm.options && activeTab().xterm.options.theme && activeTab().xterm.options.theme.background",
    );
    assert(background === '#f4f5f7', `ny fane arver det lyse tema (${background})`);

    await cdp.evaluate('closeTab(activeTabId); true');
    await waitForExpr(cdp, `termTabs.size === ${tabsBefore}`, 5000, 'fane lukket');

    await cdp.evaluate(`(() => {
      const theme = document.getElementById('set-theme');
      theme.value = 'standard';
      theme.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btn-save-settings').click();
      return true;
    })()`);
    await waitForExpr(cdp, "!document.body.classList.contains('theme-lys')", 10000, 'standardtema');
    await cdp.evaluate('closeSettings(); true');

    // ---- 7. no renderer errors ----
    await sleep(800);
    assert(
      cdp.problems.length === 0,
      `ingen console-fejl eller uncaught exceptions${cdp.problems.length ? `: ${cdp.problems.join(' | ')}` : ''}`,
    );

    await cdp.evaluate('window.lennart.closeWindow(); true').catch(() => {});
    await sleep(800);
    ok = true;
    console.log(`\nSMOKE TEST OK — ${passed} kontroller bestået.`);
  } catch (err) {
    console.error(`\nSMOKE TEST FEJLEDE: ${err.message}`);
    const output = app.output().trim();
    if (output) {
      const tail = output.split('\n').slice(-30).join('\n');
      console.error(`\nElectron-log (sidste linjer):\n${tail}`);
    }
    if (profile) {
      console.error(`\nTestprofilen er bevaret til fejlsøgning:\n${profile.base}`);
    }
    process.exitCode = 1;
  } finally {
    if (cdp) {
      try { cdp.close(); } catch { /* already closed */ }
    }
    killTree(app.child && app.child.pid);
    try {
      if (stub.server.closeAllConnections) stub.server.closeAllConnections();
      stub.server.close();
    } catch { /* already closed */ }
    if (ok && !KEEP && profile) {
      try { fs.rmSync(profile.base, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

if (HELP) {
  console.log('Lennart Terminal — Windows-smoketest\n');
  console.log('Brug:');
  console.log('  node scripts/smoke-test.js          kør hele smoketesten');
  console.log('  node scripts/smoke-test.js --keep   behold testprofilen bagefter');
  console.log('  node scripts/smoke-test.js --help   vis denne hjælp\n');
  console.log('Testen starter appen i en midlertidig profil og rører ikke dine data.');
  process.exit(0);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  console.error(`Node.js 22 eller nyere kræves (du kører ${process.version}) — den globale WebSocket bruges til CDP.`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.error('Denne smoketest skal køres på Windows — den starter den rigtige Electron-app.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`SMOKE TEST FEJLEDE: ${err.message}`);
  // Nothing has been launched yet at this point (stub/profile/Electron setup),
  // so make sure a stray listening socket cannot keep the process alive.
  process.exit(1);
});
