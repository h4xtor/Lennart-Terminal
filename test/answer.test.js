'use strict';

/**
 * Answer guard + cleanup (src/main/answer.js). The fixtures are real answers
 * from the embedded 3B model that looped, leaked the prompt or got cut off.
 */

const assert = require('assert');
const { createAnswerGuard, cleanAnswer, analyzeAnswer } = require('../src/main/answer');

const FENCE = '```';

function feed(guard, text, chunk = 7) {
  for (let i = 0; i < text.length; i += chunk) {
    if (!guard.push(text.slice(i, i + chunk))) break;
  }
}

function testStopsRepeatedBullet() {
  // The screenshot: the same WinRM bullet streamed twice in a row
  const looped = [
    'WinRM lader dig styre andre PC\'er.',
    '- Du skal have WinRM-serveren på den anden PC konfigureret til at acceptere forbindelser.',
    '- Du skal have WinRM-serveren på den anden PC konfigureret til at acceptere forbindelser.',
    '- Du skal have WinRM-serveren på den anden PC konfigureret til at acceptere forbindelser.',
    '',
  ].join('\n');
  let aborted = 0;
  const g = createAnswerGuard({ strict: true, onAbort: () => { aborted += 1; } });
  feed(g, looped);
  assert.strictEqual(aborted, 1, 'the stream is aborted exactly once');
  assert.ok(g.stoppedLoop, 'guard reports the loop');
  const res = g.finish();
  assert.strictEqual(analyzeAnswer(res.text).repeatedLines.length, 0, 'no repeated lines survive');
  assert.ok(res.text.includes('WinRM lader dig'), 'the good part is kept');
  console.log('PASS loop guard stops a repeated bullet');
}

function testRunawayNumbering() {
  const lines = Array.from({ length: 14 }, (_, i) => `${i + 1}. Kør trin nummer ${i + 1} på maskine ${i * 7}`);
  let aborted = false;
  const g = createAnswerGuard({ onAbort: () => { aborted = true; } });
  feed(g, lines.join('\n') + '\n');
  assert.ok(aborted, 'a list that passes 9 numbered items is stopped');
  console.log('PASS runaway numbered list is stopped');
}

function testLenientForBigModels() {
  const text = 'På hver af de 15 PC\'er gør du følgende:\nA\nPå hver af de 15 PC\'er gør du følgende:\nB\n';
  let aborted = false;
  const g = createAnswerGuard({ strict: false, onAbort: () => { aborted = true; } });
  feed(g, text);
  assert.ok(!aborted, 'cloud models may repeat a line twice on purpose');
  assert.strictEqual(g.finish().text.split('På hver af').length - 1, 2, 'and nothing is removed for them');
  console.log('PASS lenient mode for bigger models');
}

function testCleanup() {
  const raw = [
    '### Trin 1',
    'Slå WinRM til på hver mål-PC:',
    `${FENCE}powershell`,
    '    Enable-PSRemoting -Force',
    FENCE,
    'Slå WinRM til på hver mål-PC:',
    `${FENCE}powershell`,
    'Enable-PSRemoting -Force',
    FENCE,
    '=== DEL 2: WINDOWS ===',
    'Regler: svar kort',
    'KØRER',
  ].join('\n');
  const res = cleanAnswer(raw);
  assert.ok(res.text.startsWith('**Trin 1**'), 'headings become bold lines');
  assert.strictEqual(res.text.split('Enable-PSRemoting').length - 1, 1, 'identical code block kept once');
  assert.strictEqual(res.text.split('Slå WinRM til').length - 1, 1, 'repeated lead-in kept once');
  assert.ok(!/DEL 2|Regler:/.test(res.text), 'leaked prompt lines removed');
  assert.ok(!/KØRER/.test(res.text), 'KØRER marker hidden from the reader');
  assert.strictEqual(res.runRequested, true, '…but reported to the app');
  assert.ok(cleanAnswer('Viden om netværk er nyttig.').text.includes('Viden om'), 'normal prose starting with "Viden" survives');
  console.log('PASS cleanup (headings, duplicate blocks, leaks, KØRER)');
}

