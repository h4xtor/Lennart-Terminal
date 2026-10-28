'use strict';

/**
 * Offline smoke test for the AI layer (no Ollama needed).
 * Spins up a local mock server speaking both the Ollama API and the
 * OpenAI-compatible API, then verifies listModels + streaming chat.
 */

const http = require('http');
const assert = require('assert');
const {
  chat, listModels, buildAgentSystemPrompt, buildPowerShellSystemPrompt, buildChatSystemPrompt, buildChatTurns, PROVIDERS,
} = require('../src/main/ai');

const PORT = 18114;

// Captured request bodies, asserted after each chat() call in main().
let lastChatBody = null;
let lastOllamaOptions = null;

const server = http.createServer((req, res) => {
  res.setHeader('Connection', 'close'); // fresh connection per request (Windows keep-alive quirk)
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      models: [{ name: 'qwen2.5-coder:7b', size: 4700000000 }],
    }));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-coder' }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/or/api/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-4.6' }, { id: 'google/gemini-2.0-flash-001' }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/anthropic/v1/models') {
    if (req.headers['x-api-key'] !== 'sk-ant-test') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing key' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    ] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.ok(parsed.stream === true, 'ollama stream must be true');
      assert.ok(Array.isArray(parsed.messages), 'messages array expected');
      lastOllamaOptions = parsed.options;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const lines = [
        JSON.stringify({ message: { role: 'assistant', content: 'Run ' } }),
        JSON.stringify({ message: { role: 'assistant', content: '```powershell\nGet-Process\n```' } }),
        JSON.stringify({ done: true }),
      ];
      for (const l of lines) res.write(l + '\n');
      res.end();
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/anthropic/v1/messages') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        assert.ok(parsed.stream === true, 'anthropic stream must be true');
        assert.strictEqual(req.headers['x-api-key'], 'sk-ant-test', 'x-api-key header required');
        assert.ok(parsed.system, 'system prompt forwarded');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"content_block_delta","delta":{"text":"Claude says hi"}}\n\n');
        res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
        res.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`mock assert failed: ${err.message}`);
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.ok(parsed.stream === true, 'openai stream must be true');
      lastChatBody = parsed;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      const cut = parsed.messages.some((m) => m.content === 'cut me off');
      res.write(`data: {"choices":[{"delta":{"content":" world"},"finish_reason":"${cut ? 'length' : 'stop'}"}]}\r\n\r\n`);
      res.write('data: [DONE]');
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

/**
 * The embedded assistant gets a SHORT core prompt plus only the knowledge
 * cards that match the question. The real bug this locks down: a WinRM
 * question came back with sshd/OpenSSH steps because the old giant
 * compendium put every topic in front of a 3B model at once.
 */
