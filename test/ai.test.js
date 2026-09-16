'use strict';

/**
 * Offline smoke test for the AI layer (no Ollama needed).
 * Spins up a local mock server speaking both the Ollama API and the
 * OpenAI-compatible API, then verifies listModels + streaming chat.
 */

const http = require('http');
const assert = require('assert');
const { chat, listModels, buildAgentSystemPrompt } = require('../src/main/ai');

const PORT = 18114;

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

async function main() {
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
