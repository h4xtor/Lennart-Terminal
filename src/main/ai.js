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
  deepseek: {
    label: 'DeepSeek',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-…',
    hint: 'Stærk coder-model til favorable priser — OpenAI-kompatibel',
  },
  groq: {
    label: 'Groq',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/docs/quickstart',
    keyPlaceholder: 'gsk_…',
    hint: 'Ekstremt hurtige inference-svar (LPU)',
  },
  mistral: {
    label: 'Mistral AI',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    keyUrl: 'https://docs.mistral.ai/admin/identity-access/api-keys',
  },
  xai: {
    label: 'xAI (Grok)',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    keyUrl: 'https://docs.x.ai/developers/quickstart',
    keyPlaceholder: 'xai-…',
  },
  together: {
    label: 'Together AI',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.together.ai/v1',
    needsKey: true,
    keyUrl: 'https://docs.together.ai/docs/api-keys-authentication',
    hint: 'Adgang til hundredvis af åbne modeller (Llama, Qwen, Mistral)',
  },
  perplexity: {
    label: 'Perplexity',
    group: 'Cloud (API-nøgle)',
    protocol: 'openai',
    baseUrl: 'https://api.perplexity.ai/router/v1',
    needsKey: true,
    keyUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
    keyPlaceholder: 'pplx-…',
    hint: 'Søge-modeller med aktuelle kilder i svaret',
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
          'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
          'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
        ];
        return known.map((id) => ({ id, label: id }));
      }
      const json = await res.json();
      const arr = Array.isArray(json.data) ? json.data : [];
      const live = arr.map((m) => ({ id: m.id || m.name, label: m.display_name || m.id || m.name }))
        .filter((m) => m.id);
      return live.length ? live : [
        'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
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

// Endpoints that speak llama.cpp sampler fields (repeat_penalty / repeat_last_n).
// Cloud and unknown OpenAI-compatible servers get none — an unknown field can
// make strict APIs reject the whole request.
const LOCAL_LLAMA_PROVIDERS = new Set(['lennart-local', 'llamacpp', 'lmstudio']);

/**
 * cfg: { provider, model, baseUrl, apiKey, temperature }
 * messages: [{ role, content }]
 * opts: { system, onToken(token), signal }
 * Resolves { finishReason } — 'length' when the token limit cut the answer
 * off, 'stop' (or '') otherwise.
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

  // resolveLocalProvider() (main.js) rewrites the embedded provider to
  // 'openai-compatible' before chat() runs — cfg.embeddedLocal keeps it
  // marked, so the anti-loop caps and sampler penalties below still reach
  // the local llama-server instead of silently vanishing.
  const embedded = provider === 'lennart-local' || cfg.embeddedLocal === true;

  // The embedded 1.5B/3B coder model rambles at the generic default — answer
  // slightly cooler and much shorter, unless the user set their own values.
  const fallbackTemp = embedded ? 0.3 : 0.4;
  const temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : fallbackTemp;
  // Model settings (Settings → Model-indstillinger). maxTokens 0 = provider
  // default, topP 1 = standard sampling.
  let maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 0;
  const topP = Number(cfg.topP) > 0 ? Number(cfg.topP) : 1;

  // The embedded model gets a hard answer cap so a looping reply cannot run
  // until the context fills. 700 tokens fits a 4-step setup answer in Danish
  // (the old 400 cut real answers off mid-sentence); real loops are stopped
  // much earlier by the answer guard (answer.js). Settings can override it.
  if (embedded && !maxTokens) maxTokens = 700;

  // An answer that looped once must not teach the model to loop again.
  // Two defenses: (1) an old assistant turn that looks like a list-loop is
  // dropped entirely — the model would otherwise continue its own numbering
  // ("11. … 12. … 13. …" right after a looped 1..10 answer); (2) whatever
  // survives is capped so a long answer can't dominate the context.
  const looksLikeLoop = (content) => {
    const lines = content.split('\n').map((l) => l.trim());
    const numbered = lines.filter((l) => /^\d{1,2}\.\s/.test(l)).length;
    if (numbered >= 6) return true;
    const long = lines.filter((l) => l.length > 15);
    const seen = new Set(long);
    return seen.size < long.length; // repeated non-trivial lines
  };
  const safeMessages = messages.filter((m) => {
    if (m.role !== 'assistant' || typeof m.content !== 'string') return true;
    // Answers are cleaned by the answer guard before they reach history, so
    // a long answer is no longer a loop sign — 3500 chars keeps a full
    // 700-token answer (needed for "fortsæt") while still dropping runaways.
    return !(m.content.length > 3500 || looksLikeLoop(m.content));
  });

  if (protocol === 'ollama') {
    return chatOllama({ baseUrl, model, messages: safeMessages, system, temperature, maxTokens, topP, onToken, signal });
  }
  if (protocol === 'anthropic') {
    return chatAnthropic({ baseUrl, model, messages: safeMessages, system, temperature, maxTokens, topP, apiKey, onToken, signal });
  }
  if (protocol === 'agy') {
    return chatAgy({ messages: safeMessages, system, onToken, signal, model, allowTools: false });
  }
  return chatOpenAICompatible({ provider, embedded, baseUrl, model, messages: safeMessages, system, temperature, maxTokens, topP, apiKey, onToken, signal });
}

async function chatOllama({ baseUrl, model, messages, system, temperature, maxTokens, topP, onToken, signal }) {
  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: true,
    options: {
      temperature,
      // anti-repetition: without a penalty small models repeat steps forever.
      // Kept moderate — an aggressive penalty over the end of a long system
      // prompt makes the model rewrite the instructions instead of answering.
      repeat_penalty: 1.15,
      repeat_last_n: 256,
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
  let finishReason = '';
  await consumeNdjson(res, (obj) => {
    const tok = obj.message && obj.message.content;
    if (typeof tok === 'string' && tok) onToken(tok);
    if (obj.done && obj.done_reason) finishReason = obj.done_reason === 'length' ? 'length' : 'stop';
  });
  return { finishReason };
}

async function chatOpenAICompatible({ provider, embedded, baseUrl, model, messages, system, temperature, maxTokens, topP, apiKey, onToken, signal }) {
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
    // Anti-repetition for llama.cpp-family endpoints: without a real penalty
    // the embedded model repeats the same numbered step ("23. Net use …
    // 29. Net use") until the context fills up. 1.30 is the point where a
    // 1.5B coder model actually stops instead of merely slowing down.
    ...(embedded || LOCAL_LLAMA_PROVIDERS.has(provider) ? { repeat_penalty: 1.15, repeat_last_n: 256 } : {}),
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
    const choice = (json.choices && json.choices[0]) || {};
    const content = choice.message && choice.message.content;
    if (content) onToken(content);
    return { finishReason: choice.finish_reason === 'length' ? 'length' : 'stop' };
  }
  let finishReason = '';
  await consumeSse(res, (payload) => {
    if (payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload);
      const choice = (obj.choices && obj.choices[0]) || {};
      const tok = choice.delta && choice.delta.content;
      if (typeof tok === 'string' && tok) onToken(tok);
      if (choice.finish_reason) finishReason = choice.finish_reason === 'length' ? 'length' : 'stop';
    } catch { /* keep-alive */ }
  });
  return { finishReason };
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
  return { finishReason: 'stop' };
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

  let finishReason = '';
  await consumeSse(res, (payload) => {
    try {
      const obj = JSON.parse(payload);
      if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') {
        onToken(obj.delta.text);
      } else if (obj.type === 'message_delta' && obj.delta && obj.delta.stop_reason) {
        finishReason = obj.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
      }
    } catch { /* keep-alive */ }
  });
  return { finishReason };
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
    // Some servers frame events with \r\n — normalize before splitting
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const ev of events) {
      for (const line of ev.split('\n')) {
        if (line.startsWith('data:')) onPayload(line.slice(5).trim());
      }
    }
  }
  // A final event without the trailing blank line must not be lost
  for (const line of buf.split('\n')) {
    if (line.startsWith('data:')) onPayload(line.slice(5).trim());
  }
}

