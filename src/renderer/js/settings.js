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

  // Model settings (ctx / threads / max tokens / top-p / auto-run) + colours
  const lai = currentSettings.localAI || {};
  document.getElementById('set-ctx').value = String(lai.ctx || 4096);
  document.getElementById('set-threads').value = String(lai.threads || 0);
  document.getElementById('set-maxtokens').value = String(currentSettings.ai.maxTokens ?? 0);
  document.getElementById('set-topp').value = currentSettings.ai.topP ?? 1;
  document.getElementById('set-topp-label').textContent = Number(currentSettings.ai.topP ?? 1).toFixed(2);
  document.getElementById('set-autorun').checked = currentSettings.aiAutoRun !== false;
  const theme = currentSettings.theme || {};
  document.getElementById('set-theme').value = theme.preset || 'standard';
  document.getElementById('set-accent').value = theme.accent || '#7c6cff';
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

  const isLocal = pid === 'lennart-local';
  document.getElementById('field-apikey').style.display = (info.protocol === 'agy' || isLocal) ? 'none' : '';
  document.getElementById('set-baseurl').closest('.field').style.display = isLocal ? 'none' : '';

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
  if (isLocal) {
    const st = await window.lennart.localaiStatus();
    statusEl.innerHTML = st.running
      ? '<span class="ok">&#10004; Kører — offline PowerShell-assistent klar</span>'
      : (st.binary && st.model
        ? '<span class="ok">&#10004; Downloadet — startes automatisk</span>'
        : '<span class="err">&#9888; Hentes ved førstehjælp (~1 GB, kræver internet én gang)</span>');
  } else if (info.protocol === 'agy') {
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

  if (pid === 'lennart-local') {
    // "Hent modeller": list what is on disk + the downloadable catalogue
    const hint = document.getElementById('model-hint');
    sel.innerHTML = '<option value="">Henter modeller…</option>';
    const res = await window.lennart.localaiListModels();
    const saved = ((currentSettings.providers || {})['lennart-local'] || {}).model ||
      currentSettings.ai.model || '';

    sel.innerHTML = '';
    const add = (value, text) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      sel.appendChild(opt);
      return opt;
    };

    for (const m of res.models) {
      add(m.id, `${m.builtin ? '\u2713 ' : ''}${m.label}${m.sizeMB ? ` · ${m.sizeMB} MB` : ''}`);
    }
    for (const c of res.catalog) {
      if (c.available) continue; // already on disk → listed above
      add(`catalog:${c.id}`, `\u2B07 ${c.label} · ${c.sizeMB} MB (kan hentes)`);
    }

    if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
    else sel.selectedIndex = 0;
    if (hint) {
      hint.textContent = res.models.length > 1
        ? `${res.models.length} modeller fundet lokalt — vælg en og tryk Save.`
        : 'Modeller på USB-stikket listes her; tryk “Hent modeller” for at se og hente flere.';
    }
    updateFetchModelButton();
    if (typeof renderModelPanel === 'function') renderModelPanel();
    return;
  }

  document.getElementById('btn-fetch-model').hidden = true;
  const hint = document.getElementById('model-hint');
  if (hint) hint.textContent = '';

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

  const pid = document.getElementById('set-provider').value;
  if (pid === 'lennart-local') {
    el.textContent = 'Starter indbygget AI…';
    const res = await window.lennart.localaiEnsure();
    el.className = res.ok ? 'ok' : 'err';
    el.textContent = res.ok ? 'Kører — offline AI er klar' : `Fejlede: ${res.error}`;
    return;
  }

  const cfg = {
    provider: pid,
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

/** Show “Hent valgt” only when a not-yet-downloaded catalogue model is picked. */
function updateFetchModelButton() {
  const btn = document.getElementById('btn-fetch-model');
  if (!btn) return;
  btn.hidden = !String(document.getElementById('set-model').value || '').startsWith('catalog:');
}

// ---------------------------------------------------------------------------
// Model manager panel — the “Hent modeller” button opens it. Every
// downloadable model gets its own one-click “Hent” button with a live
// progress bar, and downloaded models are selected automatically.
// ---------------------------------------------------------------------------

function toggleModelPanel() {
  const panel = document.getElementById('model-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  // Always draw the local model manager directly — it must work even when
  // the Settings dialog (and its provider select) has never been opened.
  renderModelPanel();
  refreshModelList(); // keeps the <select> in sync as before
}

async function renderModelPanel() {
  const list = document.getElementById('model-panel-list');
  if (!list) return;
  list.innerHTML = '<div class="mp-row">Henter liste…</div>';
  let res;
  try {
    res = await window.lennart.localaiListModels();
  } catch (err) {
    list.innerHTML = `<div class="mp-row">Kunne ikke hente listen: ${err.message || err}</div>`;
    return;
  }
  window.__localaiCatalog = res;
  list.innerHTML = '';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  for (const m of res.models) {
    const row = document.createElement('div');
    row.className = 'mp-row';
    row.innerHTML = `<span class="mp-name">✓ ${esc(m.label)}</span>
      <span class="mp-size">${m.sizeMB ? `${m.sizeMB} MB` : ''}</span>
      <span class="mp-badge${m.active ? ' active' : ''}">${m.active ? 'aktiv' : 'på disken'}</span>`;
    list.appendChild(row);
  }

  const missing = (res.catalog || []).filter((c) => !c.available);
  for (const c of missing) {
    const row = document.createElement('div');
    row.className = 'mp-row';
    row.innerHTML = `<span class="mp-name">▼ ${esc(c.label)}</span>
      <span class="mp-size">${c.sizeMB} MB</span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mp-dl';
    btn.textContent = 'Hent';
    btn.title = `Hent ${c.file} (${c.sizeMB} MB) — gemmes lokalt`;
    btn.dataset.id = c.id;
    btn.addEventListener('click', () => downloadPanelModel(c.id, btn));
    row.appendChild(btn);
    list.appendChild(row);
  }

  if (!missing.length) {
    const row = document.createElement('div');
    row.className = 'mp-row small';
    row.textContent = 'Alle modeller i kataloget er hentet.';
    list.appendChild(row);
  }
}

function showModelProgress(got, total, file) {
  const box = document.getElementById('model-progress');
  if (!box) return;
  box.classList.remove('hidden');
  const fill = box.querySelector('.mp-fill');
  const note = box.querySelector('.mp-note');
  const mb = (n) => Math.round(n / 1048576);
  fill.style.width = total ? `${Math.min(100, Math.round((got / total) * 100))}%` : '35%';
  note.textContent = total
    ? `Henter ${file || 'model'}… ${mb(got)} / ${mb(total)} MB (${Math.round((got / total) * 100)}%)`
    : `Henter ${file || 'model'}… ${mb(got)} MB`;
}

function hideModelProgress() {
  const box = document.getElementById('model-progress');
  if (box) box.classList.add('hidden');
}

async function downloadPanelModel(id, btn) {
  const res0 = await window.lennart.localaiListModels();
  const entry = (res0.catalog || []).find((c) => c.id === id);
  if (!entry || !btn) return;
  btn.disabled = true;
  btn.textContent = 'Henter…';
  showModelProgress(0, entry.sizeMB * 1048576, entry.file);
  try {
    const res = await window.lennart.localaiDownloadModel({ url: entry.url, file: entry.file });
    if (!res.ok) {
      window.alert(`Download fejlede: ${res.error}`);
      return;
    }
    // Sync the model <select>, pick the fresh model and redraw the panel
    await refreshModelList();
    const sel = document.getElementById('set-model');
    if (sel && [...sel.options].some((o) => o.value === entry.id)) {
      sel.value = entry.id;
      updateFetchModelButton();
    }
    await renderModelPanel();
  } catch (err) {
    window.alert(`Download fejlede: ${err.message || err}`);
  } finally {
    hideModelProgress();
    btn.disabled = false;
    btn.textContent = 'Hent';
  }
}

/** Download the selected catalogue model (progress shows in the toast). */
async function fetchSelectedLocalModel() {
  const value = document.getElementById('set-model').value;
  if (!value.startsWith('catalog:')) return;
  const btn = document.getElementById('btn-fetch-model');
  const resAll = await window.lennart.localaiListModels();
  const entry = (resAll.catalog || []).find((c) => `catalog:${c.id}` === value);
  if (!entry) return;
  btn.disabled = true;
  btn.textContent = 'Henter…';
  try {
    const res = await window.lennart.localaiDownloadModel({ url: entry.url, file: entry.file });
    if (!res.ok) {
      window.alert(`Download fejlede: ${res.error}`);
      return;
    }
    // Rebuild the list and select the freshly downloaded model
    const before = document.getElementById('set-model').value;
    await refreshModelList();
    const sel = document.getElementById('set-model');
    if ([...sel.options].some((o) => o.value === entry.id)) sel.value = entry.id;
    else sel.value = before;
    updateFetchModelButton();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Hent valgt';
  }
}function collectSettingsPatch() {
  const pid = currentPid();
  // Never persist an undownloaded catalogue placeholder ("catalog:xyz")
  const modelValue = (() => {
    const v = String(document.getElementById('set-model').value || '');
    return v.startsWith('catalog:') ? '' : v;
  })();
  return {

    ai: {
      provider: pid,
      model: modelValue,
      baseUrl: document.getElementById('set-baseurl').value.trim(),
      temperature: parseFloat(document.getElementById('set-temp').value) || 0.4,
      maxTokens: parseInt(document.getElementById('set-maxtokens').value, 10) || 0,
      topP: parseFloat(document.getElementById('set-topp').value) || 1,
    },
    providers: {
      [pid]: {
        apiKey: document.getElementById('set-apikey').value.trim(),
        model: modelValue,
        baseUrl: document.getElementById('set-baseurl').value.trim(),
      },
    },
    localAI: {
      ctx: parseInt(document.getElementById('set-ctx').value, 10) || 4096,
      threads: parseInt(document.getElementById('set-threads').value, 10) || 0,
    },
    theme: {
      preset: document.getElementById('set-theme').value || 'standard',
      accent: document.getElementById('set-accent').value || '#7c6cff',
    },
    aiAutoRun: document.getElementById('set-autorun').checked,
    shell: document.getElementById('set-shell').value,
    fontScale: parseFloat(document.getElementById('set-fontscale').value) || 1,
    agentMode: document.getElementById('set-agent-mode').checked,
    confirmDestructive: document.getElementById('set-confirm').checked,
    agentEngine: document.getElementById('set-agent-engine').value,
    agentAutoApprove: document.getElementById('set-agent-autoapprove').checked,
    agyModel: document.getElementById('set-agy-model').value,
  };
}

function updateToppLabel() {
  document.getElementById('set-topp-label').textContent =
    Number(document.getElementById('set-topp').value).toFixed(2);
}

function updateTempLabel() {
  document.getElementById('set-temp-label').textContent =
    Number(document.getElementById('set-temp').value).toFixed(2);
}

function updateAiHeaderModel() {
  const s = window.__lennartSettings || {};
  const pid = (s.ai && s.ai.provider) || 'lennart-local';
  const info = (window.__providerCatalog && window.__providerCatalog.providers[pid]) || {};
  let model = (s.ai && s.ai.model) || 'ingen model';
  if (pid === 'lennart-local') {
    model = (s.ai && s.ai.model) ? s.ai.model : 'hardcoded model';
  }
  const fallbackLabel = pid === 'lennart-local' ? 'Indbygget AI (offline)' : pid;
  const el = document.getElementById('ai-model-label');
  if (el) el.textContent = `${info.label || fallbackLabel} · ${model}`;
}

window.__updateAiHeaderModel = updateAiHeaderModel;
