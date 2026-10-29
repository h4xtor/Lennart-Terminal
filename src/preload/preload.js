'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Every on*() subscription returns an unsubscribe function, so closed tabs
// can detach their listeners (they used to pile up for every tab ever opened).
function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

try {
  require('fs').appendFileSync(
    require('path').join(require('os').tmpdir(), 'lennart-terminal-main.log'),
    `[preload ${new Date().toISOString()}] preload executed\n`,
  );
} catch (e) { /* diagnostics only */ }

/**
 * Subscribe to an IPC push channel and return an unsubscribe function.
 * Every terminal tab registers its own listeners, so without this they piled
 * up forever after tabs were closed.
 */
function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('lennart', {
  // terminal
  createTerminal: (opts) => ipcRenderer.invoke('terminal:create', opts),
  shellStatus: () => ipcRenderer.invoke('terminal:shells'),
  writeTerminal: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  destroyTerminal: (id) => ipcRenderer.send('terminal:destroy', { id }),
  onTerminalData: (cb) => subscribe('terminal:data', cb),
  onTerminalExit: (cb) => subscribe('terminal:exit', cb),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // ai (chat)
  listModels: (cfg) => ipcRenderer.invoke('ai:listModels', cfg),
  checkConnection: (cfg) => ipcRenderer.invoke('ai:checkConnection', cfg),
  providersCatalog: () => ipcRenderer.invoke('ai:providers'),
  chat: (payload) => ipcRenderer.send('ai:chat', payload),
  cancelChat: (id) => ipcRenderer.send('ai:chat:cancel', { id }),
  onChatChunk: (cb) => subscribe('ai:chat:chunk', cb),
  onChatDone: (cb) => subscribe('ai:chat:done', cb),
  onChatError: (cb) => subscribe('ai:chat:error', cb),

  // agent (autopilot + antigravity engine)
  agentStart: (payload) => ipcRenderer.invoke('agent:start', payload),
  agentStop: (id) => ipcRenderer.send('agent:stop', { id }),
  onAgentEvent: (cb) => subscribe('agent:event', cb),
  agyAvailable: () => ipcRenderer.invoke('ai:agyAvailable'),
  agyModels: () => ipcRenderer.invoke('ai:agyModels'),

  // embedded local AI (offline PowerShell assistant)
  localaiStatus: () => ipcRenderer.invoke('localai:status'),
  localaiEnsure: () => ipcRenderer.invoke('localai:ensure'),
  localaiListModels: () => ipcRenderer.invoke('localai:listModels'),
  localaiDownloadModel: (spec) => ipcRenderer.invoke('localai:downloadModel', spec),
  onLocalaiProgress: (cb) => subscribe('localai:progress', cb),

  // network hosts + remote execution
  hostsList: () => ipcRenderer.invoke('hosts:list'),
  hostsSave: (host) => ipcRenderer.invoke('hosts:save', host),
  hostsDelete: (id) => ipcRenderer.invoke('hosts:delete', id),
  hostsSshSetupCommand: () => ipcRenderer.invoke('hosts:sshSetupCommand'),
  remoteTest: (host) => ipcRenderer.invoke('remote:test', host),
  remoteRun: (payload) => ipcRenderer.invoke('remote:run', payload),
  onRemoteData: (cb) => subscribe('remote:data', cb),

  // permanent history
  historyQuery: (opts) => ipcRenderer.invoke('history:query', opts),
  historyClear: () => ipcRenderer.invoke('history:clear'),

  // GitHub updates (portable Windows build)
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  pendingUpdate: () => ipcRenderer.invoke('update:pending'),
  onUpdateProgress: (cb) => subscribe('update:progress', cb),

  // misc
  getPaths: () => ipcRenderer.invoke('app:getPaths'),
  revealSettingsFile: () => ipcRenderer.invoke('app:revealSettingFile'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  elevation: () => ipcRenderer.invoke('app:elevation'),
  relaunchAdmin: () => ipcRenderer.invoke('app:relaunchAdmin'),
  openDevTools: () => ipcRenderer.send('app:devtools'),
  confirmCommand: (command) => ipcRenderer.invoke('terminal:confirmCommand', { command }),
  log: (msg) => ipcRenderer.send('app:log', msg),

  // window controls (frameless)
  minimize: () => ipcRenderer.send('app:minimize'),
  maximize: () => ipcRenderer.send('app:maximize'),
  closeWindow: () => ipcRenderer.send('app:close'),

  // native menu actions (File/View accelerators)
  onMenuAction: (cb) => subscribe('app:menu-action', cb),
});
