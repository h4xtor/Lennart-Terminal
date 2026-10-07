'use strict';

/**
 * Offline tests for the renderer command catalogue:
 * the 20 one-click network commands and the top menubar dropdowns.
 * commands.js is pure data, so it can be required directly.
 */

const assert = require('assert');

const { NETWORK_QUICK_COMMANDS, COMMAND_MENUS } = require('../src/renderer/js/commands');

const ALLOWED_ACTIONS = new Set([
  'ssh-setup', 'add-host', 'test-hosts',
  'ai-clear', 'ai-toggle', 'ai-agent-mode', 'ai-focus', 'ai-ask-port', 'ai-ask-ipconfig',
  // v0.3.0: the Setup menu + AI help
  'setup-settings', 'setup-models', 'setup-colors', 'models-refresh',
  'ai-help', 'github-actions', 'about',
  // v0.3.1: Fjernsupport menu + elevation
  'remote-connect', 'run-as-admin',
]);

function testTwentyNetworkCommands() {
  assert.strictEqual(NETWORK_QUICK_COMMANDS.length, 20,
    `expected exactly 20 network quick commands, got ${NETWORK_QUICK_COMMANDS.length}`);

  const labels = new Set();
  for (const item of NETWORK_QUICK_COMMANDS) {
    assert.strictEqual(typeof item.label, 'string');
    assert.strictEqual(typeof item.cmd, 'string');
    assert.ok(item.label.trim().length > 0, 'label must not be empty');
    assert.ok(item.cmd.trim().length > 0, `cmd must not be empty (${item.label})`);
    assert.ok(item.cmd.length < 600, `cmd too long for a quick button (${item.label})`);
    assert.ok(!labels.has(item.label), `duplicate quick-command label: ${item.label}`);
    labels.add(item.label);
  }
  console.log('PASS 20 network quick commands');
}

function testMenuStructure() {
  assert.ok(COMMAND_MENUS.length >= 10, `expected 10 menus (incl. Setup), got ${COMMAND_MENUS.length}`);

  // Setup must be the first menu so setup/help is easy to find
  assert.strictEqual(COMMAND_MENUS[0].id, 'setup', 'the first menubar menu must be Setup');

  const menuIds = new Set();
  const seenCmds = new Set();
  let totalItems = 0;

  for (const menu of COMMAND_MENUS) {
    assert.strictEqual(typeof menu.label, 'string');
    assert.ok(menu.label.trim().length > 0, 'menu label must not be empty');
    assert.ok(!menuIds.has(menu.id), `duplicate menu id: ${menu.id}`);
    menuIds.add(menu.id);

    assert.ok(Array.isArray(menu.items));
    assert.ok(menu.items.length >= 16,
      `menu "${menu.label}" should offer 16+ commands (10-20 more than before), got ${menu.items.length}`);

    // Alphabetical order (Danish collation) inside every dropdown
    const labels = menu.items.map((i) => i.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'da'));
    assert.deepStrictEqual(labels, sorted,
      `menu "${menu.label}" must list its items alphabetically`);

    for (const item of menu.items) {
      totalItems++;
      assert.strictEqual(typeof item.label, 'string');
      assert.ok(item.label.trim().length > 0, `empty item label in "${menu.label}"`);

      const hasCmd = typeof item.cmd === 'string' && item.cmd.trim().length > 0;
      const hasAction = typeof item.action === 'string' && item.action.trim().length > 0;
      assert.ok(hasCmd !== hasAction,
        `item "${item.label}" must have exactly one of cmd/action`);
      if (hasCmd) {
        assert.ok(item.cmd.length < 800, `menu cmd too long: ${item.label}`);
        assert.ok(!seenCmds.has(item.cmd), `duplicate menu command: ${item.cmd}`);
        seenCmds.add(item.cmd);
      }
      if (hasAction) {
        assert.ok(ALLOWED_ACTIONS.has(item.action), `unknown menu action: ${item.action}`);
      }
    }
  }
  assert.ok(totalItems >= 180, `expected 180+ menu commands total, got ${totalItems}`);
  console.log(`PASS menubar structure (${COMMAND_MENUS.length} menus, ${totalItems} items, alphabetical)`);
}

function testPowerShellOrientation() {
  // The catalogue targets Windows troubleshooting PCs — a meaningful share
  // of the commands must be PowerShell (not only .exe utilities).
  const ps = NETWORK_QUICK_COMMANDS.filter((c) =>
    /get-|set-|test-|resolve-|clear-|invoke-|foreach|sort-object|\$[a-z]/i.test(c.cmd));
  assert.ok(ps.length >= 10,
    `expected at least 10 PowerShell network commands, got ${ps.length}`);
  console.log(`PASS PowerShell coverage in quick commands (${ps.length}/20)`);
}

function main() {
  testTwentyNetworkCommands();
  testMenuStructure();
  testPowerShellOrientation();
  console.log('ALL COMMAND CATALOGUE TESTS PASSED');
}

try {
  main();
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
