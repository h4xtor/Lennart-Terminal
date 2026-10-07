'use strict';

/**
 * Embedded local AI ("Indbygget, offline").
 *
 * A hardcoded small PowerShell-capable model (Qwen2.5-Coder 1.5B Q4) runs via
 * llama.cpp's llama-server on 127.0.0.1. When the provider is 'lennart-local'
 * Lennart Terminal starts the server automatically at boot, so opening the
 * app from a USB stick gives a working offline AI chat.
 *
 * Binary + model live under userData/localai (the USB stick's Data folder in
 * portable mode) or app-local localai/llama-cpp (bundled at build time).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const PORT = 9601;
const LLAMA_RELEASE = 'b6969';
const LLAMA_ZIP_URL =
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-win-cpu-x64.zip`;

// The hardcoded offline PowerShell assistant. Chosen to be small enough for a
// USB stick while still being genuinely useful for PowerShell one-liners.
const LOCAL_MODEL = {
  id: 'qwen2.5-coder-1.5b-instruct-q4_k_m',
  file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
  label: 'Qwen2.5 Coder 1.5B · PowerShell-assistent (offline)',
  approxMB: 990,
};

// Extra small models the user can fetch from Settings → “Hent modeller”.
// All are genuinely small (1.5–3B Q4) so they stay USB-friendly and fast on
// the troubleshooting PCs. Files land in models/ and can be picked afterwards.
const MODEL_CATALOG = [
  {
    id: 'qwen2.5-coder-1.5b-instruct-q4_k_m',
    file: LOCAL_MODEL.file,
    url: LOCAL_MODEL.url,
    label: 'Qwen2.5 Coder 1.5B · indbygget PowerShell-assistent',
    sizeMB: 990,
  },
  {
    id: 'qwen2.5-coder-3b-instruct-q4_k_m',
    file: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    label: 'Qwen2.5 Coder 3B · bedre til PowerShell',
    sizeMB: 2000,
  },
  {
    id: 'phi-3.5-mini-instruct-q4',
    file: 'Phi-3.5-mini-instruct-q4.gguf',
    url: 'https://huggingface.co/microsoft/Phi-3.5-mini-instruct-gguf/resolve/main/Phi-3.5-mini-instruct-q4.gguf',
    label: 'Phi-3.5 Mini · Microsoft, stærk til kode',
    sizeMB: 2300,
  },
  {
    id: 'llama-3.2-3b-instruct-q4_k_m',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    label: 'Llama 3.2 3B · Meta',
    sizeMB: 2000,
  },
];

function binName(platform) {
  return (platform || process.platform) === 'win32' ? 'llama-server.exe' : 'llama-server';
}

function serverArgs(modelPath, port, threads, ctx) {
  const p = port || PORT;
  const t = threads || Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));
  const c = ctx || 4096;
  return ['-m', modelPath, '--host', '127.0.0.1', '--port', String(p), '-c', String(c), '-t', String(t)];
}

function healthUrl(port) {
  return `http://127.0.0.1:${port || PORT}/health`;
}

function chatUrl(port) {
  return `http://127.0.0.1:${port || PORT}/v1/chat/completions`;
}

/** Follow redirects (HuggingFace → CDN) and stream to disk with progress. */
function downloadFile(url, destFile, onProgress) {
  const maxRedirects = 5;
  return new Promise((resolve, reject) => {
    let redirectsLeft = maxRedirects;

    const get = (target) => {
      https.get(target, { headers: { 'User-Agent': 'LennartTerminal' } }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          if (redirectsLeft-- <= 0) {
            reject(new Error('For mange redirects'));
            return;
          }
          get(new URL(loc, target).toString());
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download fejlede: HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(destFile + '.part');
        res.on('data', (chunk) => {
          got += chunk.length;
          if (onProgress) onProgress({ got, total });
        });
        res.pipe(out);
        out.on('finish', () => {
          try {
            fs.renameSync(destFile + '.part', destFile);
            resolve(destFile);
          } catch (err) {
            reject(err);
          }
        });
        out.on('error', reject);
      }).on('error', reject);
    };

    get(url);
  });
}

function httpGetJson(url, timeoutMs) {
  const limit = timeoutMs || 2500;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: limit },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(buf));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function findFileRecursive(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return null;
}

function defaultRoot() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'localai');
  } catch {
    // plain node (tests / CLI) — mirror the non-portable default
    return path.join(process.env.APPDATA || process.cwd(), 'Lennart Terminal', 'localai');
  }
}

