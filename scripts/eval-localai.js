'use strict';

/**
 * Answer-quality exam for the built-in offline AI.
 *
 * Asks a fixed set of realistic Danish questions through the REAL pipeline
 * (system prompt + chat() + answer guard, same as main.js) against a running
 * llama-server, and grades every answer:
 *
 *   hard fails: wrong/missing key command, off-topic command, no code block,
 *               repeated lines, loop stop, leaked prompt text, cut off,
 *               not Danish (English/Norwegian sentences)
 *   soft notes: slow (> 90 s on this machine), long (> 1200 chars)
 *
 *   node scripts/eval-localai.js [baseUrl] [--only=id,id] [--json=file]
 *   default baseUrl http://127.0.0.1:9601/v1
 *
 * Exit code 1 when any answer fails a hard check.
 */

const fs = require('fs');
const { chat, buildChatTurns } = require('../src/main/ai');
const { createAnswerGuard, analyzeAnswer } = require('../src/main/answer');

const args = process.argv.slice(2);
const BASE = args.find((a) => /^https?:/.test(a)) || 'http://127.0.0.1:9601/v1';
const ONLY = ((args.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const JSON_OUT = (args.find((a) => a.startsWith('--json=')) || '').slice(7);
// --no-example: the previous behaviour (rules only, no example turn) — for A/B
const NO_EXAMPLE = args.includes('--no-example');

const CASES = [
  {
    id: 'winrm-setup',
    q: 'Forklar mig hvordan WinRM fungerer og opsættes? Jeg skal køre PowerShell-kommandoer på 15 PC\'er uden at gå rundt til dem.',
    must: [/Enable-PSRemoting/i, /Invoke-Command/i, /TrustedHosts/i],
    mustNot: [/sshd|OpenSSH|ssh-keygen|Get-SmbShare|authorized_keys|Remote Server Administration Tools/i],
  },
  {
    id: 'winrm-test',
    q: 'Hvordan tjekker jeg om WinRM virker på en anden PC med IP 192.168.1.50?',
    must: [/Test-WSMan|Test-NetConnection[^\n]*5985/i],
    mustNot: [/sshd|OpenSSH/i],
  },
  {
    id: 'port',
    q: 'Hvordan finder jeg ud af, hvilken proces der lytter på port 3000?',
    must: [/Get-NetTCPConnection|netstat/i],
    mustNot: [/sshd/i],
  },
  {
    id: 'bigfiles',
    q: 'Skriv en PowerShell-linje der viser de 5 største filer i denne mappe',
    must: [/Sort-Object\s+(-Property\s+)?Length\s+-Desc/i, /-First 5|Select-Object -First 5/i],
    mustNot: [],
  },
  {
    id: 'rdp',
    q: 'Hvordan slår jeg Remote Desktop til på en PC?',
    must: [/fDenyTSConnections/i],
    mustNot: [/sshd|Enable-PSRemoting/i],
  },
  {
    id: 'spooler',
    q: 'Print spooleren hænger — hvordan genstarter jeg den?',
    must: [/Restart-Service\s+(-Name\s+)?Spooler|Stop-Service\s+(-Name\s+)?Spooler/i],
    mustNot: [/sshd|Get-Printer -Name "?Spooler/i],
  },
  {
    id: 'ip-run',
    q: 'Hvad er kommanden til at vise IP-konfigurationen — og vil du udføre den for mig?',
    must: [/ipconfig|Get-NetIPConfiguration/i],
    mustNot: [],
    wantsRun: true,
  },
  {
    id: 'disk',
    q: 'Hvor meget ledig plads er der på mine drev?',
    must: [/Get-PSDrive|Get-Volume|Win32_LogicalDisk/i],
    mustNot: [/sshd/i],
  },
  {
    id: 'slow',
    q: 'Min PC er blevet langsom. Hvad skal jeg tjekke først?',
    must: [/Get-Process/i],
    mustNot: [/sshd|Format-Volume|Remove-Item/i],
  },
  {
    id: 'dns',
    q: 'Jeg kan pinge 8.8.8.8 men ikke google.com. Hvad er galt?',
    must: [/DNS/i, /flushdns|Clear-DnsClientCache|Resolve-DnsName|nslookup/i],
    mustNot: [/sshd/i],
  },
  {
    id: 'app-shortcut',
    q: 'Hvordan åbner jeg historikken i Lennart Terminal?',
    must: [/Ctrl ?\+ ?H/i],
    mustNot: [/sshd/i],
    noCode: true,
  },
  {
    id: 'winget',
    q: 'Hvordan installerer jeg Google Chrome med en kommando?',
    must: [/winget install/i],
    mustNot: [/apt|sudo|brew/i],
  },
];

// Not Danish: an English or Norwegian sentence in the prose.
const NOT_DANISH = [
  /\b(the|you|and|your|this|with|that|following)\b.*\b(the|you|and|your|is|are|to)\b/i,
  /\b(å (sikre|gjøre|kjøre|se|finne)|gjøre|stegene|trinnene|kjør|lar (dig|deg|dem)|kørs)\b/i,
];

function prose(text) {
  return String(text).replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

async function ask(c) {
  const built = buildChatTurns({ embedded: true, messages: [{ role: 'user', content: c.q }] });
  const system = built.system;
  const messages = NO_EXAMPLE ? [{ role: 'user', content: c.q }] : built.messages;
  let raw = '';
  const ctrl = new AbortController();
  const guard = createAnswerGuard({ strict: true, onAbort: () => ctrl.abort() });
  let meta = {};
  const t0 = Date.now();
  try {
    meta = await chat(
      { provider: 'openai-compatible', embeddedLocal: true, baseUrl: BASE, model: 'local', apiKey: 'local', temperature: 0.4 },
      messages,
      { system, signal: ctrl.signal, onToken: (t) => { raw += t; guard.push(t); } },
    ) || {};
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  const final = guard.finish({ truncated: meta.finishReason === 'length' });
  return { raw, text: final.text, final, ms: Date.now() - t0 };
}

function grade(c, res) {
  const hard = [];
  const soft = [];
  const a = analyzeAnswer(res.text);
  const p = prose(res.text);
  if (!c.noCode && !a.hasCodeBlock) hard.push('ingen kodeblok');
  if (a.repeatedLines.length) hard.push(`gentagne linjer (${a.repeatedLines.length})`);
  if (res.final.stoppedLoop) hard.push('løkke stoppet');
  if (res.final.truncated) hard.push('afskåret');
  if (a.leak) hard.push('prompt-tekst lækket');
  for (const re of c.must) if (!re.test(res.text)) hard.push(`mangler ${re}`);
  for (const re of c.mustNot) if (re.test(res.text)) hard.push(`forkert emne ${re}`);
  if (NOT_DANISH.some((re) => re.test(p))) hard.push('ikke rent dansk');
  if (c.wantsRun && !res.final.runRequested) soft.push('intet KØRER-mærke');
  if (res.ms > 90000) soft.push(`langsom ${Math.round(res.ms / 1000)} s`);
  if (res.text.length > 1200) soft.push(`langt ${res.text.length} tegn`);
  return { hard, soft };
}

async function main() {
  const cases = ONLY.length ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
  const results = [];
  for (const c of cases) {
    const res = await ask(c);
    const g = grade(c, res);
    results.push({ id: c.id, ms: res.ms, chars: res.text.length, ...g, text: res.text });
    console.log('='.repeat(78));
    console.log(`[${c.id}] ${c.q}`);
    console.log(`-- ${Math.round(res.ms / 1000)} s · ${res.text.length} tegn`);
    console.log(res.text);
    console.log(g.hard.length ? `FAIL: ${g.hard.join('; ')}` : 'PASS', g.soft.length ? `(${g.soft.join('; ')})` : '');
  }
  const passed = results.filter((r) => !r.hard.length).length;
  const avg = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length / 1000);
  console.log('='.repeat(78));
  console.log(`RESULTAT: ${passed}/${results.length} bestod · gennemsnit ${avg} s pr. svar`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, passed, total: results.length, avg, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
