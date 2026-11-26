import fs from "node:fs";
import path from "node:path";

const ORIGIN = "https://objmap-totk.zeldamods.org/game_files/map/";
const MAX_TILE_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_BYTES = 48 * 1024 * 1024;
const MAX_MISSING_TILES = 4096;
const TILE_PATH =
  /^map-tiles\/(surface|sky|depths)\/([0-7])\/([0-9]{1,3})\/([0-9]{1,3})\.webp$/;

export function tryTile(tilePath) {
  if (typeof tilePath !== "string") return null;
  const match = TILE_PATH.exec(tilePath);
  if (!match) return null;

  const layer = match[1];
  const zoom = Number(match[2]);
  const x = Number(match[3]);
  const y = Number(match[4]);
  const scale = Math.pow(2, zoom - 7);
  if (
    x >= Math.ceil((24000 * scale) / 256) ||
    y >= Math.ceil((20000 * scale) / 256)
  ) {
    return null;
  }

  const relative = `${layer}/${zoom}/${x}/${y}.webp`;
  const remoteLayer =
    layer === "surface" ? "Ground" : layer === "sky" ? "Sky" : "Depths";
  const remote = `${ORIGIN}${remoteLayer}/maptex/${zoom}/${x}/${y}.webp`;
  return { relative, remote };
}

export function validImage(data) {
  if (!data || !(data instanceof Uint8Array)) return false;
  const buf = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 30 || buf.length > MAX_TILE_BYTES) return false;
  if (
    buf[0] !== 0x52 || // R
    buf[1] !== 0x49 || // I
    buf[2] !== 0x46 || // F
    buf[3] !== 0x46 || // F
    buf[8] !== 0x57 || // W
    buf[9] !== 0x45 || // E
    buf[10] !== 0x42 || // B
    buf[11] !== 0x50 || // P
    buf.readUInt32LE(4) + 8 !== buf.length
  ) {
    return false;
  }

  return (
    buf[12] === 0x56 && // V
    buf[13] === 0x50 && // P
    buf[14] === 0x38 && // 8
    buf[15] === 0x20 && // ' '
    buf[23] === 0x9d &&
    buf[24] === 1 &&
    buf[25] === 0x2a &&
    (buf.readUInt16LE(26) & 0x3fff) === 256 &&
    (buf.readUInt16LE(28) & 0x3fff) === 256
  );
}

function walkWebpFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".webp")) {
        results.push(full);
      }
    }
  }
  return results;
}

export class HDMapTileCache {
  constructor({ dataRoot, currentVersion = "1.0.0" }) {
    this.root = path.join(dataRoot, "hd-map", "zeldamods-v1");
    this.currentVersion = currentVersion;
    this.memory = new Map();
    this.missingUntil = new Map();
    this.inFlight = new Map();
    this.memoryBytes = 0;
    this.cacheBytes = 0;
    this.cacheTiles = 0;
    this.downloading = 0;
    this.retryAfter = 0;
    this.unavailable = false;
    this.cacheFull = false;

    this.hdDownloadTotal = 0;
    this.hdDownloadDone = 0;
    this.hdDownloadCurrent = "";
    this.hdDownloadBusy = false;
    this.hdDownloadError = "";

    this.initialize();
  }

  initialize() {
    this.memory.clear();
    this.missingUntil.clear();
    this.memoryBytes = 0;
    let bytes = 0;
    let tiles = 0;
    let failed = false;

    try {
      for (const file of walkWebpFiles(this.root)) {
        tiles++;
        bytes += fs.statSync(file).size;
      }
    } catch {
      failed = true;
    }

    this.cacheTiles = tiles;
    this.cacheBytes = bytes;
    this.cacheFull = bytes + MAX_TILE_BYTES > MAX_CACHE_BYTES;
    this.unavailable = failed;
  }

  state() {
    return {
      cachedTiles: this.cacheTiles,
      cachedBytes: this.cacheBytes,
      downloading: this.downloading,
      unavailable: this.unavailable,
      cacheFull: this.cacheFull,
    };
  }

  get downloadingAll() {
    return this.hdDownloadBusy;
  }

  downloadState() {
    return {
      busy: this.hdDownloadBusy,
      total: this.hdDownloadTotal,
      done: this.hdDownloadDone,
      current: this.hdDownloadCurrent,
      error: this.hdDownloadError,
    };
  }

  retry() {
    this.retryAfter = 0;
    this.unavailable = false;
    this.cacheFull = this.cacheBytes + MAX_TILE_BYTES > MAX_CACHE_BYTES;
    this.missingUntil.clear();
  }

