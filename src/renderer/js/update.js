'use strict';

/**
 * Update dialog for the portable Windows build.
 *
 * The main process does all GitHub and file work. This file only renders the
 * sanitised status it gets back: current version, "what's new", download
 * progress, and the one-time "updated" notice on the first start after a
 * successful install. GitHub text is always inserted with textContent.
 */

let updateInfo = null;
let updateBusy = false;
let updateWired = false;
let updateDownloaded = false;
let updatePendingShown = false;
let updateLastProgress = null;

function updateModeText(info) {
  const warning = 'Filen er ikke codesigned, så Windows kan vise "Windows protected your PC" første gang.';
  if (info.installMode === 'portable') {
    return `Den portable .exe erstattes på samme sted, og den nye version åbner automatisk. Den gamle fil gemmes som .old som sikkerhedskopi. ${warning}`;
  }
  if (info.development) {
    return `Du kører fra kildekoden. Den nye version installeres i ${info.installDir || 'en mappe under %LOCALAPPDATA%'} og åbner automatisk; din kildekode røres ikke. ${warning}`;
  }
  return `Den nye version installeres i ${info.installDir || 'den viste mappe'} og åbner automatisk. En tidligere fil på samme sted gemmes som .old; din nuværende installation røres ikke. ${warning}`;
}

function updateEl(id) {
  return document.getElementById(id);
}

function updateSetStatus(text, kind = '') {
  const el = updateEl('update-status');
  if (!el) return;
  el.className = `update-status${kind ? ` ${kind}` : ''}`;
  el.textContent = text;
}

function updateSetBusy(busy) {
  updateBusy = busy;
  const check = updateEl('btn-update-check');
  const install = updateEl('btn-update-install');
  if (check) check.disabled = busy;
  if (install) install.disabled = busy;
}

function updateFormatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function updateFormatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('da-DK', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function updateShowProgress(progress) {
  const box = updateEl('update-progress');
  const bar = updateEl('update-bar');
  const percentEl = updateEl('update-progress-percent');
  const label = updateEl('update-progress-label');
  const note = updateEl('update-progress-note');
  if (!box || !bar) return;
  box.classList.remove('hidden');
  updateLastProgress = progress;

  const percent = progress && progress.percent != null
    ? Math.max(0, Math.min(100, Number(progress.percent)))
    : null;
  bar.style.width = percent == null ? '30%' : `${percent}%`;
  if (percentEl) percentEl.textContent = percent == null ? '…' : `${percent} %`;
  if (label) {
    label.textContent = updateInfo && updateInfo.latestVersion
      ? `Henter v${updateInfo.latestVersion}…`
      : 'Henter opdateringen…';
  }
  if (note) {
    if (progress && progress.received != null) {
      const got = updateFormatBytes(progress.received);
      const total = progress.total ? updateFormatBytes(progress.total) : '';
      note.textContent = total
        ? `${got} / ${total} hentet · SHA-256 kontrolleres, før filen installeres`
        : `${got} hentet · SHA-256 kontrolleres, før filen installeres`;
    } else {
      note.textContent = 'SHA-256 kontrolleres, før filen installeres.';
    }
  }
}

function updateHideProgress() {
  const box = updateEl('update-progress');
  if (box) box.classList.add('hidden');
}

function updateClearChanges(list) {
  if (!list) return;
  list.replaceChildren();
}

function updateFillChanges(list, changes) {
  if (!list) return;
  updateClearChanges(list);
  const items = Array.isArray(changes) ? changes.filter(Boolean) : [];
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Se ændringerne i release-noterne på GitHub.';
    list.appendChild(li);
    return;
  }
  for (const change of items) {
    const li = document.createElement('li');
    li.textContent = String(change);
    list.appendChild(li);
  }
}

function updateSetVersionLabels(version) {
  const current = `v${String(version || '…').replace(/^v/i, '')}`;
  const hero = updateEl('update-current-version');
  const about = updateEl('about-version');
  if (hero) hero.textContent = current;
  if (about) about.textContent = current;
}

