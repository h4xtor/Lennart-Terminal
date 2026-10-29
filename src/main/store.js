'use strict';

/**
 * Settings store (v2 shape) with defaults + legacy migration.
 * Location: %APPDATA%/Lennart Terminal/settings.json
 */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Providers that have ever existed in this app. Anything else in a saved
// settings file is stale (renamed/removed) and would otherwise fall through
// to the HTTP chat path with an empty baseUrl and crash the chat with
// "Failed to parse URL". v3.1 migrates those to the embedded offline AI.
const KNOWN_PROVIDERS = new Set([
  'lennart-local',
  'antigravity-cli',
  'ollama', 'lmstudio', 'llamacpp', 'openai-compatible',
  'openrouter', 'omniroute', 'openai', 'anthropic', 'gemini', 'dashscope', 'moonshot',
]);

// Provider ids used by older builds → their current equivalent. These used to
// look "known" and slip through migration, leaving Settings with a provider
// id that no longer exists in the catalog (empty select, chat errors).
const PROVIDER_ALIASES = {
  local: 'ollama',
  qwen: 'dashscope',
  kimi: 'moonshot',
};

const DEFAULTS = {
  version: 3.1,
  shell: 'powershell',
  fontScale: 1,

  // active AI configuration (used for chat + built-in agent)
  // 'lennart-local' = the embedded offline PowerShell assistant (hardcoded)
  ai: {
    provider: 'lennart-local',
    model: '',
    baseUrl: '',        // optional override, empty = provider default
    temperature: 0.4,
    maxTokens: 0,       // 0 = provider default, otherwise 256…2048
    topP: 1,            // 0.5…1, 1 = standard sampling
  },

  // embedded llama.cpp server settings (Settings → Model-indstillinger)
  localAI: {
    // Context window passed as -c. The embedded assistant ships a full
    // training compendium as its system prompt (buildPowerShellSystemPrompt
    // in ai.js, ~2.5k tokens), so 8192 is the default — 4096 would leave
    // too little room for the conversation itself.
    ctx: 8192,
    threads: 0,         // 0 = auto (cores-1, max 4)
  },

  // AI may auto-run a command when the user explicitly asks for it
  aiAutoRun: true,

  // appearance (Settings → Farver): preset classes + accent colour
  theme: {
    preset: 'standard', // standard | black | ocean | terminal | lys
    accent: '#7c6cff',
  },

  // per-provider storage: API keys + last selected model + optional baseUrl
  providers: {
    // openrouter: { apiKey: 'sk-or-…', model: 'anthropic/claude-…' },
  },

  // agent engine: 'builtin' (terminal autopilot) or 'antigravity' (agy CLI)
  agentEngine: 'builtin',
  agentAutoApprove: false,     // skip destructive confirmations (not recommended)
  agyModel: '',                // model passed to agy --model

  // known network hosts for remote command execution ({id, name, host, method, username, password, keyPath})
  hosts: [],

  chatMode: 'chat',            // 'chat' | 'agent'
  agentMode: true,             // system prompt in chat mode
  confirmDestructive: true,

  windowBounds: null,
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function mergeDefaults(target, defaults) {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined) {
      out[key] = isPlainObject(value) ? mergeDefaults({}, value) : value;
    } else if (isPlainObject(value)) {
      out[key] = mergeDefaults(out[key], value);
    }
  }
  return out;
}

class SettingsStore {
  constructor() {
    // Portable mode: LENNART_DATA_DIR (e.g. the USB stick's Data folder)
    // holds settings + history + local AI assets. The launcher always sets
    // it, so the app runs portable by default; without it we use userData.
    this.dataDir =
      process.env.LENNART_DATA_DIR ||
      (app
        ? app.getPath('userData')
        : path.join(process.env.APPDATA || os.tmpdir(), 'Lennart Terminal'));
    this.file = path.join(this.dataDir, 'settings.json');
    this._migrateIntoPortable();
    this.data = this._load();
    this._migrateStaleProvider();
    this._migrateLocalAiCtx();
    this._write();
  }

