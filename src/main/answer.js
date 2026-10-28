'use strict';

/**
 * Answer guard + cleanup for streamed AI answers.
 *
 * Small local models loop: the same bullet twice, then a third time, then a
 * numbered list that never ends. The guard watches the stream line by line
 * and pulls the plug (onAbort) the moment a loop is certain, and finish()
 * returns a cleaned answer:
 *
 *   - repeated prose lines and identical code blocks removed (first kept)
 *   - leaked prompt text ("=== DEL 2", "Regler:", "Bruger:") removed
 *   - markdown headings turned into bold lines (they restart the model)
 *   - an unclosed code block closed, a half-written last line dropped
 *   - the KØRER marker removed from the visible text (reported separately)
 *   - a short note when the answer was cut off by the token limit
 *
 * Pure functions, no I/O — unit-tested in test/answer.test.js.
 */

const MIN_LINE = 12;          // shorter lines ("```", "Eller:") may repeat legitimately
const MAX_NUMBERED = 9;       // "10." in one answer = a runaway list

// Case-sensitive on purpose: the prompt's own UPPERCASE section names leak,
// while normal Danish prose ("Viden om …") must survive.
const LEAK_RE = /^\s*(={3,}|DEL \d+\s*:|VIDEN\b|SÅDAN SVARER DU|Regler\s*:|Bruger\s*:|Svar\s*:|\[System\]|\[User\]|\[Assistant\]|<\|im_(start|end)\|>)/;
const RUN_MARKER_RE = /^\s*\**\s*KØRER\s*\**\s*\.?\s*$/i;
const FENCE_RE = /^\s*```/;

/** Normalize a prose line for duplicate detection. */
function normLine(line) {
  return String(line)
    .toLowerCase()
    .replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/, '')  // list markers / numbering
    .replace(/[*_`#>]/g, '')                        // markdown emphasis
    .replace(/[.,:;!?]+$/g, '')                     // trailing punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function normCode(code) {
  return String(code).split('\n').map((l) => l.trim()).filter(Boolean).join('\n').toLowerCase();
}

/** "Kør dette på hver mål-PC:" — a lead-in may legitimately repeat. */
function isLeadIn(line) {
  return /:\s*\**\s*$/.test(String(line));
}

/**
 * Streaming guard.
 * opts.strict  — embedded small model: abort as soon as a repeat is clearly
 *                a loop — the same line twice IN A ROW, the same two lines
 *                again (a repeating sequence), or any line a third time.
 *                Bigger models: only a line or code block 3 times.
 * Lead-in lines ending with ":" may repeat (each step introduces its own
 * code block) — they only count at the third time. The first version
 * stopped a correct WinRM answer on its second "…på hver mål-PC:".
 * opts.onAbort — called once when a loop is detected.
 */
