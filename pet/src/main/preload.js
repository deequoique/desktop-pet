const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setClickable: (clickable) => ipcRenderer.send('pet:set-clickable', clickable),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),
  startDrag: () => ipcRenderer.send('pet:drag-start'),
  stopDrag: () => ipcRenderer.send('pet:drag-end'),
  relocate: (corner) => ipcRenderer.send('pet:relocate', corner),
  resize: (scale) => ipcRenderer.send('pet:resize', scale),
  getScale: () => ipcRenderer.invoke('pet:get-scale'),
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, c) => cb(c)),
  listVoices: () => ipcRenderer.invoke('pet:voices'),
  getServerUrl: () => ipcRenderer.invoke('pet:server-url'),
  getRoomSecret: () => ipcRenderer.invoke('pet:room-secret'),
  getPairingConfig: () => ipcRenderer.invoke('pet:pairing-config'),
  savePairingConfig: (config) => ipcRenderer.invoke('pet:save-pairing-config', config),
  onPairingChanged: (cb) => ipcRenderer.on('pet:pairing-changed', (_e, config) => cb(config)),
  getDesktopSourceId: () => ipcRenderer.invoke('pet:desktop-source-id'),
});
