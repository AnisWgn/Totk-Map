import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ViewTabs } from "../../web/src/app/components/ViewTabs.jsx";
import { createViewStore } from "../../web/src/app/store.js";
import { UpdatePanel } from "../../web/src/features/updates/UpdatePanel.jsx";
import { I18N } from "../../web/src/shared/i18n.js";

afterEach(() => {
  cleanup();
});

describe("Dynamic Auto-Update Tab & Progress Bar UI", () => {
  it("displays the New update available tab, download button, live progress bar and install button", async () => {
    I18N.setLanguage("en");
    const store = createViewStore();
    const startUpdateDownload = vi.fn();
    const cancelUpdateDownload = vi.fn();
    const applyUpdate = vi.fn();

    Object.assign(store.actions, {
      setSaveView: (view) => store.update({ view }),
      startUpdateDownload,
      cancelUpdateDownload,
      applyUpdate,
      checkUpdates: vi.fn(),
    });

    render(
      <>
        <ViewTabs store={store} />
        <UpdatePanel store={store} />
      </>,
    );

    // Initially hidden when no update is available
    expect(document.getElementById("updateTab")).toBeNull();
    expect(document.getElementById("updatePanel").hidden).toBe(true);

    // Update detected -> Tab appears automatically!
    await act(async () => {
      store.update({
        updateState: {
          available: true,
          currentVersion: "1.0.0",
          latestVersion: "1.0.1",
          assetSize: 100 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          downloadedBytes: 0,
          downloadPercent: 0,
          downloadStatus: "idle",
          canAutoInstall: true,
          downloadUrl:
            "https://github.com/AnisWgn/Totk-Map/releases/download/v1.0.1/HyruleSync-Setup-v1.0.1.exe",
          releaseUrl: "https://github.com/AnisWgn/Totk-Map/releases/tag/v1.0.1",
          releaseNotes: "- Added auto-update system with live progress bar",
        },
      });
    });

    const tab = document.getElementById("updateTab");
    expect(tab).not.toBeNull();
    expect(tab.textContent).toContain("New update available");

    // Open the Update tab
    await act(async () => {
      fireEvent.click(tab);
    });
    const panel = document.getElementById("updatePanel");
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain(
      "Current version: v1.0.0 → New version: v1.0.1",
    );
    expect(panel.textContent).toContain("100.0 MB");
    expect(panel.textContent).toContain(
      "Added auto-update system with live progress bar",
    );

    // Click Download update
    const downloadBtn = document.getElementById("startUpdateDownload");
    expect(downloadBtn).not.toBeNull();
    fireEvent.click(downloadBtn);
    expect(startUpdateDownload).toHaveBeenCalledTimes(1);

    // Simulate 45% download progress -> progress bar & tab reflect 45%
    await act(async () => {
      store.update({
        updateState: {
          ...store.getSnapshot().updateState,
          downloadStatus: "downloading",
          downloadedBytes: 45 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          downloadPercent: 45,
          downloadSpeed: 10 * 1024 * 1024,
        },
      });
    });

    expect(tab.textContent).toContain("Downloading update (45%)");
    const progressBar = document.getElementById("updateDownloadProgress");
    expect(progressBar.getAttribute("aria-valuenow")).toBe("45");
    expect(progressBar.querySelector("span").style.width).toBe("45%");
    expect(panel.textContent).toContain("45.0 MB of 100.0 MB (45%)");
    expect(panel.textContent).toContain("Speed: 10.0 MB/s");

    // Simulate 100% completion -> Install and restart button appears
    await act(async () => {
      store.update({
        updateState: {
          ...store.getSnapshot().updateState,
          downloadStatus: "downloaded",
          downloadedBytes: 100 * 1024 * 1024,
          downloadPercent: 100,
          downloadSpeed: 0,
        },
      });
    });

    expect(tab.textContent).toContain("Update ready");
    expect(progressBar.getAttribute("aria-valuenow")).toBe("100");
    const installBtn = document.getElementById("installUpdateButton");
    expect(installBtn).not.toBeNull();
    fireEvent.click(installBtn);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });
});
