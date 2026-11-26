const STABLE_VERSION = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_PART = 2147483647;

export const REPOSITORY = "neimex23/HyruleSync";

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

export function evaluateRelease(
  release,
  currentVersion,
  repository = REPOSITORY,
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
  const zipName = `HyruleSync-v${version}-windows.zip`;
  const exeName = `HyruleSync-Setup-v${version}.exe`;
  const prefix = `https://github.com/${repository}/releases/download/${release.tag_name}/`;

  const asset = (release.assets || []).find(
    (item) =>
      item &&
      (item.name === zipName || item.name === exeName) &&
      item.state === "uploaded" &&
      item.size > 0 &&
      String(item.browser_download_url || "").toLowerCase() ===
        (prefix + item.name).toLowerCase(),
  );
  if (!asset) return result;

  result.latestVersion = version;
  result.releaseUrl = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
  result.releaseNotes = release.body ?? "";
  result.available = compareVersions(latest, installed) > 0;
  if (result.available) {
    result.downloadUrl = asset.browser_download_url;
  }
  return result;
}

export class UpdateChecker {
  constructor({ currentVersion, locale, repository = REPOSITORY }) {
    this.currentVersion = currentVersion;
    this.locale = locale;
    this.repository = repository;
    this.attemptedAt = 0;
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
    };
  }

  state() {
    return { ...this.info };
  }

  check(manual = false) {
    const now = Date.now();
    const cooldownMs = (manual ? 60 : 3600) * 1000;
    if (this.info.busy || now - this.attemptedAt < cooldownMs) return;

    this.attemptedAt = now;
    this.info.busy = true;
    this.info.error = "";

    this.#runCheck().catch(() => {});
  }

  async #runCheck() {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${this.repository}/releases/latest`,
        {
          headers: {
            "User-Agent": `HyruleSync/${this.currentVersion}`,
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
        };
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      } else {
        const release = await response.json();
        next = evaluateRelease(release, this.currentVersion, this.repository);
        if (!next.latestVersion) {
          throw new Error("Release package is not ready.");
        }
        next.checkedAt = new Date().toISOString();
      }
      this.info = next;
    } catch {
      this.info.busy = false;
      this.info.error = this.locale.t(
        "No se pudieron buscar actualizaciones. Revisa tu conexión e inténtalo de nuevo.",
        "Could not check for updates. Check your connection and try again.",
      );
    }
  }
}
