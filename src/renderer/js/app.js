'use strict';

async function bootApp() {
  window.__lennartSettings = await window.lennart.getSettings();
  applyFontScale();
  document.getElementById('agent-mode-state').textContent =
    window.__lennartSettings.agentMode !== false ? 'On' : 'Off';
  window.lennart.log('step 2: settings loaded');

  // Native menu accelerators (Ctrl+, / Ctrl+J / Ctrl+T / Ctrl+W) — fire
  // regardless of focus, even when xterm has the caret
  window.lennart.onMenuAction((action) => {
    if (action === 'settings') openSettings();
    else if (action === 'new-tab') newTab();
    else if (action === 'close-tab') { if (activeTabId) closeTab(activeTabId); }
    else if (action === 'toggle-ai') toggleAiPanel();
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

  const promptInput = document.getElementById('prompt-input');
  promptInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = promptInput.value;
    promptInput.value = '';
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
  window.lennart.log('step 4: AI panel + settings wired');

  await newTab();
  window.lennart.log('step 5: first terminal tab created');
  await refreshAiStatus();
  setInterval(refreshAiStatus, 20000);

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

async function refreshAiStatus() {
  const dot = document.getElementById('ai-status-dot');
  const text = document.getElementById('ai-status-text');
  try {
    const s = window.__lennartSettings;
    const cfg = {
      provider: s.ai.provider,
      baseUrl: s.ai.baseUrl,
      apiKey: ((s.providers || {})[s.ai.provider] || {}).apiKey || '',
    };
    const res = await window.lennart.checkConnection(cfg);
    dot.className = `status-dot ${res.ok ? 'ok' : 'err'}`;
    const model = s.ai.model || 'no model';
    text.textContent = res.ok ? `AI: ${s.ai.provider} · ${model}` : 'AI: offline';
  } catch {
    dot.className = 'status-dot err';
    text.textContent = 'AI: offline';
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
  document.getElementById('btn-refresh-models').addEventListener('click', () => refreshModelList());
  document.getElementById('btn-test-conn').addEventListener('click', testConnection);
  document.getElementById('set-temp').addEventListener('input', updateTempLabel);
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
