'use strict';

/**
 * Offline tests for the built-in autopilot agent:
 * decision parsing, the hard deny-list, destructive-command detection and
 * the "Auto-godkend agent-kommandoer" setting (it must skip the confirmation
 * dialog only when explicitly enabled).
 */

const assert = require('assert');
const { AgentSession, isDestructive, isHardDenied, parseDecision } = require('../src/main/agent');

async function runSession(settings) {
  let confirmations = 0;
  let step = 0;
  const session = new AgentSession({
    id: 'agent_test',
    job: 'test job',
    aiConfig: { provider: 'mock', model: 'mock' },
    settings,
    deps: {
      emit: () => {},
      run: async () => 'ok',
      confirm: async () => { confirmations += 1; return true; },
      log: () => {},
    },
  });
  // No provider/network: the model answers with one destructive command,
  // then reports the job as done.
  session.askModel = async () => (step++ === 0
    ? { thought: 'ryd op', done: false, command: 'Remove-Item C:/temp/x -Force' }
    : { thought: 'færdig', done: true, command: '' });

  const result = await session.run();
  return { result, confirmations };
}

async function main() {
  assert.strictEqual(isDestructive('Remove-Item C:/temp/x -Force'), true);
  assert.strictEqual(isDestructive('Get-Process'), false);
  assert.strictEqual(isHardDenied('format C:'), true);
  assert.strictEqual(isHardDenied('Get-ChildItem'), false);

  const parsed = parseDecision('```json\n{"thought":"ok","done":true,"command":""}\n```');
  assert.strictEqual(parsed.done, true);
  assert.strictEqual(parsed.thought, 'ok');
  console.log('PASS decision parsing + destructive/hard-deny detection');

  const auto = await runSession({ confirmDestructive: true, agentAutoApprove: true });
  assert.strictEqual(auto.confirmations, 0, 'auto-godkend must skip the confirmation dialog');
  assert.strictEqual(auto.result.ok, true);

  const manual = await runSession({ confirmDestructive: true, agentAutoApprove: false });
  assert.strictEqual(manual.confirmations, 1, 'destructive commands still ask without auto-godkend');
  assert.strictEqual(manual.result.ok, true);
  console.log('PASS agent auto-approve setting');

  console.log('ALL AGENT TESTS PASSED');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
