const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSession: (sessionId) => ipcRenderer.invoke('session:get', { sessionId }),
  createSession: (payload) => ipcRenderer.invoke('session:create', payload),
  replanSession: (sessionId) => ipcRenderer.invoke('session:replan', { sessionId }),
  resumeUnfinishedSession: (sessionId) => ipcRenderer.invoke('session:resume-unfinished', { sessionId }),
  sendSessionInput: (payload) => ipcRenderer.invoke('session:send-input', payload),
  resolveApproval: (payload) => ipcRenderer.invoke('approval:resolve', payload),
  resolveApprovalBatch: (payload) => ipcRenderer.invoke('approval:resolve-batch', payload),
  stopSession: (sessionId) => ipcRenderer.invoke('session:stop', { sessionId }),
  subscribe: (handler) => {
    if (typeof handler !== 'function') {
      return () => {};
    }
    const listener = (_event, payload) => {
      handler(payload);
    };
    ipcRenderer.on('session:event', listener);
    return () => ipcRenderer.removeListener('session:event', listener);
  },
});
