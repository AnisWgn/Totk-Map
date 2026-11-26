// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { LocaleManager } from "../../electron/backend/locale.js";
import {
  REPOSITORY,
  UpdateChecker,
  evaluateRelease,
} from "../../electron/backend/updates.js";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

describe("Auto-update engine: detection, streaming progress, SHA-256 verification and installation", () => {
  it("targets AnisWgn/Totk-Map by default, selects portable vs installer assets and detects new commits", () => {
    expect(REPOSITORY).toBe("AnisWgn/Totk-Map");

    const release = {
      tag_name: "v1.0.5",
      target_commitish: "b".repeat(40),
      body: "- Added new feature",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "Totkmap-Setup-v1.0.5.exe",
          browser_download_url:
            "https://github.com/AnisWgn/Totk-Map/releases/download/v1.0.5/Totkmap-Setup-v1.0.5.exe",
          size: 80_000_000,
          state: "uploaded",
        },
        {
          name: "Totkmap-v1.0.5-portable.exe",
          browser_download_url:
            "https://github.com/AnisWgn/Totk-Map/releases/download/v1.0.5/Totkmap-v1.0.5-portable.exe",
          size: 75_000_000,
          state: "uploaded",
        },
      ],
    };

    const installerEval = evaluateRelease(
      release,
      "1.0.4",
      "AnisWgn/Totk-Map",
      { preferPortable: false },
    );
    expect(installerEval.available).toBe(true);
    expect(installerEval.assetName).toBe("Totkmap-Setup-v1.0.5.exe");

    const portableEval = evaluateRelease(release, "1.0.4", "AnisWgn/Totk-Map", {
      preferPortable: true,
    });
    expect(portableEval.available).toBe(true);
    expect(portableEval.assetName).toBe("Totkmap-v1.0.5-portable.exe");

    // Same version but newer commit SHA is also detected as available
    const sameVersionNewCommit = evaluateRelease(
      release,
      "1.0.5",
      "AnisWgn/Totk-Map",
      { currentCommit: "a".repeat(40) },
    );
    expect(sameVersionNewCommit.available).toBe(true);

    const sameVersionSameCommit = evaluateRelease(
      release,
      "1.0.5",
      "AnisWgn/Totk-Map",
      { currentCommit: "b".repeat(40) },
    );
    expect(sameVersionSameCommit.available).toBe(false);
  });

  it("streams update packages with live progress percentages, verifies SHA-256 and triggers installation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyrulesync-upd-"));
    try {
      const part1 = Buffer.alloc(5000, 0x41);
      const part2 = Buffer.alloc(5000, 0x42);
      const fullPayload = Buffer.concat([part1, part2]);
      const expectedSha = sha256Hex(fullPayload);

      let releasePart2;
      const part2Gate = new Promise((resolve) => {
        releasePart2 = resolve;
      });

      const downloadUrl =
        "https://github.com/AnisWgn/Totk-Map/releases/download/v1.0.2/HyruleSync-Setup-v1.0.2.exe";
      const shaUrl = `${downloadUrl}.sha256`;

      const fetchImpl = vi.fn(async (url) => {
        if (String(url).endsWith("/releases/latest")) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              tag_name: "v1.0.2",
              body: "feat: auto-update progress bar",
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: "HyruleSync-Setup-v1.0.2.exe",
                  browser_download_url: downloadUrl,
                  size: fullPayload.length,
                  state: "uploaded",
                },
                {
                  name: "HyruleSync-Setup-v1.0.2.exe.sha256",
                  browser_download_url: shaUrl,
                  size: 98,
                  state: "uploaded",
                },
              ],
            }),
          };
        }
        if (url === downloadUrl) {
          return {
            status: 200,
            ok: true,
            headers: new Headers({
              "content-length": String(fullPayload.length),
            }),
            body: (async function* () {
              yield part1;
              await part2Gate;
              yield part2;
            })(),
          };
        }
        if (url === shaUrl) {
          return {
            status: 200,
            ok: true,
            text: async () => `${expectedSha}  HyruleSync-Setup-v1.0.2.exe\n`,
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const applied = [];
      const checker = new UpdateChecker({
        currentVersion: "1.0.0",
        locale: new LocaleManager("en-US"),
        repository: "AnisWgn/Totk-Map",
        updatesDir: tmpDir,
        canAutoInstall: true,
        onApplyUpdate: async (info) => {
          applied.push(info);
        },
        fetchImpl,
      });

      const checked = await checker.checkNow();
      expect(checked.available).toBe(true);
      expect(checked.latestVersion).toBe("1.0.2");
      expect(checked.canAutoInstall).toBe(true);

      checker.startDownload();

      // Wait briefly for part 1 to be written and check mid-download progress (50%)
      for (let i = 0; i < 40 && checker.state().downloadedBytes < 5000; i++) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const midState = checker.state();
      expect(midState.downloadStatus).toBe("downloading");
      expect(midState.downloadedBytes).toBe(5000);
      expect(midState.totalBytes).toBe(10000);
      expect(midState.downloadPercent).toBe(50);

      // Release second half of stream
      releasePart2();
      for (
        let i = 0;
        i < 50 && checker.state().downloadStatus === "downloading";
        i++
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }

      const finalState = checker.state();
      expect(finalState.downloadStatus).toBe("downloaded");
      expect(finalState.downloadPercent).toBe(100);
      expect(finalState.downloadedBytes).toBe(10000);

      await checker.applyUpdate();
      expect(applied).toHaveLength(1);
      expect(applied[0].version).toBe("1.0.2");
      expect(fs.readFileSync(applied[0].filePath)).toEqual(fullPayload);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects tampered downloads on SHA-256 mismatch and cleans up partial files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyrulesync-tamper-"));
    try {
      const payload = Buffer.from("corrupted-binary-payload");
      const downloadUrl =
        "https://github.com/AnisWgn/Totk-Map/releases/download/v1.0.3/HyruleSync-Setup-v1.0.3.exe";
      const shaUrl = `${downloadUrl}.sha256`;

      const checker = new UpdateChecker({
        currentVersion: "1.0.0",
        locale: new LocaleManager("en-US"),
        repository: "AnisWgn/Totk-Map",
        updatesDir: tmpDir,
        fetchImpl: async (url) => {
          if (String(url).endsWith("/releases/latest")) {
            return {
              status: 200,
              ok: true,
              json: async () => ({
                tag_name: "v1.0.3",
                body: "",
                draft: false,
                prerelease: false,
                assets: [
                  {
                    name: "HyruleSync-Setup-v1.0.3.exe",
                    browser_download_url: downloadUrl,
                    size: payload.length,
                    state: "uploaded",
                  },
                  {
                    name: "HyruleSync-Setup-v1.0.3.exe.sha256",
                    browser_download_url: shaUrl,
                    size: 98,
                    state: "uploaded",
                  },
                ],
              }),
            };
          }
          if (url === downloadUrl) {
            return {
              status: 200,
              ok: true,
              headers: new Headers({
                "content-length": String(payload.length),
              }),
              body: (async function* () {
                yield payload;
              })(),
            };
          }
          return {
            status: 200,
            ok: true,
            text: async () => `${"0".repeat(64)}  HyruleSync-Setup-v1.0.3.exe`,
          };
        },
      });

      await checker.checkNow();
      checker.startDownload();
      for (
        let i = 0;
        i < 40 && checker.state().downloadStatus === "downloading";
        i++
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }

      const state = checker.state();
      expect(state.downloadStatus).toBe("error");
      expect(state.downloadError).toContain("SHA-256");
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
