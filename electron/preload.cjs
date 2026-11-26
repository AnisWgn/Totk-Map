"use strict";

function createElectronBridge(ipc, platform = process.platform) {
  return {
    isElectron: true,
    platform,
    selectFolder: (defaultPath = "") =>
      ipc.invoke("hyrulesync:select-folder", defaultPath),
    selectSaveFile: (defaultPath = "") =>
      ipc.invoke("hyrulesync:select-save-file", defaultPath),
  };
}

if (process.versions.electron) {
  const { contextBridge, ipcRenderer } = require("electron");
  contextBridge.exposeInMainWorld(
    "electronAPI",
    createElectronBridge(ipcRenderer),
  );
}

module.exports = { createElectronBridge };
