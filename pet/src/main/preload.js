const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setClickable: (clickable) => ipcRenderer.send('pet:set-clickable', clickable),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),
  startDrag: () => ipcRenderer.send('pet:drag-start'),
  stopDrag: () => ipcRenderer.send('pet:drag-end'),
  relocate: (corner) => ipcRenderer.send('pet:relocate', corner),
  resize: (scale) => ipcRenderer.invoke('pet:set-scale', scale),
  getScale: () => ipcRenderer.invoke('pet:get-scale'),
  onScaleChanged: (cb) => {
    const handler = (_event, scale) => cb(scale);
    ipcRenderer.on('pet:scale-changed', handler);
    return () => ipcRenderer.removeListener('pet:scale-changed', handler);
  },
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, c) => cb(c)),
  listVoices: () => ipcRenderer.invoke('pet:voices'),
  getServerUrl: () => ipcRenderer.invoke('pet:server-url'),
  getRoomSecret: () => ipcRenderer.invoke('pet:room-secret'),
  getPairingConfig: () => ipcRenderer.invoke('pet:pairing-config'),
  savePairingConfig: (config) => ipcRenderer.invoke('pet:save-pairing-config', config),
  onPairingChanged: (cb) => ipcRenderer.on('pet:pairing-changed', (_e, config) => cb(config)),
  getDesktopSourceId: () => ipcRenderer.invoke('pet:desktop-source-id'),
  recordDiagnostic: (event) => ipcRenderer.send('diagnostics:record', event),
  openExternal: (url) => ipcRenderer.invoke('note:open-external', url),
  isGameMode: () => ipcRenderer.invoke('note:is-game-mode'),
  openNoteComposer: () => ipcRenderer.send('note:open-composer'),
  onGameModeChanged: (cb) => {
    const handler = (_event, enabled) => cb(enabled);
    ipcRenderer.on('note:game-mode-changed', handler);
    return () => ipcRenderer.removeListener('note:game-mode-changed', handler);
  },
  onNoteWindowClosed: (cb) => {
    const handler = (_event, frameName) => cb(frameName);
    ipcRenderer.on('note-window:closed', handler);
    return () => ipcRenderer.removeListener('note-window:closed', handler);
  },
  onNoteWindowInteracted: (cb) => {
    const handler = (_event, frameName) => cb(frameName);
    ipcRenderer.on('note-window:interacted', handler);
    return () => ipcRenderer.removeListener('note-window:interacted', handler);
  },
});