function createAnswerGuard({ strict = true, onAbort } = {}) {
  let text = '';
  let pending = '';            // current, not yet completed line
  let inCode = false;
  let codeBuf = [];
  const seenLines = new Map(); // norm -> count
  const seenCode = new Map();
  let numbered = 0;
  let stoppedLoop = false;
  let lastKey = '';             // previous prose line (normalized)
  const seenPairs = new Set();  // "prev\nkey" sequences

  const stop = () => {
    if (stoppedLoop) return;
    stoppedLoop = true;
    try { if (onAbort) onAbort(); } catch { /* ignore */ }
  };

  const onLine = (line) => {
    if (FENCE_RE.test(line)) {
      if (inCode) {
        const key = normCode(codeBuf.join('\n'));
        if (key) {
          const n = (seenCode.get(key) || 0) + 1;
          seenCode.set(key, n);
          // a code block repeated 3 times is a loop for any model
          if (n >= 3) stop();
        }
        // the block itself is part of the sequence: "lead-in, block A" and
        // "lead-in, block B" are different steps, not a repeat
        lastKey = `code:${key}`;
        codeBuf = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) { codeBuf.push(line); return; }

    if (LEAK_RE.test(line) && strict) { stop(); return; }
    if (/^\s*\d{1,3}[.)]\s+/.test(line)) {
      numbered += 1;
      if (numbered > MAX_NUMBERED) { stop(); return; }
    }
    const key = normLine(line);
    if (key.length < MIN_LINE) return;
    const n = (seenLines.get(key) || 0) + 1;
    seenLines.set(key, n);
    const pair = `${lastKey}\n${key}`;
    const pairSeen = lastKey && seenPairs.has(pair);
    if (lastKey) seenPairs.add(pair);
    const consecutive = lastKey === key;
    lastKey = key;
    if (n >= 3) { stop(); return; }
    if (!strict || n < 2) return;
    if (consecutive || (pairSeen && !isLeadIn(line))) stop();
  };

  return {
    /** Feed one streamed token. Returns false once the guard has stopped. */
    push(token) {
      if (stoppedLoop) return false;
      text += token;
      pending += token;
      const parts = pending.split('\n');
      pending = parts.pop();
      for (const line of parts) {
        onLine(line);
        if (stoppedLoop) break;
      }
      return !stoppedLoop;
    },
    get stoppedLoop() { return stoppedLoop; },
    get text() { return text; },
    /** Final cleanup. opts.truncated = the provider hit its token limit. */
    finish({ truncated = false } = {}) {
      // A loop stop also leaves a half line behind, but the "skriv fortsæt"
      // note only makes sense for a real token-limit cut (fortsæt would loop)
      const res = cleanAnswer(text, {
        truncated: truncated || stoppedLoop,
        strict: strict || stoppedLoop,   // a proven loop is deduped for any model
        note: truncated && !stoppedLoop,
      });
      return { ...res, stoppedLoop, truncated: truncated && !stoppedLoop };
    },
  };
}

/**
 * Clean a complete answer. Returns { text, runRequested, removed }.
 * opts.truncated — the answer was cut off (limit or loop stop): drop the
 *                  half-written last line and close an open code block.
 * opts.strict    — remove repeated prose lines (small models). Off for big
 *                  models, where a repeated line is usually intentional.
 */
