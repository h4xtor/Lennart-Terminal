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
  window.lennart.onChatDone(({ id }) => {
    if (id === aiState.currentId) finishStreaming();
  });
  window.lennart.onChatError(({ id, error }) => {
    if (id === aiState.currentId) failStreaming(error);
  });

  window.lennart.onAgentEvent(({ id, event }) => {
    if (id !== aiState.agentId) return;
    renderAgentEvent(event);
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
    aiEls.input.style.height = 'auto';
    aiState.messages.push({ role: 'user', content: text });
    appendMessageEl('user', text);
    startStream();
  }
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
  lines.push('Appen: Lennart Terminal — 20 netværksknapper i sidebar, dropdown-menuer øverst (Setup først), quick-connect til LAN-IP (SSH eller WinRM), AI-chat til højre som kan udføre kommandoer, historik (Ctrl+H), fjernfaner der kører kommandoer på andre PC’er.');
  lines.push('Genveje: Ctrl+T ny fane · Ctrl+J AI-panel · Ctrl+H historik · Ctrl+, setup · Ctrl+Shift+C kopiér markering.');
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
    'Giv ENDIg ikke kun én kommando: lever en fejlsøgningsdiagnose.',
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
    '- `Ctrl+T` ny fane · `Ctrl+J` AI-panel · `Ctrl+H` historik · `Ctrl+,` Setup · `Ctrl+Shift+C` kopiér markering',
    '- I prompt-boksen nederst: `Enter` = kør kommandoen · `Ctrl+Enter` = spørg AI-en',
    '',
    '**Tjek først**',
    '1. Indbygget AI: `Get-Process llama-server` og `(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9601/health).Content` — starter den ikke, åbn **Setup → Hent modeller**.',
    '2. Internet: `ping 1.1.1.1 -n 4` — API-modeller kræver forbindelse; den indbyggede kører offline.',
    '3. Fjern-PC: `Test-NetConnection <IP> -Port 22` — slå SSH til på mål-PC’en via **Setup → “Slå SSH til”** (admin), eller WinRM med `Enable-PSRemoting -Force`.',
    '4. Kommandoer køres ikke? Se om fanen er en fjern-fane (navnet øverst) — der køres alt på fjernværten.',
    '',
    '**Brug af AI-en**',
    '- Skriv et spørgsmål i boksen her til højre; kodeblokke får knapperne **Kør**, **Insert** og **Copy**.',
    '- **Setup → Hent modeller** henter stærkere modeller (Qwen3 8B, Qwen2.5 Coder 7B, DeepSeek R1 7B) til den indbyggede AI.',
    '- Bed mig om en dybdegående diagnose via knappen herunder, hvis du vil have AI-en til at kigge på konteksten.',
    err ? `_(Fejl: ${err}) — prøv igen senere.)_` : '',
  ].filter(Boolean).join('\n');
}

/** /help rendered straight into the chat (no streaming, no model). */
async function showLocalHelp(text) {
  const label = text || '/help';
  aiEls.input.value = '';
  aiEls.input.style.height = 'auto';
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
  }
}

function agentFinished() {
  aiState.agentRunning = false;
  aiState.agentId = null;
  aiEls.sendBtn.disabled = false;
  aiEls.stopBtn.hidden = true;
}