function testFocusedPrompts() {
  const { CARDS, selectCards } = require('../src/main/knowledge');

  // --- the format contract the renderer depends on ---
  const p = buildChatSystemPrompt({ embedded: true, question: 'vis min IP' });
  assert.ok(p.includes('KØRER'), 'prompt keeps the KØRER auto-run marker');
  assert.ok(p.includes('```powershell'), 'prompt keeps the fenced powershell block format');
  assert.ok(/første kodeblok/i.test(p), 'prompt pins the runnable command to the FIRST block');
  assert.ok(/Svar altid på dansk/.test(p), 'prompt demands Danish answers');
  assert.ok(/kun én gang/.test(p), 'prompt forbids repeating steps');
  assert.ok(/højst 4 korte trin/.test(p), 'prompt caps multi-step answers');
  assert.ok(/Ingen overskrifter/.test(p), 'prompt forbids # headings');
  assert.ok(p.length < 3500, `embedded prompt stays small (${p.length} chars — the old one was ~11k)`);

  // --- WinRM: WinRM card only, no SSH card ---
  const winrm = buildChatSystemPrompt({ embedded: true, question: 'Forklar hvordan WinRM fungerer og opsættes? Jeg skal køre kommandoer på 15 PC\'er' });
  assert.ok(winrm.includes('Enable-PSRemoting'), 'WinRM question gets the WinRM card');
  assert.ok(winrm.includes('Invoke-Command'), 'WinRM card teaches running on many PCs');
  assert.ok(winrm.includes('TrustedHosts'), 'WinRM card covers TrustedHosts for non-domain PCs');
  assert.ok(!winrm.includes('sshd'), 'WinRM question does NOT get the SSH card (the screenshot bug)');
  assert.ok(!/Get-SmbShare/.test(winrm), 'WinRM question does not get SMB sharing commands');

  // --- topic routing ---
  const route = (q) => selectCards(q).map((c) => c.id);
  assert.deepStrictEqual(route('Hvordan finder jeg ud af hvilken proces der lytter på port 3000?')[0], 'ports');
  assert.deepStrictEqual(route('Hvordan slår jeg Remote Desktop til?')[0], 'rdp');
  assert.ok(!route('Hvordan slår jeg Remote Desktop til?').includes('winrm'), 'RDP is not mixed with WinRM');
  assert.deepStrictEqual(route('Print spooleren hænger')[0], 'services');
  assert.deepStrictEqual(route('Hvordan slår jeg ssh til?')[0], 'ssh');
  assert.deepStrictEqual(route('Hvad gør Ctrl+J i Lennart Terminal?')[0], 'app');
  assert.deepStrictEqual(route('hej'), ['general'], 'no match → general card');
  assert.ok(selectCards('og på de andre?', 'Hvordan virker WinRM?').some((c) => c.id === 'winrm'),
    'a follow-up question keeps the previous topic');

  // --- the knowledge base still covers the classic toolbox ---
  const all = CARDS.map((c) => c.text.join('\n')).join('\n');
  for (const cmd of ['Get-NetTCPConnection', 'ipconfig /all', 'Restart-Service', 'Get-PSDrive', 'Get-WinEvent',
    'sfc /scannow', 'nvidia-smi', 'Enable-PSRemoting', 'winget', 'Stop-Process', 'fDenyTSConnections']) {
    assert.ok(all.includes(cmd), `knowledge base covers "${cmd}"`);
  }
  for (const c of CARDS) {
    assert.ok(!c.text.some((l) => /^\s*\d+\.\s/.test(l)), `card ${c.id} has no numbered lines (the model copies them)`);
  }

  // --- the cloud prompt: Danish, app-aware, still carries "Lennart" ---
  const cloud = buildAgentSystemPrompt('Hvordan virker WinRM?');
  assert.ok(cloud.includes('Lennart'), 'cloud prompt keeps its identity');
  assert.ok(/dansk/.test(cloud), 'cloud prompt answers in Danish');
  assert.ok(cloud.includes('Invoke-Command'), 'cloud prompt gets the matching knowledge too');
  assert.ok(buildPowerShellSystemPrompt().includes('KØRER'), 'back-compat builder still works');

  console.log(`PASS focused prompts (${p.length} chars embedded, ${CARDS.length} knowledge cards, topic routing)`);
}

/**
 * The settings provider dropdown is built from PROVIDERS — every cloud
 * provider must carry a working OpenAI-compatible baseUrl, a key url the
 * user can follow, and sit in the Cloud group so it shows up in Settings.
 */
function testProviderCatalog() {
  const expected = {
    deepseek: 'https://api.deepseek.com',
    groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai/v1',
    xai: 'https://api.x.ai/v1',
    together: 'https://api.together.ai/v1',
    perplexity: 'https://api.perplexity.ai/router/v1',
  };
  for (const [id, url] of Object.entries(expected)) {
    const p = PROVIDERS[id];
    assert.ok(p, `catalog includes ${id}`);
    assert.strictEqual(p.baseUrl, url, `${id} baseUrl`);
    assert.strictEqual(p.protocol, 'openai', `${id} uses the OpenAI protocol`);
    assert.strictEqual(p.group, 'Cloud (API-nøgle)', `${id} shows in the Cloud group`);
    assert.ok(p.needsKey, `${id} requires a key`);
    assert.ok(p.keyUrl && p.keyUrl.startsWith('https://'), `${id} has a key url`);
    assert.ok(p.label && p.label.length > 2, `${id} has a label`);
  }
  // The pre-existing cloud providers must stay too
  for (const id of ['openrouter', 'openai', 'anthropic', 'gemini', 'dashscope', 'moonshot', 'omniroute']) {
    assert.ok(PROVIDERS[id], `catalog still includes ${id}`);
  }
  console.log(`PASS provider catalog (${Object.keys(expected).length} new cloud providers + existing)`);
}

/**
 * The built-in model gets ONE example exchange (from the matching card) in
 * front of the first question — small models copy the shape of a real turn.
 */