function cleanAnswer(raw, { truncated = false, strict = true, note = truncated } = {}) {
  let src = String(raw || '').replace(/\r/g, '');
  let runRequested = false;
  let removed = 0;

  // A cut-off answer ends mid-sentence — drop the unfinished last line
  if (truncated && src && !src.endsWith('\n')) {
    const cut = src.lastIndexOf('\n');
    const lastLine = cut >= 0 ? src.slice(cut + 1) : src;
    if (!FENCE_RE.test(lastLine)) src = cut >= 0 ? src.slice(0, cut) : '';
  }

  const out = [];
  const seenLines = new Set();
  const seenCode = new Set();
  let inCode = false;
  let codeStart = -1;
  let codeLines = [];

  for (let line of src.split('\n')) {
    if (FENCE_RE.test(line)) {
      if (!inCode) {
        inCode = true;
        codeStart = out.length;
        codeLines = [];
        out.push(line);
      } else {
        inCode = false;
        const key = normCode(codeLines.join('\n'));
        if (!key || seenCode.has(key)) {
          // empty or identical repeat of an earlier block → drop it entirely,
          // together with the lead-in line ("Kør dette:") that introduced it
          out.length = codeStart;
          while (out.length && !out[out.length - 1].trim()) out.pop();
          if (out.length && isLeadIn(out[out.length - 1])) out.pop();
          removed += 1;
        } else {
          seenCode.add(key);
          out.push(line);
        }
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      out.push(line);
      continue;
    }
    if (RUN_MARKER_RE.test(line)) { runRequested = true; continue; }
    if (LEAK_RE.test(line)) { removed += 1; continue; }

    line = danishFix(line);
    // "### Trin 2" → "**Trin 2**" (headings make small models restart)
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    const prose = heading ? `**${heading[1].replace(/\*\*/g, '')}**` : line;

    const key = normLine(prose);
    if (strict && key.length >= MIN_LINE && !isLeadIn(prose)) {
      if (seenLines.has(key)) { removed += 1; continue; }
      seenLines.add(key);
    }
    out.push(prose);
  }
  if (inCode) {
    // unclosed block: keep it if it has content, close the fence
    if (codeLines.some((l) => l.trim())) out.push('```');
    else out.length = codeStart;
  }

  // ```Ctrl+H``` on one line → `Ctrl+H` (the model's way of saying inline code)
  for (let i = 0; i < out.length; i++) {
    out[i] = out[i].replace(/```([^`\n]+?)```/g, '`$1`');
  }
  const fenced = autoFence(out);
  if (fenced) { out.length = 0; out.push(...fenced); }

  // Collapse 3+ blank lines and trim
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Strip an inline trailing marker ("… KØRER") the model glued to a sentence
  text = text.replace(/\s+KØRER\s*$/i, () => { runRequested = true; return ''; }).trim();
  if (note && text) {
    text += '\n\n_(Svaret blev afkortet — skriv “fortsæt”, hvis du vil have resten.)_';
  }
  return { text, runRequested, removed };
}

// A bare line that IS a command (no sentence around it)
const COMMAND_LINE_RE = /^\s*(?:\$\w+\s*=|\(?(?:Get|Set|New|Remove|Start|Stop|Restart|Test|Enable|Disable|Add|Invoke|Enter|Clear|Resolve|Select|Sort|Where|Format|Out|Rename|Install|Update|Import|Export|Measure|Write|Copy|Move)-[A-Z][A-Za-z]+\b|(?:ipconfig|ping|netstat|tracert|nslookup|winget|sfc|DISM|chkdsk|powercfg|netsh|nvidia-smi|mstsc|quser|whoami|hostname|gpupdate|shutdown|tasklist|taskkill|winrm)(?:\.exe)?(?:\s|$))/;
const SENTENCE_RE = /\s(er|viser|kan|skal|bruges|betyder|giver|hvis|fordi|så du|for at)\s/i;

/**
 * An answer WITHOUT any code block whose command sits on a bare line gets
 * that line wrapped in a ```powershell block — otherwise the Kør button
 * and auto-run have nothing to work with. Returns null when nothing changes.
 */
function autoFence(lines) {
  if (lines.some((l) => FENCE_RE.test(l))) return null;
  let changed = false;
  const res = [];
  let block = null;
  for (const l of lines) {
    const t = l.trim();
    const isCmd = COMMAND_LINE_RE.test(t) && !SENTENCE_RE.test(` ${t} `) && !/[.!?]$/.test(t) && t.length < 400;
    if (isCmd) {
      if (!block) { block = []; }
      block.push(t);
      continue;
    }
    if (block) { res.push('```powershell', ...block, '```'); block = null; changed = true; }
    res.push(l);
  }
  if (block) { res.push('```powershell', ...block, '```'); changed = true; }
  return changed ? res : null;
}

// Small models slip into Norwegian now and then ("lar dig", "kørs").
// Only unambiguous non-Danish words — never touches code or `inline code`.
const NO_TO_DA = [
  [/\blar (dig|dem|os|mig|det)\b/g, 'lader $1'],
  [/\bLar (dig|dem|os|mig|det)\b/g, 'Lader $1'],
  [/\bkørs\b/g, 'køres'],
  [/\bkjør(e|er)?\b/g, (m, e) => `kør${e || ''}`],
  [/\bgjøre\b/g, 'gøre'],
  [/\bikkje\b/g, 'ikke'],
  [/\bstegene\b/g, 'trinene'],
  [/\btrinnene\b/g, 'trinene'],
  [/\bfunktionerer\b/g, 'fungerer'],
];
function danishFix(line) {
  return String(line).split(/(`[^`]*`)/).map((part, i) => {
    if (i % 2) return part; // inline code stays untouched
    let t = part;
    for (const [re, to] of NO_TO_DA) t = t.replace(re, to);
    return t;
  }).join('');
}

/** Quality metrics for an answer (used by scripts/eval-localai.js + tests). */
function analyzeAnswer(text) {
  const lines = String(text || '').split('\n');
  const seen = new Map();
  let inCode = false;
  for (const l of lines) {
    if (FENCE_RE.test(l)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const k = normLine(l);
    if (k.length >= MIN_LINE) seen.set(k, (seen.get(k) || 0) + 1);
  }
  return {
    hasCodeBlock: /```[\s\S]*?```/.test(text),
    repeatedLines: [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    leak: lines.some((l) => LEAK_RE.test(l)),
    numbered: lines.filter((l) => /^\s*\d{1,3}[.)]\s+/.test(l)).length,
  };
}

module.exports = { createAnswerGuard, cleanAnswer, analyzeAnswer, normLine };
