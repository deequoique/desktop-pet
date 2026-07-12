const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPetControl', {
  getPairingConfig: () => ipcRenderer.invoke('pet:pairing-config'),
  savePairingConfig: (config) => ipcRenderer.invoke('pet:save-pairing-config', config),
  onPairingChanged: (cb) => ipcRenderer.on('pet:pairing-changed', (_event, config) => cb(config)),
  getTtsCredentials: () => ipcRenderer.invoke('tts:get-credentials'),
  saveTtsCredentials: (apiKey) => ipcRenderer.invoke('tts:save-credentials', apiKey),
});