class LocalAI {
  constructor(opts) {
    const o = opts || {};
    this.port = o.port || PORT;
    this.model = o.model || LOCAL_MODEL;
    this.root = o.root || null;
    this.log = o.log || (() => {});
    this.emit = o.emit || (() => {});
    this.child = null;
    this.state = 'idle'; // idle|starting|running|no-binary|no-model|error
    this.lastError = '';
    this._ensurePromise = null;
    // Model settings (Settings → Model-indstillinger); 0 = auto/default.
    // configure() updates them — they apply the next time the server starts.
    this.ctx = 0;
    this.threads = 0;
  }

  configure(opts) {
    const o = opts || {};
    if (o.ctx !== undefined) this.ctx = Number(o.ctx) || 0;
    if (o.threads !== undefined) this.threads = Number(o.threads) || 0;
  }

  paths() {
    const root = this.root || defaultRoot();
    return {
      root,
      bin: path.join(root, 'llama-cpp', binName()),
      model: path.join(root, 'models', this.model.file),
    };
  }

  status() {
    const p = this.paths();
    return {
      state: this.state,
      running: this.state === 'running',
      lastError: this.lastError,
      binary: fs.existsSync(p.bin),
      model: fs.existsSync(p.model),
      modelId: this.model.id,
      modelLabel: this.model.label,
      port: this.port,
    };
  }

  /**
   * Ensure binary + model + healthy server. Concurrent calls share one
   * attempt; repeated calls after success resolve immediately.
   */
  ensure(opts) {
    const allowDownload = !opts || opts.allowDownload !== false;
    if (this.state === 'running' && this.child && !this.child.killed) {
      return Promise.resolve({ ok: true, baseUrl: `http://127.0.0.1:${this.port}/v1` });
    }
    if (this._ensurePromise) return this._ensurePromise;
    this._ensurePromise = this._ensure(allowDownload).finally(() => { this._ensurePromise = null; });
    return this._ensurePromise;
  }

  async _ensure(allowDownload) {
    this.state = 'starting';
    this.lastError = '';

    let bin = this.paths().bin;
    let model = this.paths().model;

    // A previously selected model may have been deleted from the stick —
    // fall back to the builtin model instead of downloading to a wrong name
    if (!fs.existsSync(model) && this.model.file !== LOCAL_MODEL.file) {
      this.model = LOCAL_MODEL;
      model = this.paths().model;
    }

    if (!fs.existsSync(bin)) {
      if (!allowDownload) throw new Error('llama.cpp-server er ikke downloadet endnu');
      bin = await this.downloadBinary((p) => this.emit('localai:progress', { step: 'binary', ...p }));
    }
    if (!fs.existsSync(model)) {
      if (!allowDownload) throw new Error('Modellen er ikke downloadet endnu');
      model = await this.downloadModel((p) => this.emit('localai:progress', { step: 'model', ...p }));
    }

    await this._start(bin, model);
    return { ok: true, baseUrl: `http://127.0.0.1:${this.port}/v1` };
  }

