import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBackend } from "./backend/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LOOPBACK_PORT = 45732;

export function isDirectoryWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(
      dirPath,
      `.hyrulesync-write-test-${process.pid}-${Date.now()}`,
    );
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function resolveHomeDir(app, appRoot = DEFAULT_APP_ROOT) {
  if (process.env.HYRULESYNC_HOME) {
    return path.resolve(process.env.HYRULESYNC_HOME);
  }
  if (!app.isPackaged) {
    return appRoot;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const portableDir = path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
    if (isDirectoryWritable(path.join(portableDir, ".state"))) {
      return portableDir;
    }
  }
  return app.getPath("userData");
}

export function isSafeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function startElectronApp(
  electron,
  {
    appRoot = DEFAULT_APP_ROOT,
    argv = process.argv.slice(1),
    createViteServer = null,
    spawnProcess = cp.spawn,
    platform = process.platform,
    updateFetchImpl,
  } = {},
) {
  const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    dialog,
    ipcMain,
    shell,
    nativeImage,
  } = electron;

  const isDev = !app.isPackaged && argv.includes("--dev");
  let mainWindow = null;
  let tray = null;
  let backend = null;
  let viteServer = null;
  let uiUrl = "";
  let uiOrigin = "";
  let isQuitting = false;

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return null;
  }

  function focusMainWindow(fragment = "") {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow(fragment);
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    if (fragment && uiUrl) {
      mainWindow.loadURL(uiUrl + fragment);
    }
  }

  app.on("second-instance", () => {
    focusMainWindow();
  });

  function resolveIconPath(forTray = false) {
    const fileName =
      process.platform === "win32"
        ? "hyrulesync.ico"
        : forTray
          ? "HyruleSync-icon-32.png"
          : "HyruleSync-icon.png";
    const candidate = path.join(appRoot, "assets", fileName);
    const unpacked = candidate.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    return fs.existsSync(unpacked) ? unpacked : candidate;
  }

  function buildTrayMenu() {
    if (!backend) return null;
    const t = (es, en) => backend.locale.t(es, en);
    return Menu.buildFromTemplate([
      {
        label: t("Abrir Totkmap", "Open Totkmap"),
        click: () => focusMainWindow(),
      },
      {
        label: t("Elegir carpeta de guardados…", "Choose save folder…"),
        click: () => focusMainWindow("#folder"),
      },
      {
        label: t("Pausar / reanudar Autosync", "Pause / resume Autosync"),
        click: () => backend.toggleAutosync(),
      },
      { type: "separator" },
      {
        label: t("Salir", "Exit"),
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
  }

  function refreshTrayMenu() {
    if (!tray) return;
    const menu = buildTrayMenu();
    if (menu) {
      tray.setContextMenu(menu);
    }
  }

  function setupTray() {
    try {
      const iconPath = resolveIconPath(true);
      const image = nativeImage
        ? nativeImage.createFromPath(iconPath)
        : iconPath;
      tray = new Tray(image);
      tray.setToolTip("Totkmap");
      refreshTrayMenu();
      tray.on("double-click", () => focusMainWindow());
    } catch {
      // Headless or tray-less desktop environments continue with the main window.
      tray = null;
    }
  }

  function createMainWindow(fragment = "") {
    const iconPath = resolveIconPath(false);
    const titleBarOptions =
      process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" }
        : {
            titleBarStyle: "hidden",
            titleBarOverlay: {
              color: "rgba(0, 0, 0, 0)",
              symbolColor: "#e5e7e4",
              height: 58,
            },
          };

    if (process.platform !== "darwin") {
      Menu?.setApplicationMenu?.(null);
    }

    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      title: "Totkmap",
      backgroundColor: "#0e1519",
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      autoHideMenuBar: true,
      ...titleBarOptions,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.setMenuBarVisibility?.(false);

    mainWindow.once("ready-to-show", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      try {
        if (new URL(targetUrl).origin === uiOrigin) {
          return { action: "allow" };
        }
      } catch {}
      if (isSafeExternalUrl(targetUrl)) {
        shell.openExternal(targetUrl).catch(() => {});
      }
      return { action: "deny" };
    });

    mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
      try {
        if (new URL(targetUrl).origin === uiOrigin) {
          return;
        }
      } catch {}
      event.preventDefault();
      if (isSafeExternalUrl(targetUrl)) {
        shell.openExternal(targetUrl).catch(() => {});
      }
    });

    mainWindow.on("close", (event) => {
      if (!isQuitting && backend?.settings.runInBackground && tray) {
        event.preventDefault();
        mainWindow.hide();
      }
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    if (uiUrl) {
      mainWindow.loadURL(uiUrl + fragment);
    }

    if (isDev && process.env.HYRULESYNC_OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    return mainWindow;
  }

  function registerIpcHandlers() {
    ipcMain.handle("hyrulesync:select-folder", async (_event, defaultPath) => {
      const options = {
        properties: ["openDirectory"],
      };
      if (
        defaultPath &&
        typeof defaultPath === "string" &&
        fs.existsSync(defaultPath)
      ) {
        options.defaultPath = defaultPath;
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths.length) return null;
      return result.filePaths[0];
    });

    ipcMain.handle(
      "hyrulesync:select-save-file",
      async (_event, defaultPath) => {
        const options = {
          properties: ["openFile"],
          filters: [
            { name: "TOTK Save (progress.sav)", extensions: ["sav"] },
            { name: "All Files", extensions: ["*"] },
          ],
        };
        if (
          defaultPath &&
          typeof defaultPath === "string" &&
          fs.existsSync(defaultPath)
        ) {
          options.defaultPath = defaultPath;
        }
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
      },
    );
  }

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("window-all-closed", () => {
    if (backend?.settings.runInBackground && tray && !isQuitting) {
      return;
    }
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (!mainWindow) {
      createMainWindow();
    } else {
      focusMainWindow();
    }
  });

  await app.whenReady();

  const homeDir = resolveHomeDir(app, appRoot);
  const systemCulture =
    typeof app.getLocale === "function" ? app.getLocale() : undefined;

  async function applyDownloadedUpdate({ filePath, assetName }) {
    if (
      platform === "win32" &&
      String(filePath).toLowerCase().endsWith(".exe")
    ) {
      const portableTarget = process.env.PORTABLE_EXECUTABLE_FILE;
      if (portableTarget && String(assetName).includes("-portable.exe")) {
        const scriptPath = path.join(
          path.dirname(filePath),
          "apply-portable-update.ps1",
        );
        const script = [
          "param([int]$TargetPid, [string]$SourceExe, [string]$DestExe)",
          "for ($i = 0; $i -lt 120; $i++) {",
          "  if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) { break }",
          "  Start-Sleep -Milliseconds 500",
          "}",
          "Start-Sleep -Milliseconds 400",
          "Copy-Item -LiteralPath $SourceExe -Destination $DestExe -Force",
          "Start-Process -FilePath $DestExe",
        ].join("\r\n");
        fs.writeFileSync(scriptPath, script, "utf8");
        const child = spawnProcess(
          "powershell.exe",
          [
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            String(process.pid),
            filePath,
            portableTarget,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child?.unref?.();
      } else {
        const child = spawnProcess(filePath, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child?.unref?.();
      }

      isQuitting = true;
      setTimeout(() => app.quit(), 120);
      return;
    }

    if (typeof shell.showItemInFolder === "function") {
      shell.showItemInFolder(filePath);
    } else if (typeof shell.openExternal === "function") {
      await shell.openExternal(`file://${filePath}`);
    }
  }

  backend = createBackend({
    appRoot,
    homeDir,
    args: argv,
    systemCulture,
    preferredPort: DEFAULT_LOOPBACK_PORT,
    enablePageLifetimeExit: false,
    onSettingsChanged: () => refreshTrayMenu(),
    onApplyUpdate: applyDownloadedUpdate,
    updateFetchImpl,
  });

  const started = await backend.start();
  uiUrl = started.url;

  if (isDev) {
    process.env.HYRULESYNC_URL = started.url;
    const viteFactory = createViteServer || (await import("vite")).createServer;
    viteServer = await viteFactory({
      configFile: path.join(appRoot, "vite.config.js"),
      server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: false,
      },
    });
    await viteServer.listen();
    const resolvedUrls = viteServer.resolvedUrls?.local;
    uiUrl =
      resolvedUrls && resolvedUrls.length > 0
        ? resolvedUrls[0]
        : `http://127.0.0.1:${viteServer.config.server.port}/`;
  }

  uiOrigin = new URL(uiUrl).origin;

  registerIpcHandlers();
  setupTray();
  createMainWindow();

  app.on("will-quit", () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (viteServer) {
      viteServer.close().catch(() => {});
      viteServer = null;
    }
    if (backend) {
      backend.stop().catch(() => {});
    }
  });

  return {
    get mainWindow() {
      return mainWindow;
    },
    get tray() {
      return tray;
    },
    backend,
    uiUrl,
    focusMainWindow,
  };
}

// Auto-start only when executed inside the Electron runtime
if (process.versions.electron) {
  import("electron")
    .then((electronMod) => startElectronApp(electronMod.default || electronMod))
    .catch((err) => {
      console.error("Failed to start HyruleSync Electron app:", err);
      process.exit(1);
    });
}
