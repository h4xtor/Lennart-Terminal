'use strict';

/**
 * Answer-quality evaluation for the embedded offline assistant.
 *
 * Runs a fixed set of realistic Danish questions against a running
 * llama-server (the same server Lennart Terminal starts on 127.0.0.1:9601)
 * through the REAL main-process pipeline (system prompt + chat() + answer
 * guard), and scores every answer on the things that went wrong in practice:
 * repeated lines, numbered loops, off-topic commands, missing code block,
 * prompt leakage and cut-off answers.
 *
 *   node scripts/eval-localai.js [baseUrl] [modelId]
 *   (default baseUrl http://127.0.0.1:9601/v1)
 *
 * Exit code 1 when any answer fails a hard check.
 */

const { chat, buildChatSystemPrompt } = require('../src/main/ai');
const { createAnswerGuard, analyzeAnswer } = require('../src/main/answer');

const BASE = process.argv[2] || 'http://127.0.0.1:9601/v1';
const MODEL = process.argv[3] || 'local';

// Each case: question + what a good answer MUST mention (any of) and must NOT.
const CASES = [
  {
    q: 'Forklar mig hvordan WinRM fungerer og opsættes? Jeg skal køre PowerShell-kommandoer på 15 PC\'er uden at gå rundt til dem.',
    must: [/Enable-PSRemoting/i, /Invoke-Command/i],
    mustNot: [/sshd/i, /OpenSSH/i, /Get-SmbShare/i],
  },
  {
    q: 'Hvordan finder jeg ud af, hvilken proces der lytter på port 3000?',
    must: [/Get-NetTCPConnection|netstat/i],
    mustNot: [/sshd/i],
  },
  {
    q: 'Skriv en PowerShell-linje der viser de 5 største filer i denne mappe',
    must: [/Sort-Object\s+Length|Sort Length/i],
    mustNot: [],
  },
  {
    q: 'Hvordan slår jeg Remote Desktop til på en PC?',
    must: [/fDenyTSConnections|Remote Desktop/i],
    mustNot: [/sshd/i],
  },
  {
    q: 'Print spooleren hænger — hvordan genstarter jeg den?',
    must: [/Spooler/i],
    mustNot: [/sshd/i],
  },
  {
    q: 'Hvad er kommanden til at vise IP-konfigurationen — og vil du udføre den for mig?',
    must: [/ipconfig|Get-NetIPConfiguration/i],
    mustNot: [],
    wantsRun: true,
  },
  {
    q: 'Hvordan tjekker jeg om WinRM virker på en anden PC med IP 192.168.1.50?',
    must: [/Test-WSMan|Test-NetConnection|5985|Invoke-Command/i],
    mustNot: [/sshd/i],
  },
];

async function ask(question) {
  const messages = [{ role: 'user', content: question }];
  const system = buildChatSystemPrompt({ embedded: true, question });
  let raw = '';
  const ctrl = new AbortController();
  const guard = createAnswerGuard({ onAbort: () => ctrl.abort() });
  let meta = {};
  const t0 = Date.now();
  try {
    meta = await chat(
      { provider: 'openai-compatible', embeddedLocal: true, baseUrl: BASE, model: MODEL, apiKey: 'local' },
      messages,
      { system, signal: ctrl.signal, onToken: (t) => { raw += t; guard.push(t); } },
    ) || {};
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  const final = guard.finish({ truncated: meta.finishReason === 'length' });
  return { raw, final: final.text, guard: final, ms: Date.now() - t0, finishReason: meta.finishReason };
}

async function main() {
  let failed = 0;
  for (const c of CASES) {
    const res = await ask(c.q);
    const a = analyzeAnswer(res.final);
    const problems = [];
    if (!a.hasCodeBlock) problems.push('ingen kodeblok');
    if (a.repeatedLines.length) problems.push(`gentagne linjer: ${a.repeatedLines.length}`);
    if (a.leak) problems.push('lækker prompt-tekst');
    if (!c.must.some((re) => re.test(res.final))) problems.push(`mangler: ${c.must.map(String).join(' | ')}`);
    for (const re of c.mustNot) if (re.test(res.final)) problems.push(`off-topic: ${re}`);
    if (c.wantsRun && !/KØRER/.test(res.raw)) problems.push('(blød) intet KØRER-mærke');
    const hard = problems.filter((p) => !p.startsWith('(blød)'));
    if (hard.length) failed++;
    console.log('='.repeat(78));
    console.log(`Q: ${c.q}`);
    console.log(`-- ${res.ms} ms · ${res.final.length} tegn · finish=${res.finishReason || '?'}${res.guard.stoppedLoop ? ' · LOOP STOPPET' : ''}${res.guard.removed ? ` · ${res.guard.removed} linjer fjernet` : ''}`);
    console.log(res.final);
    console.log(hard.length ? `FAIL: ${problems.join('; ')}` : `PASS${problems.length ? ` (${problems.join('; ')})` : ''}`);
  }
  console.log('='.repeat(78));
  console.log(`${CASES.length - failed}/${CASES.length} svar bestod`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