  /**
   * v3.2: the embedded assistant got a full training compendium in its
   * system prompt, and 4096 tokens no longer leaves room for a conversation
   * on top of it. Raise ONLY saved ctx values that still sit on the old
   * default (4096) — an explicit 2048 (weak PC) or 8192/16384 choice is the
   * user's decision and stays untouched.
   */
  _migrateLocalAiCtx() {
    const lai = this.data && this.data.localAI;
    if (lai && Number(lai.ctx) === 4096) {
      lai.ctx = 8192;
    }
  }

  /**
   * One-time fix for settings saved by older builds that point at a provider
   * id this version does not know (f.eks. 'antigravity-cli' fra v0.1.0-preview
   * builds where it behaved differently). Chat would fail with
   * "Failed to parse URL" — switch to the embedded offline AI instead.
   */
  _migrateStaleProvider() {
    const ai = this.data && this.data.ai;
    if (ai && PROVIDER_ALIASES[ai.provider]) {
      ai.provider = PROVIDER_ALIASES[ai.provider];
    }
    if (ai && ai.provider && !KNOWN_PROVIDERS.has(ai.provider)) {
      this.data.ai.provider = DEFAULTS.ai.provider;
      this.data.ai.model = '';
      this.data.version = DEFAULTS.version;
    }
    // Move the saved key/model record to the renamed provider as well.
    const providers = this.data && this.data.providers;
    if (isPlainObject(providers)) {
      for (const [oldId, newId] of Object.entries(PROVIDER_ALIASES)) {
        if (!providers[oldId]) continue;
        providers[newId] = { ...providers[oldId], ...(providers[newId] || {}) };
        delete providers[oldId];
      }
    }
  }

  /**
   * First portable boot on a machine that used the old %APPDATA% location:
   * carry the existing settings (API keys, hosts) onto the portable drive.
   */
  _migrateIntoPortable() {
    if (!process.env.LENNART_DATA_DIR || fs.existsSync(this.file)) return;
    try {
      const legacyDir = app
        ? app.getPath('userData')
        : path.join(process.env.APPDATA || '', 'Lennart Terminal');
      const legacy = path.join(legacyDir, 'settings.json');
      if (fs.existsSync(legacy)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.copyFileSync(legacy, this.file);
      }
    } catch { /* a fresh portable start is always acceptable */ }
  }

  _load() {
    const raw = this._read();
    const migrated = migrateLegacy(raw);
    return mergeDefaults(migrated, DEFAULTS);
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('settings write failed:', err);
    }
  }

  get(key) {
    if (key === undefined) return this.data;
    return this.data[key];
  }

  getAll() {
    return JSON.parse(JSON.stringify(this.data));
  }

  set(patch) {
    if (!isPlainObject(patch)) return;
    for (const [key, value] of Object.entries(patch)) {
      if (isPlainObject(value) && isPlainObject(this.data[key])) {
        this.data[key] = { ...this.data[key], ...value };
      } else {
        this.data[key] = value;
      }
    }
    this._write();
  }

  reset() {
    this.data = mergeDefaults({}, DEFAULTS);
    this._write();
  }
}

/**
 * v1 files had: ai: { provider, model, baseUrl, apiKey } — move apiKey into
 * providers[provider].apiKey and remember the model pick per provider.
 */
function migrateLegacy(raw) {
  if (!raw || raw.version >= 2 || !isPlainObject(raw.ai)) return raw || {};
  const out = { ...raw };
  const ai = { ...raw.ai };
  out.providers = isPlainObject(raw.providers) ? { ...raw.providers } : {};

  if (ai.apiKey) {
    const pid = ai.provider || 'ollama';
    out.providers[pid] = { ...(out.providers[pid] || {}), apiKey: ai.apiKey };
    delete ai.apiKey;
  }
  out.ai = ai;
  return out;
}

module.exports = SettingsStore;