// ---------------------------------------------------------------------------
// System prompts
//
// The knowledge itself lives in knowledge.js as small topic cards; every
// question only gets the cards that match it. The answer-format contract is
// REQUIRED by the renderer: the FIRST ```powershell block is what the Kør
// button / auto-run uses, and a lone KØRER line marks "the user asked me to
// run it" (answer.js strips it from the visible text).
// ---------------------------------------------------------------------------

const { selectCards, renderCards } = require('./knowledge');

// Static part first: llama-server caches the shared prompt prefix, so only
// the small VIDEN block at the end is re-processed per question.
const EMBEDDED_CORE = [
  'Du er Lennart — den indbyggede offline-assistent i Lennart Terminal på Windows.',
  'Brugeren er ikke programmør: forklar i almindeligt, venligt dansk, som til en ven.',
  '',
  'SÅDAN SVARER DU',
  '- Svar altid på dansk. Begynd direkte med svaret — ingen indledning, gentag ikke spørgsmålet.',
  '- Giv kommandoer i ```powershell-kodeblokke. Den første kodeblok er den, appens Kør-knap kører.',
  '- Et enkelt spørgsmål: 1-2 sætninger, én kodeblok, én kort afsluttende sætning.',
  '- En opsætning med flere trin: højst 4 korte trin. Hvert trin er én sætning, der siger HVOR det køres (fx "på hver mål-PC" eller "på din egen PC"), efterfulgt af én kodeblok.',
  '- Brug fakta fra VIDEN herunder. Hold dig til emnet i spørgsmålet — bland aldrig andre emner ind.',
  '- Skriv hvert trin og hver kommando kun én gang. Når svaret er givet, så stop.',
  '- Ingen overskrifter med #. Kun Windows PowerShell eller CMD — aldrig Linux-kommandoer.',
  '- Advar kort før kommandoer, der sletter, stopper eller ændrer noget.',
  '- Ved tvivl: sig ærligt, hvad du ikke ved, i stedet for at gætte.',
  '- Kun hvis brugeren beder dig udføre kommandoen: skriv ordet KØRER alene på sidste linje. Ellers aldrig.',
].join('\n');

