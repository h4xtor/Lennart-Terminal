'use strict';

/**
 * Offline smoke test for the AI layer (no Ollama needed).
 * Spins up a local mock server speaking both the Ollama API and the
 * OpenAI-compatible API, then verifies listModels + streaming chat.
 */

const http = require('http');
const assert = require('assert');
const {
  chat, listModels, buildAgentSystemPrompt, buildPowerShellSystemPrompt, PROVIDERS,
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
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

/**
 * The embedded assistant's system prompt is its full training compendium:
 * app knowledge + Windows troubleshooting + the answer-format contract the
 * renderer depends on (FIRST ```powershell block + KØRER marker). Lock every
 * part of it so the training cannot silently shrink back.
 */
function testPowerShellPromptTraining() {
  const p = buildPowerShellSystemPrompt();

  // It must be a real compendium, not the old 15-liner
  assert.ok(p.length > 3000, `prompt is a full compendium (${p.length} chars)`);

  // --- Part 1: the app itself (facts a fresh user must learn from the AI) ---
  for (const fact of [
    'LENNART TERMINAL',     // app section header
    'Ctrl+T',               // shortcuts
    'Ctrl+J',
    'Fjernsupport',         // menubar menu
    'Tilføj vært',          // host management
    'Hent modeller',        // model manager
    '127.0.0.1:9601',       // embedded llama-server
    'Data/history.jsonl',   // permanent history
    'Kør',                  // code-block Run button
  ]) {
    assert.ok(p.includes(fact), `prompt teaches app fact "${fact}"`);
  }

  // --- Part 2: the Windows/PowerShell troubleshooting compendium ---
  for (const cmd of [
    'Get-NetTCPConnection', // who listens on a port
    'ipconfig /all',
    'Get-Service',
    'Get-Volume',           // disk health
    'Get-WinEvent',         // event logs
    'sfc /scannow',         // system repair
    'nvidia-smi',           // GPU
    'Enable-PSRemoting',    // remote support
    'winget',               // package manager
    'Stop-Process',
  ]) {
    assert.ok(p.includes(cmd), `prompt compendium covers "${cmd}"`);
  }

  // --- Part 3: the diagnostic method ---
  assert.ok(/SÅDAN DIAGNOSTICERER DU/.test(p), 'prompt teaches the diagnostic method');

  // --- Part 4: the answer-format contract (renderer auto-run depends on it) ---
  assert.ok(p.includes('KØRER'), 'prompt keeps the KØRER auto-run marker');
  assert.ok(p.includes('```powershell'), 'prompt keeps the fenced powershell block format');
  assert.ok(/Svar på dansk/.test(p), 'prompt demands Danish answers');
  assert.ok(/FØRSTE/.test(p) || /første ```powershell/.test(p) || /FØRSTE ```powershell/.test(p),
    'prompt pins the runnable command to the FIRST powershell block');

  // --- Part 5: answer style — the small model must answer directly and never
  // run in circles (the old model repeated steps 2..9 about the same PC) ---
  assert.ok(p.includes('DEL 5: SVARSTIL'), 'prompt teaches the answer-style section');
  assert.ok(p.includes('ÉN gang'), 'prompt forbids repeating a step');
  assert.ok(p.includes('gentag for næste PC'), 'prompt gives the repeat-instead-of-looping idiom');
  assert.ok(/Stop når svaret er givet/.test(p), 'prompt tells the model to stop once answered');
  assert.ok(/Direkte: Begynd med selve svaret/.test(p), 'prompt demands starting with the answer');
  assert.ok(p.includes('HÅRD GRÆNSE'), 'prompt sets the hard 4-point limit');
  assert.ok(p.includes('punkt 5'), 'prompt forbids a fifth point explicitly');
  // The answer format is described IN WORDS. There must be no few-shot
  // "Bruger:/Svar:" transcript left anywhere in the prompt: the model
  // copied it verbatim — echoing the user's question, emitting a fake
  // KØRER and regurgitating the Regler list as its "answer".
  assert.ok(p.includes('Et svar har denne form'), 'prompt describes the answer form in words');
  assert.ok(!p.includes('<den ENE kommando'), 'no placeholder example left to copy');
  assert.strictEqual(p.indexOf('Bruger: Jeg skal RDP'), -1, 'the RDP dialog example is gone');
  assert.strictEqual(p.indexOf('Bruger: Hvad er kommanden'), -1, 'the IP dialog example is gone');
  assert.ok(p.includes('NETOP det, brugeren spurgte om'), 'prompt pins the answer to the actual question');
  assert.ok(p.includes('gengiv brugerens spørgsmål'), 'prompt forbids echoing the question');
  assert.ok(p.trim().endsWith('ellers aldrig.'), 'the prompt ends with a hard rule, not an example');
  assert.ok(p.includes('Forklar som til en ven'), 'prompt demands plain, friendly wording');
  assert.ok(p.includes('Ingen overskrifter'), 'prompt forbids ### headings (they restart the numbering)');
  assert.ok(p.includes('Ingen underpunkter'), 'prompt forbids nested bullet levels');
  assert.ok(p.includes('Ingen numre'), 'prompt forbids numbered lists (the loop generator)');
  assert.ok(p.includes('“11.”'), 'prompt forbids continuing a previous numbering');

  // --- the agent prompt is unchanged in contract ---
  const agent = buildAgentSystemPrompt();
  assert.ok(agent.includes('Lennart'), 'agent prompt keeps its identity');

  console.log(`PASS PowerShell prompt training (${p.length} chars, app + troubleshooting + format)`);
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

async function main() {
  testPowerShellPromptTraining();
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
  assert.strictEqual(lastChatBody.max_tokens, 400, 'embedded answers are capped at 400 tokens');

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
  assert.strictEqual(lastChatBody.max_tokens, 400,
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
