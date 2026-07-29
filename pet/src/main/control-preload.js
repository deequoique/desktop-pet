const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPetControl', {
  getPairingConfig: () => ipcRenderer.invoke('pet:pairing-config'),
  savePairingConfig: (config) => ipcRenderer.invoke('pet:save-pairing-config', config),
  onPairingChanged: (cb) => ipcRenderer.on('pet:pairing-changed', (_event, config) => cb(config)),
  getTtsCredentials: () => ipcRenderer.invoke('tts:get-credentials'),
  saveTtsCredentials: (apiKey) => ipcRenderer.invoke('tts:save-credentials', apiKey),
  getPetScale: () => ipcRenderer.invoke('pet:get-scale'),
  setPetScale: (scale) => ipcRenderer.invoke('pet:set-scale', scale),
  resetPetScale: () => ipcRenderer.invoke('pet:reset-scale'),
  onPetScaleChanged: (cb) => {
    const handler = (_event, scale) => cb(scale);
    ipcRenderer.on('pet:scale-changed', handler);
    return () => ipcRenderer.removeListener('pet:scale-changed', handler);
  },
  recordDiagnostic: (event) => ipcRenderer.send('diagnostics:record', event),
  getDiagnosticStatus: () => ipcRenderer.invoke('diagnostics:status'),
  dismissDiagnosticIncident: (id) => ipcRenderer.invoke('diagnostics:dismiss', id),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  onDiagnosticRefresh: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('diagnostics:refresh', handler);
    return () => ipcRenderer.removeListener('diagnostics:refresh', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('note:open-external', url),
  onMediaFloatClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('media-float:closed', handler);
    return () => ipcRenderer.removeListener('media-float:closed', handler);
  },
  onOpenNoteComposer: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('note:open-composer', handler);
    return () => ipcRenderer.removeListener('note:open-composer', handler);
  },
});
