import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SaveReader } from "./save-reader.js";
import { readMapMarkers } from "./map-markers.js";
import {
  readInventory,
  readQuests,
  readCompendium,
  readCharacters,
  readCollections,
} from "./readers.js";
import { enumerateSaveFiles, resolveSaveFolder } from "./save-sources.js";

const MAX_SAVE_BYTES = 4 * 1024 * 1024;

export function createDefaultSettings() {
  return {
    armorPlan: { target: 4, selected: [] },
    version: 2,
    source: "",
    mode: "file",
    linkOrder: "below",
    language: "auto",
    mapQuality: "high",
    auto: true,
    followLink: false,
    showLink: true,
    runInBackground: false,
    linkOpacity: 45,
    recompLive: process.platform === "win32",
  };
}

export function upgradeSettings(settings) {
  if ((settings.version ?? 0) >= 2) return false;
  settings.version = 2;
  settings.mapQuality = "high";
  return true;
}

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function readSaveFileReadOnly(filePath, locale) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SAVE_BYTES) {
    throw new Error(
      locale.t(
        "El archivo supera el tamaño de un guardado de TOTK.",
        "The file exceeds the size of a TOTK save.",
      ),
    );
  }
  return fs.readFileSync(filePath);
}

export class SaveSyncEngine {
  constructor({
    locale,
    mapResources,
    hdMapTiles,
    settings,
    saveSettings,
    definitions,
  }) {
    this.locale = locale;
    this.mapResources = mapResources;
    this.hdMapTiles = hdMapTiles;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.definitions = definitions;

    this.catalog = null;
    this.catalogBytes = null;
    this.cache = new Map();
    this.warning = "";
    this.force = true;
    this.imported = null;
    this.lastValid = null;
    this.sourceNotice = "";
    this.checkedAt = "";
    this.changedAt = "";
    this.lastRevision = "";
    this.updateCount = 0;
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.catalogBytes = Buffer.from(JSON.stringify(catalog), "utf8");
  }

  localizeAllSnapshots() {
    if (!this.catalog) return;
    for (const item of this.cache.values()) {
      this.localizeSnapshot(item.snapshot);
    }
    this.localizeSnapshot(this.imported);
    this.localizeSnapshot(this.lastValid);
  }

  localizeSnapshot(snapshot) {
    if (!snapshot || !this.catalog) return;
    const labels = [
      ["GUID presente", "GUID present"],
      ["GUID ausente", "GUID absent"],
      ["Hash ausente del guardado", "Hash missing from the save"],
    ];
    for (let i = 0; i < snapshot.values.length; i++) {
      for (const [es, en] of labels) {
        if (snapshot.values[i] === es || snapshot.values[i] === en) {
          snapshot.values[i] = this.locale.t(es, en);
          break;
        }
      }
    }
    if (snapshot.playerContext) {
      snapshot.playerContext = SaveReader.resolveContext(
        snapshot.playerContext.mapId,
        snapshot.playerPosition,
        this.catalog.points,
      );
    }
  }

  parse(data, filePath) {
    const reader = new SaveReader(data, this.locale);
    const points = this.catalog ? this.catalog.points : [];
    const states = new Array(points.length);
    const visited = new Array(points.length);
    const shrineChests = new Array(points.length);
    const values = new Array(points.length);

    for (let i = 0; i < points.length; i++) {
      const pointResult = reader.state(points[i]);
      states[i] = pointResult.state;
      values[i] = pointResult.raw;
      visited[i] = reader.booleanState(points[i].visitHash);
      shrineChests[i] = reader.readChests(points[i]);
    }

    const position = reader.playerPosition();
    let savedAt = new Date().toISOString();
    try {
      if (filePath && fs.existsSync(filePath)) {
        savedAt = fs.statSync(filePath).mtime.toISOString();
      }
    } catch {}

    return {
      collections: readCollections(reader, this.definitions.collections),
      characterProfiles: readCharacters(reader, this.definitions.characters),
      compendium: readCompendium(reader, this.definitions.compendium),
      quests: readQuests(reader, this.definitions.quests),
      inventory: readInventory(reader),
      mapMarkers: readMapMarkers(reader),
      revision: sha256Hex(reader.bytes),
      file: filePath,
      savedAt,
      format: reader.format,
      playtime: reader.playtime,
      states,
      visited,
      shrineChests,
      values,
      tableEnd: reader.tableEnd,
      guidStart: reader.guidStart,
      playerPosition: position,
      playerContext: SaveReader.resolveContext(
        reader.currentMap(),
        position,
        points,
      ),
    };
  }

