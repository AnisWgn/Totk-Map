import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { Catalog } from "./catalog.js";
import { HDMapTileCache } from "./hd-map-tiles.js";
import { LocaleManager } from "./locale.js";
import { MAP_PIN_COLORS, writeMapPinToSaveFile } from "./map-markers.js";
import { MapResourcesManager } from "./map-resources.js";
import { PageLifetime } from "./page-lifetime.js";
import { RecompLiveBridge } from "./recomp-live.js";
import { browseDirectories, getSourceOptions } from "./save-sources.js";
import {
  SaveSyncEngine,
  createDefaultSettings,
  upgradeSettings,
} from "./save-sync.js";
import { UpdateChecker } from "./updates.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PAGE_ID_REGEX = /^[0-9a-f]{32}$/;
const STRICT_INT_REGEX = /^[+-]?\d+$/;

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function cacheControlFor(contentType) {
  if (contentType === "image/webp") {
    return "private, max-age=31536000, immutable";
  }
  if (contentType === "image/png") {
    return "private, max-age=86400";
  }
  return "no-store";
}

function walkRelativeFiles(rootDir) {
  const map = new Map();
  if (!rootDir || !fs.existsSync(rootDir)) return map;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const rel = path.relative(rootDir, full).split(path.sep).join("/");
        map.set(rel, full);
      }
    }
  }
  if (map.has("index.html")) {
    map.set("", map.get("index.html"));
  }
  return map;
}

function resolveWebRoot(appRoot, explicitWebRoot) {
  if (explicitWebRoot && fs.existsSync(explicitWebRoot)) {
    return explicitWebRoot;
  }
  const candidates = [
    path.join(appRoot, "web-dist"),
    path.join(appRoot, ".local", "build", "web"),
    path.join(appRoot, "web", "public"),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
}

function resolveDataJson(appRoot, webRoot, fileName) {
  const candidates = [
    path.join(webRoot, fileName),
    path.join(appRoot, "web", "public", fileName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    }
  }
  throw new Error(`Missing data file: ${fileName}`);
}

function readBuildIdentity(appRoot, webRoot) {
  let version = "1.0.0";
  let commitSha = "";
  let repository = process.env.HYRULESYNC_REPO || undefined;

  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
    );
    if (pkg.version && /^\d+\.\d+\.\d+$/.test(pkg.version)) {
      version = pkg.version;
    }
  } catch {}

  for (const dir of [webRoot, appRoot]) {
    if (!dir) continue;
    const infoPath = path.join(dir, "build-info.json");
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
        if (info.version && /^\d+\.\d+\.\d+$/.test(info.version)) {
          version = info.version;
        }
        if (typeof info.commitSha === "string") {
          commitSha = info.commitSha;
        }
        if (
          !repository &&
          typeof info.repository === "string" &&
          info.repository
        ) {
          repository = info.repository;
        }
        break;
      } catch {}
    }
  }

  return { version, commitSha, repository };
}

