const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setClickable: (clickable) => ipcRenderer.send('pet:set-clickable', clickable),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),
  relocate: (corner) => ipcRenderer.send('pet:relocate', corner),
  resize: (scale) => ipcRenderer.send('pet:resize', scale),
  getScale: () => ipcRenderer.invoke('pet:get-scale'),
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, c) => cb(c)),
  onHotkey: (cb) => ipcRenderer.on('pet:hotkey', (_e, name) => cb(name)),
  listVoices: () => ipcRenderer.invoke('pet:voices'),
  getServerUrl: () => ipcRenderer.invoke('pet:server-url'),
  getRoomSecret: () => ipcRenderer.invoke('pet:room-secret'),
  getPairingConfig: () => ipcRenderer.invoke('pet:pairing-config'),
  savePairingConfig: (config) => ipcRenderer.invoke('pet:save-pairing-config', config),
  getDesktopSourceId: () => ipcRenderer.invoke('pet:desktop-source-id'),
});
