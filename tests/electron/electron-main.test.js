// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import {
  isSafeExternalUrl,
  resolveHomeDir,
  startElectronApp,
} from "../../electron/main.js";

const require = createRequire(import.meta.url);
const { createElectronBridge } = require("../../electron/preload.cjs");

function createMockElectron({ singleInstance = true, packaged = false } = {}) {
  const appEvents = new EventEmitter();
  const ipcHandlers = new Map();
  const openedExternals = [];
  let quitCalled = false;
  let lastMenuTemplate = null;
  let dialogResponse = { canceled: false, filePaths: ["/mock/save-folder"] };

  class MockBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.loadedUrls = [];
      this.visible = false;
      this.minimized = false;
      this.destroyed = false;
      this.windowOpenHandler = null;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (fn) => {
        this.windowOpenHandler = fn;
      };
      this.webContents.openDevTools = vi.fn();
    }
    loadURL(url) {
      this.loadedUrls.push(url);
      this.emit("ready-to-show");
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    restore() {
      this.minimized = false;
    }
    focus() {}
    isMinimized() {
      return this.minimized;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
  }

  class MockTray extends EventEmitter {
    constructor(image) {
      super();
      this.image = image;
      this.tooltip = "";
      this.menu = null;
      this.destroyed = false;
    }
    setToolTip(text) {
      this.tooltip = text;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  const app = Object.assign(appEvents, {
    isPackaged: packaged,
    requestSingleInstanceLock: () => singleInstance,
    whenReady: () => Promise.resolve(),
    getLocale: () => "en-US",
    getPath: (name) => path.join(os.tmpdir(), `mock-${name}`),
    quit: () => {
      appEvents.emit("before-quit");
      quitCalled = true;
      appEvents.emit("will-quit");
    },
  });

  const Menu = {
    buildFromTemplate: (template) => {
      lastMenuTemplate = template;
      return { items: template };
    },
  };

  const ipcMain = {
    handle: (channel, handler) => {
      ipcHandlers.set(channel, handler);
    },
  };

  const dialog = {
    showOpenDialog: vi.fn(async () => dialogResponse),
  };

  const shell = {
    openExternal: vi.fn(async (url) => {
      openedExternals.push(url);
    }),
  };

  const nativeImage = {
    createFromPath: (p) => p,
  };

  return {
    electron: {
      app,
      BrowserWindow: MockBrowserWindow,
      Tray: MockTray,
      Menu,
      dialog,
      ipcMain,
      shell,
      nativeImage,
    },
    ipcHandlers,
    openedExternals,
    getQuitCalled: () => quitCalled,
    getLastMenuTemplate: () => lastMenuTemplate,
    setDialogResponse: (res) => {
      dialogResponse = res;
    },
  };
}

describe("Electron desktop shell (main.js & preload.cjs)", () => {
  it("exposes a clean IPC bridge in preload.cjs", async () => {
    const invoke = vi.fn(async (channel, arg) => `${channel}:${arg}`);
    const bridge = createElectronBridge({ invoke }, "win32");
    expect(bridge.isElectron).toBe(true);
    expect(bridge.platform).toBe("win32");
    expect(await bridge.selectFolder("C:\\Saves")).toBe(
      "hyrulesync:select-folder:C:\\Saves",
    );
    expect(await bridge.selectSaveFile("C:\\progress.sav")).toBe(
      "hyrulesync:select-save-file:C:\\progress.sav",
    );
  });

  it("resolves homeDir properly across dev, portable .exe and NSIS installed modes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hyrulesync-home-"));
    const prevHome = process.env.HYRULESYNC_HOME;
    const prevPortable = process.env.PORTABLE_EXECUTABLE_DIR;
    try {
      delete process.env.HYRULESYNC_HOME;
      delete process.env.PORTABLE_EXECUTABLE_DIR;

      // Dev mode uses appRoot
      expect(
        resolveHomeDir(
          { isPackaged: false, getPath: () => "/userdata" },
          "/repo",
        ),
      ).toBe("/repo");

      // Portable .exe uses writable PORTABLE_EXECUTABLE_DIR
      process.env.PORTABLE_EXECUTABLE_DIR = tmp;
      expect(
        resolveHomeDir(
          { isPackaged: true, getPath: () => "/userdata" },
          "/asar",
        ),
      ).toBe(tmp);

      // NSIS installed mode falls back to userData
      delete process.env.PORTABLE_EXECUTABLE_DIR;
      expect(
        resolveHomeDir(
          { isPackaged: true, getPath: () => "/appdata/HyruleSync" },
          "/asar",
        ),
      ).toBe("/appdata/HyruleSync");
    } finally {
      if (prevHome !== undefined) process.env.HYRULESYNC_HOME = prevHome;
      else delete process.env.HYRULESYNC_HOME;
      if (prevPortable !== undefined) {
        process.env.PORTABLE_EXECUTABLE_DIR = prevPortable;
      } else {
        delete process.env.PORTABLE_EXECUTABLE_DIR;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("quits immediately when another instance already holds the single-instance lock", async () => {
    const mock = createMockElectron({ singleInstance: false });
    const instance = await startElectronApp(mock.electron);
    expect(instance).toBeNull();
    expect(mock.getQuitCalled()).toBe(true);
  });

  it("starts backend + BrowserWindow + Tray, routes external links to OS browser, supports tray background mode and IPC pickers", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hyrulesync-main-"));
    const prevHome = process.env.HYRULESYNC_HOME;
    process.env.HYRULESYNC_HOME = tmpHome;

    const mock = createMockElectron({ singleInstance: true });
    const appRoot = path.resolve(import.meta.dirname, "../..");

    try {
      const runtime = await startElectronApp(mock.electron, {
        appRoot,
        argv: [],
      });
      expect(runtime).not.toBeNull();
      expect(runtime.mainWindow).not.toBeNull();
      expect(runtime.mainWindow.options.webPreferences.contextIsolation).toBe(
        true,
      );
      expect(runtime.mainWindow.options.webPreferences.nodeIntegration).toBe(
        false,
      );
      expect(runtime.mainWindow.options.webPreferences.sandbox).toBe(true);
      expect(runtime.uiUrl).toMatch(
        /^http:\/\/hyrulesync\.localhost:\d+\/[0-9a-f]{32}\/$/,
      );

      // Internal vs external URL handling
      expect(isSafeExternalUrl("https://zeldadungeon.net")).toBe(true);
      expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);

      const popupExternal = runtime.mainWindow.windowOpenHandler({
        url: "https://zeldadungeon.net/wiki/Lookout_Landing",
      });
      expect(popupExternal).toEqual({ action: "deny" });
      expect(mock.openedExternals).toContain(
        "https://zeldadungeon.net/wiki/Lookout_Landing",
      );

      const popupInternal = runtime.mainWindow.windowOpenHandler({
        url: `${runtime.uiUrl}#folder`,
      });
      expect(popupInternal).toEqual({ action: "allow" });

      // Native folder/file picker IPC handlers
      const folderHandler = mock.ipcHandlers.get("hyrulesync:select-folder");
      expect(await folderHandler({}, tmpHome)).toBe("/mock/save-folder");

      mock.setDialogResponse({ canceled: true, filePaths: [] });
      expect(await folderHandler({}, tmpHome)).toBeNull();

      // Background tray mode hides window on close instead of quitting
      runtime.backend.settings.runInBackground = true;
      let prevented = false;
      runtime.mainWindow.emit("close", {
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
      expect(runtime.mainWindow.isVisible()).toBe(false);

      // Tray menu restores window or exits cleanly
      const menu = mock.getLastMenuTemplate();
      expect(menu[0].label).toBe("Open Totkmap");
      menu[0].click();
      expect(runtime.mainWindow.isVisible()).toBe(true);

      // Exit item quits cleanly and stops backend
      menu[4].click();
      expect(mock.getQuitCalled()).toBe(true);
    } finally {
      if (prevHome !== undefined) process.env.HYRULESYNC_HOME = prevHome;
      else delete process.env.HYRULESYNC_HOME;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
