'use strict';

/**
 * AI panel v2: Chat mode (streaming chat, code-block actions) and Agent mode
 * (autopilot — the AI takes over a job and runs it in the live terminal,
 * streaming each command + output into the panel).
 */

const aiState = {
  messages: [],
  streaming: false,
  currentId: null,
  mode: 'chat',           // 'chat' | 'agent'
  agentRunning: false,
  agentId: null,
  agentEventsBeforeStart: [],
  agentStopRequested: false,
  stickToBottom: true,    // auto-scroll while the user is at the bottom
};

const aiEls = {};

function initAiPanel() {
  aiEls.pane = document.getElementById('ai-pane');
  aiEls.messages = document.getElementById('ai-messages');
  aiEls.suggestions = document.getElementById('ai-suggestions');
  aiEls.input = document.getElementById('ai-input');
  aiEls.form = document.getElementById('ai-composer');
  aiEls.sendBtn = document.getElementById('btn-ai-send');
  aiEls.stopBtn = document.getElementById('btn-ai-stop');
  aiEls.modelLabel = document.getElementById('ai-model-label');
  aiEls.chipChat = document.getElementById('chip-chat');
  aiEls.chipAgent = document.getElementById('chip-agent');

  aiEls.form.addEventListener('submit', onAiSubmit);
  aiEls.stopBtn.addEventListener('click', onStopClicked);

  // Enter = send, Shift+Enter = newline (ignored during IME composition)
  aiEls.input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      aiEls.form.requestSubmit();
    }
  });

  // Feltet vokser med teksten (op til ~6 linjer) — lange beskeder kan læses
  // uden at panelet bliver dækket, og feltet krymper igen når der tømmes.
  aiEls.input.addEventListener('input', autoGrowInput);

  // Stop auto-scrolling when the user scrolls up to read;
  // resume following the stream when they return to the bottom
  aiEls.messages.addEventListener('scroll', () => {
    aiState.stickToBottom = isNearBottom();
  });
  document.getElementById('btn-send-terminal').addEventListener('click', attachTerminalOutput);
  document.getElementById('btn-clear-chat').addEventListener('click', () => {
    aiState.messages = [];
    aiEls.messages.innerHTML = '';
    showSuggestions();
  });

  aiEls.chipChat.addEventListener('click', () => setMode('chat'));
  aiEls.chipAgent.addEventListener('click', () => setMode('agent'));

  window.lennart.onChatChunk(({ id, token }) => {
    if (id !== aiState.currentId) return;
    aiState.assistantBuf = (aiState.assistantBuf || '') + token;
    renderStreaming();
  });
  window.lennart.onChatDone((payload) => {
    if (payload && payload.id === aiState.currentId) finishStreaming(payload);
  });
  window.lennart.onChatError(({ id, error }) => {
    if (id === aiState.currentId) failStreaming(error);
  });

  window.lennart.onAgentEvent(({ id, event }) => {
    if (aiState.agentRunning && !aiState.agentId) {
      aiState.agentEventsBeforeStart.push({ id, event });
      return;
    }
    if (id === aiState.agentId) renderAgentEvent(event);
  });

  setMode('chat');
  showSuggestions();
}

