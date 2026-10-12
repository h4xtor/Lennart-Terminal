'use strict';

/**
 * AI provider catalog + client layer.
 *
 * Providers:
 *  - Local:   ollama / lmstudio / llamacpp / openai-compatible
 *  - Cloud:   openrouter, omniroute, openai (Codex), anthropic (Claude),
 *             gemini (Google), dashscope (Qwen), moonshot (Kimi)
 *
 * All cloud providers use either the OpenAI Chat Completions protocol
 * or the Anthropic Messages protocol. Gemini supports both (OpenAI-compat
 * endpoint and native v1beta), we use the OpenAI-compatible one.
 */

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

const PROVIDERS = {
  // ---- embedded (offline, hardcoded model — no setup) ----
  'lennart-local': {
    label: 'Indbygget, offline (Qwen2.5 Coder · PowerShell)',
    group: 'Indbygget (offline)',
    protocol: 'openai',
    baseUrl: '',                 // resolved at runtime to the embedded llama.cpp server
    needsKey: false,
    hint: 'Kører 100% lokalt — perfekt på USB-stikket. Serveren startes automatisk.',
  },
  // ---- local ----
  ollama: {
    label: 'Ollama (lokal)',
    group: 'Lokale / private',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    needsKey: false,
  },
  lmstudio: {
    label: 'LM Studio (lokal)',
    group: 'Lokale / private',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
  },
  llamacpp: {
    label: 'llama.cpp server (lokal)',
    group: 'Lokale / private',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    needsKey: false,
  },
  'openai-compatible': {
    label: 'Custom OpenAI-kompatibel…',
    group: 'Lokale / private',
    protocol: 'openai',
    baseUrl: '',
    needsKey: false,
  },

  // ---- cloud ----
  openrouter: {
    label: 'OpenRouter',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-v1-…',
    modelsPage: 'https://openrouter.ai/models',
  },
  omniroute: {
    label: 'OmniRoute (gateway)',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:20128/v1',
    needsKey: false,
    keyUrl: 'https://github.com/diegosouzapw/OmniRoute#-quick-start',
    keyPlaceholder: 'valgfri — kræves kun hvis din gateway er konfigureret med auth',
    modelsPage: 'https://omniroute.online/',
    hint: 'Lokal AI-gateway (350+ udbydere, 1200+ modeller). Installér: npm install -g omniroute && omniroute — så virker model "auto" med det samme',
  },
  openai: {
    label: 'OpenAI / Codex',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    group: 'Cloud (API-nøgle)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
  },
  gemini: {
    label: 'Google Gemini',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIza…',
  },
  dashscope: {
    label: 'Qwen (DashScope)',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    keyUrl: 'https://bailian.console.alibabacloud.com/',
    keyPlaceholder: 'sk-…',
  },
  moonshot: {
    label: 'Kimi (Moonshot)',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    needsKey: true,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyPlaceholder: 'sk-…',
  },
  'antigravity-cli': {
    label: 'Antigravity CLI (lokal agent-motor)',
    group: 'Agent-motor',
    protocol: 'agy',
    needsKey: false,
    hint: 'Bruger den installerede agy CLI som agent-motor',
  },
};

const PROVIDER_GROUPS = [
  'Indbygget (offline)',
  'Lokale / private',
  'Cloud (API-nøgle)',
  'Agent-motor',
];

// Anything unknown in a saved settings file (renamed/removed provider from an
// older build) falls back to the embedded offline AI instead of crashing chat
// with "Failed to parse URL from /chat/completions".
const DEFAULT_PROVIDER = 'lennart-local';

// ---------------------------------------------------------------------------
// Normalization + fetch helpers
// ---------------------------------------------------------------------------

function providerInfo(id) {
  return PROVIDERS[id] || null;
}