const CLOUD_CORE = [
  'Du er Lennart, AI-assistenten i Lennart Terminal — en Windows-terminal (PowerShell) med AI-panel, fjern-faner til andre PC\'er (SSH eller WinRM) og en agent-tilstand.',
  'Brugeren er ikke nødvendigvis programmør: svar på dansk i almindeligt, venligt sprog — kort, konkret og korrekt.',
  '',
  'Regler:',
  '- Windows + PowerShell er standardmiljøet, medmindre brugeren siger andet.',
  '- Kommandoer står i egne ```powershell-kodeblokke. Hver blok får knapperne Kopiér, Indsæt og Kør (Kør kører i den aktive fane — også en fjern-fane).',
  '- Ved opsætninger: korte trin, og skriv tydeligt hvor hvert trin køres (fx på hver mål-PC eller på din egen PC).',
  '- Opfind aldrig kommando-output eller filindhold — sig hvad brugeren skal tjekke.',
  '- Advar tydeligt før destruktive kommandoer (sletning, formatering, force-push, stop af processer).',
  '- Du kan ikke selv køre noget i chat-tilstand — brugeren trykker Kør.',
].join('\n');

/**
 * System prompt for the chat panel.
 * opts.embedded — the small built-in offline model (strict, short prompt)
 * opts.question — the latest user message (selects the knowledge cards)
 * opts.previous — the user message before it (follow-up questions)
 */
function buildChatSystemPrompt({ embedded = true, question = '', previous = '' } = {}) {
  const cards = selectCards(question, previous, { max: embedded ? 2 : 3 });
  const core = embedded ? EMBEDDED_CORE : CLOUD_CORE;
  return `${core}\n\nVIDEN (brug kun det, der passer til spørgsmålet):\n${renderCards(cards)}`;
}

/** Back-compat: the embedded prompt without a question (general card). */
function buildPowerShellSystemPrompt(question) {
  return buildChatSystemPrompt({ embedded: true, question: question || '' });
}

/** Back-compat: the prompt used for bigger/cloud models. */
function buildAgentSystemPrompt(question) {
  return buildChatSystemPrompt({ embedded: false, question: question || '' });
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
  buildChatSystemPrompt,
  agyAvailable,
  listAgyModels,
  runAgyAgent,
};