  inspectFile(rawPath) {
    const fullPath = path.resolve(rawPath);
    const before = fs.statSync(fullPath);
    const data = readSaveFileReadOnly(fullPath, this.locale);
    const result = this.parse(data, fullPath);
    const after = fs.statSync(fullPath);
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      throw new Error(
        this.locale.t(
          "El juego está escribiendo el guardado. Se reintentará.",
          "The game is writing the save. HyruleSync will retry.",
        ),
      );
    }
    result.savedAt = before.mtime.toISOString();
    return result;
  }

  saveSummary(snapshot) {
    return {
      file: snapshot.file,
      savedAt: snapshot.savedAt,
      playtime: snapshot.playtime,
      format: snapshot.format,
      playerContext: snapshot.playerContext,
      counts: this.catalog ? this.catalog.countProgress(snapshot.states) : [],
    };
  }

  inspectionResult(snapshot) {
    return {
      ok: true,
      snapshot,
      summary: this.saveSummary(snapshot),
    };
  }

  uploadSave(bodyBuffer) {
    const next = this.parse(bodyBuffer, "progress.sav");
    this.imported = next;
    this.cache.clear();
    this.lastValid = null;
    this.sourceNotice = "";
    this.settings.source = "";
    this.settings.mode = "memory";
    this.settings.auto = false;
    this.warning = "";
    this.force = false;
    this.saveSettings();
  }

  selectFile(rawPath) {
    const file = path.resolve(rawPath);
    this.parse(readSaveFileReadOnly(file, this.locale), file);
    this.setSource(file, "file");
    this.settings.auto = false;
    this.saveSettings();
  }

  selectFolder(rawPath) {
    const dir = path.resolve(rawPath);
    const parsed = path.parse(dir);
    if (dir === parsed.root) {
      throw new Error(
        this.locale.t(
          "Elige una carpeta de guardados, no una unidad completa.",
          "Select a save folder, not an entire drive.",
        ),
      );
    }
    if (!fs.existsSync(dir) || enumerateSaveFiles(dir).length === 0) {
      throw new Error(
        this.locale.t(
          "La carpeta no contiene ningún progress.sav.",
          "The folder does not contain any progress.sav files.",
        ),
      );
    }
    this.setSource(dir, "folder");
  }

  setSource(source, mode) {
    this.settings.source = source;
    this.settings.mode = mode;
    if (mode === "folder") this.settings.auto = true;
    this.force = true;
    this.cache.clear();
    this.imported = null;
    this.lastValid = null;
    this.sourceNotice = "";
    this.warning = "";
    this.saveSettings();
  }

  refreshSaves() {
    this.force = true;
    const now = Date.now();
    for (const item of this.cache.values()) {
      item.observed = now;
    }
  }

  setAuto(enabled) {
    this.settings.auto = Boolean(enabled);
    if (enabled) this.force = true;
    this.saveSettings();
  }

  toggleAutosync() {
    this.settings.auto = !this.settings.auto;
    this.force = this.settings.auto;
    this.saveSettings();
  }

  findSavePaths() {
    this.sourceNotice = "";
    if (this.settings.mode !== "folder") {
      return fs.existsSync(this.settings.source) ? [this.settings.source] : [];
    }

    const folder = resolveSaveFolder(this.settings.source);
    if (
      folder.toLowerCase() !== path.resolve(this.settings.source).toLowerCase()
    ) {
      this.sourceNotice = this.locale.t(
        "Siguiendo el último guardado terminado en el buffer. Se volverá a la carpeta habitual automáticamente cuando el juego pueda actualizarla.",
        "Following the latest completed save in the buffer. Tracking will return to the usual folder automatically when the game can update it.",
      );
    }
    if (!fs.existsSync(folder)) {
      throw new Error(
        this.locale.t(
          "La carpeta seleccionada ya no existe.",
          "The selected folder no longer exists.",
        ),
      );
    }
    return enumerateSaveFiles(folder);
  }

  scan(nowMs = Date.now()) {
    try {
      if (
        !this.mapResources.ready ||
        !this.settings.source ||
        (!this.settings.auto && !this.force)
      ) {
        return;
      }

      this.checkedAt = new Date(nowMs).toISOString();
      const paths = this.findSavePaths();
      if (paths.length === 0) {
        this.warning = this.locale.t(
          "No se encuentra ningún progress.sav en la selección.",
          "No progress.sav file was found in the selected location.",
        );
        return;
      }

      const activeSet = new Set(paths);
      for (const existing of [...this.cache.keys()]) {
        if (!activeSet.has(existing)) {
          this.cache.delete(existing);
        }
      }

      let pending = false;
      this.warning = "";
      for (const savePath of paths) {
        if (this.#scanSave(savePath, nowMs)) pending = true;
      }
      if (!pending) this.force = false;
    } catch (ex) {
      this.warning = ex.message;
    }
  }

  #scanSave(savePath, nowMs) {
    const stat = fs.statSync(savePath);
    let item = this.cache.get(savePath);
    if (!item) {
      item = {
        mtimeMs: -1,
        size: -1,
        observed: 0,
        snapshot: null,
        error: "",
      };
      this.cache.set(savePath, item);
    }

    if (item.mtimeMs !== stat.mtimeMs || item.size !== stat.size) {
      item.mtimeMs = stat.mtimeMs;
      item.size = stat.size;
      item.observed = nowMs;
      item.error = "";
      return true;
    }

    if (item.observed === Infinity) return false;
    if (nowMs - item.observed < 800) return true;

    try {
      const data = readSaveFileReadOnly(savePath, this.locale);
      const after = fs.statSync(savePath);
      if (after.mtimeMs !== item.mtimeMs || after.size !== item.size) {
        return true;
      }
      item.snapshot = this.parse(data, savePath);
      item.snapshot.savedAt = new Date(item.mtimeMs).toISOString();
      item.observed = Infinity;
      item.error = "";
      return false;
    } catch (ex) {
      item.error = ex.message;
      return true;
    }
  }

  #sortedCacheEntries() {
    return [...this.cache.entries()].sort(([keyA, a], [keyB, b]) => {
      const savedA = a.snapshot ? a.snapshot.savedAt : "";
      const savedB = b.snapshot ? b.snapshot.savedAt : "";
      if (savedA !== savedB) return savedB < savedA ? -1 : 1;

      const playA = a.snapshot ? a.snapshot.playtime : 0;
      const playB = b.snapshot ? b.snapshot.playtime : 0;
      if (playA !== playB) return playB - playA;

      return keyA.toLowerCase().localeCompare(keyB.toLowerCase());
    });
  }

  saveSlots() {
    return {
      slots: this.#sortedCacheEntries().map(([file, value]) => ({
        file,
        status:
          value.error !== ""
            ? "error"
            : value.observed !== Infinity
              ? "reading"
              : "ok",
        error: value.error,
        summary: value.snapshot ? this.saveSummary(value.snapshot) : null,
      })),
    };
  }

  state() {
    const candidates = this.#sortedCacheEntries()
      .map(([, value]) => value)
      .filter((value) => value.snapshot !== null);

    const selected =
      this.imported ??
      (candidates.length === 0 ? this.lastValid : candidates[0].snapshot);
    if (this.imported === null && selected !== null) {
      this.lastValid = selected;
    }
    if (selected !== null && selected.revision !== this.lastRevision) {
      this.lastRevision = selected.revision;
      this.changedAt = new Date().toISOString();
      this.updateCount++;
    }

    let message = this.warning;
    for (const [key, value] of this.cache.entries()) {
      if (value.error !== "") {
        message =
          this.locale.t("No se pudo leer ", "Could not read ") +
          path.basename(path.dirname(key)) +
          ": " +
          value.error +
          this.locale.t(
            " Se conserva el último estado válido.",
            " The last valid state is preserved.",
          );
        break;
      }
    }

    return {
      language: this.locale.language,
      checkedAt: this.checkedAt,
      changedAt: this.changedAt,
      updateCount: this.updateCount,
      picking: false,
      status:
        message !== ""
          ? "error"
          : selected === null
            ? "empty"
            : this.force
              ? "reading"
              : "ok",
      message,
      sourceNotice: this.sourceNotice,
      source: this.settings.source,
      mode: this.settings.mode,
      auto: this.settings.auto,
      followLink: this.settings.followLink,
      showLink: this.settings.showLink,
      linkOrder: this.settings.linkOrder,
      linkOpacity: this.settings.linkOpacity,
      runInBackground: this.settings.runInBackground,
      snapshot: selected,
      mapQuality: this.settings.mapQuality,
      hdMap: this.hdMapTiles.state(),
      hdMapDownload: this.hdMapTiles.downloadState(),
      slots: candidates.map((item) => ({
        file: item.snapshot.file,
        playtime: item.snapshot.playtime,
        savedAt: item.snapshot.savedAt,
      })),
    };
  }
}
