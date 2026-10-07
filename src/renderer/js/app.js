'use strict';

async function bootApp() {
  window.__lennartSettings = await window.lennart.getSettings();
  applyFontScale();
  document.getElementById('agent-mode-state').textContent =
    window.__lennartSettings.agentMode !== false ? 'On' : 'Off';
  applyTheme();
  try {
    window.__lennartElevation = await window.lennart.elevation();
  } catch {
    window.__lennartElevation = { admin: true };
  }
  window.lennart.log('step 2: settings loaded');

  // Native menu accelerators (Ctrl+, / Ctrl+J / Ctrl+T / Ctrl+W) — fire
  // regardless of focus, even when xterm has the caret
  window.lennart.onMenuAction((action) => {
    if (action === 'settings') openSettings();
    else if (action === 'new-tab') newTab();
    else if (action === 'close-tab') { if (activeTabId) closeTab(activeTabId); }
    else if (action === 'toggle-ai') toggleAiPanel();
    else if (action === 'history') openHistory();
  });

  document.getElementById('btn-minimize').addEventListener('click', () => window.lennart.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.lennart.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.lennart.closeWindow());
  document.getElementById('btn-devtools').addEventListener('click', () => window.lennart.openDevTools());
  document.getElementById('btn-settings').addEventListener('click', openSettings);

  document.getElementById('btn-new-tab').addEventListener('click', () => newTab());
  document.getElementById('btn-new-tab-inline').addEventListener('click', () => newTab());
  document.querySelectorAll('.shell-btn').forEach((b) => {
    b.addEventListener('click', () => newTab(b.dataset.shell));
  });
  document.getElementById('btn-toggle-ai').addEventListener('click', toggleAiPanel);
  document.getElementById('btn-agent-mode').addEventListener('click', toggleAgentMode);
  document.getElementById('btn-copy-term')?.addEventListener('click', copyTermSelection);
  // Not elevated → visible notice (click = relaunch as administrator)
  const elevRow = document.getElementById('elev-row');
  if (elevRow && window.__lennartElevation && !window.__lennartElevation.admin) {
    elevRow.classList.remove('hidden');
    elevRow.addEventListener('click', () => {
      if (window.confirm('Genstart som administrator (UAC)?')) window.lennart.relaunchAdmin();
    });
  }

  // History button lives in the titlebar next to settings
  const histBtn = document.getElementById('btn-history');
  if (histBtn) histBtn.addEventListener('click', openHistory);

  const promptInput = document.getElementById('prompt-input');
  // Bottom hint ("Ask AI (Ctrl+Enter) or type a command…") shows while empty
  const promptHint = document.getElementById('prompt-hint');
  const syncPromptHint = () => {
    if (promptHint) promptHint.classList.toggle('hidden', promptInput.value.length > 0);
  };
  promptInput.addEventListener('input', syncPromptHint);
  syncPromptHint();
  promptInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = promptInput.value;
    promptInput.value = '';
    syncPromptHint();
    if (e.ctrlKey) {
      if (text.trim()) {
        aiEls.input.value = text;
        document.getElementById('ai-composer').requestSubmit();
      }
    } else {
      const tab = activeTab();
      if (tab && text.trim()) tab.runCommand(text);
    }
  });

  window.lennart.log('step 3: pre-AI-panel init');
  initAiPanel();
  wireSettingsEvents();
  initHostUI();
  initHistoryUI();
  initLocalAIToast();
  initQuickTroubleshooting();
  initMenubar();
  initQuickConnect();
  // Disable shells that are not installed (e.g. PowerShell 7 without pwsh)
  try {
    const shells = await window.lennart.shellStatus();
    window.__lennartShells = shells;
    document.querySelectorAll('.shell-btn').forEach((b) => {
      if (shells[b.dataset.shell] === false) {
        b.disabled = true;
        b.classList.add('unavailable');
        b.title = `${b.textContent} er ikke installeret på denne PC`;
      }
    });
  } catch { /* main-process too old — buttons stay enabled */ }
  if (window.__updateAiHeaderModel) window.__updateAiHeaderModel();
  window.lennart.log('step 4: AI panel + settings + hosts + history wired');

  await newTab();
  window.lennart.log('step 5: first terminal tab created');
  await refreshAiStatus();
  setInterval(refreshAiStatus, 20000);

  // Boot the embedded local AI in the background when it is the active
  // provider, so chat works immediately (first run downloads once).
  if (window.__lennartSettings.ai?.provider === 'lennart-local') {
    window.lennart.localaiEnsure().then((r) => {
      window.lennart.log(`localai ensure: ${r.ok ? 'running' : r.error}`);
      refreshAiStatus();
    });
  }

  window.lennart.log('bootApp OK');
}

