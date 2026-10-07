'use strict';

/**
 * Network hosts UI (sidebar + add/edit dialog), permanent history dialog
 * (Ctrl+H) and the local-AI download/start progress toast.
 */

const hostUI = { editingId: null, pendingOpenAddr: null };

// ---------------------------------------------------------------------------
// Sidebar host list
// ---------------------------------------------------------------------------

async function loadHosts() {
  const list = document.getElementById('host-list');
  if (!list) return;
  const hosts = await window.lennart.hostsList();
  list.innerHTML = '';
  for (const h of hosts) {
    const el = document.createElement('button');
    el.className = 'host-item';
    el.title = `${h.host} · ${h.method.toUpperCase()} — klik for at åbne fjern-fane`;
    el.innerHTML = `
      <span class="dot ok"></span>
      <span class="name">${escapeHtml(h.name || h.host)}</span>
      <span class="badge">${escapeHtml(h.method)}</span>
      <span class="del" title="Slet vært">&#10005;</span>`;
    el.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Slet værten "${h.name || h.host}"?`)) return;
      await window.lennart.hostsDelete(h.id);
      loadHosts();
    });
    el.addEventListener('click', () => openRemoteTab(h));
    list.appendChild(el);
  }
}

function openHostDialog(existing) {
  hostUI.editingId = existing ? existing.id : null;
  document.getElementById('host-dialog-title').textContent = existing ? 'Redigér vært' : 'Tilføj vært';
  document.getElementById('host-name').value = existing ? existing.name || '' : '';
  document.getElementById('host-addr').value = existing ? existing.host : '';
  document.getElementById('host-method').value = existing ? existing.method || 'ssh' : 'ssh';
  document.getElementById('host-user').value = existing ? existing.username || '' : '';
  document.getElementById('host-pass').value = existing ? existing.password || '' : '';
  document.getElementById('host-key').value = existing ? existing.keyPath || '' : '';
  document.getElementById('host-test-result').textContent = '';
  document.getElementById('host-overlay').classList.remove('hidden');
}

function closeHostDialog() {
  document.getElementById('host-overlay').classList.add('hidden');
  hostUI.editingId = null;
}

function hostFromForm() {
  return {
    id: hostUI.editingId || undefined,
    name: document.getElementById('host-name').value.trim(),
    host: document.getElementById('host-addr').value.trim(),
    method: document.getElementById('host-method').value,
    username: document.getElementById('host-user').value.trim(),
    password: document.getElementById('host-pass').value,
    keyPath: document.getElementById('host-key').value.trim(),
  };
}

function initHostUI() {
  document.getElementById('btn-add-host').addEventListener('click', () => openHostDialog(null));
  document.getElementById('btn-host-cancel').addEventListener('click', closeHostDialog);
  document.getElementById('host-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'host-overlay') closeHostDialog();
  });
  document.getElementById('btn-host-save').addEventListener('click', async () => {
    const form = hostFromForm();
    const res = await window.lennart.hostsSave(form);
    const note = document.getElementById('host-test-result');
    if (!res.ok) {
      note.textContent = res.error;
      note.className = 'err';
      return;
    }
    closeHostDialog();
    loadHosts();
    // Quick-connect flow: the user typed an unknown IP in the sidebar —
    // open the remote tab for it as soon as it has been saved
    if (hostUI.pendingOpenAddr) {
      const addr = hostUI.pendingOpenAddr;
      hostUI.pendingOpenAddr = null;
      const hosts = await window.lennart.hostsList();
      const match = hosts.find((h) => h.host === addr);
      if (match) openRemoteTab(match);
    }
  });
  document.getElementById('btn-host-test').addEventListener('click', async () => {
    const el = document.getElementById('host-test-result');
    el.className = '';
    el.textContent = 'Tester…';
    const res = await window.lennart.remoteTest(hostFromForm());
    el.className = res.ok ? 'ok' : 'err';
    const out = (res.output || '').trim().split('\n').filter(Boolean).pop() || '';
    el.textContent = res.ok ? `OK — svar: ${out}` : `Fejlede: ${out || 'timeout'}`;
  });
  document.getElementById('btn-show-ssh-setup').addEventListener('click', async () => {
    const { command } = await window.lennart.hostsSshSetupCommand();
    const note = document.getElementById('ssh-setup-note');
    note.textContent = command;
    note.title = command + '\n\n(Klik for at kopiere)';
    note.style.userSelect = 'text';
    note.onclick = () => {
      navigator.clipboard.writeText(command);
      note.title = 'Kopieret!';
    };
  });
  loadHosts();
}

// ---------------------------------------------------------------------------
// Remote tabs
// ---------------------------------------------------------------------------

function openRemoteTab(host) {
  if (typeof createRemoteTab === 'function') createRemoteTab(host);
}

// ---------------------------------------------------------------------------
// History dialog
// ---------------------------------------------------------------------------

async function loadHistoryList() {
  const listEl = document.getElementById('history-list');
  const q = document.getElementById('history-search').value.trim();
  const type = document.getElementById('history-type').value;
  const rows = await window.lennart.historyQuery({ limit: 300, query: q, type: type || undefined });

  if (!rows.length) {
    listEl.innerHTML = '<div class="hist-empty">Ingen historik endnu — kør en kommando, eller stil AI et spørgsmål.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'hist-item';
    const time = new Date(r.t).toLocaleString('da-DK');
    const host = r.host && r.host !== 'local' ? escapeHtml(r.host) : '';
    el.innerHTML = `
      <div class="row1">
        <span class="h-type ${escapeHtml(r.type)}">${escapeHtml(r.type)}</span>
        ${host ? `<span class="h-host">${host}</span>` : ''}
        <span class="h-time">${escapeHtml(time)}</span>
      </div>
      <pre><code class="h-cmd">${escapeHtml(r.command || '')}</code>${r.output ? '\n' + escapeHtml(r.output) : ''}</pre>`;
    listEl.appendChild(el);
  }
}

function openHistory() {
  document.getElementById('history-overlay').classList.remove('hidden');
  loadHistoryList();
}

function closeHistory() {
  document.getElementById('history-overlay').classList.add('hidden');
}

function initHistoryUI() {
  document.getElementById('btn-history').addEventListener('click', openHistory);
  document.getElementById('btn-close-history').addEventListener('click', closeHistory);
  document.getElementById('history-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'history-overlay') closeHistory();
  });
  let debounce;
  document.getElementById('history-search').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(loadHistoryList, 250);
  });
  document.getElementById('history-type').addEventListener('change', loadHistoryList);
  document.getElementById('btn-history-clear').addEventListener('click', async () => {
    if (!window.confirm('Ryd al permanent historik? Dette kan ikke fortrydes.')) return;
    await window.lennart.historyClear();
    loadHistoryList();
  });
}

// ---------------------------------------------------------------------------
// Local AI progress toast
// ---------------------------------------------------------------------------

function initLocalAIToast() {
  const toast = document.createElement('div');
  toast.id = 'localai-toast';
  toast.innerHTML = `
    <div class="t-title">Indbygget AI klargøres…</div>
    <div class="t-bar"><div class="t-fill"></div></div>
    <div class="t-note">Hentes én gang og gemmes lokalt</div>`;
  document.body.appendChild(toast);

  window.lennart.onLocalaiProgress(({ step, got, total, file }) => {
    toast.classList.add('show');
    const title = toast.querySelector('.t-title');
    const fill = toast.querySelector('.t-fill');
    const note = toast.querySelector('.t-note');
    const mb = (n) => (n / (1024 * 1024)).toFixed(0);
    if (step === 'binary') {
      title.textContent = 'Henter llama.cpp (AI-motoren)…';
      note.textContent = total ? `${mb(got)} / ${mb(total)} MB — gemmes lokalt` : `${mb(got)} MB hentet`;
    } else if (step === 'model') {
      title.textContent = file
        ? `Henter model: ${file}…`
        : 'Henter PowerShell-modellen (én gang)…';
      note.textContent = total ? `${mb(got)} / ${mb(total)} MB — gemmes lokalt` : `${mb(got)} MB hentet`;
    }
    fill.style.width = total ? `${Math.round((got / total) * 100)}%` : '50%';
  });

  // Hide the toast once the local AI is confirmed running (polled at boot)
  const hideTimer = setInterval(async () => {
    try {
      const st = await window.lennart.localaiStatus();
      if (st.running) {
        toast.classList.remove('show');
        clearInterval(hideTimer);
      }
    } catch { /* keep polling */ }
  }, 3000);
  setTimeout(() => clearInterval(hideTimer), 15 * 60 * 1000);
}
