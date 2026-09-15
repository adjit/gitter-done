const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitter', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('state:refresh'),
  quit: () => ipcRenderer.send('app:quit'),
  resize: (height) => ipcRenderer.send('window:resize', height),
  onState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
});
