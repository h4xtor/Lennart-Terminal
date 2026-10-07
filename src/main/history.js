'use strict';

/**
 * Permanent history: every command run through Lennart Terminal (prompt box,
 * AI Run, agent steps, remote hosts) and every AI question/answer is appended
 * to a JSONL file in the data dir — which is the USB stick's Data folder in
 * portable mode, so the full troubleshooting trail travels with the stick.
 */

const fs = require('fs');
const path = require('path');

const MAX_OUTPUT_CHARS = 2500;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // rotate at ~5 MB

function tail(s, n) {
  const v = String(s || '');
  return v.length <= n ? v : `…${v.slice(-n)}`;
}

class HistoryStore {
  constructor(file, opts) {
    this.file = file;
    this.maxBytes = (opts && opts.maxBytes) || MAX_FILE_BYTES;
  }

  add(entry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.maxBytes) {
        // keep one generation of rotation
        try { fs.unlinkSync(this.file + '.1'); } catch { /* first rotation */ }
        fs.renameSync(this.file, this.file + '.1');
      }
      const rec = {
        t: Date.now(),
        type: entry.type || 'local',          // local|remote|agent|ai
        host: entry.host || 'local',
        command: tail(entry.command, 4000),
        output: entry.output ? tail(entry.output, MAX_OUTPUT_CHARS) : '',
        ok: entry.ok,
      };
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf8');
      return true;
    } catch {
      return false; // history must never break the app
    }
  }

  /** Newest first. opts: { limit, query, type } */
  query(opts) {
    const o = opts || {};
    const limit = Math.min(o.limit || 200, 1000);
    let lines = [];
    try {
      const files = [this.file, this.file + '.1'].filter((f) => fs.existsSync(f));
      for (const f of files) {
        const raw = fs.readFileSync(f, 'utf8');
        lines = lines.concat(raw.split('\n').filter(Boolean));
      }
    } catch {
      return [];
    }
    const q = (o.query || '').toLowerCase();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      if (o.type && rec.type !== o.type) continue;
      if (q && !(`${rec.command}\n${rec.output}`.toLowerCase().includes(q))) continue;
      out.push(rec);
    }
    return out;
  }

  clear() {
    try {
      for (const f of [this.file, this.file + '.1']) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { HistoryStore, tail, MAX_OUTPUT_CHARS };
