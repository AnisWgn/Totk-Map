// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Catalog } from "../../electron/backend/catalog.js";
import { LocaleManager } from "../../electron/backend/locale.js";
import { resolveSaveFolder } from "../../electron/backend/save-sources.js";
import {
  SaveSyncEngine,
  createDefaultSettings,
} from "../../electron/backend/save-sync.js";

function createFixture() {
  const buf = Buffer.alloc(2307856);
  buf.writeUInt32LE(0x01020304, 0);
  buf.writeUInt32LE(0x49e946, 4);
  buf.writeUInt32LE(0x3c138, 8);
  buf.writeUInt32LE(123, 40);
  buf.writeUInt32LE(0, 44);
  buf.writeUInt32LE(0xe573f564, 48);
  buf.writeUInt32LE(999, 52);
  buf.writeUInt32LE(0xa3db7114, 56);
  buf.writeUInt32LE(64, 60);
  buf.writeBigUInt64LE(18446744073709551001n, 64);
  return buf;
}

describe("SaveSyncEngine autosync and Recomp save-tx transaction tracking", () => {
  it("tracks newest slots, breaks ties by playtime, survives partial writes and follows Recomp transactions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyrulesync-sync-"));
    try {
      const settings = {
        ...createDefaultSettings(),
        source: root,
        mode: "folder",
        auto: true,
      };
      const engine = new SaveSyncEngine({
        locale: new LocaleManager("en-US"),
        mapResources: { ready: true },
        hdMapTiles: { state: () => ({}), downloadState: () => ({}) },
        settings,
        saveSettings: () => true,
        definitions: {
          collections: [],
          quests: [],
          compendium: [],
          characters: [],
        },
      });
      engine.setCatalog(new Catalog());

      const startMs = Date.UTC(2026, 10, 1, 12, 0, 0);
      const writeSave = (filePath, playtime, whenMs, x) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const bytes = createFixture();
        bytes.writeUInt32LE(playtime, 52);
        bytes.writeUInt32LE(0xc884818d, 56);
        bytes.writeUInt32LE(128, 60);
        bytes.writeUInt32LE(0xa3db7114, 64);
        bytes.writeUInt32LE(80, 68);
        bytes.writeUInt32LE(0, 80);
        bytes.writeUInt32LE(0, 84);
        bytes.writeFloatLE(x, 128);
        fs.writeFileSync(filePath, bytes);
        const whenDate = new Date(whenMs);
        fs.utimesSync(filePath, whenDate, whenDate);
      };

      const settle = () => {
        const t0 = Date.now();
        engine.scan(t0);
        engine.scan(t0 + 1500);
      };

      const manual = path.join(root, "slot_00", "progress.sav");
      const oldAuto = path.join(root, "slot_03", "progress.sav");
      const newAuto = path.join(root, "slot_05", "progress.sav");

      writeSave(manual, 10000, startMs, 1);
      writeSave(oldAuto, 20000, startMs + 60_000, 3);
      writeSave(newAuto, 1000, startMs + 120_000, 5);
      settle();

      expect(engine.state().snapshot?.file).toBe(newAuto);
      expect(engine.state().snapshot?.playerPosition?.x).toBe(5);
      expect(engine.saveSlots().slots[0].file).toBe(newAuto);

      // Equal timestamps use playtime as tie breaker
      writeSave(manual, 500, startMs + 180_000, 7);
      settle();
      expect(engine.state().snapshot?.file).toBe(manual);
      writeSave(newAuto, 600, startMs + 180_000, 8);
      settle();
      expect(engine.state().snapshot?.file).toBe(newAuto);

      // Incomplete write keeps previous valid snapshot and recovers once complete
      fs.writeFileSync(newAuto, "partial");
      const partialTime = new Date(startMs + 240_000);
      fs.utimesSync(newAuto, partialTime, partialTime);
      settle();
      expect(engine.state().snapshot?.file).toBe(newAuto);
      expect(engine.state().snapshot?.playerPosition?.x).toBe(8);
      expect(engine.cache.get(newAuto).error).not.toBe("");

      writeSave(newAuto, 400, startMs + 300_000, 9);
      settle();
      expect(engine.state().snapshot?.playtime).toBe(400);
      expect(engine.state().snapshot?.playerPosition?.x).toBe(9);

      // Recomp save-tx/ready-* discovery
      const profile = path.join(root, "profile");
      const account = path.join(
        profile,
        "save",
        "00000000000000020000000000000001",
      );
      writeSave(
        path.join(account, "slot_03", "progress.sav"),
        30000,
        startMs,
        3,
      );
      const uid = Buffer.alloc(16);
      uid.writeBigUInt64LE(1n, 0);
      uid.writeBigUInt64LE(2n, 8);
      fs.writeFileSync(path.join(profile, "account.uid"), uid);

      const transactions = path.join(profile, "save-tx");
      const ready9 = path.join(transactions, "ready-0000000009");
      const ready10 = path.join(transactions, "ready-0000000010");
      const pending = path.join(ready10, "slot_05", "progress.sav");
      writeSave(
        path.join(ready9, "slot_03", "progress.sav"),
        40000,
        startMs + 3_600_000,
        4,
      );
      writeSave(pending, 700, startMs + 7_200_000, 10);
      writeSave(
        path.join(transactions, "work", "slot_00", "progress.sav"),
        90000,
        startMs + 86_400_000,
        99,
      );

      engine.setSource(account, "folder");
      expect(engine.state().snapshot).toBeNull();
      settle();
      expect(engine.state().snapshot?.file).toBe(pending);
      expect(engine.state().snapshot?.playerPosition?.x).toBe(10);
      expect(engine.sourceNotice).not.toBe("");

      // Malformed account.uid disables pending transaction discovery
      fs.writeFileSync(path.join(profile, "account.uid"), Buffer.alloc(15));
      expect(resolveSaveFolder(account)).toBe(account);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
