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

/**
 * Streaming guard.
 * opts.strict  — embedded small model: abort on the FIRST repeated line.
 *                Bigger models: abort only when a line shows up 3 times.
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
    if (n >= (strict ? 2 : 3)) stop();
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

  for (const line of src.split('\n')) {
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
          // empty or identical repeat of an earlier block → drop it entirely
          out.length = codeStart;
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

    // "### Trin 2" → "**Trin 2**" (headings make small models restart)
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    const prose = heading ? `**${heading[1].replace(/\*\*/g, '')}**` : line;

    const key = normLine(prose);
    if (strict && key.length >= MIN_LINE) {
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

  // Collapse 3+ blank lines and trim
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Strip an inline trailing marker ("… KØRER") the model glued to a sentence
  text = text.replace(/\s+KØRER\s*$/i, () => { runRequested = true; return ''; }).trim();
  if (note && text) {
    text += '\n\n_(Svaret blev afkortet — skriv “fortsæt”, hvis du vil have resten.)_';
  }
  return { text, runRequested, removed };
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
