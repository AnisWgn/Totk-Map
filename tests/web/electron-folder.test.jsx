import { describe, expect, it, vi } from "vitest";

import { createSaveController } from "../../web/src/features/saves/controller.js";
import { I18N } from "../../web/src/shared/i18n.js";

describe("Electron native folder picker integration in SaveController", () => {
  it("uses window.electronAPI.selectFolder when running in Electron", async () => {
    I18N.setLanguage("en");
    document.body.innerHTML = `
      <button id="openSaves"></button>
      <button id="reloadSlots"></button>
      <button id="viewInspected"></button>
      <button id="inspectPath"></button>
      <input id="inspectFilePath" />
      <input id="inspectUpload" type="file" />
      <div id="inspectedDetails"></div>
      <div id="savesError"></div>
      <button id="openSave"></button>
      <button id="welcomeLoad"></button>
      <input id="saveFile" type="file" />
      <button id="openFolder"></button>
      <button id="welcomeFolder"></button>
      <button id="browseFolder"></button>
      <button id="folderUp"></button>
      <button id="folderDrives"></button>
      <select id="knownSaves"></select>
      <input id="filePath" />
      <dialog id="fileDialog"><form><p id="fileError"></p></form></dialog>
      <select id="knownFolders"></select>
      <input id="folderPath" value="C:\\Initial" />
      <section id="folderBrowser" hidden></section>
      <dialog id="folderDialog"><form><p id="folderError">Previous error</p></form></dialog>
    `;

    const selectFolder = vi.fn(
      async () => "C:\\Games\\Zelda TOTK\\profile\\save\\01",
    );
    globalThis.electronAPI = { isElectron: true, selectFolder };

    try {
      const request = vi.fn();
      const controller = createSaveController({
        $: (id) => document.getElementById(id),
        request,
        command: vi.fn(),
        toast: vi.fn(),
        locationText: () => "",
        onPreview: vi.fn(),
        disposed: false,
      });

      controller.initSaves();
      await document.getElementById("browseFolder").onclick();

      expect(selectFolder).toHaveBeenCalledWith("C:\\Initial");
      expect(document.getElementById("folderPath").value).toBe(
        "C:\\Games\\Zelda TOTK\\profile\\save\\01",
      );
      expect(document.getElementById("folderError").textContent).toBe("");
      expect(request).not.toHaveBeenCalled();
    } finally {
      delete globalThis.electronAPI;
    }
  });
});