function listenOnPort(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function createBackend({
  appRoot,
  homeDir = appRoot,
  webRoot: explicitWebRoot,
  args = [],
  systemCulture,
  preferredPort = 0,
  previewMode = false,
  enablePageLifetimeExit = false,
  onShouldExit,
  onSettingsChanged,
  onApplyUpdate = null,
  updateFetchImpl,
  recompLiveOptions = {},
}) {
  const resolvedAppRoot = path.resolve(appRoot);
  const resolvedHome = path.resolve(homeDir);
  const webRoot = resolveWebRoot(resolvedAppRoot, explicitWebRoot);
  const buildIdentity = readBuildIdentity(resolvedAppRoot, webRoot);
  const currentVersion = buildIdentity.version;
  const stateDir = path.join(resolvedHome, ".state");
  const dataRoot = path.join(resolvedHome, ".data");
  const settingsPath = path.join(stateDir, "settings.json");

  const locale = new LocaleManager(systemCulture);
  let settings = createDefaultSettings();

  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        settings = { ...createDefaultSettings(), ...parsed };
      }
    } catch {
      // Unreadable preferences leave defaults in place.
    }
  }

  settings.language = LocaleManager.preference(settings.language);
  settings.linkOpacity = Math.max(
    0,
    Math.min(100, Number(settings.linkOpacity ?? 45) || 0),
  );
  settings.mapQuality =
    settings.mapQuality === "high" || settings.mapQuality === "standard"
      ? settings.mapQuality
      : "high";

  locale.configure(args, settings.language);

  function saveSettings() {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
      if (typeof onSettingsChanged === "function") {
        onSettingsChanged(settings);
      }
      return true;
    } catch {
      return false;
    }
  }

  let urlFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--auto") settings.auto = true;
    if (i >= args.length - 1) continue;
    switch (args[i]) {
      case "--source":
        settings.source = path.resolve(args[++i]);
        settings.mode = "file";
        break;
      case "--folder":
        settings.source = path.resolve(args[++i]);
        settings.mode = "folder";
        break;
      case "--url-file":
        urlFile = path.resolve(args[++i]);
        break;
    }
  }

  const collectionData = resolveDataJson(
    resolvedAppRoot,
    webRoot,
    "collection-data.json",
  );
  const questData = resolveDataJson(
    resolvedAppRoot,
    webRoot,
    "quest-data.json",
  );
  const worldData = resolveDataJson(
    resolvedAppRoot,
    webRoot,
    "world-data.json",
  );
  const validArmorIds = new Set(
    (collectionData.armor || []).map((entry) => entry.id),
  );

  function normalizeArmorPlan(plan) {
    const target =
      plan && plan.target >= 1 && plan.target <= 4 ? plan.target : 4;
    const selected =
      !plan || !Array.isArray(plan.selected)
        ? []
        : [
            ...new Set(
              plan.selected.filter(
                (id) => typeof id === "string" && validArmorIds.has(id),
              ),
            ),
          ];
    return { target, selected };
  }

  settings.armorPlan = normalizeArmorPlan(settings.armorPlan);

  const mapResources = new MapResourcesManager({
    dataRoot,
    manifestPath: path.join(resolvedAppRoot, "assets", "resources.json"),
    locale,
    currentVersion,
  });
  const hdMapTiles = new HDMapTileCache({ dataRoot, currentVersion });
  const updates = new UpdateChecker({
    currentVersion,
    currentCommit: buildIdentity.commitSha,
    repository: buildIdentity.repository,
    locale,
    updatesDir: path.join(stateDir, "updates"),
    preferPortable: Boolean(
      process.env.PORTABLE_EXECUTABLE_FILE ||
      process.env.PORTABLE_EXECUTABLE_DIR,
    ),
    canAutoInstall: Boolean(onApplyUpdate),
    onApplyUpdate,
    fetchImpl: updateFetchImpl,
  });
  const pages = new PageLifetime();
  const recompLive = new RecompLiveBridge({
    enabled: Boolean(settings.recompLive),
    locale,
    ...recompLiveOptions,
  });

  const saveSync = new SaveSyncEngine({
    locale,
    mapResources,
    hdMapTiles,
    settings,
    saveSettings,
    definitions: {
      collections: collectionData.entries || [],
      quests: questData.quests || [],
      compendium: worldData.entries || [],
      characters: worldData.characters || [],
    },
  });

  const towersJson = fs.readFileSync(
    path.join(resolvedAppRoot, "assets", "towers.json"),
    "utf8",
  );
  const shrinesJson = fs.readFileSync(
    path.join(resolvedAppRoot, "assets", "shrines.json"),
    "utf8",
  );
  const creditsObj = {
    ...JSON.parse(
      fs.readFileSync(
        path.join(resolvedAppRoot, "assets", "credits.json"),
        "utf8",
      ),
    ),
    version: currentVersion,
  };
  const creditsBytes = Buffer.from(JSON.stringify(creditsObj), "utf8");

  const legalFiles = new Map([
    ["legal/app.txt", path.join(resolvedAppRoot, "LICENSE")],
    [
      "legal/leaflet.txt",
      path.join(resolvedAppRoot, "licenses", "Leaflet.txt"),
    ],
    ["legal/react.txt", path.join(resolvedAppRoot, "licenses", "React.txt")],
    [
      "legal/savegame-editors.txt",
      path.join(resolvedAppRoot, "licenses", "SavegameEditors.txt"),
    ],
    ["legal/third-party.en.md", path.join(resolvedAppRoot, "THIRD_PARTY.md")],
    [
      "legal/third-party.es.md",
      path.join(resolvedAppRoot, "docs", "THIRD_PARTY.es.md"),
    ],
  ]);

  function loadCatalog() {
    const mapDataPath = path.join(mapResources.root, "map_data.json");
    if (!fs.existsSync(mapDataPath)) return;
    const mapDataText = fs.readFileSync(mapDataPath, "utf8");
    const loaded = Catalog.load(mapDataText, towersJson, shrinesJson, locale);
    saveSync.setCatalog(loaded);
  }

  if (mapResources.ready) {
    loadCatalog();
  }
  mapResources.onReady = loadCatalog;

  function setLanguage(preference) {
    if (preference !== "en" && preference !== "es" && preference !== "auto") {
      throw new Error(
        locale.t(
          "Elige español, inglés o automático.",
          "Choose Spanish, English or automatic.",
        ),
      );
    }
    locale.configure([], preference);
    settings.language = preference;
    if (saveSync.catalog) {
      loadCatalog();
      saveSync.localizeAllSnapshots();
    }
    saveSettings();
  }

  function setLinkOpacity(text) {
    if (!STRICT_INT_REGEX.test(text)) {
      throw new Error(
        locale.t(
          "La opacidad debe estar entre 0 y 100.",
          "Opacity must be between 0 and 100.",
        ),
      );
    }
    const opacity = Number(text);
    if (!Number.isInteger(opacity) || opacity < 0 || opacity > 100) {
      throw new Error(
        locale.t(
          "La opacidad debe estar entre 0 y 100.",
          "Opacity must be between 0 and 100.",
        ),
      );
    }
    settings.linkOpacity = opacity;
    saveSettings();
  }

  function setMapQuality(text) {
    if (text !== "standard" && text !== "high") {
      throw new Error(
        locale.t("Calidad del mapa inválida.", "Invalid map quality."),
      );
    }
    settings.mapQuality = text;
    saveSettings();
  }

  function setArmorPlan(text) {
    let plan;
    try {
      plan = JSON.parse(text);
    } catch {
      throw new Error(
        locale.t("Plan de armaduras inválido.", "Invalid armor plan."),
      );
    }
    if (
      !plan ||
      typeof plan !== "object" ||
      !Number.isInteger(plan.target) ||
      plan.target < 1 ||
      plan.target > 4 ||
      !Array.isArray(plan.selected) ||
      plan.selected.length > 135
    ) {
      throw new Error(
        locale.t("Plan de armaduras inválido.", "Invalid armor plan."),
      );
    }
    const normalized = normalizeArmorPlan(plan);
    if (normalized.selected.length !== plan.selected.length) {
      throw new Error(
        locale.t(
          "El plan contiene piezas inválidas o repetidas.",
          "The plan contains invalid or duplicate pieces.",
        ),
      );
    }
    const previous = settings.armorPlan;
    settings.armorPlan = normalized;
    if (!saveSettings()) {
      settings.armorPlan = previous;
      throw new Error(
        locale.t(
          "No se pudo guardar el plan de armaduras.",
          "The armor plan could not be saved.",
        ),
      );
    }
  }

  async function handleSetPin(rawText) {
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error(
        locale.t("Datos de baliza inválidos.", "Invalid pin payload."),
      );
    }
    const color = String(payload?.color || "");
    if (!MAP_PIN_COLORS.includes(color)) {
      throw new Error(
        locale.t("Color de baliza inválido.", "Invalid pin color."),
      );
    }

    const activePins =
      recompLive.pins ?? saveSync.lastValid?.mapMarkers?.pins ?? [];
    let slot = payload?.slot;
    if (slot === "auto" || slot === undefined || slot === null) {
      const sameColor = activePins.find((p) => p.color === color);
      if (sameColor) {
        slot = sameColor.slot;
      } else {
        const used = new Set(activePins.map((p) => p.slot));
        slot = [0, 1, 2, 3, 4, 5].find((s) => !used.has(s)) ?? 0;
      }
    }
    slot = Number(slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 5) {
      throw new Error(
        locale.t(
          "La ranura de baliza debe estar entre 1 y 6.",
          "Pin slot must be between 1 and 6.",
        ),
      );
    }

    const position = {
      x: Number(payload?.position?.x ?? 0),
      y: Number(payload?.position?.y ?? 120),
      z: Number(payload?.position?.z ?? 0),
    };
    const target = payload?.target || "auto";

    if (
      target !== "save" &&
      (recompLive.status === "bridge" ||
        (recompLive.status === "connected" && recompLive.canWriteMemory))
    ) {
      const memRes = await recompLive.writePinInMemory({
        slot,
        color,
        position,
      });
      if (memRes.ok) {
        return {
          ok: true,
          appliedTo: recompLive.status === "bridge" ? "bridge" : "memory",
          slot,
          color,
          live: recompLive.state(),
        };
      }
      if (target === "memory") {
        throw new Error(memRes.error || "Memory write failed.");
      }
    }

    const saveFile = saveSync.lastValid?.file;
    if (saveFile && fs.existsSync(saveFile)) {
      writeMapPinToSaveFile(
        saveFile,
        path.join(stateDir, "backups"),
        { slot, color, position },
        locale,
      );
      saveSync.refreshSaves();
      return {
        ok: true,
        appliedTo: "save",
        slot,
        color,
        live: recompLive.state(),
      };
    }

    throw new Error(
      locale.t(
        "Conecta TotK Recomp en directo o carga un archivo progress.sav en disco para colocar una baliza.",
        "Connect TotK Recomp live or load a progress.sav file on disk to place a pin.",
      ),
    );
  }

  const postRoutes = new Map([
    [
      "api/prepare-map",
      { requiresMap: false, handle: () => mapResources.startDownload() },
    ],
    [
      "api/map-quality",
      {
        requiresMap: true,
        handle: (body) => setMapQuality(body.toString("utf8").trim()),
      },
    ],
    [
      "api/download-hd-map",
      { requiresMap: false, handle: () => hdMapTiles.startDownloadAll() },
    ],
    [
      "api/language",
      {
        requiresMap: false,
        handle: (body) => setLanguage(body.toString("utf8").trim()),
      },
    ],
    [
      "api/armor-plan",
      {
        requiresMap: false,
        handle: (body) => setArmorPlan(body.toString("utf8").trim()),
      },
    ],
    [
      "api/check-updates",
      { requiresMap: false, handle: () => updates.check(true) },
    ],
    [
      "api/download-update",
      {
        requiresMap: false,
        handle: (body) => {
          let autoApply = false;
          try {
            const raw = body.toString("utf8").trim();
            if (raw) autoApply = Boolean(JSON.parse(raw)?.autoApply);
          } catch {}
          return updates.startDownload({ autoApply });
        },
      },
    ],
    [
      "api/cancel-update",
      { requiresMap: false, handle: () => updates.cancelDownload() },
    ],
    [
      "api/apply-update",
      { requiresMap: false, handle: () => updates.applyUpdate() },
    ],
    [
      "api/follow-on",
      {
        requiresMap: false,
        handle: () => {
          settings.followLink = true;
          saveSettings();
        },
      },
    ],
    [
      "api/follow-off",
      {
        requiresMap: false,
        handle: () => {
          settings.followLink = false;
          saveSettings();
        },
      },
    ],
    [
      "api/show-link",
      {
        requiresMap: false,
        handle: () => {
          settings.showLink = true;
          saveSettings();
        },
      },
    ],
    [
      "api/hide-link",
      {
        requiresMap: false,
        handle: () => {
          settings.showLink = false;
          saveSettings();
        },
      },
    ],
    [
      "api/link-above",
      {
        requiresMap: false,
        handle: () => {
          settings.linkOrder = "above";
          saveSettings();
        },
      },
    ],
    [
      "api/link-below",
      {
        requiresMap: false,
        handle: () => {
          settings.linkOrder = "below";
          saveSettings();
        },
      },
    ],
    [
      "api/background-on",
      {
        requiresMap: false,
        handle: () => {
          settings.runInBackground = true;
          saveSettings();
        },
      },
    ],
    [
      "api/background-off",
      {
        requiresMap: false,
        handle: () => {
          settings.runInBackground = false;
          saveSettings();
        },
      },
    ],
    [
      "api/page-close",
      {
        requiresMap: false,
        handle: (body) => {
          const pageId = body.toString("utf8");
          if (!PAGE_ID_REGEX.test(pageId)) {
            throw new Error("Invalid page session.");
          }
          pages.close(pageId, null, Date.now());
        },
      },
    ],
    [
      "api/link-opacity",
      {
        requiresMap: false,
        handle: (body) => setLinkOpacity(body.toString("utf8").trim()),
      },
    ],
    [
      "api/inspect-file",
      {
        requiresMap: true,
        handle: (body) =>
          saveSync.inspectionResult(
            saveSync.inspectFile(body.toString("utf8").trim()),
          ),
      },
    ],
    [
      "api/inspect-upload",
      {
        requiresMap: true,
        handle: (body) =>
          saveSync.inspectionResult(saveSync.parse(body, "progress.sav")),
      },
    ],
    [
      "api/upload",
      { requiresMap: true, handle: (body) => saveSync.uploadSave(body) },
    ],
    [
      "api/set-file",
      {
        requiresMap: true,
        handle: (body) => saveSync.selectFile(body.toString("utf8").trim()),
      },
    ],
    [
      "api/set-folder",
      {
        requiresMap: true,
        handle: (body) => saveSync.selectFolder(body.toString("utf8").trim()),
      },
    ],
    [
      "api/refresh",
      { requiresMap: true, handle: () => saveSync.refreshSaves() },
    ],
    [
      "api/auto-on",
      { requiresMap: true, handle: () => saveSync.setAuto(true) },
    ],
    [
      "api/auto-off",
      { requiresMap: true, handle: () => saveSync.setAuto(false) },
    ],
    [
      "api/live-on",
      {
        requiresMap: false,
        handle: () => {
          settings.recompLive = true;
          saveSettings();
          return recompLive.setEnabled(true);
        },
      },
    ],
    [
      "api/live-off",
      {
        requiresMap: false,
        handle: () => {
          settings.recompLive = false;
          saveSettings();
          return recompLive.setEnabled(false);
        },
      },
    ],
    [
      "api/live-rescan",
      { requiresMap: false, handle: () => recompLive.rescan() },
    ],
    [
      "api/live-telemetry",
      {
        requiresMap: false,
        handle: (body) =>
          recompLive.ingestExternalTelemetry(
            JSON.parse(body.toString("utf8").trim()),
          ),
      },
    ],
    [
      "api/set-pin",
      {
        requiresMap: false,
        handle: (body) => handleSetPin(body.toString("utf8").trim()),
      },
    ],
  ]);

  let server = null;
  let scanTimer = null;
  let pageTimer = null;
  let running = false;
  let boundPort = 0;
  let url = "";
  const token = crypto.randomBytes(16).toString("hex");
  const sseConnections = new Set();
  const webFiles = walkRelativeFiles(webRoot);

  function cspHeaderValue() {
    const base =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://raw.githubusercontent.com https://www.zeldadungeon.net https://cdn.wikimg.net; connect-src 'self'; base-uri 'self'";
    return previewMode ? base : `${base}; frame-ancestors 'none'`;
  }

  function sendResponse(res, body, contentType, statusCode = 200) {
    const buffer = Buffer.isBuffer(body)
      ? body
      : Buffer.from(String(body), "utf8");
    const statusMessages = {
      200: "OK",
      400: "Bad Request",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
    };
    res.statusCode = statusCode;
    res.statusMessage = statusMessages[statusCode] || "OK";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", cacheControlFor(contentType));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", cspHeaderValue());
    res.setHeader("Connection", "close");
    res.end(buffer);
  }

  function jsonResponse(res, value, statusCode = 200) {
    sendResponse(
      res,
      JSON.stringify(value),
      "application/json; charset=utf-8",
      statusCode,
    );
  }

  function textResponse(res, text, statusCode) {
    sendResponse(res, text, "text/plain; charset=utf-8", statusCode);
  }

  function isAuthorized(req, parsedUrl) {
    if (previewMode) {
      return !parsedUrl.pathname.includes("..");
    }

    const host = String(req.headers.host || "");
    const portSuffix = `:${boundPort}`;
    const validHost =
      host.toLowerCase() === `hyrulesync.localhost${portSuffix}` ||
      host.toLowerCase() === `127.0.0.1${portSuffix}`;
    if (!validHost) return false;

    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      String(origin).toLowerCase() !== `http://${host.toLowerCase()}`
    ) {
      return false;
    }

    return parsedUrl.pathname.startsWith(`/${token}/`);
  }

  async function serveAsset(res, routePath) {
    if (routePath.startsWith("map-tiles/")) {
      const enabled = mapResources.ready && settings.mapQuality === "high";
      // Re-scan if a tile was dropped directly on disk (e.g., offline cache restore or tests)
      const tile = await hdMapTiles.read(routePath, enabled);
      if (!tile) {
        textResponse(res, "Map tile unavailable.", 404);
      } else {
        sendResponse(res, tile, "image/webp", 200);
      }
      return;
    }

    if (legalFiles.has(routePath)) {
      const legalPath = legalFiles.get(routePath);
      if (fs.existsSync(legalPath)) {
        sendResponse(
          res,
          fs.readFileSync(legalPath),
          contentTypeFor(routePath),
          200,
        );
        return;
      }
    }

    if (webFiles.has(routePath)) {
      const targetFile = webFiles.get(routePath);
      sendResponse(
        res,
        fs.readFileSync(targetFile),
        contentTypeFor(targetFile),
        200,
      );
      return;
    }

    if (
      mapResources.ready &&
      routePath.endsWith(".png") &&
      mapResources.manifest.files.some((f) => f.path === routePath)
    ) {
      const dataFile = path.join(mapResources.root, routePath);
      if (fs.existsSync(dataFile)) {
        sendResponse(res, fs.readFileSync(dataFile), "image/png", 200);
        return;
      }
    }

    textResponse(res, locale.t("No encontrado.", "Not found."), 404);
  }

  function handlePageSession(req, res, parsedUrl) {
    const pageId = parsedUrl.searchParams.get("id") || "";
    if (!PAGE_ID_REGEX.test(pageId)) {
      req.socket.destroy();
      return;
    }

    const connection = {};
    pages.open(pageId, connection);
    sseConnections.add(res);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "close",
    });
    res.write(": connected\n\n");

    const interval = setInterval(() => {
      if (!running || !pages.connected(pageId, connection) || res.destroyed) {
        clearInterval(interval);
        res.end();
        return;
      }
      try {
        res.write(": connected\n\n");
      } catch {
        clearInterval(interval);
      }
    }, 1000);

    const cleanup = () => {
      clearInterval(interval);
      sseConnections.delete(res);
      pages.close(pageId, connection, Date.now());
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  function readRequestBody(req) {
    return new Promise((resolve, reject) => {
      const rawLength = req.headers["content-length"];
      if (!previewMode) {
        if (
          rawLength === undefined ||
          !/^\d+$/.test(String(rawLength).trim())
        ) {
          reject(new Error("Invalid Content-Length"));
          return;
        }
      }

      const expectedLength =
        rawLength !== undefined ? Number(String(rawLength).trim()) : null;
      if (
        expectedLength !== null &&
        (!Number.isInteger(expectedLength) ||
          expectedLength < 0 ||
          expectedLength > MAX_BODY_BYTES)
      ) {
        reject(new Error("Invalid request size"));
        return;
      }

      const chunks = [];
      let received = 0;
      let settled = false;

      req.on("data", (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (
          received > MAX_BODY_BYTES ||
          (expectedLength !== null && received > expectedLength)
        ) {
          settled = true;
          reject(new Error("Oversized body"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("aborted", () => {
        if (settled) return;
        settled = true;
        reject(new Error("Aborted upload"));
      });

      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      req.on("end", () => {
        if (settled) return;
        if (expectedLength !== null && received !== expectedLength) {
          settled = true;
          reject(new Error("Incomplete upload"));
          return;
        }
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async function handleRequest(req, res) {
    try {
      const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (!isAuthorized(req, parsedUrl)) {
        textResponse(
          res,
          locale.t("Acceso no autorizado.", "Unauthorized access."),
          403,
        );
        return;
      }

      const routePath = previewMode
        ? parsedUrl.pathname.slice(1)
        : parsedUrl.pathname.slice(token.length + 2);

      if (req.method === "GET" && routePath === "api/page-session") {
        handlePageSession(req, res, parsedUrl);
        return;
      }

      if (req.method === "GET") {
        switch (routePath) {
          case "api/config":
            jsonResponse(res, {
              language: locale.language,
              languagePreference: settings.language,
              windowsCulture: locale.windowsCulture,
              runInBackground: settings.runInBackground,
              armorPlan: normalizeArmorPlan(settings.armorPlan),
            });
            return;
          case "api/credits":
            sendResponse(
              res,
              creditsBytes,
              "application/json; charset=utf-8",
              200,
            );
            return;
          case "api/updates":
            updates.check(false);
            jsonResponse(res, updates.state());
            return;
          case "api/live":
            jsonResponse(res, recompLive.state());
            return;
          case "api/setup":
            jsonResponse(res, mapResources.state());
            return;
          case "api/folders":
            try {
              const queryPath = parsedUrl.searchParams.get("path") ?? "";
              jsonResponse(res, browseDirectories(queryPath, locale));
            } catch (ex) {
              jsonResponse(res, { error: ex.message }, 400);
            }
            return;
          case "api/state":
            jsonResponse(res, saveSync.state());
            return;
          case "api/saves":
            jsonResponse(res, saveSync.saveSlots());
            return;
          case "catalog.json":
            sendResponse(
              res,
              saveSync.catalogBytes ?? Buffer.from("{}", "utf8"),
              "application/json; charset=utf-8",
              200,
            );
            return;
          case "api/source-options":
            jsonResponse(res, getSourceOptions(resolvedHome, settings));
            return;
          default:
            await serveAsset(res, routePath);
            return;
        }
      }

      if (req.method === "POST") {
        let body;
        try {
          body = await readRequestBody(req);
        } catch {
          req.socket.destroy();
          return;
        }

        const hasOrigin = previewMode || req.headers.origin !== undefined;
        if (!hasOrigin || !routePath.startsWith("api/")) {
          textResponse(
            res,
            locale.t("Método no permitido.", "Method not allowed."),
            405,
          );
          return;
        }

        const route = postRoutes.get(routePath);
        try {
          if ((!route || route.requiresMap) && !mapResources.ready) {
            throw new Error(
              locale.t(
                "Primero prepara los recursos del mapa.",
                "Prepare the map resources first.",
              ),
            );
          }
          if (!route) {
            jsonResponse(res, { ok: false, error: null }, 404);
            return;
          }
          const result = await route.handle(body);
          jsonResponse(res, result ?? { ok: true, error: null }, 200);
        } catch (ex) {
          jsonResponse(res, { ok: false, error: ex.message }, 400);
        }
        return;
      }

      textResponse(
        res,
        locale.t("Método no permitido.", "Method not allowed."),
        405,
      );
    } catch {
      if (!res.headersSent) {
        req.socket.destroy();
      }
    }
  }

  async function start() {
    fs.mkdirSync(stateDir, { recursive: true });
    if (upgradeSettings(settings)) {
      saveSettings();
    }

    server = http.createServer((req, res) => {
      handleRequest(req, res);
    });
    server.on("clientError", (_err, socket) => {
      socket.destroy();
    });

    const bindHost = previewMode ? "0.0.0.0" : "127.0.0.1";
    try {
      boundPort = await listenOnPort(server, bindHost, preferredPort);
    } catch (err) {
      if (!previewMode && preferredPort !== 0 && err.code === "EADDRINUSE") {
        boundPort = await listenOnPort(server, bindHost, 0);
      } else {
        throw err;
      }
    }

    running = true;
    url = previewMode
      ? `http://127.0.0.1:${boundPort}/`
      : `http://hyrulesync.localhost:${boundPort}/${token}/`;

    fs.writeFileSync(path.join(stateDir, "url.txt"), url, "utf8");
    if (urlFile) {
      fs.mkdirSync(path.dirname(urlFile), { recursive: true });
      fs.writeFileSync(urlFile, url, "utf8");
    }

    saveSync.scan();
    recompLive.start();
    scanTimer = setInterval(() => saveSync.scan(), 500);

    if (enablePageLifetimeExit) {
      pageTimer = setInterval(() => {
        if (
          pages.shouldExit(
            Date.now(),
            settings.runInBackground,
            hdMapTiles.downloadingAll,
          )
        ) {
          if (typeof onShouldExit === "function") {
            onShouldExit();
          }
        }
      }, 500);
    }

    return { url, port: boundPort, token };
  }

  async function stop() {
    running = false;
    recompLive.stop();
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    if (pageTimer) {
      clearInterval(pageTimer);
      pageTimer = null;
    }
    for (const res of sseConnections) {
      try {
        res.end();
      } catch {}
    }
    sseConnections.clear();

    if (server) {
      const toClose = server;
      server = null;
      await new Promise((resolve) => {
        toClose.close(() => resolve());
      });
    }
  }

  return {
    locale,
    settings,
    mapResources,
    hdMapTiles,
    updates,
    recompLive,
    pages,
    saveSync,
    get url() {
      return url;
    },
    get port() {
      return boundPort;
    },
    get token() {
      return token;
    },
    start,
    stop,
    toggleAutosync: () => saveSync.toggleAutosync(),
  };
}