function resolveConfig(cfg) {
  const info = providerInfo(cfg.provider) || {};
  const baseUrl = (cfg.baseUrl || '').trim() || info.baseUrl || '';
  const apiKey = (cfg.apiKey || '').trim();
  // Stale/unknown provider id (settings saved by an older build): the offline
  // embedded assistant is the safe default — it needs no key, URL or model.
  const provider = info ? cfg.provider : DEFAULT_PROVIDER;
  return {
    provider,
    protocol: (info || providerInfo(DEFAULT_PROVIDER)).protocol || 'openai',
    baseUrl,
    apiKey,
  };
}

function withTimeoutSignal(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

async function listModels(cfg, { timeout = 6000 } = {}) {
  const { provider, protocol, baseUrl, apiKey } = resolveConfig(cfg);

  if (!baseUrl && provider !== 'antigravity-cli') {
    throw new Error('Ingen base URL konfigureret — åbn Settings og vælg en udbyder (eller tilføj en base URL)');
  }

  if (protocol === 'ollama') {
    const { signal, done } = withTimeoutSignal(timeout);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal });
      if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
      const json = await res.json();
      return (json.models || []).map((m) => ({ id: m.name, label: `${m.name}  (${formatBytes(m.size)})` }));
    } finally {
      done();
    }
  }

  if (protocol === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic kræver en API-nøgle (Settings → API-nøgle)');
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    const { signal, done } = withTimeoutSignal(timeout);
    try {
      const res = await fetch(`${baseUrl}/models`, { signal, headers });
      if (!res.ok) {
        // Older accounts/keys may not expose /models — fall back to known line-up
        const known = [
          'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
          'claude-opus-4-1', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest',
        ];
        return known.map((id) => ({ id, label: id }));
      }
      const json = await res.json();
      const arr = Array.isArray(json.data) ? json.data : [];
      const live = arr.map((m) => ({ id: m.id || m.name, label: m.display_name || m.id || m.name }))
        .filter((m) => m.id);
      return live.length ? live : [
        'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
      ].map((id) => ({ id, label: id }));
    } finally {
      done();
    }
  }

  if (protocol === 'agy') {
    return listAgyModels();
  }

  // OpenAI-compatible: GET /models
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const { signal, done } = withTimeoutSignal(timeout);
  try {
    const res = await fetch(`${baseUrl}/models`, { signal, headers });
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Endpoint ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 140)}` : ''}`);
    }
    const json = await res.json();
    const arr = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
    const models = arr
      .map((m) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    // Provider-specific niceties
    if (provider === 'openrouter') {
      for (const m of models) m.label = m.label.replace(/^openrouter\//, '');
    }
    if (provider === 'gemini') {
      for (const m of models) m.label = m.label.replace(/^models\//, '');
    }
    return models;
  } finally {
    done();
  }
}

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

/**
 * cfg: { provider, model, baseUrl, apiKey, temperature }
 * messages: [{ role, content }]
 * opts: { system, onToken(token), signal }
 */
async function chat(cfg, messages, { system, onToken, signal } = {}) {
  const { provider, protocol, baseUrl, apiKey } = resolveConfig(cfg);
  const model = cfg.model || '';

  if (!model && provider !== 'antigravity-cli') {
    throw new Error('Ingen model valgt — åbn Settings og vælg en');
  }
  // Never let a half-configured provider reach fetch with an empty URL
  // (that surfaced as "Failed to parse URL from /chat/completions").
  if (protocol === 'openai' && !baseUrl) {
    throw new Error('AI-udbyder er ikke konfigureret — åbn Settings og vælg "Indbygget (offline)" eller udfyld en base URL');
  }

  const temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : 0.4;
  // Model settings (Settings → Model-indstillinger). maxTokens 0 = provider
  // default, topP 1 = standard sampling.
  const maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 0;
  const topP = Number(cfg.topP) > 0 ? Number(cfg.topP) : 1;

  if (protocol === 'ollama') {
    return chatOllama({ baseUrl, model, messages, system, temperature, maxTokens, topP, onToken, signal });
  }
  if (protocol === 'anthropic') {
    return chatAnthropic({ baseUrl, model, messages, system, temperature, maxTokens, topP, apiKey, onToken, signal });
  }
  if (protocol === 'agy') {
    return chatAgy({ messages, system, onToken, signal, model, allowTools: false });
  }
  return chatOpenAICompatible({ baseUrl, model, messages, system, temperature, maxTokens, topP, apiKey, onToken, signal });
}

async function chatOllama({ baseUrl, model, messages, system, temperature, maxTokens, topP, onToken, signal }) {
  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: true,
    options: {
      temperature,
      ...(maxTokens > 0 ? { num_predict: maxTokens } : {}),
      ...(topP < 1 ? { top_p: topP } : {}),
    },
  };
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await safeText(res)).slice(0, 200)}`);
  await consumeNdjson(res, (obj) => {
    const tok = obj.message && obj.message.content;
    if (typeof tok === 'string' && tok) onToken(tok);
  });
}

async function chatOpenAICompatible({ baseUrl, model, messages, system, temperature, maxTokens, topP, apiKey, onToken, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  headers['HTTP-Referer'] = 'https://lennart-terminal.local';
  headers['X-Title'] = 'Lennart Terminal';

  const body = {
    model,
    stream: true,
    temperature,
    ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
    ...(topP < 1 ? { top_p: topP } : {}),
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
  };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`AI endpoint ${res.status}: ${(await safeText(res)).slice(0, 200)}`);

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    const json = await res.json();
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (content) onToken(content);
    return;
  }
  await consumeSse(res, (payload) => {
    if (payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload);
      const tok = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
      if (typeof tok === 'string' && tok) onToken(tok);
    } catch { /* keep-alive */ }
  });
}

/**
 * Chat via the Antigravity CLI (one-shot --print per turn).
 * Streaming comes from the CLI's text events; no API key or endpoint needed.
 */
async function chatAgy({ messages, system, onToken, signal, model, allowTools }) {
  const parts = [];
  if (system) parts.push(`[System]\n${system}`);
  for (const m of messages) {
    parts.push(`[${m.role === 'assistant' ? 'Assistant' : 'User'}]\n${m.content}`);
  }
  parts.push('[Assistant]');

  const res = await runAgyAgent({
    prompt: parts.join('\n\n'),
    onEvent: (ev) => {
      if (ev.type === 'text' && onToken) onToken(ev.text);
    },
    signal,
    model,
    allowTools: allowTools === true,
  });
  void res;
}

async function chatAnthropic({ baseUrl, model, messages, system, temperature, maxTokens, topP, apiKey, onToken, signal }) {
  if (!apiKey) throw new Error('Anthropic kræver en API-nøgle (Settings → API Keys)');

  // Anthropic has no system-role messages — merge them into the system prompt
  const systemText = [system, ...messages.filter((m) => m.role === 'system').map((m) => m.content)]
    .filter(Boolean).join('\n\n');

  const body = {
    model,
    max_tokens: maxTokens > 0 ? maxTokens : 4096,
    temperature,
    ...(topP < 1 ? { top_p: topP } : {}),
    stream: true,
    ...(systemText ? { system: systemText } : {}),
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  };

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await safeText(res)).slice(0, 200)}`);

  await consumeSse(res, (payload) => {
    try {
      const obj = JSON.parse(payload);
      if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') {
        onToken(obj.delta.text);
      }
    } catch { /* keep-alive */ }
  });
}

