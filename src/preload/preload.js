'use strict';

const { contextBridge, ipcRenderer } = require('electron');

try {
  require('fs').appendFileSync(
    require('path').join(require('os').tmpdir(), 'lennart-terminal-main.log'),
    `[preload ${new Date().toISOString()}] preload executed\n`,
  );
} catch (e) { /* diagnostics only */ }

contextBridge.exposeInMainWorld('lennart', {
  // terminal
  createTerminal: (opts) => ipcRenderer.invoke('terminal:create', opts),
  writeTerminal: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  destroyTerminal: (id) => ipcRenderer.send('terminal:destroy', { id }),
  onTerminalData: (cb) => ipcRenderer.on('terminal:data', (_e, payload) => cb(payload)),
  onTerminalExit: (cb) => ipcRenderer.on('terminal:exit', (_e, payload) => cb(payload)),

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
  onChatChunk: (cb) => ipcRenderer.on('ai:chat:chunk', (_e, payload) => cb(payload)),
  onChatDone: (cb) => ipcRenderer.on('ai:chat:done', (_e, payload) => cb(payload)),
  onChatError: (cb) => ipcRenderer.on('ai:chat:error', (_e, payload) => cb(payload)),

  // agent (autopilot + antigravity engine)
  agentStart: (payload) => ipcRenderer.invoke('agent:start', payload),
  agentStop: (id) => ipcRenderer.send('agent:stop', { id }),
  onAgentEvent: (cb) => ipcRenderer.on('agent:event', (_e, payload) => cb(payload)),
  agyAvailable: () => ipcRenderer.invoke('ai:agyAvailable'),
  agyModels: () => ipcRenderer.invoke('ai:agyModels'),

  // misc
  getPaths: () => ipcRenderer.invoke('app:getPaths'),
  revealSettingsFile: () => ipcRenderer.invoke('app:revealSettingFile'),
  openDevTools: () => ipcRenderer.send('app:devtools'),
  confirmCommand: (command) => ipcRenderer.invoke('terminal:confirmCommand', { command }),
  log: (msg) => ipcRenderer.send('app:log', msg),

  // window controls (frameless)
  minimize: () => ipcRenderer.send('app:minimize'),
  maximize: () => ipcRenderer.send('app:maximize'),
  closeWindow: () => ipcRenderer.send('app:close'),

  // native menu actions (File/View accelerators)
  onMenuAction: (cb) => ipcRenderer.on('app:menu-action', (_e, action) => cb(action)),
});