function testExampleTurns() {
  const { CARDS } = require('../src/main/knowledge');
  for (const c of CARDS) {
    assert.ok(c.example && c.example.q && c.example.a, `card ${c.id} has an example answer`);
    assert.ok(!/^\s*\d+\.\s/m.test(c.example.a), `example ${c.id} has no numbered list`);
    assert.ok(!/^#/m.test(c.example.a), `example ${c.id} has no headings`);
    assert.ok(c.example.a.length < 1200, `example ${c.id} is short (${c.example.a.length})`);
    if (c.id !== 'app') assert.ok(c.example.a.includes('```powershell'), `example ${c.id} shows a powershell block`);
  }
  const q = [{ role: 'user', content: 'Hvordan genstarter jeg print spooleren?' }];
  const first = buildChatTurns({ embedded: true, messages: q });
  assert.strictEqual(first.messages.length, 3, 'example user + assistant turn + the real question');
  assert.strictEqual(first.messages[1].role, 'assistant');
  assert.ok(/Restart-Service/.test(first.messages[1].content), 'the services example is chosen for a spooler question');
  assert.strictEqual(first.messages[2].content, q[0].content, 'the real question comes last');

  const later = buildChatTurns({ embedded: true, messages: [...q, { role: 'assistant', content: 'svar' }, { role: 'user', content: 'og lyden?' }] });
  assert.strictEqual(later.messages.length, 3, 'no example once the conversation has real turns');

  const cloud = buildChatTurns({ embedded: false, messages: q });
  assert.strictEqual(cloud.messages.length, 1, 'big/cloud models get no example turn');
  assert.ok(/dansk/.test(cloud.system), 'cloud prompt still Danish');

  const help = buildChatTurns({ embedded: true, messages: q, extraSystem: ['HELP-KONTEKST'] });
  assert.ok(help.system.endsWith('HELP-KONTEKST'), '/help context is merged into the one system prompt');
  console.log(`PASS example turns (${CARDS.length} cards with model answers)`);
}

async function main() {
  testFocusedPrompts();
  testExampleTurns();
  testProviderCatalog();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  // --- Ollama provider ---
  const ollamaCfg = { provider: 'ollama', model: 'qwen2.5-coder:7b', baseUrl: `http://127.0.0.1:${PORT}` };
  const models = await listModels(ollamaCfg);
  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].id, 'qwen2.5-coder:7b');

  let ollamaText = '';
  await chat(ollamaCfg, [{ role: 'user', content: 'how to list processes?' }], {
    system: buildAgentSystemPrompt(),
    onToken: (t) => { ollamaText += t; },
  });
  assert.ok(ollamaText.includes('Get-Process'), `ollama streaming failed: ${ollamaText}`);
  console.log('PASS ollama listModels + streaming chat');

  // --- OpenAI-compatible provider ---
  const ocCfg = { provider: 'openai-compatible', model: 'mock-coder', baseUrl: `http://127.0.0.1:${PORT}/v1` };
  const ocModels = await listModels(ocCfg);
  assert.strictEqual(ocModels[0].id, 'mock-coder');

  let ocText = '';
  await chat(ocCfg, [{ role: 'user', content: 'hi' }], {
    onToken: (t) => { ocText += t; },
  });
  assert.strictEqual(ocText, 'hello world', `openai-compatible streaming failed: ${ocText}`);
  const cutRes = await chat(ocCfg, [{ role: 'user', content: 'cut me off' }], { onToken: () => {} });
  assert.strictEqual(cutRes.finishReason, 'length', 'finish_reason "length" is reported (CRLF framing + no trailing blank line)');
  console.log('PASS openai-compatible listModels + streaming chat');

  // --- Ollama anti-repetition options must reach the server ---
  assert.ok(lastOllamaOptions, 'mock captured ollama options');
  assert.strictEqual(lastOllamaOptions.repeat_penalty, 1.15, 'ollama gets repeat_penalty');
  assert.ok(lastChatBody.repeat_penalty === undefined,
    'unknown llama.cpp fields are NOT sent to a plain openai-compatible server');

  // --- Embedded model: anti-loop sampling must reach the server ---
  lastChatBody = null;
  const localCfg = { provider: 'lennart-local', model: 'mock-coder', baseUrl: `http://127.0.0.1:${PORT}/v1` };
  await chat(localCfg, [{ role: 'user', content: 'vis min IP' }], { onToken: () => {} });
  assert.ok(lastChatBody, 'mock captured the embedded chat body');
  assert.strictEqual(lastChatBody.repeat_penalty, 1.15, 'llama.cpp repeat_penalty is sent');
  assert.strictEqual(lastChatBody.repeat_last_n, 256, 'llama.cpp repeat_last_n is sent');
  assert.strictEqual(lastChatBody.max_tokens, 700, 'embedded answers are capped at 700 tokens');

  // Overlong and loop-shaped answers must be dropped from history entirely:
  // the model would otherwise continue its own numbering next turn
  // (the real bug: a looped 1..10 answer produced "11. … 12. … 13. …").
  lastChatBody = null;
  await chat(localCfg, [
    { role: 'assistant', content: 'x'.repeat(5000) },
    { role: 'user', content: 'og igen?' },
  ], { onToken: () => {} });
  assert.ok(!lastChatBody.messages.some((m) => m.role === 'assistant'),
    'overlong old answers are dropped from history');

  lastChatBody = null;
  await chat(localCfg, [
    { role: 'user', content: 'første spørgsmål' },
    { role: 'assistant', content: Array.from({ length: 10 }, (_, i) => `${i + 1}. Gør noget ${i + 1}`).join('\n') },
    { role: 'user', content: 'og videre?' },
  ], { onToken: () => {} });
  assert.ok(!lastChatBody.messages.some((m) => m.role === 'assistant'),
    'loop-shaped answers (6+ numbered steps) are dropped from history');

  // After main.js resolveLocalProvider() rewrites the provider to
  // 'openai-compatible', the embeddedLocal flag must keep cap + penalties
  // alive (the real bug: they silently vanished after the rewrite).
  lastChatBody = null;
  await chat({ ...localCfg, provider: 'openai-compatible', embeddedLocal: true }, [
    { role: 'user', content: 'vis IP' },
  ], { onToken: () => {} });
  assert.strictEqual(lastChatBody.max_tokens, 700,
    'embeddedLocal keeps the answer cap after the provider rewrite');
  assert.strictEqual(lastChatBody.repeat_penalty, 1.15,
    'embeddedLocal keeps repeat_penalty after the provider rewrite');

  // A normal short answer must survive
  lastChatBody = null;
  await chat(localCfg, [
    { role: 'user', content: 'vis IP' },
    { role: 'assistant', content: 'Kommanden er `ipconfig /all`.' },
    { role: 'user', content: 'tak' },
  ], { onToken: () => {} });
  assert.strictEqual(lastChatBody.messages.filter((m) => m.role === 'assistant').length, 1,
    'a short clean answer stays in history');
  console.log('PASS embedded anti-loop sampling (repeat_penalty, answer cap, history filtering)');

  if (server.closeAllConnections) server.closeAllConnections();
  // --- Anthropic protocol ---
  const antCfg = { provider: 'anthropic', model: 'claude-sonnet-4-6', baseUrl: `http://127.0.0.1:${PORT}/anthropic/v1`, apiKey: 'sk-ant-test' };
  let antText = '';
  await chat(antCfg, [{ role: 'user', content: 'hi' }], {
    system: 'be brief',
    onToken: (t) => { antText += t; },
  });
  assert.ok(antText.includes('Claude says hi'), `anthropic streaming failed: ${antText}`);
  console.log('PASS anthropic streaming chat');

  // --- Anthropic model listing (live /models endpoint) ---
  const antModels = await listModels({ provider: 'anthropic', baseUrl: `http://127.0.0.1:${PORT}/anthropic/v1`, apiKey: 'sk-ant-test' });
  assert.ok(antModels.some((m) => m.id === 'claude-sonnet-4-6'), 'anthropic /models listing works');
  console.log('PASS anthropic model listing');

  // --- OpenRouter (OpenAI protocol over cloud URL) ---
  const orCfg = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', baseUrl: `http://127.0.0.1:${PORT}/or/api/v1`, apiKey: 'sk-or-test' };
  const orModels = await listModels(orCfg);
  assert.strictEqual(orModels.length, 2, 'openrouter model list');
  console.log('PASS openrouter model listing');

  server.closeAllConnections?.();
  server.close();
  console.log('ALL AI TESTS PASSED');
  // Let libuv finish closing handles before exiting (avoids Windows teardown assertion)
  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
