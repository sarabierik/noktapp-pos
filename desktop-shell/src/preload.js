'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** A deliberately tiny bridge: the till UI is a normal web page and should
 *  keep working in a browser during development. */
contextBridge.exposeInMainWorld('noktapp', {
  version: () => ipcRenderer.invoke('app:version'),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  toggleCustomerDisplay: () => ipcRenderer.invoke('app:display'),
  isDesktop: true,
});
