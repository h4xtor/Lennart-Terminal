'use strict';

/**
 * Settings migrations: users of the OLD built-in models are moved to the new
 * built-in model once; a deliberately chosen bigger model is kept.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Plain node: stand in for the 'electron' module (no app → userData unused)
const realResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(req, ...rest) {
  if (req === 'electron') return 'electron-stub';
  return realResolve.call(this, req, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: {} };

function freshStore(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-store-'));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  process.env.LENNART_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/main/store')];
  // eslint-disable-next-line global-require
  const SettingsStore = require('../src/main/store');
  return { store: new SettingsStore(), dir };
}

const { LOCAL_MODEL } = require('../src/main/localai');

// 1. old 3B built-in pick → cleared (= new built-in model)
let { store, dir } = freshStore({
  version: 3.1,
  ai: { provider: 'lennart-local', model: 'qwen2.5-coder-3b-instruct-q4_k_m' },
  providers: { 'lennart-local': { model: 'qwen2.5-coder-3b-instruct-q4_k_m' } },
});
assert.strictEqual(store.get('ai').model, '', 'old built-in model choice is cleared');
assert.strictEqual(store.get('providers')['lennart-local'].model, '', 'also in the per-provider memory');
assert.strictEqual(store.get('builtinModelVersion'), 2, 'migration is recorded');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).ai.model, '', 'and saved to disk');

// 2. a later deliberate pick of an old model is respected (runs only once)
store.set({ ai: { model: 'qwen2.5-coder-1.5b-instruct-q4_k_m' } });
({ store } = freshStore(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))));
assert.strictEqual(store.get('ai').model, 'qwen2.5-coder-1.5b-instruct-q4_k_m', 'migration never runs twice');

// 3. a bigger catalogue model is kept
({ store } = freshStore({ version: 3.1, ai: { provider: 'lennart-local', model: 'qwen2.5-coder-7b-instruct-q4_k_m' } }));
assert.strictEqual(store.get('ai').model, 'qwen2.5-coder-7b-instruct-q4_k_m', 'a chosen 7B model is kept');

// 4. brand-new install
({ store } = freshStore(null));
assert.strictEqual(store.get('ai').provider, 'lennart-local', 'new installs use the built-in AI');
assert.strictEqual(LOCAL_MODEL.id, 'qwen3-4b-instruct-2507-q4_k_m', 'the built-in model is Qwen3 4B');

console.log('PASS settings migration to the new built-in model');
console.log('ALL STORE TESTS PASSED');
