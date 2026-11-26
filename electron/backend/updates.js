import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STABLE_VERSION = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const MAX_PART = 2147483647;
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;

export const REPOSITORY = process.env.HYRULESYNC_REPO || "AnisWgn/Totk-Map";

export function parseVersion(tag) {
  if (typeof tag !== "string" || !STABLE_VERSION.test(tag)) return null;
  const parts = tag.replace(/^v/, "").split(".").map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > MAX_PART)) {
    return null;
  }
  return parts;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(65536);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function evaluateRelease(
  release,
  currentVersion,
  repository = REPOSITORY,
  { preferPortable = false, currentCommit = "" } = {},
) {
  const result = {
    currentVersion,
    latestVersion: "",
    downloadUrl: "",
    releaseUrl: "",
    releaseNotes: "",
    checkedAt: "",
    error: "",
    available: false,
    busy: false,
    assetName: "",
    assetSize: 0,
    sha256Url: "",
    releaseCommit: "",
  };

  const latest = release ? parseVersion(release.tag_name) : null;
  const installed = parseVersion(currentVersion);
  if (
    !release ||
    release.draft ||
    release.prerelease ||
    !latest ||
    !installed
  ) {
    return result;
  }

  const version = latest.join(".");
  const setupExe = `Totkmap-Setup-v${version}.exe`;
  const portableExe = `Totkmap-v${version}-portable.exe`;
  const zipPkg = `Totkmap-v${version}-windows.zip`;
  const legacySetupExe = `HyruleSync-Setup-v${version}.exe`;
  const legacyPortableExe = `HyruleSync-v${version}-portable.exe`;
  const legacyZip = `HyruleSync-v${version}-windows.zip`;
  const candidates = preferPortable
    ? [
        portableExe,
        setupExe,
        zipPkg,
        legacyPortableExe,
        legacySetupExe,
        legacyZip,
      ]
    : [
        setupExe,
        portableExe,
        zipPkg,
        legacySetupExe,
        legacyPortableExe,
        legacyZip,
      ];
  const prefix = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
  const assets = Array.isArray(release.assets) ? release.assets : [];

  let matchedAsset = null;
  for (const candidateName of candidates) {
    const found = assets.find(
      (item) =>
        item &&
        item.name === candidateName &&
        item.state === "uploaded" &&
        item.size > 0 &&
        item.size <= MAX_UPDATE_BYTES &&
        String(item.browser_download_url || "").toLowerCase() ===
          (prefix + candidateName).toLowerCase(),
    );
    if (found) {
      matchedAsset = found;
      break;
    }
  }
  if (!matchedAsset) return result;

  const checksumName = `${matchedAsset.name}.sha256`;
  const checksumAsset = assets.find(
    (item) =>
      item &&
      item.name === checksumName &&
      item.state === "uploaded" &&
      item.size > 0 &&
      item.size <= 4096 &&
      String(item.browser_download_url || "").toLowerCase() ===
        (prefix + checksumName).toLowerCase(),
  );

  const releaseCommit = COMMIT_SHA_REGEX.test(release.target_commitish || "")
    ? String(release.target_commitish).toLowerCase()
    : "";
  const normalizedCurrentCommit = COMMIT_SHA_REGEX.test(currentCommit || "")
    ? String(currentCommit).toLowerCase()
    : "";

  const versionComparison = compareVersions(latest, installed);
  const commitChanged =
    versionComparison === 0 &&
    Boolean(releaseCommit && normalizedCurrentCommit) &&
    releaseCommit !== normalizedCurrentCommit;

  result.latestVersion = version;
  result.releaseUrl = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
  result.releaseNotes = release.body ?? "";
  result.releaseCommit = releaseCommit;
  result.available = versionComparison > 0 || commitChanged;

  if (result.available) {
    result.downloadUrl = matchedAsset.browser_download_url;
    result.assetName = matchedAsset.name;
    result.assetSize = matchedAsset.size;
    result.sha256Url = checksumAsset ? checksumAsset.browser_download_url : "";
  }
  return result;
}

export class UpdateChecker {
  constructor({
    currentVersion,
    currentCommit = "",
    locale,
    repository = REPOSITORY,
    updatesDir = "",
    preferPortable = false,
    canAutoInstall = process.platform === "win32",
    onApplyUpdate = null,
    fetchImpl = globalThis.fetch,
  }) {
    this.currentVersion = currentVersion;
    this.currentCommit = currentCommit;
    this.locale = locale;
    this.repository = repository;
    this.updatesDir = updatesDir;
    this.preferPortable = preferPortable;
    this.canAutoInstall = canAutoInstall;
    this.onApplyUpdate = onApplyUpdate;
    this.fetchImpl = fetchImpl;

    this.attemptedAt = 0;
    this.abortController = null;
    this.downloadStatus = "idle";
    this.downloadedBytes = 0;
    this.totalBytes = 0;
    this.downloadPercent = 0;
    this.downloadSpeed = 0;
    this.downloadError = "";
    this.downloadedFile = "";

    this.info = {
      currentVersion,
      latestVersion: "",
      downloadUrl: "",
      releaseUrl: "",
      releaseNotes: "",
      checkedAt: "",
      error: "",
      available: false,
      busy: false,
      assetName: "",
      assetSize: 0,
      sha256Url: "",
      releaseCommit: "",
    };
  }

