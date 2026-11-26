import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function parseTarEntries(tarBuffer) {
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const rawName = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim();
    const size = sizeText ? parseInt(sizeText, 8) : 0;
    const typeFlag = header[156];

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuffer.length) break;

    // Regular file ('0' or '\0') — strip top-level "<repo>-<commit>/" folder prefix
    if (typeFlag === 48 || typeFlag === 0) {
      const slashIndex = fullName.indexOf("/");
      const relative =
        slashIndex >= 0 ? fullName.slice(slashIndex + 1) : fullName;
      entries.set(relative, tarBuffer.subarray(dataStart, dataEnd));
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

export class MapResourcesManager {
  constructor({ dataRoot, manifestPath, locale, currentVersion = "1.0.0" }) {
    this.root = dataRoot;
    this.locale = locale;
    this.currentVersion = currentVersion;
    this.manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    this.total = this.manifest.files.reduce((sum, f) => sum + f.size, 0);
    this.received = 0;
    this.current = "";
    this.error = "";
    this.busy = false;
    this.ready = this.manifest.files.every((f) => this.isValid(f));
    this.onReady = null;
  }

  isValid(item) {
    const filePath = path.join(this.root, item.path);
    try {
      const stat = fs.statSync(filePath);
      return (
        stat.isFile() &&
        stat.size === item.size &&
        sha256File(filePath) === item.sha256
      );
    } catch {
      return false;
    }
  }

  state() {
    return {
      ready: this.ready,
      busy: this.busy,
      received: this.received,
      total: this.total,
      current: this.current,
      error: this.error,
    };
  }

  startDownload() {
    if (this.busy || this.ready) return;
    this.busy = true;
    this.error = "";
    this.received = 0;

    this.#downloadAll().catch(() => {});
  }

  async #downloadSingle(item) {
    const url = `https://raw.githubusercontent.com/${this.manifest.repository}/${this.manifest.commit}/${item.source}`;
    const response = await fetch(url, {
      headers: { "User-Agent": `HyruleSync/${this.currentVersion}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      length += buf.length;
      if (length > item.size) {
        throw new Error(
          this.locale.t(
            "El recurso supera el tamaño esperado.",
            "The resource exceeds the expected size.",
          ),
        );
      }
      chunks.push(buf);
      this.received += buf.length;
    }

    const content = Buffer.concat(chunks);
    this.#verifyAndWrite(item, content);
  }

  #verifyAndWrite(item, content) {
    if (content.length !== item.size || sha256Buffer(content) !== item.sha256) {
      throw new Error(
        this.locale.t(
          "El recurso no coincide con la versión esperada: ",
          "The resource does not match the expected version: ",
        ) + item.path,
      );
    }
    const target = path.join(this.root, item.path);
    const partial = `${target}.part`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(partial, content);
    fs.renameSync(partial, target);
  }

  async #downloadViaArchive(pendingItems) {
    const archiveUrl = `https://codeload.github.com/${this.manifest.repository}/tar.gz/${this.manifest.commit}`;
    const response = await fetch(archiveUrl, {
      headers: { "User-Agent": `HyruleSync/${this.currentVersion}` },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const baseReceived = this.received;
    const remainingTotal = pendingItems.reduce((sum, f) => sum + f.size, 0);
    const compressedChunks = [];
    let downloadedCompressed = 0;

    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      compressedChunks.push(buf);
      downloadedCompressed += buf.length;
      this.received = Math.min(
        baseReceived + Math.floor(remainingTotal * 0.85),
        baseReceived + downloadedCompressed,
      );
    }

    const tarBuffer = zlib.gunzipSync(Buffer.concat(compressedChunks));
    const entries = parseTarEntries(tarBuffer);

    this.received = baseReceived;
    for (const item of pendingItems) {
      this.current = item.path;
      const content = entries.get(item.source);
      if (!content) {
        throw new Error(
          this.locale.t(
            "Recurso de la aplicación ausente: ",
            "Missing application resource: ",
          ) + item.path,
        );
      }
      this.#verifyAndWrite(item, content);
      this.received += item.size;
    }
  }

  async #downloadAll() {
    try {
      const pending = [];
      for (const item of this.manifest.files) {
        this.current = item.path;
        if (this.isValid(item)) {
          this.received += item.size;
        } else {
          pending.push(item);
        }
      }

      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        this.current = item.path;
        const beforeItem = this.received;
        try {
          await this.#downloadSingle(item);
        } catch (rawError) {
          this.received = beforeItem;
          try {
            await this.#downloadViaArchive(pending.slice(i));
            break;
          } catch {
            throw rawError;
          }
        }
      }

      if (typeof this.onReady === "function") {
        this.onReady();
      }
      this.ready = true;
      this.current = "";
    } catch (ex) {
      this.error =
        this.locale.t(
          "No se pudo preparar el mapa: ",
          "Could not prepare the map: ",
        ) +
        ex.message +
        this.locale.t(
          " Puedes reintentar; se conservan los recursos verificados.",
          " You can retry; verified resources are preserved.",
        );
    } finally {
      this.busy = false;
    }
  }
}