  startDownloadAll() {
    if (this.hdDownloadBusy) return;
    this.hdDownloadBusy = true;
    this.hdDownloadError = "";
    this.hdDownloadDone = 0;
    this.hdDownloadTotal = 0;
    this.hdDownloadCurrent = "";
    this.missingUntil.clear();

    this.#downloadAllTiles().catch((err) => {
      this.hdDownloadBusy = false;
      this.hdDownloadError = err.message;
    });
  }

  async #downloadAllTiles() {
    const layers = ["surface", "sky", "depths"];
    const tiles = [];
    for (const layer of layers) {
      for (let z = 1; z <= 7; z++) {
        const scale = Math.pow(2, z - 7);
        const w = Math.ceil((24000 * scale) / 256);
        const h = Math.ceil((20000 * scale) / 256);
        for (let x = 0; x < w; x++) {
          for (let y = 0; y < h; y++) {
            tiles.push(`map-tiles/${layer}/${z}/${x}/${y}.webp`);
          }
        }
      }
    }

    this.hdDownloadTotal = tiles.length;
    let index = 0;
    let done = 0;

    const worker = async () => {
      while (index < tiles.length) {
        const currentPath = tiles[index++];
        this.hdDownloadCurrent = currentPath;
        try {
          await this.read(currentPath, true);
        } catch {}
        done++;
        this.hdDownloadDone = done;
      }
    };

    await Promise.all(Array.from({ length: 6 }, () => worker()));
    this.hdDownloadBusy = false;
    this.hdDownloadCurrent = "";
  }

  readCachedSync(tilePath) {
    const parsed = tryTile(tilePath);
    if (!parsed) return null;
    const { relative } = parsed;
    const target = path.join(this.root, relative);

    const mem = this.#tryMemory(relative, target);
    if (mem) return mem;

    if (fs.existsSync(target)) {
      try {
        const stat = fs.statSync(target);
        const cached =
          stat.size <= MAX_TILE_BYTES ? fs.readFileSync(target) : null;
        if (validImage(cached)) {
          this.#addMemory(relative, target, cached);
          return cached;
        }
        fs.unlinkSync(target);
        this.#removeMemory(relative);
        if (this.cacheTiles > 0) this.cacheTiles--;
        this.cacheBytes = Math.max(0, this.cacheBytes - stat.size);
        this.cacheFull = this.cacheBytes + MAX_TILE_BYTES > MAX_CACHE_BYTES;
      } catch {
        return null;
      }
    }
    return null;
  }

  async read(tilePath, allowDownload) {
    const parsed = tryTile(tilePath);
    if (!parsed) return null;
    const cached = this.readCachedSync(tilePath);
    if (cached) return cached;

    if (!allowDownload || Date.now() < this.retryAfter) return null;
    this.cacheFull = this.cacheBytes + MAX_TILE_BYTES > MAX_CACHE_BYTES;
    if (this.cacheFull) return null;
    if (this.#isMissing(parsed.relative)) return null;

    if (this.inFlight.has(parsed.relative)) {
      return this.inFlight.get(parsed.relative);
    }

    const promise = this.#fetchAndStore(parsed.relative, parsed.remote).finally(
      () => {
        this.inFlight.delete(parsed.relative);
      },
    );
    this.inFlight.set(parsed.relative, promise);
    return promise;
  }

  async #fetchAndStore(relative, remote) {
    if (this.downloading >= 6) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (Date.now() < this.retryAfter) return null;

    const target = path.join(this.root, relative);
    this.downloading++;
    try {
      const response = await fetch(remote, {
        headers: { "User-Agent": `Totkmap/${this.currentVersion}` },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 404) {
        this.#markMissing(relative);
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      if (
        response.status !== 200 ||
        !contentType.toLowerCase().startsWith("image/webp")
      ) {
        this.#backOff();
        return null;
      }

      const arrayBuf = await response.arrayBuffer();
      if (arrayBuf.byteLength > MAX_TILE_BYTES) {
        this.#backOff();
        return null;
      }

      const data = Buffer.from(arrayBuf);
      if (!validImage(data)) {
        this.#backOff();
        return null;
      }

      if (this.cacheBytes + data.length > MAX_CACHE_BYTES) {
        this.cacheFull = true;
        return null;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const partial = `${target}.part`;
      fs.writeFileSync(partial, data);
      fs.renameSync(partial, target);
      this.cacheBytes += data.length;
      this.cacheTiles++;
      this.unavailable = false;
      this.#addMemory(relative, target, data);
      return data;
    } catch {
      this.#backOff();
      return null;
    } finally {
      this.downloading--;
    }
  }

  #tryMemory(relative, target) {
    const tile = this.memory.get(relative);
    if (!tile) return null;
    try {
      const stat = fs.statSync(target);
      if (stat.size !== tile.length || stat.mtimeMs !== tile.mtimeMs) {
        this.#removeMemory(relative);
        return null;
      }
    } catch {
      this.#removeMemory(relative);
      return null;
    }
    // Refresh LRU order
    this.memory.delete(relative);
    this.memory.set(relative, tile);
    return tile.data;
  }

  #addMemory(relative, target, data) {
    this.#removeMemory(relative);
    if (data.length > MAX_MEMORY_BYTES) return;
    try {
      const stat = fs.statSync(target);
      this.memory.set(relative, {
        data,
        length: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      this.memoryBytes += data.length;
      while (this.memoryBytes > MAX_MEMORY_BYTES && this.memory.size > 0) {
        const oldestKey = this.memory.keys().next().value;
        this.#removeMemory(oldestKey);
      }
    } catch {}
  }

  #removeMemory(relative) {
    const tile = this.memory.get(relative);
    if (!tile) return;
    this.memory.delete(relative);
    this.memoryBytes -= tile.data.length;
  }

  #isMissing(relative) {
    const until = this.missingUntil.get(relative);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.missingUntil.delete(relative);
    return false;
  }

  #markMissing(relative) {
    if (this.missingUntil.size >= MAX_MISSING_TILES) {
      this.missingUntil.clear();
    }
    this.missingUntil.set(relative, Date.now() + 10 * 60 * 1000);
  }

  #backOff() {
    this.unavailable = true;
    this.retryAfter = Date.now() + 30 * 1000;
  }
}