  state() {
    return {
      currentVersion: this.info.currentVersion,
      currentCommit: this.currentCommit ? this.currentCommit.slice(0, 7) : "",
      latestVersion: this.info.latestVersion,
      releaseCommit: this.info.releaseCommit
        ? this.info.releaseCommit.slice(0, 7)
        : "",
      downloadUrl: this.info.downloadUrl,
      releaseUrl: this.info.releaseUrl,
      releaseNotes: this.info.releaseNotes,
      checkedAt: this.info.checkedAt,
      error: this.info.error,
      available: this.info.available,
      busy: this.info.busy,
      assetName: this.info.assetName,
      assetSize: this.info.assetSize,
      downloadStatus: this.downloadStatus,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes || this.info.assetSize || 0,
      downloadPercent: this.downloadPercent,
      downloadSpeed: this.downloadSpeed,
      downloadError: this.downloadError,
      canAutoInstall: Boolean(
        this.canAutoInstall &&
        this.info.assetName &&
        this.info.assetName.toLowerCase().endsWith(".exe"),
      ),
    };
  }

  check(manual = false) {
    const now = Date.now();
    // Automatic polling checks every 2 minutes so newly published commits/releases appear quickly.
    const cooldownMs = (manual ? 15 : 120) * 1000;
    if (
      this.info.busy ||
      this.downloadStatus === "downloading" ||
      now - this.attemptedAt < cooldownMs
    ) {
      return;
    }

    this.attemptedAt = now;
    this.info.busy = true;
    this.info.error = "";

    this.#runCheck().catch(() => {});
  }

  async checkNow() {
    this.attemptedAt = Date.now();
    this.info.busy = true;
    this.info.error = "";
    await this.#runCheck();
    return this.state();
  }

