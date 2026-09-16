'use strict';

/**
 * Settings store (v2 shape) with defaults + legacy migration.
 * Location: %APPDATA%/Lennart Terminal/settings.json
 */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  version: 2,
  shell: 'powershell',
  fontScale: 1,

  // active AI configuration (used for chat + built-in agent)
  ai: {
    provider: 'ollama',
    model: '',
    baseUrl: '',        // optional override, empty = provider default
    temperature: 0.4,
  },

  // per-provider storage: API keys + last selected model + optional baseUrl
  providers: {
    // openrouter: { apiKey: 'sk-or-…', model: 'anthropic/claude-…' },
  },

  // agent engine: 'builtin' (terminal autopilot) or 'antigravity' (agy CLI)
  agentEngine: 'builtin',
  agentAutoApprove: false,     // skip destructive confirmations (not recommended)
  agyModel: '',                // model passed to agy --model

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
    const userData = app
      ? app.getPath('userData')
      : path.join(process.env.APPDATA || os.tmpdir(), 'Lennart Terminal');
    this.file = path.join(userData, 'settings.json');
    this.data = this._load();
    this._write();
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