function onStopClicked() {
  if (aiState.mode === 'agent' && aiState.agentId) {
    window.lennart.agentStop(aiState.agentId);
    appendStatus('Agent stoppet af bruger.');
    agentFinished();
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

function renderStreaming() {
  const el = aiState.streamEl;
  if (!el) return;
  el.body.innerHTML = markdownToHtml(aiState.assistantBuf);
  wireCodeBlockActions(el.body);
  scrollBottom();
}

function finishStreaming() {
  if (!aiState.streaming) return;
  aiState.streaming = false;
  aiState.pendingHelp = false;
  aiEls.sendBtn.disabled = false;
  aiEls.stopBtn.hidden = true;

  const text = aiState.assistantBuf || '';
  aiState.messages.push({ role: 'assistant', content: text });
  if (aiState.streamEl) {
    aiState.streamEl.body.classList.remove('cursor-blink');
    if (text) {
      aiState.streamEl.body.innerHTML = markdownToHtml(text);
      wireCodeBlockActions(aiState.streamEl.body);
    }
  }
  aiState.streamEl = null;
  scrollBottom();

  // The embedded PowerShell assistant: when the user asked us to run the
  // command ("…og vil du udføre den for mig?"), run it in the active tab.
  maybeAutoRunFromAnswer(text);
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
  appendMessageEl('error', `AI error: ${error}`);
  scrollBottom(true);
}

function attachTerminalOutput() {
  const tab = activeTab();
  if (!tab || !tab.sessionId) {
    appendMessageEl('error', 'No live terminal session to attach.');
    return;
  }
  const buf = (tab.outputBuf || '').trim();
  if (!buf) {
    appendMessageEl('error', 'Terminal output buffer is empty — run something first.');
    return;
  }
  aiState.messages.push({
    role: 'user',
    content: `Recent terminal output (last ${buf.length} chars):\n\`\`\`\n${buf}\n\`\`\`\n(Use this as context for my next question.)`,
  });
  appendMessageEl('user', `📎 Attached ${buf.length} chars of recent terminal output`);
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
  roleEl.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : (aiState.modelLabel || 'AI');

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
  const ideas = [
    'Explain the last command I ran',
    'Write a PowerShell one-liner to list the 5 largest files under the current folder',
    'Why is my git branch behind and how do I fix it?',
    'How do I find which process is listening on port 3000?',
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
      mk('Copy', 'Copy to clipboard', () => navigator.clipboard.writeText(pre.getAttribute('data-code') || '')),
      mk('Insert', 'Insert into prompt box (Enter to run yourself)', () => {
        const inp = document.getElementById('prompt-input');
        inp.value = pre.getAttribute('data-code') || '';
        inp.focus();
      }),
      mk('Run', 'Run in the active terminal tab', () => runAiCommand(pre.getAttribute('data-code') || '')),
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
  if (!tab || !tab.sessionId) {
    appendMessageEl('error', 'No active terminal session.');
    return;
  }
  const settings = window.__lennartSettings || {};
  if (settings.confirmDestructive !== false && isDestructiveCommand(cmd)) {
    const ok = await window.lennart.confirmCommand(cmd);
    if (!ok) {
      appendMessageEl('error', 'Command cancelled.');
      return;
    }
  }
  tab.runCommand(cmd);
}

// ---------------------------------------------------------------------------
// Auto-run: “Hvad er kommanden til X — og vil du udføre den for mig?”
// The answer must contain a short fenced PowerShell block AND the last user
// message must actually ask for execution. Destructive commands still go
// through the confirmation dialog; remote tabs always ask first.
// ---------------------------------------------------------------------------

function userWantsExecution(text) {
  return /(kør|kore|udfør|udfoer|udføre|execut|run it|kører den|udfør den)/i.test(String(text || ''));
}

function extractRunCommand(answer) {
  const m = String(answer || '').match(/```(?:powershell|ps1|pwsh|posh)?[ \t]*\n([\s\S]*?)```/i);
  if (!m) return null;
  const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const cmd = lines.join(' ');      // one-liner form — safe for the prompt box
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
    runAiCommand(cmd);
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
  let inCode = false, codeLang = '', codeBuf = [], listOpen = false;

  const closeList = () => {
    if (listOpen) { out.push('</ul>'); listOpen = false; }
  };

  for (const raw of lines) {
    const fence = raw.match(/^\s*```(\w*)/);
    if (fence) {
      if (inCode) {
        out.push(renderCodeBlock(codeBuf.join('\n'), codeLang));
        inCode = false; codeBuf = []; codeLang = '';
      } else {
        closeList();
        inCode = true; codeLang = fence[1] || '';
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    closeList();

    if (!raw.trim()) { out.push('<p></p>'); continue; }
    out.push(`<p>${inlineMd(raw)}</p>`);
  }
  if (inCode) out.push(renderCodeBlock(codeBuf.join('\n'), codeLang));
  closeList();
  return out.join('');
}

function renderCodeBlock(code, lang) {
  const escaped = escapeHtml(code);
  const attrLang = escapeHtml(lang || '');
  return `<pre data-lang="${attrLang}" data-code="${escapeHtml(code)}"><code>${escaped}</code></pre>`;
}

function inlineMd(s) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<i>$2</i>');
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