function setMode(mode) {
  aiState.mode = mode;
  aiEls.chipChat.classList.toggle('active', mode === 'chat');
  aiEls.chipAgent.classList.toggle('active', mode === 'agent');
  aiEls.input.placeholder = mode === 'agent'
    ? 'Beskriv et job — agenten overtager styringen og kører det i terminalen… (Enter = send)'
    : 'Spørg AI-en om noget… (Enter = send, Shift+Enter = nyt linjeskift)';

  if (mode === 'agent' && !aiState.agentRunning) {
    aiEls.suggestions.innerHTML = '';
    const jobs = [
      'Find ud af hvorfor port 3000 er optaget, og dræb processen',
      'Opret et nyt git repo her med en fin .gitignore for Node',
      'Tjek diskplads på alle drev og ryd temp-mapper',
      'Opdatér alle npm-pakker i dette projekt sikkert',
    ];
    for (const job of jobs) {
      const b = document.createElement('button');
      b.className = 'suggestion';
      b.textContent = job;
      b.addEventListener('click', () => { aiEls.input.value = job; aiEls.input.focus(); });
      aiEls.suggestions.appendChild(b);
    }
  } else if (mode === 'chat') {
    showSuggestions();
  }
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

function onAiSubmit(e) {
  e.preventDefault();
  const text = aiEls.input.value.trim();
  if (!text) return;

  // The user just asked something — always follow the answer
  aiState.stickToBottom = true;

  // /help — answer locally and instantly. The embedded model is far too small
  // to diagnose reliably (it happily invents “Sandsynlige årsager”), and a
  // help request must NEVER depend on a model being reachable.
  if (/^\/(help|hjælp|hjaelp)\b/i.test(text)) {
    showLocalHelp(text);
    return;
  }

  if (aiState.mode === 'agent') {
    startAgentJob(text);
  } else if (!aiState.streaming) {
    aiEls.input.value = '';
    autoGrowInput();
    aiState.messages.push({ role: 'user', content: text });
    appendMessageEl('user', text);
    startStream();
  }
}

/**
 * Hold composeren mellem 2 og 6 linjer: vokser med teksten, stopper ved
 * max-height (132px i CSS'en) hvorefter den ruller i stedet.
 */
function autoGrowInput() {
  const el = aiEls.input;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

// ---------------------------------------------------------------------------
// /help — context-aware help. The agent is told exactly where the person
// stands (active tab, remote host, recent output, provider state, shortcuts)
// and answers: 1) where you are, 2) likely causes, 3) concrete fixes.
// ---------------------------------------------------------------------------

async function buildHelpContext() {
  const tab = activeTab();
  const s = window.__lennartSettings || {};
  const lines = [];

  if (tab && tab.remote && tab.host) {
    lines.push(`Sted: fjern-fane → ${tab.host.name || tab.host.host} (${tab.host.method} · ${tab.host.host}) — kommandoer køres på fjernværten.`);
  } else if (tab) {
    lines.push(`Sted: lokal fane — shell: ${tab.shellName || tab.shell || 'PowerShell'}.`);
  } else {
    lines.push('Sted: ingen terminalfane er åben.');
  }

  const cwd = document.getElementById('cwd-label')?.textContent;
  if (cwd) lines.push(`Arbejdsmappe: ${cwd}`);

  const buf = String(tab?.outputBuf || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
  if (buf) {
    lines.push(`Seneste terminaloutput (rene linjer, sidste 700 tegn):\n${buf.slice(-700)}`);
  }

  lines.push(`AI: ${s.ai?.provider || '?'} · ${s.ai?.model || 'indbygget standardmodel'} · auto-udfør: ${s.aiAutoRun === false ? 'fra' : 'til'} · bekræftelse før ødelæggende: ${s.confirmDestructive === false ? 'fra' : 'til'}.`);
  lines.push('Appen: Lennart Terminal — 20 netværksknapper i sidebar, dropdown-menuer øverst (Opsætning først), quick-connect til LAN-IP (SSH eller WinRM), AI-chat til højre som kan udføre kommandoer, historik (Ctrl+H), fjernfaner der kører kommandoer på andre PC’er.');
  lines.push('Genveje: Ctrl+T ny fane · Ctrl+J AI-panel · Ctrl+H historik · Ctrl+, opsætning · Ctrl+Shift+C kopiér markering.');
  lines.push('Svar på dansk og struktureret: (1) hvor personen står, (2) 2-4 sandsynlige årsager, (3) konkrete løsninger — giv kommandoer i ```powershell-kodeblokke.');

  return lines.join('\n\n');
}

async function sendHelpRequest(text) {
  let ctx = '';
  try {
    ctx = await buildHelpContext();
  } catch { /* best effort */ }
  aiState.messages.push({ role: 'user', content: text });
  appendMessageEl('user', text);
  aiState.helpContext = [
    'Du er Lennart Terminals AI-assistent. Brugeren skrev "/help" i appen — det er IKKE et ønske om at køre PowerShell-kommandoen "help".',
    'Giv ikke kun én kommando: lever en fejlsøgningsdiagnose.',
    'Kontekst for hvor personen står:',
    ctx,
    '',
    'Svar på dansk med præcis denne struktur:',
    '**Hvor du står** — 1-2 linjer.',
    '**Sandsynlige årsager** — 2-4 punkter ud fra konteksten.',
    '**Løsninger** — konkrete trin; kommandoer i ```powershell-kodeblokke.',
  ].join('\n\n');
  aiState.pendingHelp = true;
  startStream();
}

/**
 * The deterministic /help answer: where the person stands, the shortcuts and
 * the checks that actually matter. Built from the LIVE context, so it is
 * always correct and always available — no model round-trip.
 */
async function localHelpMarkdown(err) {
  let ctx = '';
  try {
    ctx = await buildHelpContext();
  } catch { /* ignore */ }
  const where = ctx.split('\n\n').slice(0, 3).map((l) => `- ${l.replace(/\n/g, ' ')}`).join('\n');
  return [
    '### /help — Lennart Terminal',
    '',
    '**Hvor du står**',
    where || '- (kontekst ikke tilgængelig endnu)',
    '',
    '**Genveje**',
    '- `Ctrl+T` ny fane · `Ctrl+J` AI-panel · `Ctrl+H` historik · `Ctrl+,` Opsætning · `Ctrl+Shift+C` kopiér markering',
    '- I prompt-boksen nederst: `Enter` = kør kommandoen · `Ctrl+Enter` = spørg AI-en',
    '',
    '**Tjek først**',
    '1. Indbygget AI: `Get-Process llama-server` og `(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9601/health).Content` — starter den ikke, åbn **Opsætning → Hent modeller**.',
    '2. Internet: `ping 1.1.1.1 -n 4` — API-modeller kræver forbindelse; den indbyggede kører offline.',
    '3. Fjern-PC: `Test-NetConnection <IP> -Port 22` — slå SSH til på mål-PC’en via **Opsætning → “Slå SSH til”** (admin), eller WinRM med `Enable-PSRemoting -Force`.',
    '4. Kommandoer køres ikke? Se om fanen er en fjern-fane (navnet øverst) — der køres alt på fjernværten.',
    '',
    '**Brug af AI-en**',
    '- Skriv et spørgsmål i boksen her til højre; kodeblokke får knapperne **Kør**, **Indsæt** og **Kopiér**.',
    '- **Opsætning → Hent modeller** henter stærkere modeller (Qwen3 8B, Qwen2.5 Coder 7B, DeepSeek R1 7B) til den indbyggede AI.',
    '- Bed mig om en dybdegående diagnose via knappen herunder, hvis du vil have AI-en til at kigge på konteksten.',
    err ? `_(Fejl: ${err} — prøv igen senere.)_` : '',
  ].filter(Boolean).join('\n');
}

/** /help rendered straight into the chat (no streaming, no model). */
async function showLocalHelp(text) {
  const label = text || '/help';
  aiEls.input.value = '';
  autoGrowInput();
  if (aiState.streaming) return;
  aiState.messages.push({ role: 'user', content: label });
  appendMessageEl('user', label);
  const md = await localHelpMarkdown('');
  aiState.messages.push({ role: 'assistant', content: md });
  appendMessageEl('assistant', md);
  scrollBottom(true);
  offerAiDiagnosis();
}

/** One chip: let the model add a diagnosis on top of the local answer. */
function offerAiDiagnosis() {
  if (!aiEls.suggestions) return;
  aiEls.suggestions.innerHTML = '';
  const b = document.createElement('button');
  b.className = 'suggestion';
  b.textContent = '🤖 Bed AI-en om en dybdegående diagnose';
  b.title = 'Lader modellen kigge på konteksten (kræver at AI-en svarer)';
  b.addEventListener('click', () => {
    aiEls.suggestions.innerHTML = '';
    sendHelpRequest('Forklar mere: hvor står jeg lige nu, hvad er de mest sandsynlige årsager, og hvad er løsningerne?');
  });
  aiEls.suggestions.appendChild(b);
}

/** Stream-error fallback: the local answer with the error noted. */
async function showLocalHelpFallback(err) {
  appendMessageEl('assistant', await localHelpMarkdown(err));
}

function startAgentJob(job) {
  if (aiState.agentRunning) return;
  const tab = activeTab();
  if (!tab || !tab.sessionId) {
    appendMessageEl('error', 'Ingen aktiv terminal — agenten har brug for en fane at arbejde i.');
    return;
  }
  aiEls.input.value = '';
  aiState.agentRunning = true;
  aiState.agentEventsBeforeStart = [];
  aiState.agentStopRequested = false;
  aiEls.sendBtn.disabled = true;
  aiEls.stopBtn.hidden = false;
  aiEls.suggestions.innerHTML = '';

  appendMessageEl('user', `🎯 Job: ${job}`);

  window.lennart.agentStart({ sessionId: tab.sessionId, job }).then((res) => {
    if (!res.ok) {
      agentFinished();
      appendMessageEl('error', `Agent kunne ikke starte: ${res.error}`);
      return;
    }
    aiState.agentId = res.id;
    if (aiState.agentStopRequested) window.lennart.agentStop(res.id);
    const pending = aiState.agentEventsBeforeStart;
    aiState.agentEventsBeforeStart = [];
    for (const item of pending) {
      if (item.id === aiState.agentId) renderAgentEvent(item.event);
    }
  }).catch((err) => {
    agentFinished();
    appendMessageEl('error', `Agent kunne ikke starte: ${err.message || err}`);
  });
}

function renderAgentEvent(ev) {
  if (ev.type === 'status') {
    appendStatus(ev.text);
  } else if (ev.type === 'command') {
    const el = appendMessageEl('assistant', '');
    el.root.classList.add('agent-step');
    el.body.innerHTML = `
      <div class="step-head"><span class="step-badge">trin</span><span>${escapeHtml(ev.thought || 'Kører…')}</span></div>
      <pre data-code="${escapeHtml(ev.text)}"><code>${escapeHtml(ev.text)}</code></pre>`;
  } else if (ev.type === 'output') {
    const el = appendMessageEl('assistant', '');
    el.root.classList.add('agent-step');
    el.body.innerHTML = `
      <div class="step-head"><span class="step-badge">output</span></div>
      <pre><code>${escapeHtml(ev.text)}</code></pre>`;
  } else if (ev.type === 'error') {
    appendStatus(ev.text, true);
  } else if (ev.type === 'done') {
    agentFinished();
    if (ev.text) appendMessageEl('assistant', ev.text);
  } else if (ev.type === 'finished') {
    agentFinished();
  }
}

function agentFinished() {
  aiState.agentRunning = false;
  aiState.agentId = null;
  aiState.agentEventsBeforeStart = [];
  aiState.agentStopRequested = false;
  aiEls.sendBtn.disabled = false;
  aiEls.stopBtn.disabled = false;
  aiEls.stopBtn.hidden = true;
}

function onStopClicked() {
  if (aiState.agentRunning) {
    aiState.agentStopRequested = true;
    if (aiState.agentId) window.lennart.agentStop(aiState.agentId);
    aiEls.stopBtn.disabled = true;
    appendStatus('Stopper agenten. En kommando, der allerede kører, kan fortsætte i terminalen.');
  } else if (aiState.currentId) {
    window.lennart.cancelChat(aiState.currentId);
  }
}

// ---------------------------------------------------------------------------
// Chat flow
// ---------------------------------------------------------------------------

function startStream() {
  const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  aiState.currentId = id;
  aiState.streaming = true;
  aiState.assistantBuf = '';

  aiEls.sendBtn.disabled = true;
  aiEls.stopBtn.hidden = false;

  const streamEl = appendMessageEl('assistant', '');
  streamEl.body.classList.add('cursor-blink');
  aiState.streamEl = streamEl;

  const messages = aiState.messages.slice(-16);
  if (aiState.helpContext) {
    messages.unshift({ role: 'system', content: aiState.helpContext });
    aiState.helpContext = null;
    // “/help” is an app command, not a PowerShell request — rephrase for the
    // model so tiny models don't answer with the literal command "help".
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser && /^\/(help|hjælp|hjaelp)\b/i.test(String(lastUser.content).trim())) {
      lastUser.content = 'Jeg skrev /help i Lennart Terminal. Ud fra konteksten i denne samtale: hvor står jeg, hvad kan være galt, og hvad er løsningerne?';
    }
  }

  window.lennart.chat({
    id,
    agentMode: window.__lennartSettings?.agentMode !== false,
    messages,
  });
}

// The KØRER marker is an instruction to the app, not text for the reader
function visibleAnswer(text) {
  return String(text || '').replace(/^[ \t]*\**[ \t]*KØRER[ \t]*\**[ \t]*\.?[ \t]*$/gim, '');
}

// Re-rendering markdown on every token is O(n²) for long answers — batch
// the stream into one render per animation frame.
let streamRenderQueued = false;
function renderStreaming() {
  if (streamRenderQueued) return;
  streamRenderQueued = true;
  requestAnimationFrame(() => {
    streamRenderQueued = false;
    const el = aiState.streamEl;
    if (!el) return;
    el.body.innerHTML = markdownToHtml(visibleAnswer(aiState.assistantBuf));
    wireCodeBlockActions(el.body);
    scrollBottom();
  });
}

/**
 * payload (from main): { text, runRequested, stoppedLoop, truncated, aborted }
 * text is the CLEANED answer (repeats, leaked prompt text and the KØRER
 * marker removed) — it replaces the raw stream.
 */
function finishStreaming(payload) {
  if (!aiState.streaming) return;
  const p = payload || {};
  aiState.streaming = false;
  aiState.pendingHelp = false;
  aiEls.sendBtn.disabled = false;
  aiEls.stopBtn.hidden = true;

  const text = typeof p.text === 'string' ? p.text : visibleAnswer(aiState.assistantBuf || '').trim();
  aiState.assistantBuf = text;
  if (text) aiState.messages.push({ role: 'assistant', content: text });
  if (aiState.streamEl) {
    aiState.streamEl.body.classList.remove('cursor-blink');
    if (text) {
      aiState.streamEl.body.innerHTML = markdownToHtml(text);
      wireCodeBlockActions(aiState.streamEl.body);
    } else if (p.aborted) {
      aiState.streamEl.root.remove();
    } else {
      aiState.streamEl.body.textContent = '(intet svar — prøv at spørge igen)';
    }
  }
  aiState.streamEl = null;
  if (p.stoppedLoop) {
    appendStatus('Svaret blev stoppet, fordi modellen begyndte at gentage sig selv. Gentagelserne er fjernet.');
  }
  if (p.aborted) appendStatus('Svaret blev stoppet.');
  scrollBottom();

  // When the user asked us to run the command ("…og vil du udføre den for
  // mig?"), run it in the active tab — never for a stopped answer.
  if (!p.aborted) maybeAutoRunFromAnswer(text);
}

function failStreaming(error) {
  aiState.streaming = false;
  aiEls.sendBtn.disabled = false;
  aiEls.stopBtn.hidden = true;
  if (aiState.streamEl) aiState.streamEl.root.remove();
  aiState.streamEl = null;
  if (aiState.pendingHelp) {
    // /help must always help — fall back to the local diagnostic
    aiState.pendingHelp = false;
    showLocalHelpFallback(error);
    return;
  }
  appendMessageEl('error', `AI-fejl: ${error}`);
  scrollBottom(true);
}

function attachTerminalOutput() {
  const tab = activeTab();
  if (!tab || (!tab.sessionId && !tab.remote)) {
    appendMessageEl('error', 'Ingen aktiv terminal at vedhæfte output fra.');
    return;
  }
  // Strip ANSI colour codes — they are noise (and tokens) for the model
  const buf = String(tab.outputBuf || '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(-6000);
  if (!buf) {
    appendMessageEl('error', 'Terminalen har ikke noget output endnu — kør en kommando først.');
    return;
  }
  const where = tab.remote ? ` fra ${tab.host.name || tab.host.host}` : '';
  aiState.messages.push({
    role: 'user',
    content: `Seneste terminal-output${where} (${buf.length} tegn):\n\`\`\`\n${buf}\n\`\`\`\n(Brug det som kontekst til mit næste spørgsmål.)`,
  });
  appendMessageEl('user', `📎 Vedhæftede ${buf.length} tegn terminal-output${where}`);
  scrollBottom(true);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function appendStatus(text, isError = false) {
  const el = document.createElement('div');
  el.className = `status-msg${isError ? ' err' : ''}`;
  el.textContent = `· ${text}`;
  aiEls.messages.appendChild(el);
  scrollBottom();
}

function appendMessageEl(role, text) {
  const root = document.createElement('div');
  root.className = `msg ${role === 'user' ? 'user' : role === 'error' ? 'error' : 'assistant'}`;

  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role';
  roleEl.textContent = role === 'user' ? 'Dig' : role === 'error' ? 'Fejl' : (aiState.modelLabel || 'AI');

  const body = document.createElement('div');
  body.className = 'msg-body';
  if (role === 'user' || role === 'error') {
    body.textContent = text;
  } else {
    body.innerHTML = markdownToHtml(text);
  }

  root.append(roleEl, body);
  aiEls.messages.appendChild(root);
  aiEls.suggestions.innerHTML = '';
  scrollBottom();
  return { root, body };
}

function showSuggestions() {
  // AI-panelets forslag skal altid være på dansk
  const ideas = [
    'Forklar den kommando, jeg lige kørte',
    'Skriv en PowerShell-linje der viser de 5 største filer i denne mappe',
    'Hvorfor er min git-gren bagud — og hvordan fikser jeg det?',
    'Hvordan finder jeg ud af, hvilken proces der lytter på port 3000?',
  ];
  aiEls.suggestions.innerHTML = '';
  for (const idea of ideas) {
    const b = document.createElement('button');
    b.className = 'suggestion';
    b.textContent = idea;
    b.addEventListener('click', () => {
      aiEls.input.value = idea;
      aiEls.input.focus();
    });
    aiEls.suggestions.appendChild(b);
  }
}

function wireCodeBlockActions(scope) {
  scope.querySelectorAll('pre[data-lang]').forEach((pre) => {
    if (pre.querySelector('.code-actions')) return;

    const lang = pre.getAttribute('data-lang') || '';
    const bar = document.createElement('div');
    bar.className = 'code-actions';

    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };

    bar.append(
      mk('Kopiér', 'Kopiér til udklipsholderen', (e) => {
        navigator.clipboard.writeText(pre.getAttribute('data-code') || '');
        e.target.textContent = '✓ Kopieret';
        setTimeout(() => { e.target.textContent = 'Kopiér'; }, 1200);
      }),
      mk('Indsæt', 'Sæt ind i prompt-boksen (tryk selv Enter for at køre)', () => {
        const inp = document.getElementById('prompt-input');
        inp.value = pre.getAttribute('data-code') || '';
        inp.dispatchEvent(new Event('input'));
        inp.focus();
      }),
      mk('Kør', 'Kør i den aktive fane (også fjern-faner)', () => runAiCommand(pre.getAttribute('data-code') || '')),
    );
    if (lang) {
      const tag = document.createElement('span');
      tag.className = 'code-lang';
      tag.textContent = lang;
      bar.prepend(tag);
    }
    pre.prepend(bar);
  });
}

async function runAiCommand(cmd) {
  const tab = activeTab();
  // Remote tabs have no local PTY session — they run through remoteRun
  if (!tab || (!tab.sessionId && !tab.remote) || tab.dead) {
    appendMessageEl('error', 'Ingen aktiv terminal-fane at køre kommandoen i.');
    return;
  }
  // Multi-line blocks become one line for the prompt (PowerShell accepts ';')
  const line = String(cmd || '').split('\n').map((l) => l.trim()).filter(Boolean).join('; ');
  if (!line) return;
  const settings = window.__lennartSettings || {};
  if (settings.confirmDestructive !== false && isDestructiveCommand(line)) {
    const ok = await window.lennart.confirmCommand(line);
    if (!ok) {
      appendMessageEl('error', 'Kommandoen blev annulleret.');
      return;
    }
  }
  tab.runCommand(line);
}

// ---------------------------------------------------------------------------
// Auto-run: “Hvad er kommanden til X — og vil du udføre den for mig?”
// The answer must contain a short fenced PowerShell block AND the last user
// message must actually ask for execution. Destructive commands still go
// through the confirmation dialog; remote tabs always ask first.
// ---------------------------------------------------------------------------

/**
 * Only an EXPLICIT request runs anything. The old check matched any “kør…”
 * — so “Hvorfor kører min PC langsomt?” or “hvilken kommando skal jeg køre?”
 * auto-executed the answer. Now one of these must be present:
 *   “… udfør/kør … for mig”, “kør den/det/kommandoen”, a sentence that
 *   starts with “Kør …” / “Udfør …”, or “run it / execute it”.
 */
const RUN_VERB = '(?:udfør|udføre|udfoer|kør|køre|koer|execute|run)';
const WANTS_RUN_RES = [
  new RegExp(`(?<!\\p{L})${RUN_VERB}(?!\\p{L})[^.?!\\n]{0,40}(?<!\\p{L})for mig(?!\\p{L})`, 'iu'),
  new RegExp(`(?<!\\p{L})(?:kør|udfør|koer|udfoer)\\s+(?:den|det|dem|kommandoen|kommandoerne)(?!\\p{L})`, 'iu'),
  new RegExp(`(?:^|[.!?\\n]\\s*)(?:kør|udfør|run|execute)(?!\\p{L})`, 'iu'),
  /\b(?:run|execute) (?:it|this|that)\b/i,
];
function userWantsExecution(text) {
  const t = String(text || '').trim();
  return WANTS_RUN_RES.some((re) => re.test(t));
}

function extractRunCommand(answer) {
  const m = String(answer || '').match(/```(?:powershell|ps1|pwsh|posh|cmd|bat)?[ \t]*\n([\s\S]*?)```/i);
  if (!m) return null;
  const lines = m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return null;
  const cmd = lines.join('; ');     // one-liner form — safe for the prompt box
  if (cmd.length > 500) return null; // never auto-run long scripts
  if (/```/.test(cmd)) return null;
  return cmd;
}

function maybeAutoRunFromAnswer(answer) {
  try {
    // Settings → “AI må udføre kommandoer automatisk”
    if ((window.__lennartSettings || {}).aiAutoRun === false) return;
    const lastUser = [...aiState.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || !userWantsExecution(lastUser.content)) return;
    const cmd = extractRunCommand(answer);
    if (!cmd) return;
    const tab = activeTab();
    if (!tab) return;

    if (tab.dead) return;
    if (tab.remote) {
      const ok = window.confirm(
        `Kør kommandoen på fjernværten ${tab.host.host}?\n\n${cmd}`,
      );
      if (!ok) {
        appendStatus('Kommando annulleret — den blev ikke kørt på fjernværten.');
        return;
      }
      appendStatus(`⇄ Kører på ${tab.host.host}: ${cmd}`);
    } else {
      appendStatus(`🤖 Kører i terminalen: ${cmd}`);
    }
    runAiCommand(cmd).catch((err) => appendStatus(`Auto-kør fejlede: ${err.message || err}`, true));
  } catch (err) {
    appendStatus(`Auto-kør fejlede: ${err.message || err}`, true);
  }
}

function isDestructiveCommand(cmd) {
  const c = cmd.toLowerCase();
  return /\b(rm\s+-[rf]|remove-item.+(-recurse|-force)|del\s+\/[sq]|rd\s+\/s|format(-volume)?\b|diskpart|mkfs|dd\s+if=|git\s+push\s+(--force|-f)|git\s+reset\s+--hard|stop-process\s+-force|taskkill\s+\/f|shutdown|reg\s+delete|remove-itemproperty)\b/.test(c);
}

// ---------------------------------------------------------------------------
// Mini markdown renderer (safe: builds DOM, escapes text)
// ---------------------------------------------------------------------------

function markdownToHtml(md) {
  const out = [];
  const lines = String(md).split('\n');
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  let list = null;            // 'ul' | 'ol' | null
  let lastBlank = false;

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const raw of lines) {
    const fence = raw.match(/^\s*```\s*([\w+#-]*)/);
    if (fence) {
      if (inCode) {
        out.push(renderCodeBlock(codeBuf.join('\n'), codeLang));
        inCode = false; codeBuf = []; codeLang = '';
      } else {
        closeList();
        inCode = true; codeLang = fence[1] || '';
      }
      lastBlank = false;
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    // Headings → a bold line (no giant <h1> inside a chat bubble)
    const h = raw.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      closeList();
      out.push(`<p class="md-h"><b>${inlineMd(h[1])}</b></p>`);
      lastBlank = false;
      continue;
    }

    const ol = raw.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') {
        closeList();
        // keep the model's numbering when a code block split the list
        out.push(`<ol start="${Number(ol[1]) || 1}">`);
        list = 'ol';
      }
      out.push(`<li>${inlineMd(ol[2])}</li>`);
      lastBlank = false;
      continue;
    }

    const li = raw.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      lastBlank = false;
      continue;
    }

    if (!raw.trim()) {
      // a blank line between list items keeps the list open
      if (!list && !lastBlank) out.push('<p></p>');
      lastBlank = true;
      continue;
    }
    closeList();
    out.push(`<p>${inlineMd(raw.trim())}</p>`);
    lastBlank = false;
  }
  if (inCode) out.push(renderCodeBlock(codeBuf.join('\n'), codeLang));
  closeList();
  return out.join('');
}

/** Remove the common leading indentation (code blocks nested in lists). */
function dedentCode(code) {
  const lines = String(code).replace(/\s+$/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

function renderCodeBlock(code, lang) {
  const clean = dedentCode(code);
  const escaped = escapeHtml(clean);
  const attrLang = escapeHtml(lang || '');
  return `<pre data-lang="${attrLang}" data-code="${escaped}"><code>${escaped}</code></pre>`;
}

function inlineMd(s) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|\s)\*([^*]+)\*(?=\s|$|[.,:;!?])/g, '$1<i>$2</i>');
  h = h.replace(/(^|\s)_([^_]+)_(?=\s|$|[.,:;!?])/g, '$1<i>$2</i>');
  // [tekst](https://…) → link (opened in the browser by main's open handler)
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h;
}

// ---------------------------------------------------------------------------
// Auto-scroll: follow the stream while the user is at (or near) the bottom;
// never yank the view if they scrolled up to read something.
// ---------------------------------------------------------------------------

const SCROLL_STICKY_PX = 48;

function isNearBottom() {
  const el = aiEls.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_STICKY_PX;
}

function scrollBottom(force = false) {
  const el = aiEls.messages;
  if (force) aiState.stickToBottom = true;
  if (aiState.stickToBottom) el.scrollTop = el.scrollHeight;
}