function updateRenderAvailable(info, ready = false) {
  updateInfo = info;
  updateDownloaded = Boolean(ready);
  const card = updateEl('update-card');
  const install = updateEl('btn-update-install');
  const check = updateEl('btn-update-check');
  const later = updateEl('btn-update-later');
  if (!card || !install) return;

  card.classList.remove('hidden');
  updateHideProgress();
  updateEl('update-pending')?.classList.add('hidden');
  updateSetVersionLabels(info.currentVersion);

  const versionEl = updateEl('update-version');
  if (versionEl) versionEl.textContent = `v${info.latestVersion}`;
  const meta = updateEl('update-meta');
  if (meta) {
    const parts = [];
    const date = updateFormatDate(info.publishedAt);
    if (date) parts.push(`Udgivet ${date}`);
    if (info.size) parts.push(updateFormatBytes(info.size));
    if (info.releasesBehind > 1) parts.push(`${info.releasesBehind} versioner nyere`);
    else if (info.releasesBehind === 1) parts.push('1 version nyere');
    meta.textContent = parts.join(' · ');
  }

  updateFillChanges(updateEl('update-changes'), info.changes);
  const note = updateEl('update-mode-note');
  if (note) note.textContent = updateModeText(info);

  if (!info.checksumUrl) {
    install.classList.add('hidden');
    if (check) check.classList.remove('hidden');
    updateSetStatus(
      'Releasen mangler en SHA-256-kontrolsum. Af sikkerhedshensyn installeres den ikke automatisk — brug GitHub-linket.',
      'warn',
    );
    return;
  }

  install.classList.remove('hidden');
  install.textContent = ready ? 'Installer og genstart' : 'Download og installer';
  install.disabled = false;
  if (check) {
    check.classList.toggle('hidden', ready);
    check.textContent = ready ? 'Søg efter opdatering' : 'Søg igen';
  }
  if (later) later.textContent = 'Luk';
  updateSetStatus(
    ready
      ? `v${info.latestVersion} er hentet og SHA-256-verificeret. Klar til at installere.`
      : `Der er en ny version klar: v${info.latestVersion}.`,
    'ok',
  );
}

function updateRenderCurrent(info) {
  updateInfo = info;
  updateDownloaded = false;
  updateHideProgress();
  updateEl('update-card')?.classList.add('hidden');
  updateEl('update-pending')?.classList.add('hidden');
  const install = updateEl('btn-update-install');
  const check = updateEl('btn-update-check');
  if (install) install.classList.add('hidden');
  if (check) {
    check.classList.remove('hidden');
    check.textContent = 'Søg igen';
  }
  updateSetVersionLabels(info.currentVersion);
  updateSetStatus(`Du kører den nyeste version (v${info.latestVersion}).`, 'ok');
}

function updateShowError(message) {
  updateHideProgress();
  updateEl('update-card')?.classList.add('hidden');
  updateSetStatus(message || 'Opdateringen kunne ikke gennemføres.', 'err');
  const check = updateEl('btn-update-check');
  const install = updateEl('btn-update-install');
  if (check) {
    check.classList.remove('hidden');
    check.textContent = 'Prøv igen';
  }
  if (install) install.classList.add('hidden');
}

function closeUpdateDialog() {
  updateEl('update-overlay')?.classList.add('hidden');
}

async function refreshUpdateVersion() {
  try {
    const paths = await window.lennart.getPaths();
    window.__lennartVersion = paths.version;
    updateSetVersionLabels(paths.version);
    const about = updateEl('about-update-status');
    if (about) about.textContent = `Du kører v${paths.version}.`;
  } catch { /* keep the placeholder */ }
}

async function runUpdateCheck() {
  if (updateBusy) return;
  updateSetBusy(true);
  updateDownloaded = false;
  updateHideProgress();
  updateEl('update-card')?.classList.add('hidden');
  updateEl('update-pending')?.classList.add('hidden');
  updateEl('btn-update-install')?.classList.add('hidden');
  const check = updateEl('btn-update-check');
  if (check) {
    check.classList.remove('hidden');
    check.textContent = 'Tjekker…';
  }
  updateSetStatus('Tjekker GitHub for nye versioner…');

  try {
    const result = await window.lennart.checkForUpdates();
    if (!result || !result.ok) {
      updateShowError((result && result.error) || 'Kunne ikke tjekke for opdateringer.');
      return;
    }
    updateInfo = result;
    if (!result.updateAvailable) {
      updateRenderCurrent(result);
      return;
    }
    const status = await window.lennart.updateStatus();
    updateRenderAvailable(result, status.phase === 'ready' && status.downloaded);
  } catch (err) {
    updateShowError(`Kunne ikke tjekke for opdateringer: ${err.message || err}`);
  } finally {
    updateSetBusy(false);
  }
}

