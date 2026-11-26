// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Catalog } from "../../electron/backend/catalog.js";
import {
  HDMapTileCache,
  tryTile,
  validImage,
} from "../../electron/backend/hd-map-tiles.js";
import { LocaleManager } from "../../electron/backend/locale.js";
import { PageLifetime } from "../../electron/backend/page-lifetime.js";
import {
  readCharacters,
  readCollections,
  readCompendium,
  readInventory,
  readQuests,
} from "../../electron/backend/readers.js";
import { SaveReader, murmurHash3 } from "../../electron/backend/save-reader.js";
import {
  createDefaultSettings,
  upgradeSettings,
} from "../../electron/backend/save-sync.js";
import {
  evaluateRelease,
  parseVersion,
} from "../../electron/backend/updates.js";

const FORMATS = [
  [2307552, 0x46c3c8, 0x3c050, "1.0"],
  [2307656, 0x47e0f4, 0x3c088, "1.1 / 1.2"],
  [2307856, 0x49e946, 0x3c138, "1.4 / Recomp 1.4.3"],
];

function createFixture(length, version, metadata) {
  const buf = Buffer.alloc(length);
  buf.writeUInt32LE(0x01020304, 0);
  buf.writeUInt32LE(version, 4);
  buf.writeUInt32LE(metadata, 8);
  buf.writeUInt32LE(123, 40);
  buf.writeUInt32LE(0, 44);
  buf.writeUInt32LE(0xe573f564, 48);
  buf.writeUInt32LE(999, 52);
  buf.writeUInt32LE(0xa3db7114, 56);
  buf.writeUInt32LE(64, 60);
  buf.writeBigUInt64LE(18446744073709551001n, 64);
  return buf;
}

