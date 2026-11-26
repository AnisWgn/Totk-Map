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
  const bridge = createElectronBridge(ipcRenderer);
  contextBridge.exposeInMainWorld("electronAPI", bridge);

  const applyElectronClasses = () => {
    const root = document?.documentElement;
    if (!root) return;
    root.classList.add("is-electron", `electron-${bridge.platform || "win32"}`);
  };
  if (typeof window !== "undefined") {
    if (document?.documentElement) {
      applyElectronClasses();
    } else {
      window.addEventListener("DOMContentLoaded", applyElectronClasses, {
        once: true,
      });
    }
  }
}

module.exports = { createElectronBridge };