async function toggleAgentMode() {
  const next = !(window.__lennartSettings.agentMode !== false);
  window.__lennartSettings.agentMode = next;
  await window.lennart.setSettings({ agentMode: next });
  document.getElementById('agent-mode-state').textContent = next ? 'On' : 'Off';
}

function applyFontScale() {
  window.__lennartFontScale = window.__lennartSettings.fontScale || 1;
  for (const t of termTabs.values()) {
    if (t.xterm) {
      t.xterm.options.fontSize = Math.round(13 * window.__lennartFontScale);
      t.fit();
    }
  }
}

// ---------------------------------------------------------------------------
// Quick network command buttons (the 20 most used network commands)
// Runs in the active tab — local terminal or remote host tab alike.
// ---------------------------------------------------------------------------

function runInActiveTab(cmd) {
  const tab = activeTab();
  if (!tab) {
    // No tab yet (early boot) — create one and run once the shell is up
    const t = newTab();
    const iv = setInterval(() => {
      if (t.sessionId) { clearInterval(iv); t.runCommand(cmd); }
      else if (t.dead) clearInterval(iv);
    }, 120);
    return;
  }
  tab.runCommand(cmd);
}

function initQuickTroubleshooting() {
  const grid = document.getElementById('quick-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const actions = typeof NETWORK_QUICK_COMMANDS !== 'undefined'
    ? NETWORK_QUICK_COMMANDS
    : [];
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'quick-btn';
    b.textContent = a.label;
    b.title = a.cmd;
    b.addEventListener('click', () => runInActiveTab(a.cmd));
    grid.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Top menubar: dropdown menus with the most used PowerShell commands
// ---------------------------------------------------------------------------

function initMenubar() {
  const bar = document.getElementById('menubar');
  if (!bar || typeof COMMAND_MENUS === 'undefined') return;
  bar.innerHTML = '';

  for (const menu of COMMAND_MENUS) {
    const wrap = document.createElement('div');
    wrap.className = menu.id === 'setup' ? 'menu menu-setup' : 'menu';

    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    btn.type = 'button';
    btn.textContent = menu.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = wrap.classList.contains('open');
      closeAllMenus();
      if (!wasOpen) wrap.classList.add('open');
    });
    wrap.appendChild(btn);

    const pop = document.createElement('div');
    pop.className = 'menu-pop';
    const admin = Boolean(window.__lennartElevation && window.__lennartElevation.admin);
    for (const item of menu.items) {
      const it = document.createElement('button');
      it.className = 'menu-item';
      it.type = 'button';
      it.textContent = item.label;
      if (item.cmd) it.title = item.cmd;
      // Not running elevated → mark the commands that need administrator
      if (!admin && item.cmd && typeof requiresAdmin === 'function' && requiresAdmin(item.cmd)) {
        const tag = document.createElement('span');
        tag.className = 'admin-need';
        tag.textContent = '· kræver administrator';
        it.appendChild(tag);
      }
      it.addEventListener('click', () => {
        closeAllMenus();
        if (item.cmd) runInActiveTab(item.cmd);
        else if (item.action) runMenuAction(item.action);
      });
      pop.appendChild(it);
    }
    wrap.appendChild(pop);
    bar.appendChild(wrap);
  }

  // Version pinned to the far right of the menubar
  const spacer = document.createElement('span');
  spacer.className = 'menubar-spacer';
  bar.appendChild(spacer);
  const tag = document.createElement('span');
  tag.id = 'version-tag';
  tag.title = 'Lennart Terminal — CI: github.com/h4xtor/Lennarts-Terminal/actions';
  tag.textContent = 'v0.2.0';
  bar.appendChild(tag);
  window.lennart.getPaths()
    .then((p) => { if (p && p.version) tag.textContent = `v${p.version}`; })
    .catch(() => { /* keep the static fallback */ });

  document.addEventListener('click', closeAllMenus);
}

