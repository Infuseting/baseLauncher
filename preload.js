const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
  fsExists: (p) => ipcRenderer.invoke('fs:exists', p),
  fsReaddir: (p) => ipcRenderer.invoke('fs:readdir', p),
  launchVersion: (opts) => ipcRenderer.invoke('launcher:runVersion', opts),
  launchJava: (opts) => ipcRenderer.invoke('launch:java', opts),
  startSync: (opts) => ipcRenderer.invoke('sync:start', opts),
  launcherKill: () => ipcRenderer.invoke('launcher:kill'),
  launcherGetArgs: () => ipcRenderer.invoke('launcher:getArgs'),
  installMcAndForge: (opts) => ipcRenderer.invoke('install:mc-and-forge', opts),
  onSyncProgress: (cb) => {
    ipcRenderer.on('sync:progress', (event, data) => cb(data))
  },
  onSyncLog: (cb) => {
    ipcRenderer.on('sync:log', (event, data) => cb(data))
  },
  fetchRemoteInfo: (url) => ipcRenderer.invoke('remote:fetch', url),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (s) => ipcRenderer.invoke('settings:set', s),
  ensureJava22: (preferredPath, jarURL) => ipcRenderer.invoke('java:ensure22', preferredPath, jarURL),
  onSyncMeta: (cb) => {
    ipcRenderer.on('sync:meta', (event, data) => cb(data))
  }
})