describe("Electron Node backend readers & utilities", () => {
  it("resolves locales, CLI overrides and settings v2 upgrade", () => {
    expect(LocaleManager.resolve("es-UY")).toBe("es");
    expect(LocaleManager.resolve("en-GB")).toBe("en");
    expect(LocaleManager.resolve("fr-FR")).toBe("en");
    expect(LocaleManager.preference(null)).toBe("auto");

    const locale = new LocaleManager("fr-FR");
    locale.configure([], "es");
    expect(locale.language).toBe("es");
    expect(locale.t("Salir", "Exit")).toBe("Salir");

    locale.configure(["--language", "en"], "es");
    expect(locale.language).toBe("en");
    expect(locale.t("Salir", "Exit")).toBe("Exit");

    expect(createDefaultSettings().mapQuality).toBe("high");
    const legacy = { mapQuality: "standard" };
    expect(upgradeSettings(legacy)).toBe(true);
    expect(legacy.version).toBe(2);
    expect(legacy.mapQuality).toBe("high");
    expect(upgradeSettings(legacy)).toBe(false);

    const explicitSd = { version: 2, mapQuality: "standard" };
    expect(upgradeSettings(explicitSd)).toBe(false);
    expect(explicitSd.mapQuality).toBe("standard");
  });

  it("matches exact MurmurHash3 x86_32 vectors and parses headers, GUIDs > 2^53 and states", () => {
    expect(murmurHash3("IsVisitLocation.Dungeon001")).toBe(0xab281eb6);
    expect(murmurHash3("PlayerStatus.MaxLife")).toBe(0xfbe01da1);
    expect(murmurHash3("PlayerStatus.MaxStamina")).toBe(0xf9212c74);

    for (const [len, ver, meta, expectedLabel] of FORMATS) {
      const reader = new SaveReader(createFixture(len, ver, meta));
      expect(reader.format).toBe(expectedLabel);
      expect(reader.playtime).toBe(999);
    }

    const data = createFixture(2307856, 0x49e946, 0x3c138);
    data.writeUInt32LE(1, 44);
    expect(
      new SaveReader(data).state({ category: "shrines", hash: "123" }).state,
    ).toBe(0);
    expect(
      new SaveReader(data).state({ category: "carry_koroks", hash: "123" })
        .state,
    ).toBe(0);
    expect(
      new SaveReader(data).state({ category: "lightroots", hash: "123" }).state,
    ).toBe(0);

    data.writeUInt32LE(1654019904, 44);
    expect(
      new SaveReader(data).state({ category: "shrines", hash: "123" }).state,
    ).toBe(1);
    expect(
      new SaveReader(data).state({ category: "carry_koroks", hash: "123" })
        .state,
    ).toBe(1);

    data.writeUInt32LE(404286466, 44);
    expect(
      new SaveReader(data).state({ category: "lightroots", hash: "123" }).state,
    ).toBe(1);

    data.writeUInt32LE(2, 44);
    expect(
      new SaveReader(data).state({ category: "wells", hash: "123" }).state,
    ).toBe(1);

    data.writeUInt32LE(0, 44);
    expect(
      new SaveReader(data).state({ category: "wells", hash: "123" }).state,
    ).toBe(0);
    expect(
      new SaveReader(data).state({ category: "wells", hash: "124" }).state,
    ).toBe(-1);

    // 64-bit unsigned GUID precision above Number.MAX_SAFE_INTEGER
    expect(
      new SaveReader(data).state({
        category: "sages_wills",
        guid: "18446744073709551001",
      }).state,
    ).toBe(1);
    expect(
      new SaveReader(data).state({
        category: "sages_wills",
        guid: "18446744073709551000",
      }).state,
    ).toBe(0);

    expect(() => new SaveReader(Buffer.alloc(30))).toThrow();
    expect(() => new SaveReader(null)).toThrow();
    data.writeUInt32LE(1, 60);
    expect(() => new SaveReader(data)).toThrow();
  });

  it("reads player position, scene context and shrine chests across all save formats", () => {
    for (const [length, header, metadata] of FORMATS) {
      const data = createFixture(length, header, metadata);
      expect(new SaveReader(data).playerPosition()).toBeNull();

      data.writeUInt32LE(0xc884818d, 56);
      data.writeUInt32LE(128, 60);
      data.writeUInt32LE(0xa3db7114, 64);
      data.writeUInt32LE(80, 68);
      data.writeUInt32LE(0, 80);
      data.writeUInt32LE(0, 84);
      data.writeFloatLE(-1234.5, 128);
      data.writeFloatLE(985.25, 132);
      data.writeFloatLE(4321.75, 136);

      const p = new SaveReader(data).playerPosition();
      expect(p).toEqual({ x: -1234.5, y: 985.25, z: 4321.75 });

      data.writeFloatLE(NaN, 128);
      expect(new SaveReader(data).playerPosition()).toBeNull();
      data.writeFloatLE(Infinity, 128);
      expect(new SaveReader(data).playerPosition()).toBeNull();

      // Context & shrine entrance projection
      const ctxData = createFixture(length, header, metadata);
      ctxData.writeUInt32LE(0x1d6189da, 56);
      ctxData.writeUInt32LE(128, 60);
      ctxData.writeUInt32LE(0xa3db7114, 64);
      ctxData.writeUInt32LE(80, 68);
      ctxData.write("Dungeon048", 128, "ascii");
      expect(new SaveReader(ctxData).currentMap()).toBe("Dungeon048");

      const points = [
        {
          id: "shrines:48",
          category: "shrines",
          internalName: "Dungeon048",
          name: "Test Shrine",
          position: { x: 123, y: 900, z: 456 },
        },
      ];
      const raw = { x: 1, y: -100, z: 2 };
      const resolved = SaveReader.resolveContext("Dungeon048", raw, points);
      expect(resolved.kind).toBe("shrine");
      expect(resolved.shrineId).toBe("shrines:48");
      expect(resolved.mapPosition.y).toBe(900);
      expect(
        SaveReader.resolveContext("MainField", raw, points).mapPosition,
      ).toEqual(raw);
      expect(
        SaveReader.resolveContext("LargeDungeonFire", raw, points).mapPosition,
      ).toBeNull();

      // Shrine chests
      const chestData = createFixture(length, header, metadata);
      const visitHash = murmurHash3("IsVisitLocation.Dungeon001");
      chestData.writeUInt32LE(visitHash, 56);
      chestData.writeUInt32LE(1, 60);
      chestData.writeUInt32LE(456, 64);
      chestData.writeUInt32LE(0, 68);
      chestData.writeUInt32LE(789, 72);
      chestData.writeUInt32LE(1, 76);
      chestData.writeUInt32LE(0xa3db7114, 80);
      chestData.writeUInt32LE(96, 84);

      const point = {
        category: "shrines",
        hash: "123",
        visitHash: String(visitHash),
        chestHashes: ["456", "789"],
      };
      const reader = new SaveReader(chestData);
      expect(reader.state(point).state).toBe(0);
      expect(reader.booleanState(point.visitHash)).toBe(1);
      expect(reader.readChests(point)).toEqual({
        total: 2,
        opened: 1,
        unknown: 0,
      });
    }
  });

  it("reads inventory pouches, quests, compendium, characters and collections", () => {
    const [length, header, metadata] = FORMATS[2];
    const data = createFixture(length, header, metadata);
    let table = 40;
    let cursor = 2048;

    const putScalar = (key, value) => {
      data.writeUInt32LE(murmurHash3(key), table);
      data.writeUInt32LE(value >>> 0, table + 4);
      table += 8;
    };
    const putStrings = (key, values) => {
      putScalar(key, cursor);
      data.writeUInt32LE(values.length, cursor);
      cursor += 4;
      for (const value of values) {
        data.fill(0, cursor, cursor + 64);
        data.write(value, cursor, "ascii");
        cursor += 64;
      }
    };
    const putNumbers = (key, values) => {
      putScalar(key, cursor);
      data.writeUInt32LE(values.length, cursor);
      cursor += 4;
      for (const value of values) {
        data.writeUInt32LE(value >>> 0, cursor);
        cursor += 4;
      }
    };

    putScalar("PlayerStatus.Life", 17);
    putScalar("PlayerStatus.MaxLife", 40);
    putScalar("PlayerStatus.MaxStamina", 1157234688); // 2000.0f
    putScalar("PlayerStatus.CurrentRupee", 0);
    const energyBuf = Buffer.alloc(4);
    energyBuf.writeFloatLE(6000, 0);
    putScalar("PlayerStatus.MaxEnergy", energyBuf.readUInt32LE(0));

    putStrings("Pouch.Weapon.Content.Name", [
      "Weapon_Sword_001",
      "",
      "Weapon_Sword_002",
    ]);
    putNumbers("Pouch.Weapon.Content.Life", [0, 10, 23]);
    putNumbers("Pouch.Weapon.ValidNum", [3]);
    putNumbers("Pouch.Weapon.EquipIndex", [2]);
    putStrings("Pouch.Weapon.Content.Combined.Name", ["Item_Fruit_A", "", ""]);
    putStrings("Pouch.KeyItem.Content.Name", ["Parasail"]);
    putNumbers("Pouch.KeyItem.Content.StockNum", [0xffffffff]);
    putStrings("Pouch.Food.Content.Name", ["Item_Cook_A_01"]);
    putNumbers("Pouch.Food.Content.LifeRecover", [12]);
    putStrings("Pouch.Food.Content.MaterialName", [
      "Item_Fruit_A",
      "Item_Fruit_A",
      "",
      "",
      "",
    ]);
    putStrings("Pouch.Material.Content.Name", []);
    data.writeUInt32LE(0xa3db7114, table);
    data.writeUInt32LE(1024, table + 4);

    const inv = readInventory(new SaveReader(data));
    expect(inv.life).toBe(17);
    expect(inv.maxLife).toBe(40);
    expect(inv.stamina).toBe(2000);
    expect(inv.energy).toBe(6000);
    expect(inv.rupees).toBe(0);
    expect(inv.ponyPoints).toBeNull();
    expect(inv.groups).toHaveLength(9);
    expect(inv.groups[0].available).toBe(true);
    expect(inv.groups[0].capacity).toBe(3);
    expect(inv.groups[0].items).toHaveLength(2);
    expect(inv.groups[0].items[0].details.durability).toBe(0);
    expect(inv.groups[0].items[0].equipped).toBe(false);
    expect(inv.groups[0].items[1].equipped).toBe(true);
    expect(inv.groups[0].items[0].details.fuseId).toBe("Item_Fruit_A");
    expect(inv.groups[8].items[0].details.quantity).toBe(-1);
    expect(inv.groups[6].items[0].details.recipe[1]).toBe("Item_Fruit_A");

    // Quests, Compendium, Characters, Collections
    const qData = createFixture(length, header, metadata);
    const questDefs = [
      { id: "test", hash: 123, steps: ["NotReady", "Ready", "Complete"] },
      { id: "missing", hash: 124, steps: ["Complete"] },
    ];
    qData.writeUInt32LE(murmurHash3("Complete"), 44);
    const qRes = readQuests(new SaveReader(qData), questDefs);
    expect(qRes[0].state).toBe("done");
    expect(qRes[1].state).toBe("unknown");

    const root = path.resolve(import.meta.dirname, "../..");
    const worldJson = JSON.parse(
      fs.readFileSync(path.join(root, "web/public/world-data.json"), "utf8"),
    );
    const collectionJson = JSON.parse(
      fs.readFileSync(
        path.join(root, "web/public/collection-data.json"),
        "utf8",
      ),
    );
    expect(
      readCompendium(new SaveReader(qData), worldJson.entries),
    ).toHaveLength(509);
    expect(
      readCharacters(new SaveReader(qData), worldJson.characters),
    ).toHaveLength(22);
    expect(
      readCollections(new SaveReader(qData), collectionJson.entries),
    ).toHaveLength(100);
  });

  it("loads all 152 shrines and 166 chests in Catalog and counts progress accurately", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const shrineText = fs.readFileSync(
      path.join(root, "assets/shrines.json"),
      "utf8",
    );
    const shrineDefs = JSON.parse(shrineText).shrines;
    const emptyData = {
      shrines: shrineDefs.map((s) => ({ internal_name: s.id })),
    };
    const loaded = Catalog.load(
      emptyData,
      "[]",
      shrineText,
      new LocaleManager("en-US"),
    );
    expect(loaded.points).toHaveLength(152);
    let totalChests = 0;
    for (const p of loaded.points) {
      expect(p.visitHash).toBe(
        String(murmurHash3(`IsVisitLocation.${p.internalName}`)),
      );
      totalChests += p.chestHashes.length;
    }
    expect(totalChests).toBe(166);
    const counts = loaded.countProgress(
      loaded.points.map((_, i) => (i % 2 === 0 ? 1 : 0)),
    );
    const shrineCount = counts.find((c) => c.id === "shrines");
    expect(shrineCount).toEqual({
      id: "shrines",
      total: 152,
      found: 76,
      unknown: 0,
    });
  });

  it("validates HD map tiles, evicts corrupt cache files, checks releases and tracks page lifetime", async () => {
    expect(tryTile("map-tiles/surface/7/93/78.webp")?.remote).toBe(
      "https://objmap-totk.zeldamods.org/game_files/map/Ground/maptex/7/93/78.webp",
    );
    expect(tryTile("map-tiles/surface/8/0/0.webp")).toBeNull();
    expect(tryTile("map-tiles/../1/0/0.webp")).toBeNull();

    const tile = Buffer.alloc(30);
    tile.write("RIFF", 0, "ascii");
    tile.writeUInt32LE(22, 4);
    tile.write("WEBPVP8 ", 8, "ascii");
    tile[23] = 0x9d;
    tile[24] = 1;
    tile[25] = 0x2a;
    tile[27] = 1;
    tile[29] = 1;
    expect(validImage(tile)).toBe(true);
    expect(validImage(Buffer.alloc(29))).toBe(false);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyrulesync-hd-"));
    try {
      const cache = new HDMapTileCache({ dataRoot: tmpDir });
      const cachedFile = path.join(cache.root, "surface/7/93/78.webp");
      fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
      fs.writeFileSync(cachedFile, tile);
      cache.initialize();
      expect(
        (await cache.read("map-tiles/surface/7/93/78.webp", false)).length,
      ).toBe(tile.length);
      fs.writeFileSync(cachedFile, "corrupt");
      cache.initialize();
      expect(
        await cache.read("map-tiles/surface/7/93/78.webp", false),
      ).toBeNull();
      expect(fs.existsSync(cachedFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(parseVersion("v1.10.0")).toEqual([1, 10, 0]);
    expect(parseVersion("v01.2.3")).toBeNull();
    const release = {
      tag_name: "v1.10.0",
      body: "Notes",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "HyruleSync-Setup-v1.10.0.exe",
          browser_download_url:
            "https://github.com/AnisWgn/Totk-Map/releases/download/v1.10.0/HyruleSync-Setup-v1.10.0.exe",
          size: 1000,
          state: "uploaded",
        },
      ],
    };
    expect(evaluateRelease(release, "1.9.0").available).toBe(true);
    expect(evaluateRelease(release, "1.10.0").available).toBe(false);

    const pages = new PageLifetime();
    const now = 100000;
    const conn = {};
    pages.open("a", conn);
    pages.close("a", conn, now);
    expect(pages.shouldExit(now + 4000, false)).toBe(false);
    expect(pages.shouldExit(now + 5000, false)).toBe(true);
    expect(pages.shouldExit(now + 5000, true)).toBe(false);
  });
});
