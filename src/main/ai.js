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
  'Lokale / private',
  'Cloud (API-nøgle)',
  'Agent-motor',
];

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
  return { provider: cfg.provider, protocol: info.protocol || 'openai', baseUrl, apiKey };
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
    throw new Error('Ingen base URL konfigureret');
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

  const temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : 0.4;

  if (protocol === 'ollama') {
    return chatOllama({ baseUrl, model, messages, system, temperature, onToken, signal });
  }
  if (protocol === 'anthropic') {
    return chatAnthropic({ baseUrl, model, messages, system, temperature, apiKey, onToken, signal });
  }
  if (protocol === 'agy') {
    return chatAgy({ messages, system, onToken, signal, model, allowTools: false });
  }
  return chatOpenAICompatible({ baseUrl, model, messages, system, temperature, apiKey, onToken, signal });
}

async function chatOllama({ baseUrl, model, messages, system, temperature, onToken, signal }) {
  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: true,
    options: { temperature },
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

async function chatOpenAICompatible({ baseUrl, model, messages, system, temperature, apiKey, onToken, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  headers['HTTP-Referer'] = 'https://lennart-terminal.local';
  headers['X-Title'] = 'Lennart Terminal';

  const body = {
    model,
    stream: true,
    temperature,
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

async function chatAnthropic({ baseUrl, model, messages, system, temperature, apiKey, onToken, signal }) {
  if (!apiKey) throw new Error('Anthropic kræver en API-nøgle (Settings → API Keys)');

  const body = {
    model,
    max_tokens: 4096,
    temperature,
    stream: true,
    ...(system ? { system } : {}),
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

module.exports = {
  chat,
  listModels,
  PROVIDERS,
  PROVIDER_GROUPS,
  providerInfo,
  buildAgentSystemPrompt,
  agyAvailable,
  listAgyModels,
  runAgyAgent,
};
