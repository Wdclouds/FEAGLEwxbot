import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('feagleDesktop', {
  isDesktop: true,
  version: '0.5.0',
  openExternal: (url) => ipcRenderer.invoke('feagle:open-external', url),
  getLogs: () => ipcRenderer.invoke('feagle:get-logs'),
  onLog: (callback) => {
    const subscription = (event, logEntry) => callback(logEntry);
    ipcRenderer.on('feagle:log-entry', subscription);
    return () => ipcRenderer.removeListener('feagle:log-entry', subscription);
  },
  restartServices: () => ipcRenderer.invoke('feagle:restart-services'),
  quitApp: () => ipcRenderer.invoke('feagle:quit-app'),
});