  async #runCheck() {
    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${this.repository}/releases/latest`,
        {
          headers: {
            "User-Agent": `Totkmap/${this.currentVersion}`,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(15000),
        },
      );

      let next;
      if (response.status === 404) {
        next = {
          currentVersion: this.currentVersion,
          latestVersion: "",
          downloadUrl: "",
          releaseUrl: "",
          releaseNotes: "",
          checkedAt: new Date().toISOString(),
          error: "",
          available: false,
          busy: false,
          assetName: "",
          assetSize: 0,
          sha256Url: "",
          releaseCommit: "",
        };
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      } else {
        const release = await response.json();
        next = evaluateRelease(release, this.currentVersion, this.repository, {
          preferPortable: this.preferPortable,
          currentCommit: this.currentCommit,
        });
        if (!next.latestVersion) {
          throw new Error("Release package is not ready.");
        }
        next.checkedAt = new Date().toISOString();
      }

      const previousAsset = this.info.assetName;
      this.info = next;

      // Sync existing downloaded file state if already on disk for this exact asset
      if (this.info.available && this.updatesDir && this.info.assetName) {
        const target = path.join(this.updatesDir, this.info.assetName);
        if (this.downloadStatus !== "downloading") {
          try {
            const stat = fs.statSync(target);
            if (stat.isFile() && stat.size === this.info.assetSize) {
              this.downloadedFile = target;
              this.downloadedBytes = stat.size;
              this.totalBytes = stat.size;
              this.downloadPercent = 100;
              this.downloadStatus = "downloaded";
              this.downloadError = "";
            } else if (previousAsset !== this.info.assetName) {
              this.#resetDownloadState();
            }
          } catch {
            if (previousAsset !== this.info.assetName) {
              this.#resetDownloadState();
            }
          }
        }
      } else if (
        !this.info.available &&
        this.downloadStatus !== "downloading"
      ) {
        this.#resetDownloadState();
      }
    } catch {
      this.info.busy = false;
      this.info.error = this.locale.t(
        "No se pudieron buscar actualizaciones. Revisa tu conexión e inténtalo de nuevo.",
        "Could not check for updates. Check your connection and try again.",
      );
    }
  }

  #resetDownloadState() {
    this.downloadStatus = "idle";
    this.downloadedBytes = 0;
    this.totalBytes = this.info.assetSize || 0;
    this.downloadPercent = 0;
    this.downloadSpeed = 0;
    this.downloadError = "";
    this.downloadedFile = "";
  }

  startDownload() {
    if (
      !this.info.available ||
      !this.info.downloadUrl ||
      !this.info.assetName
    ) {
      throw new Error(
        this.locale.t(
          "No hay ninguna actualización disponible para descargar.",
          "No update is available to download.",
        ),
      );
    }
    if (!this.updatesDir) {
      throw new Error("Updates directory is not configured.");
    }
    if (this.downloadStatus === "downloading") {
      return { ok: true, status: this.downloadStatus };
    }

    const targetPath = path.join(this.updatesDir, this.info.assetName);
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isFile() && stat.size === this.info.assetSize) {
        this.downloadedFile = targetPath;
        this.downloadedBytes = stat.size;
        this.totalBytes = stat.size;
        this.downloadPercent = 100;
        this.downloadStatus = "downloaded";
        this.downloadError = "";
        return { ok: true, status: "downloaded" };
      }
    } catch {}

    this.downloadStatus = "downloading";
    this.downloadedBytes = 0;
    this.totalBytes = this.info.assetSize || 0;
    this.downloadPercent = 0;
    this.downloadSpeed = 0;
    this.downloadError = "";
    this.downloadedFile = "";
    this.abortController = new AbortController();

    this.#runDownload(targetPath, this.abortController.signal).catch(() => {});
    return { ok: true, status: "downloading" };
  }

  cancelDownload() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.downloadStatus === "downloading") {
      this.#resetDownloadState();
    }
    return { ok: true };
  }

  async #runDownload(targetPath, signal) {
    const partPath = `${targetPath}.part`;
    let fd = null;
    const expectedSize = this.info.assetSize || 0;
    const maxAllowed = expectedSize > 0 ? expectedSize : MAX_UPDATE_BYTES;
    const sha256Url = this.info.sha256Url;
    const startedAt = Date.now();

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const response = await this.fetchImpl(this.info.downloadUrl, {
        headers: {
          "User-Agent": `Totkmap/${this.currentVersion}`,
        },
        signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 0 && this.totalBytes === 0) {
        this.totalBytes = contentLength;
      }

      fd = fs.openSync(partPath, "w");
      let received = 0;

      for await (const chunk of response.body) {
        if (signal.aborted) {
          throw new Error("ABORTED");
        }
        const buf = Buffer.from(chunk);
        received += buf.length;
        if (received > maxAllowed) {
          throw new Error(
            this.locale.t(
              "El paquete supera el tamaño esperado.",
              "Update package exceeds expected size.",
            ),
          );
        }
        fs.writeSync(fd, buf);
        this.downloadedBytes = received;
        if (this.totalBytes > 0) {
          this.downloadPercent = Math.min(
            99,
            Math.floor((received / this.totalBytes) * 100),
          );
        }
        const elapsedSec = Math.max(0.05, (Date.now() - startedAt) / 1000);
        this.downloadSpeed = Math.round(received / elapsedSec);
      }

      fs.closeSync(fd);
      fd = null;

      if (expectedSize > 0 && received !== expectedSize) {
        throw new Error(
          this.locale.t(
            "Descarga incompleta de la actualización.",
            "Update download was incomplete.",
          ),
        );
      }

      if (sha256Url) {
        const checksumResponse = await this.fetchImpl(sha256Url, {
          headers: { "User-Agent": `Totkmap/${this.currentVersion}` },
          signal,
        });
        if (!checksumResponse.ok) {
          throw new Error("Could not verify update checksum.");
        }
        const checksumText = (await checksumResponse.text()).trim();
        const expectedHash = checksumText.split(/\s+/)[0]?.toLowerCase();
        if (
          !expectedHash ||
          !/^[0-9a-f]{64}$/.test(expectedHash) ||
          sha256File(partPath) !== expectedHash
        ) {
          throw new Error(
            this.locale.t(
              "La verificación de seguridad (SHA-256) de la actualización falló.",
              "Update security verification (SHA-256) failed.",
            ),
          );
        }
      }

      fs.renameSync(partPath, targetPath);
      this.downloadedFile = targetPath;
      this.downloadedBytes = received;
      this.totalBytes = received;
      this.downloadPercent = 100;
      this.downloadSpeed = 0;
      this.downloadError = "";
      this.downloadStatus = "downloaded";
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch {}

      if (signal.aborted || err?.message === "ABORTED") {
        return;
      }

      this.downloadSpeed = 0;
      this.downloadStatus = "error";
      this.downloadError =
        this.locale.t(
          "No se pudo descargar la actualización: ",
          "Could not download update: ",
        ) + (err?.message || "Unknown error");
    } finally {
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
    }
  }

  async applyUpdate() {
    if (
      this.downloadStatus !== "downloaded" ||
      !this.downloadedFile ||
      !fs.existsSync(this.downloadedFile)
    ) {
      throw new Error(
        this.locale.t(
          "Primero descarga la actualización.",
          "Download the update first.",
        ),
      );
    }

    if (typeof this.onApplyUpdate !== "function") {
      throw new Error(
        this.locale.t(
          "La instalación automática solo está disponible en el cliente de escritorio.",
          "Automatic installation is only available in the desktop client.",
        ),
      );
    }

    this.downloadStatus = "applying";
    try {
      await this.onApplyUpdate({
        filePath: this.downloadedFile,
        assetName: this.info.assetName,
        version: this.info.latestVersion,
      });
      return { ok: true };
    } catch (err) {
      this.downloadStatus = "downloaded";
      throw err;
    }
  }
}