function testTruncation() {
  // Cut off mid-code-block and mid-sentence (the screenshot ended "net use + Get-S")
  const raw = `Kør dette:\n${FENCE}powershell\nGet-Service WinRM\nTest-WSMan local`;
  const res = cleanAnswer(raw, { truncated: true });
  assert.ok(res.text.includes('Get-Service WinRM'), 'complete lines are kept');
  assert.ok(!res.text.includes('Test-WSMan local'), 'the half-written last line is dropped');
  assert.strictEqual((res.text.match(/```/g) || []).length, 2, 'the open code block is closed');
  assert.ok(/afkortet/.test(res.text), 'the reader is told the answer was cut off');

  const prose = cleanAnswer('Første linje er hel.\n- net use + Get-S', { truncated: true });
  assert.ok(!prose.text.includes('Get-S'), 'a half bullet is dropped');
  console.log('PASS truncated answers are tidied');
}

function testGuardFinishFlags() {
  const g = createAnswerGuard();
  feed(g, 'Kort svar.\n```powershell\nipconfig /all\n```\nFærdig.');
  const res = g.finish({ truncated: false });
  assert.strictEqual(res.stoppedLoop, false);
  assert.strictEqual(res.truncated, false);
  assert.ok(res.text.endsWith('Færdig.'), 'a clean answer passes through unchanged');
  console.log('PASS clean answers pass through');
}

function testRealFalsePositives() {
  // 1. A correct WinRM answer: two steps on the target PC share a lead-in.
  //    The first guard version killed this answer at the second lead-in.
  const winrm = [
    'WinRM lader din PC styre andre PC\'er.',
    '',
    'Kør følgende kommando på hver mål-PC:',
    `${FENCE}powershell`,
    'Enable-PSRemoting -Force -SkipNetworkProfileCheck',
    FENCE,
    'Kør følgende kommando på hver mål-PC:',
    `${FENCE}powershell`,
    'Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private',
    FENCE,
    'Kør følgende på din egen PC:',
    `${FENCE}powershell`,
    'Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value "192.168.1.*" -Force',
    FENCE,
    '',
  ].join('\n');
  let aborted = false;
  const g = createAnswerGuard({ strict: true, onAbort: () => { aborted = true; } });
  feed(g, winrm);
  assert.ok(!aborted, 'a repeated lead-in before DIFFERENT commands is not a loop');
  const res = g.finish();
  assert.strictEqual(res.text.split('Kør følgende kommando på hver mål-PC:').length - 1, 2, 'both lead-ins are kept');
  assert.ok(res.text.includes('TrustedHosts'), 'the whole answer survives');

  // 2. A repeating SEQUENCE is a loop even when each line is "new" text-wise
  const seq = 'Tjek kablet til routeren først.\nGenstart derefter routeren helt.\nTjek kablet til routeren først.\nGenstart derefter routeren helt.\n';
  let stopped = false;
  feed(createAnswerGuard({ onAbort: () => { stopped = true; } }), seq);
  assert.ok(stopped, 'a repeating two-line sequence is stopped');

  // 3. The spooler answer had the right command but no code block → no Kør button
  const bare = cleanAnswer('Genstart print-køen:\nStop-Service Spooler -Force; Start-Service Spooler');
  assert.ok(/```powershell\nStop-Service Spooler -Force; Start-Service Spooler\n```/.test(bare.text), 'a bare command line is wrapped in a powershell block');
  assert.ok(!/```/.test(cleanAnswer('Get-Process viser hvilke programmer der kører.').text), 'a sentence about a cmdlet is not fenced');

  // 4. ```Ctrl + H``` used as inline code
  assert.ok(cleanAnswer('Tryk ```Ctrl+H``` for historik.').text.includes('`Ctrl+H`'), 'one-line triple backticks become inline code');

  // 5. A dropped duplicate code block takes its lead-in with it
  const dup = cleanAnswer(`Kør dette:\n${FENCE}powershell\nipconfig /all\n${FENCE}\nOg igen her:\n${FENCE}powershell\nipconfig /all\n${FENCE}`);
  assert.ok(!dup.text.includes('Og igen her:'), 'lead-in of a removed duplicate block is removed too');
  // 6. Norwegian slips are fixed in prose, never in code
  const no = cleanAnswer('WinRM lar dig styre PC\'er, det kørs som admin.\n```powershell\n$lar = 1\n```\nBrug `lar dig` ikke.');
  assert.ok(no.text.startsWith('WinRM lader dig styre PC\'er, det køres som admin.'), 'lar dig → lader dig, kørs → køres');
  assert.ok(no.text.includes('$lar = 1') && no.text.includes('`lar dig`'), 'code and inline code untouched');
  console.log('PASS real false positives (repeated lead-ins, bare commands, inline fences)');
}

testStopsRepeatedBullet();
testRealFalsePositives();
testRunawayNumbering();
testLenientForBigModels();
testCleanup();
testTruncation();
testGuardFinishFlags();
console.log('ALL ANSWER TESTS PASSED');