async function installDownloadedUpdate() {
  const install = updateEl('btn-update-install');
  const check = updateEl('btn-update-check');
  const later = updateEl('btn-update-later');
  updateSetBusy(true);
  if (install) {
    install.classList.remove('hidden');
    install.textContent = 'Installerer…';
    install.disabled = true;
  }
  if (check) check.classList.add('hidden');
  if (later) later.disabled = true;
  updateSetStatus('Installerer… appen lukker, og den nye version åbner automatisk.', 'ok');
  const label = updateEl('update-progress-label');
  const percent = updateEl('update-progress-percent');
  const bar = updateEl('update-bar');
  if (label) label.textContent = 'Installerer…';
  if (percent) percent.textContent = '100 %';
  if (bar) bar.style.width = '100%';

  try {
    const result = await window.lennart.installUpdate();
    if (!result || !result.ok) {
      updateSetBusy(false);
      if (later) later.disabled = false;
      if (install) {
        install.disabled = false;
        install.textContent = 'Prøv igen';
      }
      updateSetStatus((result && result.error) || 'Installationen kunne ikke starte.', 'err');
      return;
    }
    if (install) install.textContent = 'Genstarter…';
    updateSetStatus('Genstarter med den nye version…', 'ok');
  } catch (err) {
    updateSetBusy(false);
    if (later) later.disabled = false;
    if (install) {
      install.disabled = false;
      install.textContent = 'Prøv igen';
    }
    updateSetStatus(`Installationen fejlede: ${err.message || err}`, 'err');
  }
}

async function startUpdateInstall() {
  if (!updateInfo || updateBusy) return;
  if (updateDownloaded) {
    await installDownloadedUpdate();
    return;
  }

  const install = updateEl('btn-update-install');
  const check = updateEl('btn-update-check');
  updateSetBusy(true);
  if (install) {
    install.classList.remove('hidden');
    install.textContent = 'Downloader…';
    install.disabled = true;
  }
  if (check) check.classList.add('hidden');
  updateSetStatus(`Henter v${updateInfo.latestVersion} fra GitHub…`);
  updateShowProgress({ received: 0, total: updateInfo.size || 0, percent: 0 });

  try {
    const result = await window.lennart.downloadUpdate();
    if (!result || !result.ok) {
      updateSetBusy(false);
      if (install) {
        install.disabled = false;
        install.textContent = 'Prøv igen';
      }
      if (check) {
        check.classList.remove('hidden');
        check.textContent = 'Prøv igen';
      }
      updateSetStatus((result && result.error) || 'Downloadet kunne ikke gennemføres.', 'err');
      return;
    }
    updateDownloaded = true;
    updateShowProgress({ received: result.size, total: result.size, percent: 100 });
    const note = updateEl('update-progress-note');
    if (note) {
      note.textContent = `SHA-256 ✓ ${updateFormatBytes(result.size)} · filen er kontrolleret og klar`;
    }
    await installDownloadedUpdate();
  } catch (err) {
    updateSetBusy(false);
    if (install) {
      install.disabled = false;
      install.textContent = 'Prøv igen';
    }
    updateSetStatus(`Downloadet fejlede: ${err.message || err}`, 'err');
  }
}

async function applyUpdateStatus(status) {
  if (!status) return;
  if (status.info) updateInfo = status.info;
  if (status.currentVersion) updateSetVersionLabels(status.currentVersion);
  if (status.phase === 'downloading') {
    if (status.info) updateRenderAvailable(status.info, false);
    updateSetBusy(true);
    const install = updateEl('btn-update-install');
    if (install) {
      install.classList.remove('hidden');
      install.textContent = 'Downloader…';
      install.disabled = true;
    }
    updateShowProgress(status.progress || updateLastProgress || { received: 0, total: 0, percent: 0 });
    updateSetStatus(`Henter v${(status.info && status.info.latestVersion) || ''}…`);
    return;
  }
  if (status.phase === 'ready' && status.info) {
    updateRenderAvailable(status.info, true);
    if (status.progress) updateShowProgress({ ...status.progress, percent: 100 });
    return;
  }
  if (status.phase === 'installing') {
    updateSetBusy(true);
    updateSetStatus('Installerer… appen lukker om et øjeblik.', 'ok');
    return;
  }
  if (status.phase === 'error' && status.error) {
    updateShowError(status.error);
    return;
  }
  if (status.info && status.info.updateAvailable) {
    updateRenderAvailable(status.info, false);
  } else if (status.info && status.phase === 'current') {
    updateRenderCurrent(status.info);
  }
}

