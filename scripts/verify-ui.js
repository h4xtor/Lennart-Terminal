'use strict';

/**
 * UI verification for Lennart Terminal (v0.2.0).
 *
 * Starts are done externally: launch electron with --remote-debugging-port,
 * then run:  node scripts/verify-ui.js [port]
 *
 * Verifies from inside the real renderer:
 *   1. quick troubleshooting buttons exist (8) and are wired
 *   2. AI header label shows the embedded offline model
 *   3. version row matches package.json (v0.2.0)
 *   4. settings provider = lennart-local (offline AI)
 *   5. a REAL chat round-trip through window.lennart.chat succeeds
 *      (this exercises main-process resolveLocalProvider -> localAI -> ai.chat)
 *   6. no console errors / uncaught exceptions during the run
 *   7. the chat answer was recorded in the permanent history
 */

const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9222);
const HISTORY = path.join(__dirname, '..', 'Data', 'history.jsonl');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`PASS ${msg}`);
}

async function main() {
  // ---- locate the page target ----
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on CDP port ' + PORT);

  // ---- minimal CDP client (Node >= 22 has global WebSocket) ----
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const problems = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value || a.description || '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.text} ${d.exception ? d.exception.description || '' : ''}`);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`evaluate failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : ''}`);
    }
    return r.result.value;
  };

  await send('Runtime.enable');

  // ---- 1. the 20 network quick buttons ----
  const quickCount = await evaluate(`document.querySelectorAll('.quick-btn').length`);
  assert(quickCount === 20, `20 network quick buttons in sidebar (got ${quickCount})`);

  const firstQuick = await evaluate(`(document.querySelector('.quick-btn') || {}).title || ''`);
  assert(firstQuick.length > 0, `quick button carries its command as tooltip (${firstQuick})`);

  // ---- 1b. top menubar dropdowns (10 menus incl. Setup, 180+ commands, alphabetical) ----
  const menuCount = await evaluate(`document.querySelectorAll('#menubar .menu').length`);
  assert(menuCount >= 10, `menubar has 10 command dropdowns incl. Setup (got ${menuCount})`);
  const itemCount = await evaluate(`document.querySelectorAll('#menubar .menu-item').length`);
  assert(itemCount >= 180, `menubar exposes 180+ commands (got ${itemCount})`);
  const menuHasCmd = await evaluate(`
    [...document.querySelectorAll('#menubar .menu-item')].filter(b => (b.title || '').length > 0).length
  `);
  assert(menuHasCmd >= 40, `menu items show their command as tooltip (${menuHasCmd})`);

  const firstMenu = await evaluate(`(document.querySelector('#menubar .menu .menu-btn') || {}).textContent || ''`);
  assert(firstMenu.trim() === 'Setup', `Setup is the first menubar menu ("${firstMenu.trim()}")`);
  const sortedMenus = await evaluate(`
    [...document.querySelectorAll('#menubar .menu')].every((m) => {
      const strip = (t) => t.replace(/\s*· kræver administrator\s*/g, '').trim();
      const labels = [...m.querySelectorAll('.menu-item')].map((b) => strip(b.textContent));
      const s = [...labels].sort((a, b) => a.localeCompare(b, 'da'));
      return labels.every((v, i) => v === s[i]);
    })
  `);
  assert(sortedMenus === true, 'every menubar menu is sorted alphabetically');

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const versionTag = await evaluate(`(document.getElementById('version-tag') || {}).textContent || ''`);
  assert(versionTag === `v${pkg.version}`, `version tag sits at the far right of the menubar (${versionTag})`);

  // ---- 1c. quick connect to a LAN host ----
  const quickIp = await evaluate(`!!document.getElementById('quick-host-ip') && !!document.getElementById('btn-quick-connect')`);
  assert(quickIp === true, 'sidebar quick-connect (IP input + Forbind button) exists');
  // The remote-support guidance lives in a hover-only ⓘ (no scrolling UI)
  const infoDot = await evaluate(`
    (() => {
      const dots = [...document.querySelectorAll('.info-dot')];
      const d = dots.find((x) => /SSH/i.test(x.title));
      return d ? d.title : '';
    })()
  `);
  assert(/SSH/i.test(infoDot) && /WinRM/i.test(infoDot),
    'remote guidance sits in a hover ⓘ (SSH + WinRM)');

  // No scrolling in the main app: the sidebar must fit the viewport
  const sidebarFits = await evaluate(`(() => {
      const s = document.getElementById('sidebar');
      return { scroll: s.scrollHeight, client: s.clientHeight };
    })()`);
  assert(sidebarFits.scroll <= sidebarFits.client + 2,
    `sidebar fits without scrolling (${sidebarFits.scroll} <= ${sidebarFits.client})`);

  // Dedicated Fjernsupport menubar menu with the remote functions
  const remoteMenu = await evaluate(`
    (() => {
      const btns = [...document.querySelectorAll('#menubar .menu-btn')];
      const b = btns.find((x) => x.textContent.includes('Fjernsupport'));
      if (!b) return '';
      const items = [...b.parentElement.querySelectorAll('.menu-item')].map((i) => i.textContent);
      return JSON.stringify(items);
    })()
  `);
  const remoteItems = remoteMenu ? JSON.parse(remoteMenu) : [];
  assert(remoteItems.length >= 16, `Fjernsupport top menu exists (${remoteItems.length} items)`);
  assert(remoteItems.some((t) => t.includes('Forbind til IP')) &&
         remoteItems.some((t) => t.includes('SSH setup')) &&
         remoteItems.some((t) => t.includes('Tilføj vært')),
    'Fjernsupport menu contains the remote functions (quick-connect, SSH setup, add host)');

  // ---- 1f. administrator: elevation state, per-command labels, AI status ----
  const elev = JSON.parse(await evaluate(`window.lennart.elevation().then((e) => JSON.stringify(e))`, true));
  assert(typeof elev.admin === 'boolean', `elevation is reported (${JSON.stringify(elev)})`);

  // eslint-disable-next-line global-require
  const { COMMAND_MENUS, requiresAdmin } = require('../src/renderer/js/commands');
  const expectedAdminLabels = elev.admin
    ? 0
    : COMMAND_MENUS.reduce((n, m) => n + m.items.filter((i) => i.cmd && requiresAdmin(i.cmd)).length, 0);
  const shownLabels = await evaluate(`document.querySelectorAll('#menubar .admin-need').length`);
  assert(shownLabels === expectedAdminLabels,
    `admin labels next to every admin-requiring command (${shownLabels} shown, ${expectedAdminLabels} expected)`);
  if (!elev.admin) {
    assert(shownLabels >= 3, `non-admin session shows “kræver administrator” (${shownLabels} items)`);
    const elevRow = await evaluate(`!document.getElementById('elev-row').classList.contains('hidden')`);
    assert(elevRow === true, 'sidebar warns that the app runs without administrator');
  }

  // AI status must read Online/Offline (real reachability, incl. Ollama)
  const statusDeadline = Date.now() + 60000;
  let aiStatus = '';
  for (;;) {
    aiStatus = await evaluate(`document.getElementById('ai-status-text').textContent`);
    if (/^AI: (Online|Offline)/.test(aiStatus)) break;
    if (Date.now() > statusDeadline) throw new Error(`AI status never showed Online/Offline: "${aiStatus}"`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const settingsNow = await evaluate(`window.lennart.getSettings()`, true);
  assert(settingsNow.ai.provider === 'lennart-local' ? /Online/.test(aiStatus) : true,
    `AI status reads Online/Offline ("${aiStatus}")`);

  // Terminal bottom must never be covered by the prompt box
  const layout = JSON.parse(await evaluate(`JSON.stringify((() => {
      const sc = document.querySelector('.xterm-screen').getBoundingClientRect();
      const pb = document.getElementById('prompt-box').getBoundingClientRect();
      return { screenBottom: Math.round(sc.bottom), promptTop: Math.round(pb.top) };
    })())`));
  assert(layout.screenBottom <= layout.promptTop + 1,
    `prompt box does not cover the terminal (screen ${layout.screenBottom} <= prompt ${layout.promptTop})`);

  // Prompt placeholder keeps its original (muted) colour — only the
  // menubar Setup entry is red.
  const ph = JSON.parse(await evaluate(`JSON.stringify((() => {
      const el = document.getElementById('prompt-input');
      if (el.value) { el.value = ''; el.dispatchEvent(new Event('input')); }
      return { color: getComputedStyle(el, '::placeholder').color,
               hint: (document.getElementById('prompt-hint') || {}).textContent || '',
               hintVisible: !!(document.getElementById('prompt-hint') &&
                 !document.getElementById('prompt-hint').classList.contains('hidden')),
               hintColor: (() => { const b = document.querySelector('#prompt-hint b');
                 return b ? getComputedStyle(b).color : ''; })() };
    })())`));
  const reddish = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return !!(m && Number(m[1]) > 200 && Number(m[2]) < 170 && Number(m[3]) < 170); };
  assert(!reddish(ph.color), `prompt placeholder is NOT red — back to the original colour (${ph.color})`);
  assert(ph.hint.includes('Ask AI (Ctrl+Enter)') && ph.hint.includes('or type a command'),
    `bottom hint names the AI shortcut + command hint ("${ph.hint}")`);
  assert(ph.hintVisible === true, 'bottom hint is visible while the prompt box is empty');
  assert(ph.hintColor === 'rgb(124, 108, 255)', `“Ask AI (Ctrl+Enter)” is lit in the accent colour (${ph.hintColor})`);

  // ---- 1d. "Hent modeller" for local models ----
  const fetchBtn = await evaluate(`(document.getElementById('btn-refresh-models') || {}).textContent || ''`);
  assert(fetchBtn.includes('Hent modeller'), `settings has a "Hent modeller" button ("${fetchBtn}")`);
  const localModels = await evaluate(`window.lennart.localaiListModels()`, true);
  assert(localModels && Array.isArray(localModels.models) && localModels.models.length >= 1,
    `local model list returns the models on disk (${localModels && localModels.models.length})`);
  assert(Array.isArray(localModels.catalog) && localModels.catalog.length >= 2,
    `model catalogue offers downloadable models (${localModels && localModels.catalog.length})`);

  // ---- 1e. Setup button, model manager panel, copy button ----
  const setupBtnGone = await evaluate(`!document.getElementById('btn-open-setup')`);
  assert(setupBtnGone === true, 'sidebar Setup button has been removed (lives in the menubar only)');

  const menuSetupBtn = await evaluate(`!!document.querySelector('#menubar .menu-setup .menu-btn')`);
  assert(menuSetupBtn === true, 'menubar has the Setup menu entry');
  const menuSetupColor = await evaluate(`(() => {
      const b = document.querySelector('#menubar .menu-setup .menu-btn');
      return b ? getComputedStyle(b).color : '';
    })()`);
  const mr = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(menuSetupColor);
  assert(mr && Number(mr[1]) > 200 && Number(mr[2]) < 170 && Number(mr[3]) < 170,
    `menubar Setup entry is red text (${menuSetupColor})`);

  // Shells that are not installed on this machine must be disabled
  const gate = JSON.parse(await evaluate(`window.lennart.shellStatus().then((s) => JSON.stringify(s))`, true));
  const gateOk = await evaluate(`(function (shells) {
      return [...document.querySelectorAll('.shell-btn')].every((b) => shells[b.dataset.shell] !== false || b.disabled);
    })(${JSON.stringify(gate)})`);
  assert(gateOk === true, `shells that are not installed are disabled in the sidebar (${JSON.stringify(gate)})`);
  // Windows PowerShell exists on every Windows box (System32\WindowsPowerShell\v1.0)
  // — it must never be greyed out, it is the default shell.
  assert(gate.powershell === true, `Windows PowerShell is detected as available (${JSON.stringify(gate)})`);

  await evaluate(`document.getElementById('btn-refresh-models').click(); true`);
  await new Promise((r) => setTimeout(r, 700));
  const panel = JSON.parse(await evaluate(`JSON.stringify({
      open: !document.getElementById('model-panel').classList.contains('hidden'),
      rows: document.querySelectorAll('#model-panel-list .mp-row').length,
      dl: document.querySelectorAll('#model-panel-list .mp-dl').length,
    })`));
  assert(panel.open === true, '“Hent modeller” opens the model manager panel');
  assert(panel.rows >= 3 && panel.dl >= 1,
    `panel lists models + per-model download buttons (rows ${panel.rows}, download buttons ${panel.dl})`);
  await evaluate(`document.getElementById('btn-refresh-models').click(); true`); // close again
  await new Promise((r) => setTimeout(r, 200));

  const copyBtn = await evaluate(`!!document.getElementById('btn-copy-term') && typeof copyTermSelection === 'function'`);
  assert(copyBtn === true, 'terminal has a copy button + copy helper (Ctrl+Shift+C / højreklik)');

  // ---- 2. AI header label ----
  const label = await evaluate(`document.getElementById('ai-model-label').textContent`);
  assert(label.includes('Indbygget'), `AI header shows embedded model ("${label}")`);
  const selectedModel = await evaluate(`(window.__lennartSettings && window.__lennartSettings.ai && window.__lennartSettings.ai.model) || ''`);
  assert(
    selectedModel ? label.includes(selectedModel) : label.includes('hardcoded model'),
    `AI header shows the selected model ("${label}" vs "${selectedModel || 'hardcoded model'}")`,
  );

  // The suggestion chips in the AI pane must be Danish
  const sugg = JSON.parse(await evaluate(`JSON.stringify(
      [...document.querySelectorAll('#ai-suggestions .suggestion')].map((b) => b.textContent.trim()))`));
  assert(sugg.length >= 3, `AI pane shows suggestion chips (${sugg.length})`);
  assert(sugg.every((s) => /^(Forklar|Skriv|Hvordan|Hvad|Hvorfor|Vis|Hjælp|Gør)/.test(s)),
    `AI suggestions are in Danish (${JSON.stringify(sugg.slice(0, 2))})`);
  assert(!sugg.some((s) => /^(Explain|How|Why|What|Write|Can)\b/.test(s)),
    'no English suggestion chips');

  // ---- 3. brand sign bottom-left + colour/model settings present ----
  const brand = await evaluate(`(document.getElementById('brand-row') || {}).textContent || ''`);
  assert(brand.trim() === 'Lennart Terminal', `brand sign at the bottom-left ("${brand.trim()}")`);

  const extras = await evaluate(`JSON.stringify({
      accent: !!document.getElementById('set-accent'),
      theme: !!document.getElementById('set-theme'),
      ctx: !!document.getElementById('set-ctx'),
      maxTokens: !!document.getElementById('set-maxtokens'),
      autorun: !!document.getElementById('set-autorun'),
      nav: document.querySelectorAll('#set-nav button').length,
      accentValue: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    })`);
  const ex = JSON.parse(extras);
  assert(ex.accent && ex.theme && ex.ctx && ex.maxTokens && ex.autorun,
    'settings expose colour + model options (accent, theme, ctx, max tokens, auto-run)');
  assert(ex.nav >= 6, `settings dialog has section nav chips (${ex.nav})`);
  assert(/^#[0-9a-f]{6}$/i.test(ex.accentValue), `theme accent is applied ("${ex.accentValue}")`);

  // ---- 4. settings provider ----
  const settings = await evaluate(`window.lennart.getSettings()`, true);
  assert(settings.ai && settings.ai.provider === 'lennart-local', `provider is lennart-local (${settings.ai && settings.ai.provider})`);

  // ---- 5. real chat round-trip through the app's own bridge ----
  const historyBefore = fs.existsSync(HISTORY)
    ? fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).length
    : 0;

  const answer = await evaluate(`
    new Promise((resolve, reject) => {
      const id = 'verify-' + Date.now();
      let buf = '';
      const timer = setTimeout(() => reject(new Error('chat timeout (120s)')), 120000);
      window.lennart.onChatChunk(({ id: cid, token }) => { if (cid === id) buf += token; });
      window.lennart.onChatDone(({ id: cid }) => { if (cid === id) { clearTimeout(timer); resolve(buf); } });
      window.lennart.onChatError(({ id: cid, error }) => { if (cid === id) { clearTimeout(timer); reject(new Error(error)); } });
      window.lennart.chat({
        id,
        messages: [{ role: 'user', content: 'Give ONE PowerShell command that lists listening TCP ports. Only the command, no prose.' }],
        agentMode: false,
      });
    })
  `, true);

  assert(typeof answer === 'string' && answer.length > 10, `chat answered (${answer.slice(0, 80).replace(/\\n/g, ' ')}...)`);
  assert(/get-nettcpconnection|get-nettcpendpoint|netstat|get-netudpendpoint/i.test(answer), `answer contains a listening-port command`);

  // ---- 5b. clicking a menubar command runs it in the active tab ----
  await evaluate(`
    window.__runSpy = [];
    (function () {
      const t = activeTab();
      const orig = t.runCommand.bind(t);
      t.runCommand = (c) => { window.__runSpy.push(String(c)); return orig(c); };
    })();
    true
  `);
  await evaluate(`
    (function () {
      const items = [...document.querySelectorAll('#menubar .menu-item')];
      const target = items.find((b) => b.textContent === 'Hostname');
      if (!target) throw new Error('menu item "Hostname" not found');
      target.click();
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));
  const menuRuns = await evaluate(`window.__runSpy.length`);
  assert(menuRuns >= 1, `menubar item click ran a command in the active tab (${menuRuns} call(s))`);
  const menuRunCmd = await evaluate(`window.__runSpy[window.__runSpy.length - 1] || ''`);
  assert(/^hostname$/i.test(menuRunCmd), `menu ran the expected command ("${menuRunCmd}")`);

  // ---- 5c. quick-connect: unknown IP opens the add-host dialog prefilled ----
  await evaluate(`
    document.getElementById('quick-host-ip').value = '10.20.30.40';
    document.getElementById('btn-quick-connect').click();
    true
  `);
  await new Promise((r) => setTimeout(r, 600));
  const dialogState = await evaluate(`
    JSON.stringify({
      open: !document.getElementById('host-overlay').classList.contains('hidden'),
      addr: document.getElementById('host-addr').value,
    })
  `);
  const parsed = JSON.parse(dialogState);
  assert(parsed.open === true, 'quick-connect opens the add-host dialog for an unknown IP');
  assert(parsed.addr === '10.20.30.40', `dialog is prefilled with the typed IP (${parsed.addr})`);
  await evaluate(`document.getElementById('btn-host-cancel').click(); true`);
  await new Promise((r) => setTimeout(r, 200));

  // ---- 5d. settings: “Hent modeller" lists local models + catalogue ----
  await evaluate(`openSettings(); true`);
  await new Promise((r) => setTimeout(r, 700));
  await evaluate(`document.getElementById('btn-refresh-models').click(); true`);
  await new Promise((r) => setTimeout(r, 900));
  const modelPicker = await evaluate(`
    JSON.stringify({
      options: [...document.getElementById('set-model').options].map((o) => ({ v: o.value, t: o.textContent })),
      fetchHidden: document.getElementById('btn-fetch-model').hidden,
    })
  `);
  const picker = JSON.parse(modelPicker);
  assert(picker.options.length >= 2,
    `"Hent modeller" lists local models + downloadable ones (${picker.options.length} options)`);
  assert(picker.options.some((o) => o.v.startsWith('catalog:')),
    'model list offers at least one downloadable catalogue model');
  assert(picker.fetchHidden === true, '“Hent valgt" stays hidden while a local model is selected');
  await evaluate(`
    (function () {
      const sel = document.getElementById('set-model');
      const cat = [...sel.options].find((o) => o.value.startsWith('catalog:'));
      sel.value = cat.value;
      sel.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  const fetchShown = await evaluate(`!document.getElementById('btn-fetch-model').hidden`);
  assert(fetchShown === true, 'selecting a catalogue model reveals the “Hent valgt" button');
  await evaluate(`document.getElementById('set-model').selectedIndex = 0; closeSettings(); true`);
  await new Promise((r) => setTimeout(r, 300));

  // ---- 5e. auto-run helpers ("…og vil du udføre den for mig?") ----
  const helpers = await evaluate(`JSON.stringify({
    wants: userWantsExecution('Hvad er kommanden til at vise IP — og vil du udføre den for mig?'),
    wantsNo: userWantsExecution('Hvad er kommanden til at vise IP?'),
    cmd: extractRunCommand('Svar:' + String.fromCharCode(96, 96, 96) + 'powershell' + String.fromCharCode(10) + 'ipconfig /all' + String.fromCharCode(10) + String.fromCharCode(96, 96, 96)),
    noBlock: extractRunCommand('ingen kode her'),
  })`);
  const h = JSON.parse(helpers);
  assert(h.wants === true, 'userWantsExecution detects the Danish “udfør" request');
  assert(h.wantsNo === false, 'userWantsExecution ignores a plain question');
  assert(h.cmd === 'ipconfig /all', `extractRunCommand pulls the command block ("${h.cmd}")`);
  assert(h.noBlock === null, 'extractRunCommand returns null without a code block');

  // ---- 5f. REAL auto-run: ask the AI to run a command, watch the terminal ----
  await evaluate(`window.__runSpy = []; true`);
  const autoAnswer = await evaluate(`
    new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('auto-run chat timeout (120s)')); } }, 120000);
      window.lennart.onChatChunk(({ token }) => { if (!settled) buf += token; });
      window.lennart.onChatDone(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(buf); } });
      window.lennart.onChatError(({ error }) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(error)); } });
      aiState.messages.push({ role: 'user', content: 'Hvad er kommanden til at vise IP-konfigurationen — og vil du udføre den for mig?' });
      aiEls.input.value = '';
      startStream();
    })
  `, true);
  await new Promise((r) => setTimeout(r, 800));
  assert(typeof autoAnswer === 'string' && autoAnswer.length > 10,
    `auto-run chat answered (${String(autoAnswer).slice(0, 70).replace(/\\n/g, ' ')}...)`);
  assert(/```powershell/i.test(autoAnswer), 'answer contains a fenced PowerShell block');
  const autoRuns = await evaluate(`window.__runSpy.slice()`);
  assert(Array.isArray(autoRuns) && autoRuns.length >= 1,
    `AI executed the command in the terminal (${JSON.stringify(autoRuns)})`);
  assert(/ipconfig/i.test(autoRuns[0] || ''), `executed the expected command ("${autoRuns[0]}")`);
  const statusShown = await evaluate(`
    [...document.querySelectorAll('#ai-messages .status-msg')]
      .some((el) => /Kører i terminalen/.test(el.textContent))
  `);
  assert(statusShown === true, 'chat shows a “Kører i terminalen" status line');

  // ---- 5g. /help must answer locally, instantly and deterministically ----
  const assistantBefore = await evaluate(`document.querySelectorAll('#ai-messages .msg.assistant').length`);
  const helpStarted = Date.now();
  await evaluate(`
    (function () {
      const inp = document.getElementById('ai-input');
      inp.value = '/help';
      document.getElementById('ai-composer').requestSubmit();
      return true;
    })()
  `);
  const helpDeadline = Date.now() + 15000;
  let helpText = '';
  let helpMs = 0;
  for (;;) {
    const state = JSON.parse(await evaluate(`JSON.stringify({
        n: document.querySelectorAll('#ai-messages .msg.assistant').length,
        last: (document.querySelector('#ai-messages .msg.assistant:last-of-type') || {}).innerText || '',
        err: [...document.querySelectorAll('#ai-messages .msg.error')].some((e) => /AI error/.test(e.textContent)),
      })`));
    if (state.n > assistantBefore && state.last.trim().length > 40 && !state.err &&
        /(hvor du står|tjek først|genveje)/i.test(state.last)) {
      helpText = state.last;
      helpMs = Date.now() - helpStarted;
      break;
    }
    if (state.err) throw new Error('/help produced an AI error instead of help');
    if (Date.now() > helpDeadline) throw new Error(`/help timeout — last: ${state.last.slice(0, 140)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  assert(helpText.length > 40, `/help answered with contextual help (${helpText.slice(0, 70).replace(/\n/g, ' ')}...)`);
  // Local help carries the live shortcut list — a model answer never does.
  assert(helpText.includes('Ctrl+J') && helpText.includes('Tjek først') && helpText.includes('Hvor du står'),
    '/help is the deterministic local answer (shortcuts + checks, not a model guess)');
  assert(helpMs < 6000, `/help is instant — no model round-trip (${helpMs}ms)`);

  // ---- 5h. the terminal re-fits when the pane shrinks (no hidden bottom) ----
  // Poll until the layout settles (the refit is event-driven) and ALWAYS
  // clear the emulated viewport, even when the assertion fails — otherwise a
  // failure leaks the 1380×760 override into every later run.
  await send('Emulation.setDeviceMetricsOverride', { width: 1380, height: 760, deviceScaleFactor: 1, mobile: false });
  let shrunk = null;
  try {
    const shrinkDeadline = Date.now() + 8000;
    for (;;) {
      shrunk = JSON.parse(await evaluate(`JSON.stringify((() => {
          const sc = document.querySelector('.xterm-screen').getBoundingClientRect();
          const pb = document.getElementById('prompt-box').getBoundingClientRect();
          const tc = document.getElementById('terminal-container').getBoundingClientRect();
          return { screenBottom: Math.round(sc.bottom), promptTop: Math.round(pb.top),
                   containerBottom: Math.round(tc.bottom) };
        })())`));
      if (shrunk.screenBottom <= shrunk.promptTop + 1 && shrunk.screenBottom <= shrunk.containerBottom + 1) break;
      if (Date.now() > shrinkDeadline) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert(shrunk.screenBottom <= shrunk.promptTop + 1 && shrunk.screenBottom <= shrunk.containerBottom + 1,
      `terminal re-fits after the window shrinks (${shrunk.screenBottom} <= ${shrunk.promptTop})`);
  } finally {
    await send('Emulation.clearDeviceMetricsOverride', {});
    await new Promise((r) => setTimeout(r, 900));
  }

  // ---- 6. no console errors during the run ----
  await new Promise((r) => setTimeout(r, 1500));
  assert(problems.length === 0, `no console errors / exceptions (${problems.length ? problems.join(' | ') : 'clean'})`);

  // ---- 7. permanent history recorded the Q&A ----
  await new Promise((r) => setTimeout(r, 800));
  const historyAfter = fs.existsSync(HISTORY)
    ? fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).length
    : 0;
  assert(historyAfter > historyBefore, `history.jsonl grew (${historyBefore} -> ${historyAfter} lines)`);

  ws.close();
  console.log('UI VERIFY OK');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`UI VERIFY FAILED: ${err.message}`);
  process.exit(1);
});
