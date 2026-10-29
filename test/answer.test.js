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

testStopsRepeatedBullet();
testRunawayNumbering();
testLenientForBigModels();
testCleanup();
testTruncation();
testGuardFinishFlags();
console.log('ALL ANSWER TESTS PASSED');
