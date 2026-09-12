const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  openDevtools: () => ipcRenderer.invoke('open-devtools'),
  onToggleDetectionHotkey: (callback) => ipcRenderer.on('toggle-detection-hotkey', callback),
});
