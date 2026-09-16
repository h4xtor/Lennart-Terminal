'use strict';

/**
 * Settings dialog v2: grouped provider select (from main-process catalog),
 * per-provider API keys, base URL override, model refresh, connection test,
 * agent engine (builtin autopilot vs Antigravity CLI).
 */

let currentSettings = null;
let providerCatalog = { providers: {}, groups: [] };

function openSettings() {
  document.getElementById('settings-overlay').classList.remove('hidden');
  loadSettingsUi();
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

async function loadSettingsUi() {
  currentSettings = await window.lennart.getSettings();
  providerCatalog = await window.lennart.providersCatalog();
  window.__providerCatalog = providerCatalog;

  fillProviderSelect();
  applyProviderSelection();

  document.getElementById('set-temp').value = currentSettings.ai.temperature ?? 0.4;
  document.getElementById('set-temp-label').textContent = Number(currentSettings.ai.temperature ?? 0.4).toFixed(2);
  document.getElementById('set-shell').value = currentSettings.shell || 'powershell';
  document.getElementById('set-fontscale').value = currentSettings.fontScale ?? 1;
  document.getElementById('set-agent-mode').checked = currentSettings.agentMode !== false;
  document.getElementById('set-confirm').checked = currentSettings.confirmDestructive !== false;
  document.getElementById('set-agent-engine').value = currentSettings.agentEngine || 'builtin';
  document.getElementById('set-agent-autoapprove').checked = currentSettings.agentAutoApprove === true;
  document.getElementById('agent-mode-state').textContent = currentSettings.agentMode !== false ? 'On' : 'Off';
  updateAgyFieldVisibility();

  const paths = await window.lennart.getPaths();
  document.getElementById('settings-paths').textContent =
    `Settings: ${paths.settingsFile}\nVersion: v${paths.version} · ${paths.platform}`;
}

function fillProviderSelect() {
  const sel = document.getElementById('set-provider');
  sel.innerHTML = '';
  for (const groupName of providerCatalog.groups) {
    const items = Object.entries(providerCatalog.providers).filter(([, p]) => p.group === groupName);
    if (!items.length) continue;
    const og = document.createElement('optgroup');
    og.label = groupName;
    for (const [id, p] of items) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = currentSettings.ai.provider || 'ollama';
}

async function applyProviderSelection() {
  const pid = document.getElementById('set-provider').value;
  const info = providerCatalog.providers[pid] || {};
  const stored = (currentSettings.providers || {})[pid] || {};

  document.getElementById('set-baseurl').value = stored.baseUrl || '';
  document.getElementById('set-apikey').value = stored.apiKey || '';
  document.getElementById('set-apikey').placeholder = info.keyPlaceholder || 'valgfri';
  // Only the agy engine has no key concept — everything else accepts an
  // optional or required key (OmniRoute gateway auth, local proxies, …)
  document.getElementById('set-apikey').disabled = info.protocol === 'agy';

  document.getElementById('key-hint').textContent = info.keyUrl
    ? `Hent en nøgle: ${info.keyUrl}`
    : (info.hint || '');

  const statusEl = document.getElementById('provider-status');
  if (info.protocol === 'agy') {
    statusEl.innerHTML = '<span class="ok">&#10004; Lokal agent-motor — v&#230;lg den under Agent</span>';
  } else if (info.needsKey && !stored.apiKey) {
    statusEl.innerHTML = '<span class="err">&#9888; API-n&#248;gle mangler</span>';
  } else {
    statusEl.innerHTML = '<span class="ok">&#10004; Konfigureret</span>';
  }

  updateAgyFieldVisibility();
  await refreshModelList();
}

function updateAgyFieldVisibility() {
  const engine = document.getElementById('set-agent-engine').value;
  document.getElementById('field-agy-model').style.display = engine === 'antigravity' ? '' : 'none';
}

async function refreshModelList() {
  const sel = document.getElementById('set-model');
  const pid = document.getElementById('set-provider').value;
  const info = providerCatalog.providers[pid] || {};

  if (info.protocol === 'agy') {
    sel.innerHTML = '<option value="">(agy-motor — v&#230;lg model under Agent)</option>';
    return;
  }

  const cfg = {
    provider: pid,
    baseUrl: document.getElementById('set-baseurl').value.trim(),
    apiKey: document.getElementById('set-apikey').value.trim(),
  };

  sel.innerHTML = '<option value="">loading…</option>';
  const res = cfg.baseUrl
    ? await window.lennart.listModels(cfg)
    : { ok: false, error: 'No endpoint configured' };

  sel.innerHTML = '';
  if (res.ok && res.models.length) {
    const saved = ((currentSettings.providers || {})[pid] || {}).model;
    for (const m of res.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
      if (m.id === saved) sel.value = m.id;
    }
    if (!sel.value) sel.selectedIndex = 0;
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = res.ok ? 'Ingen modeller fundet — kører serveren?' : `Utilgængelig: ${res.error}`;
    sel.appendChild(opt);
  }
}

async function testConnection() {
  const el = document.getElementById('conn-result');
  el.className = '';
  el.textContent = 'Testing…';

  const cfg = {
    provider: document.getElementById('set-provider').value,
    baseUrl: document.getElementById('set-baseurl').value.trim(),
    apiKey: document.getElementById('set-apikey').value.trim(),
  };
  const res = await window.lennart.checkConnection(cfg);
  el.className = res.ok ? 'ok' : 'err';
  el.textContent = res.ok ? `Forbundet — ${res.count} model(ler)` : `Fejlede: ${res.error}`;
}

function currentPid() {
  return document.getElementById('set-provider').value;
}

function collectSettingsPatch() {
  const pid = currentPid();
  return {
    ai: {
      provider: pid,
      model: document.getElementById('set-model').value,
      baseUrl: document.getElementById('set-baseurl').value.trim(),
    },
    providers: {
      [pid]: {
        apiKey: document.getElementById('set-apikey').value.trim(),
        model: document.getElementById('set-model').value,
        baseUrl: document.getElementById('set-baseurl').value.trim(),
      },
    },
    shell: document.getElementById('set-shell').value,
    fontScale: parseFloat(document.getElementById('set-fontscale').value) || 1,
    agentMode: document.getElementById('set-agent-mode').checked,
    confirmDestructive: document.getElementById('set-confirm').checked,
    agentEngine: document.getElementById('set-agent-engine').value,
    agentAutoApprove: document.getElementById('set-agent-autoapprove').checked,
    agyModel: document.getElementById('set-agy-model').value,
  };
}

function updateTempLabel() {
  document.getElementById('set-temp-label').textContent =
    Number(document.getElementById('set-temp').value).toFixed(2);
}

function updateAiHeaderModel() {
  const s = window.__lennartSettings || {};
  const pid = (s.ai && s.ai.provider) || 'ollama';
  const info = (window.__providerCatalog && window.__providerCatalog.providers[pid]) || {};
  const model = (s.ai && s.ai.model) || 'ingen model';
  const el = document.getElementById('ai-model-label');
  if (el) el.textContent = `${info.label || pid} · ${model}`;
}

window.__updateAiHeaderModel = updateAiHeaderModel;