  _start(bin, modelPath) {
    const args = serverArgs(modelPath, this.port, this.threads, this.ctx);
    this.log(`localai: spawn ${bin} ${args.join(' ')}`);
    this.child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    return new Promise((resolve, reject) => {
      let settled = false;
      const deadline = Date.now() + 180000; // first load can be slow from USB HDD

      this.child.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        this.state = 'error';
        this.lastError = `llama-server afsluttede med kode ${code}`;
        reject(new Error(this.lastError));
      });

      const pollTimer = setInterval(() => {
        if (settled) return;
        httpGetJson(healthUrl(this.port), 1200)
          .then((h) => {
            if (h && h.status === 'ok' && !settled) {
              settled = true;
              clearInterval(pollTimer);
              this.state = 'running';
              resolve();
            }
          })
          .catch(() => { /* not ready yet */ });
        if (Date.now() > deadline && !settled) {
          settled = true;
          clearInterval(pollTimer);
          this.state = 'error';
          this.lastError = 'lokal AI-server svarer ikke (timeout 180s)';
          reject(new Error(this.lastError));
        }
      }, 700);
    });
  }

  downloadBinary(onProgress) {
    const bin = this.paths().bin;
    const dir = path.dirname(bin);
    fs.mkdirSync(dir, { recursive: true });
    const zip = bin + '.zip';
    this.log('localai: downloading llama.cpp ' + LLAMA_RELEASE);
    return downloadFile(LLAMA_ZIP_URL, zip, onProgress).then(() => new Promise((resolve, reject) => {
      // Expand-Archive (Windows PowerShell, built in) — tar cannot read zip
      // reliably across environments (Git Bash ships GNU tar).
      const ps = [
        '$ErrorActionPreference = "Stop"',
        `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${dir}" -Force`,
      ].join('; ');
      const t = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      t.on('exit', (code) => {
        try { fs.unlinkSync(zip); } catch { /* ignore */ }
        if (code !== 0) {
          reject(new Error(`udpakning fejlede (Expand-Archive exit ${code})`));
          return;
        }
        if (fs.existsSync(bin)) {
          resolve(bin);
          return;
        }
        // The zip may nest everything in a top-level folder — find the exe
        // anywhere below dir and move it into place.
        const found = findFileRecursive(dir, path.basename(bin));
        if (!found) {
          reject(new Error('llama-server fandtes ikke i zip-filen'));
          return;
        }
        try {
          fs.renameSync(found, bin);
          resolve(bin);
        } catch (err) {
          reject(err);
        }
      });
      t.on('error', reject);
    }));
  }

  downloadModel(onProgress) {
    const model = this.paths().model;
    fs.mkdirSync(path.dirname(model), { recursive: true });
    this.log('localai: downloading model ' + this.model.id);
    return downloadFile(this.model.url, model, onProgress);
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch { /* already dead */ }
      this.child = null;
    }
    this.state = 'idle';
  }

  // -----------------------------------------------------------------------
  // Model catalogue: what is on disk, what can be fetched, and selection
  // -----------------------------------------------------------------------

  /** Every GGUF file present under models/ (id = file stem, no extension). */
  listLocalModels() {
    const dir = path.join(this.paths().root, 'models');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* nothing downloaded yet */ }
    const out = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.gguf')) continue;
      let sizeMB = 0;
      try { sizeMB = Math.round(fs.statSync(path.join(dir, name)).size / 1048576); } catch { /* ignore */ }
      const id = name.replace(/\.gguf$/i, '');
      const builtin = name === LOCAL_MODEL.file;
      out.push({
        id,
        file: name,
        label: builtin ? LOCAL_MODEL.label : `${id} · ${sizeMB} MB`,
        sizeMB,
        builtin,
        active: this.model.file === name,
      });
    }
    // Builtin first, then alphabetical
    out.sort((a, b) => (b.builtin - a.builtin) || a.id.localeCompare(b.id));
    return out;
  }

  /** Catalogue entries with an `available` flag (already downloaded?). */
  modelCatalog() {
    const onDisk = new Set(this.listLocalModels().map((m) => m.file.toLowerCase()));
    return MODEL_CATALOG.map((m) => ({ ...m, available: onDisk.has(m.file.toLowerCase()) }));
  }

  /**
   * Switch to another model already present on disk. Returns true when the
   * active model changed (the server is stopped so it restarts with the new
   * file on the next ensure()). Unknown ids are ignored.
   */
  selectModel(id) {
    if (!id || id === this.model.id) return false;
    const found = this.listLocalModels().find((m) => m.id === id || m.file === id);
    if (!found) return false;
    if (this.state === 'running') this.stop();
    this.model = {
      id: found.id,
      file: found.file,
      label: found.label,
      url: (MODEL_CATALOG.find((m) => m.file === found.file) || {}).url || '',
    };
    this.log(`localai: selected model ${found.file}`);
    return true;
  }

  /** Download an extra model from the catalogue into models/. */
  downloadModelTo(spec) {
    const s = spec || {};
    const file = path.basename(String(s.file || ''));
    if (!file.toLowerCase().endsWith('.gguf')) {
      return Promise.reject(new Error('Filnavnet skal ende med .gguf'));
    }
    const url = String(s.url || '');
    if (!/^https:\/\//i.test(url)) {
      return Promise.reject(new Error('URL skal være https'));
    }
    const dest = path.join(this.paths().root, 'models', file);
    if (fs.existsSync(dest)) return Promise.resolve(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    this.log(`localai: downloading extra model ${file}`);
    const emit = (p) => this.emit('localai:progress', { step: 'model', file, ...p });
    emit({ got: 0, total: 0 });
    return downloadFile(url, dest, emit);
  }
}

module.exports = {
  LocalAI,
  LOCAL_MODEL,
  MODEL_CATALOG,
  LLAMA_ZIP_URL,
  PORT,
  binName,
  serverArgs,
  healthUrl,
  chatUrl,
  downloadFile,
  httpGetJson,
};
