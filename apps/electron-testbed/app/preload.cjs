// The bridge the renderer reaches the main process through: context
// isolation stays on, and the page sees only these calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('testbed', {
  greeting: () => ipcRenderer.invoke('testbed:greeting'),
  signIn: (form) => ipcRenderer.invoke('testbed:sign-in', form),
  openSettings: () => ipcRenderer.invoke('testbed:open-settings'),
  userData: () => ipcRenderer.invoke('testbed:user-data'),
});