function showPendingUpdate(pending) {
  if (!pending) return;
  updatePendingShown = true;
  updateInfo = {
    releaseUrl: pending.releaseUrl || '',
    currentVersion: pending.to,
    latestVersion: pending.to,
  };
  updateSetVersionLabels(pending.to);
  const title = updateEl('update-title');
  if (title) title.textContent = 'Opdatering gennemført';
  updateEl('update-overlay')?.classList.remove('hidden');
  updateEl('update-card')?.classList.add('hidden');
  updateHideProgress();
  updateEl('update-pending')?.classList.remove('hidden');

  const meta = updateEl('update-pending-meta');
  if (meta) {
    const from = pending.from ? `v${String(pending.from).replace(/^v/i, '')}` : '';
    const to = pending.to ? `v${String(pending.to).replace(/^v/i, '')}` : '';
    meta.textContent = from && to
      ? `Du gik fra ${from} til ${to}. Her er, hvad der er nyt.`
      : 'Den nye version er installeret. Her er, hvad der er nyt.';
  }
  updateFillChanges(updateEl('update-pending-changes'), pending.changes);
  updateSetStatus('Den nye version kører nu. Opdateringen blev kontrolleret med SHA-256.', 'ok');

  const check = updateEl('btn-update-check');
  const install = updateEl('btn-update-install');
  const later = updateEl('btn-update-later');
  if (check) check.classList.add('hidden');
  if (install) install.classList.add('hidden');
  if (later) later.textContent = 'Fortsæt';
}

async function maybeShowPendingUpdate() {
  if (updatePendingShown) return;
  if (!updateEl('update-overlay')?.classList.contains('hidden')) return;
  try {
    const pending = await window.lennart.pendingUpdate();
    if (pending) showPendingUpdate(pending);
  } catch { /* the notice is optional */ }
}

async function openUpdateDialog(autoCheck = true) {
  const overlay = updateEl('update-overlay');
  if (!overlay) return;
  updatePendingShown = false;
  overlay.classList.remove('hidden');
  const title = updateEl('update-title');
  if (title) title.textContent = 'Opdatering';
  updateEl('update-pending')?.classList.add('hidden');
  updateEl('update-card')?.classList.add('hidden');
  updateHideProgress();
  updateEl('btn-update-install')?.classList.add('hidden');
  const check = updateEl('btn-update-check');
  if (check) {
    check.classList.remove('hidden');
    check.disabled = false;
    check.textContent = 'Søg efter opdatering';
  }
  const install = updateEl('btn-update-install');
  if (install) {
    install.disabled = false;
    install.textContent = 'Download og installer';
  }
  const later = updateEl('btn-update-later');
  if (later) {
    later.disabled = false;
    later.textContent = 'Luk';
  }
  updateSetStatus('Tjek GitHub for at se, om der er en ny version.');
  await refreshUpdateVersion();

  const status = await window.lennart.updateStatus().catch(() => null);
  if (status && (status.phase === 'downloading' || status.phase === 'ready' || status.phase === 'installing')) {
    updateSetBusy(false);
    await applyUpdateStatus(status);
    return;
  }
  if (autoCheck) runUpdateCheck();
}

function initUpdateUI() {
  if (updateWired) return;
  updateWired = true;

  updateEl('btn-close-update')?.addEventListener('click', closeUpdateDialog);
  updateEl('btn-update-check')?.addEventListener('click', runUpdateCheck);
  updateEl('btn-update-install')?.addEventListener('click', startUpdateInstall);
  updateEl('btn-update-later')?.addEventListener('click', closeUpdateDialog);
  updateEl('update-overlay')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'update-overlay') closeUpdateDialog();
  });
  updateEl('btn-update-github')?.addEventListener('click', () => {
    const url = (updateInfo && updateInfo.releaseUrl)
      || 'https://github.com/h4xtor/Lennart-Terminal/releases/latest';
    window.lennart.openExternal(url);
  });

  window.lennart.onUpdateProgress((progress) => {
    if (!progress) return;
    updateLastProgress = progress;
    if (!updateEl('update-overlay')?.classList.contains('hidden')) {
      updateShowProgress(progress);
      if (progress.percent != null && progress.percent < 100) {
        updateSetStatus(`Henter v${(updateInfo && updateInfo.latestVersion) || ''}…`);
      }
    }
  });

  refreshUpdateVersion();
  setTimeout(() => { maybeShowPendingUpdate(); }, 900);
}
