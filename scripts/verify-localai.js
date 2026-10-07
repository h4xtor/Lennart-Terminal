'use strict';

/**
 * One-off end-to-end verification of the embedded local AI:
 * downloads llama.cpp + the hardcoded model (first run only), starts the
 * server, and asks it a real PowerShell question over the OpenAI protocol.
 * Run:  node scripts/verify-localai.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { LocalAI, LOCAL_MODEL, chatUrl } = require('../src/main/localai');

// Use the app's real data dir so this warms exactly what the app will use.
const ROOT = process.env.LENNART_DATA_DIR
  ? path.join(process.env.LENNART_DATA_DIR, 'localai')
  : path.join(process.env.APPDATA || os.tmpdir(), 'Lennart Terminal', 'localai');

const ai = new LocalAI({
  root: ROOT,
  log: (m) => console.log(`[engine] ${m}`),
  emit: (ev, p) => {
    if (ev !== 'localai:progress') return;
    const mb = (n) => (n / (1024 * 1024)).toFixed(0);
    const pct = p.total ? ` (${Math.round((p.got / p.total) * 100)}%)` : '';
    process.stdout.write(`\r[download ${p.step}] ${mb(p.got)} MB${pct}   `);
  },
});

async function ask(question) {
  const res = await fetch(chatUrl(ai.port), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_MODEL.id,
      messages: [
        { role: 'system', content: 'You are a PowerShell assistant. Answer with the command only, in a single code block.' },
        { role: 'user', content: question },
      ],
      max_tokens: 200,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

(async () => {
  console.log(`Local AI root: ${ROOT}`);
  console.log('Ensuring engine (downloads on first run — this can take a few minutes)...');
  const t0 = Date.now();
  await ai.ensure();
  console.log(`\nServer ready in ${((Date.now() - t0) / 1000).toFixed(1)}s on port ${ai.port}`);

  const answer = await ask('How do I list the 5 largest files under the current directory?');
  console.log('\n=== MODEL ANSWER ===');
  console.log(answer.trim().slice(0, 600));
  console.log('====================');
  console.log('LOCAL AI END-TO-END OK');
  process.exit(0);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