function closeAllMenus() {
  document.querySelectorAll('#menubar .menu.open').forEach((m) => m.classList.remove('open'));
}

async function runMenuAction(action) {
  switch (action) {
    case 'ssh-setup': {
      const { command } = await window.lennart.hostsSshSetupCommand();
      await navigator.clipboard.writeText(command);
      if (typeof appendStatus === 'function') appendStatus(`SSH setup-kommando kopieret`);
      window.alert(`Kør dette én gang på mål-PC'en (som admin) for at slå SSH til:\n\n${command}`);
      break;
    }
    case 'remote-connect': {
      const ip = document.getElementById('quick-host-ip');
      if (ip) { ip.focus(); ip.select(); }
      break;
    }
    case 'add-host':
      openHostDialog(null);
      break;
    case 'test-hosts':
      await testAllHosts();
      break;
    case 'ai-clear':
      document.getElementById('btn-clear-chat')?.click();
      break;
    case 'ai-toggle':
      toggleAiPanel();
      break;
    case 'ai-agent-mode':
      toggleAgentMode();
      break;
    case 'ai-focus':
      document.getElementById('ai-input')?.focus();
      break;
    case 'ai-ask-port':
      setAiPrompt('Hvad er kommanden til at finde ud af, hvilken proces der lytter på port 8080, og vil du udføre den for mig?');
      break;
    case 'ai-ask-ipconfig':
      setAiPrompt('Udfør en ipconfig /all for mig og forklar resultatet kort.');
      break;
    case 'ai-help':
      setAiPrompt('/help');
      setTimeout(() => document.getElementById('ai-composer')?.requestSubmit(), 60);
      break;
    case 'setup-settings':
      openSettings();
      break;
    case 'setup-models': {
      openSettings();
      setTimeout(() => {
        const panel = document.getElementById('model-panel');
        if (panel && panel.classList.contains('hidden')) toggleModelPanel();
        else refreshModelList();
        document.getElementById('sec-ai')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 350);
      break;
    }
    case 'setup-colors':
      openSettings();
      setTimeout(() => {
        document.getElementById('sec-colors')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 350);
      break;
    case 'models-refresh':
      await refreshModelList();
      if (typeof renderModelPanel === 'function') await renderModelPanel();
      break;
    case 'github-actions':
      window.lennart.openExternal('https://github.com/h4xtor/Lennarts-Terminal/actions');
      break;
    case 'run-as-admin': {
      const ok = window.confirm('Genstart Lennart Terminal som administrator (UAC)?\n\nAlle kommandoer og faner køres derefter med administrator-rettigheder.');
      if (ok) window.lennart.relaunchAdmin();
      break;
    }
    case 'about': {
      const p = await window.lennart.getPaths();
      window.alert(`Lennart Terminal v${p.version} · ${p.platform}\n\nGitHub (CI): https://github.com/h4xtor/Lennarts-Terminal/actions\n\nIndbygget offline-AI, 20 netværksknapper, 10 dropdown-menuer, fjernstyring via SSH/WinRM.`);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Theme (Settings → Farver): preset classes + accent colour, applied live
// ---------------------------------------------------------------------------

const THEME_BODY_CLASSES = ['theme-black', 'theme-ocean', 'theme-terminal', 'theme-lys'];

function applyTheme(override) {
  const s = window.__lennartSettings || {};
  const stored = s.theme || {};
  const preset = (override && override.preset) || stored.preset || 'standard';
  const accent = (override && override.accent) || stored.accent || '#7c6cff';

  document.body.classList.remove(...THEME_BODY_CLASSES);
  if (preset !== 'standard') document.body.classList.add(`theme-${preset}`);

  document.documentElement.style.setProperty('--accent', accent);
  const rgba = /^#[0-9a-f]{6}$/i.test(accent)
    ? `rgba(${parseInt(accent.slice(1, 3), 16)}, ${parseInt(accent.slice(3, 5), 16)}, ${parseInt(accent.slice(5, 7), 16)}, 0.16)`
    : 'rgba(124, 108, 255, 0.16)';
  document.documentElement.style.setProperty('--accent-soft', rgba);

  if (typeof applyTerminalTheme === 'function') applyTerminalTheme(preset, accent);
}

function setAiPrompt(text) {
  const inp = document.getElementById('ai-input');
  if (!inp) return;
  if (document.getElementById('ai-pane')?.classList.contains('collapsed')) toggleAiPanel();
  inp.value = text;
  inp.focus();
}

async function testAllHosts() {
  const hosts = await window.lennart.hostsList();
  if (!hosts.length) {
    window.alert('Ingen værter endnu — tilføj en PC først (sidebar → Netværk).');
    return;
  }
  const results = [];
  for (const h of hosts) {
    const res = await window.lennart.remoteTest(h);
    results.push(`${res.ok ? 'OK  ' : 'FEJL'} ${h.name || h.host} (${h.host} · ${h.method})`);
  }
  window.alert('Test af værter:\n\n' + results.join('\n'));
}

// ---------------------------------------------------------------------------
// Quick connect: type a LAN IP → open a remote tab (or the add-host dialog)
// ---------------------------------------------------------------------------

function initQuickConnect() {
  const input = document.getElementById('quick-host-ip');
  const btn = document.getElementById('btn-quick-connect');
  if (!input || !btn) return;

  const go = async () => {
    const addr = input.value.trim();
    if (!addr) {
      openHostDialog(null);
      return;
    }
    const hosts = await window.lennart.hostsList();
    const match = hosts.find((h) => h.host === addr || (h.name && h.name === addr));
    if (match) {
      openRemoteTab(match);
      return;
    }
    // Unknown address → open the dialog with the address filled in and open
    // the remote tab automatically once the host has been saved
    hostUI.pendingOpenAddr = addr;
    openHostDialog(null);
    document.getElementById('host-addr').value = addr;
    document.getElementById('host-name').value = addr;
    document.getElementById('host-user').focus();
  };

  btn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(); }
  });
}

async function refreshAiStatus() {
  const dot = document.getElementById('ai-status-dot');
  const text = document.getElementById('ai-status-text');
  try {
    // Re-read settings so main-process fallbacks (f.eks. agy → offline AI)
    // become visible without a restart
    window.__lennartSettings = await window.lennart.getSettings();
    const s = window.__lennartSettings;
    if (s.ai.provider === 'lennart-local') {
      // Never poke the embedded engine from the status poll — it must not
      // silently start a 1 GB download. Report state only.
      const st = await window.lennart.localaiStatus();
      dot.className = `status-dot ${st.running ? 'ok' : 'err'}`;
      text.textContent = st.running
        ? 'AI: Online · indbygget'
        : (st.binary && st.model ? 'AI: Offline (starter…)' : 'AI: Offline (henter…)');
      return;
    }
    const cfg = {
      provider: s.ai.provider,
      baseUrl: s.ai.baseUrl,
      apiKey: ((s.providers || {})[s.ai.provider] || {}).apiKey || '',
    };
    const res = await window.lennart.checkConnection(cfg);
    dot.className = `status-dot ${res.ok ? 'ok' : 'err'}`;
    const model = s.ai.model || 'no model';
    // Online/Offline reflects reality: for Ollama & co. the endpoint is
    // actually pinged, so “Online” means the engine is really running.
    text.textContent = res.ok ? `AI: Online · ${s.ai.provider} · ${model}` : 'AI: Offline';
  } catch {
    dot.className = 'status-dot err';
    text.textContent = 'AI: Offline';
  }
}

function toggleAiPanel() {
  document.getElementById('ai-pane').classList.toggle('collapsed');
  requestAnimationFrame(() => {
    const tab = activeTab();
    if (tab) tab.fit();
  });
}

function wireSettingsEvents() {
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-overlay') closeSettings();
  });
  // “Hent modeller” opens the model manager panel (list + one-click downloads)
  document.getElementById('btn-refresh-models').addEventListener('click', toggleModelPanel);
  document.getElementById('btn-fetch-model').addEventListener('click', fetchSelectedLocalModel);
  document.getElementById('set-model').addEventListener('change', updateFetchModelButton);
  document.getElementById('btn-test-conn').addEventListener('click', testConnection);
  document.getElementById('set-temp').addEventListener('input', updateTempLabel);
  document.getElementById('set-topp').addEventListener('input', updateToppLabel);
  // Colours: live preview while picking, persisted on Save
  document.getElementById('set-theme').addEventListener('change', () =>
    applyTheme({
      preset: document.getElementById('set-theme').value,
      accent: document.getElementById('set-accent').value,
    }));
  document.getElementById('set-accent').addEventListener('input', () =>
    applyTheme({
      preset: document.getElementById('set-theme').value,
      accent: document.getElementById('set-accent').value,
    }));
  document.getElementById('btn-open-actions')?.addEventListener('click', () =>
    window.lennart.openExternal('https://github.com/h4xtor/Lennarts-Terminal/actions'));
  // Section nav chips in the settings dialog
  document.querySelectorAll('#set-nav button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#set-nav button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById(b.dataset.sec)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // Live progress for downloads started from the model panel
  window.lennart.onLocalaiProgress(({ got, total, file }) => {
    const box = document.getElementById('model-progress');
    if (box && !box.classList.contains('hidden')) showModelProgress(got, total, file);
  });
  document.getElementById('set-provider').addEventListener('change', applyProviderSelection);
  document.getElementById('set-agent-engine').addEventListener('change', updateAgyFieldVisibility);
  document.getElementById('btn-refresh-agy').addEventListener('click', refreshAgyModels);
  document.getElementById('btn-show-key').addEventListener('click', () => {
    const k = document.getElementById('set-apikey');
    k.type = k.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-open-settings-file').addEventListener('click', () => {
    window.lennart.revealSettingsFile();
  });
  document.getElementById('btn-reset-settings').addEventListener('click', async () => {
    if (!window.confirm('Reset all settings to defaults?')) return;
    await window.lennart.resetSettings();
    window.__lennartSettings = await window.lennart.getSettings();
    applyFontScale();
    if (window.__updateAiHeaderModel) window.__updateAiHeaderModel();
    await refreshAiStatus();
    loadSettingsUi();
  });
}

async function refreshAgyModels() {
  const sel = document.getElementById('set-agy-model');
  sel.innerHTML = '<option value="">loading…</option>';
  const res = await window.lennart.agyModels();
  sel.innerHTML = '<option value="">— standard —</option>';
  if (res.ok) {
    for (const m of res.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
      if (m.id === (window.__lennartSettings.agyModel || '')) sel.value = m.id;
    }
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `agy utilgængelig: ${res.error}`;
    sel.appendChild(opt);
  }
}

async function saveSettings() {
  const patch = collectSettingsPatch();
  window.__lennartSettings = await window.lennart.setSettings(patch);
  applyFontScale();
  applyTheme();
  if (window.__updateAiHeaderModel) window.__updateAiHeaderModel();
  document.getElementById('settings-save-note').textContent = `Saved ${new Date().toLocaleTimeString()}`;
  await refreshAiStatus();
}

// Capture phase: intercept app shortcuts BEFORE xterm.js sees them
// Capture phase: intercept app shortcuts BEFORE xterm.js sees them.
// Matches on both e.key and e.code so non-US layouts (f.eks. dansk) also work.
window.addEventListener('keydown', (e) => {
  let handled = false;
  const k = (e.key || '').toLowerCase();
  const c = e.code || '';
  if (e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (k === ',' || c === 'Comma') { openSettings(); handled = true; }
    else if (k === 't' || c === 'KeyT') { newTab(); handled = true; }
    else if (k === 'j' || c === 'KeyJ') { toggleAiPanel(); handled = true; }
    else if (k === 'w' || c === 'KeyW') { if (activeTabId) closeTab(activeTabId); handled = true; }
    else if (k === 'h' || c === 'KeyH') { openHistory(); handled = true; }
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

bootApp().catch((err) => {
  window.lennart?.log(`bootApp failed: ${err.stack || err}`);
  document.body.innerHTML =
    `<pre style="color:#f87171;padding:20px;white-space:pre-wrap">Lennart Terminal failed to start:\n${err.stack || err}</pre>`;
});