// ---------------------------------------------------------------------------
// Antigravity CLI engine (agent mode only)
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');

function agyAvailable() {
  return new Promise((resolve) => {
    const p = spawn('agy', ['--version'], { shell: true });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function listAgyModels() {
  return new Promise((resolve, reject) => {
    const p = spawn('agy', ['models'], { shell: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', (err) => reject(new Error(`agy CLI ikke fundet: ${err.message}`)));
    p.on('close', () => {
      const models = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^([a-z0-9][a-z0-9._-]*)\s+(.+)$/i);
        if (m && !/fetching/i.test(line)) {
          models.push({ id: m[1], label: m[2].trim() });
        }
      }
      if (!models.length) reject(new Error('agy models returnerede ingen modeller'));
      else resolve(models);
    });
  });
}

/**
 * Run an agent job through the Antigravity CLI.
 * opts: { onEvent(event), signal, model, approvalMode }
 * Events: { type: 'tool', name, detail }, { type: 'text', text },
 *         { type: 'done', text }, { type: 'error', error }
 */
function runAgyAgent({ prompt, cwd, onEvent, signal, model, allowTools }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', String(prompt || '').slice(0, 28000),
      '--output-format', 'stream-json',
    ];
    // Agent jobs may execute tools; plain chat must not
    if (allowTools !== false) args.push('--dangerously-skip-permissions');
    if (model) args.push('--model', model);

    // No shell: Node escapes args safely (multiline prompts stay intact)
    const child = spawn('agy', args, { cwd: cwd || undefined, windowsHide: true });
    let fullText = '';
    let buf = '';

    signal && signal.addEventListener('abort', () => {
      try { child.kill(); } catch { /* ignore */ }
    });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          // agy stream-json: step_update carries text_delta / tool steps,
          // result carries the final response
          if (ev.event === 'step_update' && ev.step_update) {
            const su = ev.step_update;
            if (typeof su.text_delta === 'string' && su.text_delta) {
              fullText += su.text_delta;
              onEvent && onEvent({ type: 'text', text: su.text_delta });
            } else if (su.step_type && su.step_type !== 'user_input' && su.step_type !== 'agent_response') {
              onEvent && onEvent({ type: 'tool', name: su.step_type, detail: su.state || '' });
            }
          } else if (ev.event === 'result' && ev.result) {
            if (typeof ev.result.response === 'string' && ev.result.response) {
              fullText = ev.result.response;
            }
          }
        } catch { /* non-JSON line (banners etc.) */ }
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) onEvent && onEvent({ type: 'info', text: s.slice(0, 300) });
    });

    child.on('error', (err) => {
      reject(new Error(
        err.code === 'ENOENT'
          ? 'agy CLI blev ikke fundet — tjek at Antigravity er installeret og på PATH'
          : `Kunne ikke starte agy: ${err.message}`,
      ));
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ text: fullText });
      else reject(new Error(`agy afsluttede med kode ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Stream parsing helpers
// ---------------------------------------------------------------------------

async function consumeNdjson(res, onObject) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { onObject(JSON.parse(t)); } catch { /* partial */ }
    }
  }
  if (buf.trim()) {
    try { onObject(JSON.parse(buf.trim())); } catch { /* ignore */ }
  }
}

async function consumeSse(res, onPayload) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const ev of events) {
      for (const line of ev.split('\n')) {
        if (line.startsWith('data:')) onPayload(line.slice(5).trim());
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent system prompt (built-in autopilot)
// ---------------------------------------------------------------------------

function buildAgentSystemPrompt() {
  return [
    'You are Lennart, the AI agent inside Lennart Terminal on Windows.',
    'The user works in a terminal and sees your answers in a side panel.',
    '',
    'Rules:',
    '- Be concise and practical; prefer short paragraphs and lists.',
    '- Put commands in their own fenced code block (```powershell or ```bash).',
    '- Windows + PowerShell is the default environment.',
    '- Never invent file contents or command output. Say what to check instead.',
    '- Warn explicitly before destructive commands (delete, format, force-push, kill).',
    '- You cannot execute anything yourself — the user runs commands.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// System prompt for the small embedded offline model (lennart-local).
//
// This is the offline assistant's FULL training compendium: everything the
// model must know about (a) Lennart Terminal itself and (b) Windows /
// PowerShell troubleshooting. It is dense and concrete on purpose — small
// models follow concrete facts far better than vague instructions — and the
// localAI context default (8192 tokens, store.js) is sized to fit it.
// The answer-format contract at the bottom is REQUIRED by the renderer:
// maybeAutoRunFromAnswer() reads the FIRST ```powershell block and the KØRER
// marker drives auto-execution. Do not change that contract without also
// updating scripts/verify-ui.js (5e/5f) and src/renderer/js/ai.js.
// ---------------------------------------------------------------------------

function buildPowerShellSystemPrompt() {
  return [
    'Du er Lennart — den indbyggede offline-assistent i Lennart Terminal på Windows.',
    'Du kender alt om appen og om PowerShell/Windows-fejlsøgning, og du svarer på dansk.',
    '',
    '=== DEL 1: APPEN “LENNART TERMINAL” ===',
    'Layout: venstre sidebar (New Tab, 4 shell-knapper, 20 netværks-kommando-knapper, quick-connect til LAN-PC’er, AI-sektion, status nederst), topmenü med 10 dropdowns, terminal i midten med prompt-boks nederst, AI-panel til højre.',
    'Genveje: Ctrl+T ny fane · Ctrl+W luk fane · Ctrl+J vis/skjul AI-panel · Ctrl+H historik · Ctrl+, Settings · Ctrl+Shift+C kopiér markering · i prompt-boksen: Enter kører kommandoen i den aktive fane, Ctrl+Enter sender til AI-panelet.',
    'Menüer (alfabetiske, kommandoen står i tooltip): Setup, Netværk, System, Processer, Disk, Sikkerhed, GPU & spil, Fejlfinding, Fjernsupport, AI. Hver post kører en færdig PowerShell-kommando i den aktive fane; admin-krævende poster er mærket “kræver administrator”.',
    'AI-panel: Chat- eller Agent-tilstand med Stop-knap. Hver ```powershell-kodeblok i et svar får knapperne Copy, Insert (i prompt-boksen) og Kør (kører i den aktive fane). “Attach last output” vedhæfter seneste terminaloutput som kontekst.',
    'Agent-tilstand: AI’en planlægger et job og kører selv kommandoerne trin for trin i terminalen med live-output; destruktive kommandoer kræver godkendelse (medmindre auto-godkendelse er slået til).',
    'Historik (Ctrl+H eller 📚): alle kommandoer (lokale, fjern, agent) og AI-samtaler gemmes i Data/history.jsonl og kan søges; “Ryd historik” tømmer den.',
    'Modeller: Setup → “Hent modeller” åbner modelmanageren med ét-kliks download til Data/localai/models (*.gguf) og live statuslinje. Indbygget: Qwen2.5 Coder 1.5B. Katalog: Qwen2.5 Coder 3B, Llama 3.2 3B, Phi-3.5 Mini, Qwen3 8B, Qwen2.5 Coder 7B, DeepSeek R1 7B, Llama 3.1 8B, Mistral 7B v0.3. Den indbyggede server kører llama-server på http://127.0.0.1:9601 (sundhedstjek: GET /health).',
    'Andre udbydere i Settings: Ollama (127.0.0.1:11434), LM Studio (1234), llama.cpp (8080), OpenRouter, OmniRoute, OpenAI, Claude (Anthropic), Gemini, Qwen (DashScope), Kimi (Moonshot) samt Antigravity CLI (agy) som agent-motor.',
    'Model-indstillinger: kontekst 2048–16384 tokens, CPU-tråde, maks svar-tokens, top-p, temperature. Ændringer genstarter den indbyggede server næste gang, så de slår med det samme.',
    'Fjernstyring: quick-connect med en LAN-IP (SSH eller WinRM) åbner en fjern-fane, hvor ALLE kommandoer køres på den anden PC. På mål-PC’en kræves SSH slået til (Setup → “Slå SSH til (OpenSSH Server)” + “SSH-tjeneste auto-start” + firewall port 22) eller WinRM (Enable-PSRemoting -Force). Værter gemmes via “Tilføj vært…” med navn, IP, metode, brugernavn, adgangskode (WinRM) og nøglefil (SSH). RDP slås til via Setup → “Slå RDP til”. Wake-on-LAN: Fjernsupport-menuen viser MAC-adresser og slår WoL til på adapteren.',
    'Administrator: appen foretrækker at køre som admin; uden admin mærkes påkrævede kommandoer i menuerne, og Setup → “Genstart som administrator” genstarter forhøjet (UAC).',
    'USB-tilstand: hele appen (indstillinger, historik, modeller) kan ligge på et USB-stik via Data-mappen og fungerer offline på en anden PC.',
    '/help i chatten svarer med det samme ud fra live-konteksten (genveje, tjek først, hvor du står) — uden at spørge modellen.',
    '',
    '=== DEL 2: WINDOWS-POWERSHELL-KOMPENDIUM ===',
    'Netværk: ipconfig /all · ipconfig /flushdns · Get-NetIPConfiguration · Get-NetAdapter (status, link-speed, MAC) · Get-NetTCPConnection -State Listen (hvem lytter på port X — OwningProcess er PID’en) · netstat -ano · Test-NetConnection vært -Port 443 · ping 8.8.8.8 (forbindelse) vs ping google.com (DNS) · tracert -d · Resolve-DnsName · Clear-DnsClientCache · netsh wlan show networks mode=bssid · netsh wlan show profile name="NET" key=clear (Wi-Fi-adgangskode) · Get-NetFirewallProfile · offentlig IP: (Invoke-WebRequest -UseBasicParsing https://api.ipify.org).Content · default-gateway: (Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort RouteMetric | Select -First 1).NextHop',
    'Portfejlfinding: Find lytteren med Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -eq 8080} — OwningProcess = PID → vis med Get-Process -Id <pid> → Stop-Process -Id <pid> (advar altid først).',
    'Processer & tjenester: Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,CPU,Id · WorkingSet64 = hukommelse (MB) · Stop-Process -Id X (-Force er destruktivt — advar) · taskkill /F /PID X · Get-Service · Start-Service/Restart-Service X · “auto-start men stoppede” tjenester er en klassisk fejl · Get-CimInstance Win32_StartupCommand (programmer ved login) · Run-nøgler i registry · Get-ScheduledTask · tasklist /svc (svchost’er).',
    'System: Get-ComputerInfo (model, OS, build) · systeminfo · (Get-CimInstance Win32_OperatingSystem).LastBootUpTime (oppe-tid) · Get-HotFix (opdateringer) · $env:USERNAME, $env:COMPUTERNAME, $env:PATH · Get-TimeZone · installerede programmer via registry Uninstall-nøgler · winget list / winget install <id> · gpresult /r og gpupdate /force · slmgr /xpr (aktivering) · CPU: Win32_Processor · RAM: TotalPhysicalMemory.',
    'Disk: Get-Volume (størrelse, sundhed) · Get-PSDrive -PSProvider FileSystem · Get-PhysicalDisk + Get-StorageReliabilityCounter (SSD-sundhed, Wear) · Get-Partition / Get-Disk · USB-diske via BusType · største filer: Get-ChildItem STI -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 · temp-mapper måles først, ryddes med -WhatIf først · Optimize-Volume -DriveLetter C -Analyze · TRIM: fsutil behavior query DisableDeleteNotify · chkdsk C: /scan · vssadmin list shadows.',
    'Sikkerhed: Get-NetFirewallRule -Direction Inbound -Enabled True · tilladte porte via Get-NetFirewallPortFilter · Defender: Get-MpComputerStatus, Get-MpThreatDetection, Get-MpPreference (ExclusionPath), Start-MpScan -ScanType QuickScan · logon-fejl 4625 / logons 4624 i Security-loggen (kræver admin) · whoami /priv og whoami /groups · Get-LocalGroupMember Administrators · net accounts · certifikater i Cert:\\LocalMachine\\My (snart udløbet = NotAfter < 30 dage) · UAC-niveau i registry · BitLocker: Manage-bde -status · Confirm-SecureBootUEFI · Get-Tpm · Get-ExecutionPolicy -List.',
    'GPU & strøm: nvidia-smi · nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv · Get-CimInstance Win32_VideoController (driver, refresh-rate) · GPU-belastning: Get-Counter "\\GPU Engine(*)\\Utilization Percentage" · powercfg /getactivescheme, /list, /a, /batteryreport, /systempowerreport · dxdiag.',
    'Fejlfinding & log: Get-WinEvent -FilterHashtable @{Level=1;LogName="System"} (kritiske) · ID 6008 = uventet nedlukning · WHEA-Logger = bluescreen/hardware · dumps i C:\\Windows\\Minidump · Service Control Manager-hændelser = service-fejl · Get-EventLog -LogName System -Newest 20 -EntryType Error · reparation i rækkefølge: sfc /scannow → DISM /Online /Cleanup-Image /CheckHealth → /RestoreHealth · Windows Update-fejl: wuauserv + opdateringshændelser · netværkskaos: ipconfig /release; ipconfig /flushdns; ipconfig /renew; netsh winsock reset · netsh winhttp reset proxy · hosts-fil: C:\\Windows\\System32\\drivers\\etc\\hosts · Print Spooler og lyd-services.',
    'Fjernsupport: SSH på mål: Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 · Set-Service sshd -StartupType Automatic; Start-Service sshd · firewall port 22 · ssh-keygen -t ed25519 · ssh -V · WinRM: Enable-PSRemoting -Force -SkipNetworkProfileCheck · Test-WSMan localhost · winrm get winrm/config · RDP: registry fDenyTSConnections=0 + Enable-NetFirewallRule -DisplayGroup "Remote Desktop" · query session / quser (aktive RDP-sessioner) · net use + Get-SmbSession / Get-SmbShare (deling) · Wake-on-LAN via MAC + Set-NetAdapterAdvancedProperty "Wake on Magic Packet".',
    'PowerShell-idiomer: Brug de indbyggede cmdlets (Get-*) først. Get-CimInstance frem for Get-WmiObject. Filtrér med Where-Object, sorter med Sort-Object, formater med Format-Table -AutoSize eller Format-List. Tilføj -ErrorAction SilentlyContinue ved læsning der kan fejle. Brug -WhatIf før ødelæggende ændringer. $env: giver miljøvariabler. Undgå interaktive kommandoer (vim, pause, -Wait) i chat-svar.',
    '',
    '=== DEL 3: SÅDAN DIAGNOSTICERER DU ===',
    '1. Læs fejlen/brugeren præcist — gæt aldrig. 2. Indsnævr: lokalt eller fjern-fane? netværk, disk, service eller program? 3. Bevis med ÉN kommando ad gangen, læs-only først. 4. Fortolk output og peg på årsagen. 5. Giv fixet plus en verifikations-kommando bagefter. Ved tvivl: spørg i stedet for at gætte.',
    '',
    '=== DEL 4: SVARFORMAT (følg det altid) ===',
    'Bruger: Hvad er kommanden til at vise IP-adressen — og vil du udføre den for mig?',
    'Svar:',
    'Kommanden er:',
    '```powershell',
    'ipconfig /all',
    '```',
    'KØRER',
    '',
    'Regler:',
    '- Svar på dansk, kort og direkte (højst 4 linjer før kodeblokken).',
    '- Giv altid kommandoen i en ```powershell kodeblok med én kørlinje hvis muligt.',
    '- Kommandoen skal stå i den FØRSTE ```powershell-kodeblok i svaret — appens auto-kør og knappen “Kør” læser kun den første blok.',
    '- Kun Windows PowerShell/CMD — aldrig bash eller Linux-kommandoer, medmindre brugeren beder om det.',
    '- Hvis brugeren beder om at udføre kommanden (fx “…og vil du udføre den for mig?”), så afslut svaret med den sidste linje KØRER lige efter kodeblokken.',
    '- Skriv aldrig KØRER i andre sammenhænge.',
    '- Advar kort før ødelæggende kommandoer (Remove-Item -Recurse, Format, Stop-Process -Force osv.).',
    '- Ved tvivl: giv kommanden og lad brugeren trykke Kør.',
  ].join('\n');
}

module.exports = {
  chat,
  listModels,
  PROVIDERS,
  PROVIDER_GROUPS,
  providerInfo,
  DEFAULT_PROVIDER,
  buildAgentSystemPrompt,
  buildPowerShellSystemPrompt,
  agyAvailable,
  listAgyModels,
  runAgyAgent,
};
