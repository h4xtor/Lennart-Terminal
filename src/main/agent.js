'use strict';

/**
 * Built-in autopilot agent.
 *
 * Loop: PLAN (model proposes JSON steps) -> RUN (write into live PTY, wait
 * for quiet, capture output) -> OBSERVE (model sees output, proposes next
 * step or DONE). Destructive commands need explicit user approval.
 */

const { chat, runAgyAgent } = require('./ai');

const STEP_TIMEOUT_MS = 120000;
const MAX_STEPS = 20;
const MAX_OUTPUT_CHARS = 12000;

const HARD_DENY = [
  /rm\s+-rf\s+\/(\s|$)/i,
  /format(\.com|\s+[c-z]:)/i,
  /diskpart/i,
  /shutdown\s+(\/[sr])/i,
  /cipher\s+\/w/i,
  /vssadmin\s+delete\s+shadows/i,
  /bcdedit/i,
];

function isHardDenied(cmd) {
  return HARD_DENY.some((re) => re.test(cmd));
}

function isDestructive(cmd) {
  const c = cmd.toLowerCase();
  return /\b(rm\s|remove-item|del\s|rd\s|format|diskpart|mkfs|dd\s+if=|git\s+push\s+(-f|--force)|git\s+reset\s+--hard|stop-process|taskkill|shutdown|reg\s+delete|net\s+user|netsh|sc\s+delete|kill)\b/.test(c);
}

function truncate(s, n = MAX_OUTPUT_CHARS) {
  return s.length <= n ? s : `…(truncated)…\n${s.slice(-n)}`;
}

function makeMarker() {
  return `__LT_DONE_${Math.random().toString(36).slice(2, 10).toUpperCase()}__`;
}

// Strip ANSI escapes + the marker line from captured output
function cleanOutput(raw, marker) {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !l.includes(marker) && !l.includes('__LT_DONE_'))
    .join('\n')
    .trim();
}

const PLAN_INSTRUCTION = `You are the Lennart Terminal autopilot agent. You control a live terminal on Windows (PowerShell).
Reply ONLY with minified JSON, no markdown, no prose:

{"thought":"one short sentence","done":false,"command":"the next shell command to run","expect":"what output should look like"}

Rules:
- One command per reply. Simple, self-contained commands (no interactive editors like vim/nano).
- "done":true when the job is complete (command can be "" then).
- If a command failed, adapt: read the error and change approach.
- Never run destructive commands unless strictly required by the job.`;

// ---------------------------------------------------------------------------
// Agent session
// ---------------------------------------------------------------------------

class AgentSession {
  constructor({ id, job, aiConfig, settings, deps }) {
    this.id = id;
    this.job = job;
    this.aiConfig = aiConfig || {};  // effective AI cfg incl. per-provider API key
    this.settings = settings || {};
    this.deps = deps;                // { emit, run, confirm, log }
    this.aborted = false;
    this.stepCount = 0;
  }

  abort() {
    this.aborted = true;
  }

  async run() {
    const emit = (event) => this.deps.emit(this.id, event);
    const history = [];

    emit({ type: 'status', text: 'Planlægger job…' });

    const cfg = this.aiConfig;
    const useAgy = cfg.provider === 'antigravity-cli';

    while (!this.aborted && this.stepCount < MAX_STEPS) {
      // ---- ask model for next step ----
      let decision;
      try {
        decision = useAgy ? await this.askAgy(history) : await this.askModel(history, cfg);
      } catch (err) {
        emit({ type: 'error', text: String(err.message || err) });
        return { ok: false, error: String(err.message || err) };
      }

      if (this.aborted) return { ok: false, aborted: true };

      if (decision.done) {
        emit({ type: 'status', text: 'Job gennemført ✅' });
        emit({ type: 'done', text: decision.thought || 'Færdig.' });
        return { ok: true, summary: decision.thought };
      }

      const cmd = (decision.command || '').trim();
      if (!cmd) {
        emit({ type: 'error', text: 'Modellen svarede uden kommando — stopper.' });
        return { ok: false, error: 'empty command' };
      }

      // ---- safety ----
      if (isHardDenied(cmd)) {
        emit({ type: 'error', text: `Blokeret (hard deny): ${cmd}` });
        emit({ type: 'done', text: 'Agenten forsøgte en blokeret kommando og er stoppet.' });
        return { ok: false, error: 'hard-denied command' };
      }

      if (this.settings.confirmDestructive !== false && isDestructive(cmd)) {
        emit({ type: 'status', text: `Venter på godkendelse: ${cmd}` });
        const ok = await this.deps.confirm(cmd);
        if (!ok) {
          emit({ type: 'error', text: 'Kommando afvist af bruger — agenten stopper.' });
          return { ok: false, error: 'user denied' };
        }
      }

      // ---- run ----
      emit({ type: 'command', text: cmd, thought: decision.thought });
      this.stepCount += 1;

      let output;
      try {
        output = await this.deps.run(cmd, STEP_TIMEOUT_MS);
      } catch (err) {
        output = `[command failed: ${err.message}]`;
      }
      emit({ type: 'output', text: truncate(output) });

      history.push({ command: cmd, output: truncate(output, 6000) });
    }

    if (this.stepCount >= MAX_STEPS) {
      emit({ type: 'error', text: `Stegrænse (${MAX_STEPS}) nået — stopper.` });
      return { ok: false, error: 'max steps' };
    }
    return { ok: false, aborted: true };
  }

  async askModel(history, cfg) {
    const userContent = [
      `JOB FROM USER: ${this.job}`,
      history.length ? '' : '(no steps run yet)',
      ...history.map((h) => `CMD: ${h.command}\nOUTPUT:\n${h.output}\n`),
      '',
      'Reply with ONLY the JSON object for the next step.',
    ].join('\n');

    let raw = '';
    await chat(cfg, [{ role: 'user', content: userContent }], {
      system: PLAN_INSTRUCTION,
      onToken: (t) => { raw += t; },
    });
    return parseDecision(raw);
  }

  async askAgy(history) {
    const prompt = [
      PLAN_INSTRUCTION,
      '',
      `JOB FROM USER: ${this.job}`,
      ...history.map((h) => `CMD: ${h.command}\nOUTPUT:\n${h.output}\n`),
      '',
      'Reply with ONLY the JSON object for the next step.',
    ].join('\n');
    const res = await runAgyAgent({ prompt, onEvent: null });
    return parseDecision(res.text || '');
  }
}

function parseDecision(raw) {
  // Models sometimes wrap JSON in ```json fences or prose — find the object
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Modellen svarede ikke med JSON: ${raw.slice(0, 160)}`);
  }
  const obj = JSON.parse(candidate.slice(start, end + 1));
  return {
    thought: String(obj.thought || ''),
    done: Boolean(obj.done),
    command: String(obj.command || ''),
  };
}

module.exports = { AgentSession, isDestructive, isHardDenied, parseDecision };
