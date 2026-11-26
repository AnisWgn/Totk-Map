// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { LocaleManager } from "../../electron/backend/locale.js";
import {
  HASH_MAP_PIN_POS,
  HASH_MAP_PIN_TYPE,
  HASH_SAVE_POS_RAD_Y,
  HASH_STAMP_LAYER,
  HASH_STAMP_POS,
  HASH_STAMP_TYPE,
  PIN_HASH_BY_COLOR,
  STAMP_HASH_BY_TYPE,
  readMapMarkers,
  writeMapPinToSaveFile,
} from "../../electron/backend/map-markers.js";
import { RecompLiveBridge } from "../../electron/backend/recomp-live.js";
import { SaveReader, murmurHash3 } from "../../electron/backend/save-reader.js";

function buildSyntheticRecompSave() {
  // Format 1.4 / Recomp 1.4.3: size 2307856, header 0x0049e946, metadata 0x0003c138
  const buf = Buffer.alloc(2307856, 0);
  buf.writeUInt32LE(0x01020304, 0);
  buf.writeUInt32LE(0x0049e946, 4);
  buf.writeUInt32LE(0x0003c138, 8);

  let dataCursor = 0x1000;
  let tablePos = 40;

  function addPointerEntry(hash, payloadBuilder) {
    const addr = dataCursor;
    dataCursor = payloadBuilder(addr);
    buf.writeUInt32LE(hash >>> 0, tablePos);
    buf.writeUInt32LE(addr >>> 0, tablePos + 4);
    tablePos += 8;
  }

  function addScalarFloatEntry(hash, val) {
    buf.writeUInt32LE(hash >>> 0, tablePos);
    buf.writeFloatLE(val, tablePos + 4);
    tablePos += 8;
  }

  // Link yaw
  addScalarFloatEntry(HASH_SAVE_POS_RAD_Y, 1.57);

  // 6 Colored Map Pins (slot 0 = Red at [250, 140, -500], slot 2 = LightBlue at [-1200, 900, 300])
  addPointerEntry(HASH_MAP_PIN_TYPE, (at) => {
    buf.writeUInt32LE(6, at);
    const invalid = PIN_HASH_BY_COLOR.get("Invalid");
    for (let i = 0; i < 6; i++) {
      buf.writeUInt32LE(invalid, at + 4 + i * 4);
    }
    buf.writeUInt32LE(PIN_HASH_BY_COLOR.get("Red"), at + 4);
    buf.writeUInt32LE(PIN_HASH_BY_COLOR.get("LightBlue"), at + 4 + 2 * 4);
    return at + 4 + 6 * 4;
  });

  addPointerEntry(HASH_MAP_PIN_POS, (at) => {
    buf.writeUInt32LE(6, at);
    buf.writeFloatLE(250, at + 4);
    buf.writeFloatLE(140, at + 8);
    buf.writeFloatLE(-500, at + 12);

    const slot2 = at + 4 + 2 * 12;
    buf.writeFloatLE(-1200, slot2);
    buf.writeFloatLE(900, slot2 + 4);
    buf.writeFloatLE(300, slot2 + 8);
    return at + 4 + 6 * 12;
  });

  // 4 Stamp slots for test (slot 1 = Leaf on Sky at x=400, north=800 -> z=-800)
  addPointerEntry(HASH_STAMP_TYPE, (at) => {
    buf.writeUInt32LE(4, at);
    const invalid = STAMP_HASH_BY_TYPE.get("Invalid");
    for (let i = 0; i < 4; i++) {
      buf.writeUInt32LE(invalid, at + 4 + i * 4);
    }
    buf.writeUInt32LE(STAMP_HASH_BY_TYPE.get("Leaf"), at + 4 + 1 * 4);
    return at + 4 + 4 * 4;
  });

  addPointerEntry(HASH_STAMP_LAYER, (at) => {
    buf.writeUInt32LE(4, at);
    buf.writeUInt32LE(murmurHash3("Sky"), at + 4 + 1 * 4);
    return at + 4 + 4 * 4;
  });

  addPointerEntry(HASH_STAMP_POS, (at) => {
    buf.writeUInt32LE(4, at);
    buf.writeFloatLE(400, at + 4 + 1 * 8);
    buf.writeFloatLE(800, at + 4 + 1 * 8 + 4);
    return at + 4 + 4 * 8;
  });

  // Table end marker (0xa3db7114 -> guidStart)
  const guidStart = 0x4000;
  buf.writeUInt32LE(0xa3db7114, tablePos);
  buf.writeUInt32LE(guidStart, tablePos + 4);

  return buf;
}

describe("TotK Recomp real-time memory bridge and in-game map pins/stamps", () => {
  it("reads colored pins, stamps and Link yaw from Recomp 1.4.3 saves and writes pins safely with backup", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyrulesync-pins-"));
    try {
      const savePath = path.join(tmpDir, "progress.sav");
      const backupsDir = path.join(tmpDir, "backups");
      fs.writeFileSync(savePath, buildSyntheticRecompSave());

      const reader = new SaveReader(fs.readFileSync(savePath));
      const markers = readMapMarkers(reader);

      expect(markers.playerYaw).toBeCloseTo(1.57, 2);
      expect(markers.pins).toEqual([
        {
          slot: 0,
          color: "Red",
          isFit: false,
          position: { x: 250, y: 140, z: -500 },
        },
        {
          slot: 2,
          color: "LightBlue",
          isFit: false,
          position: { x: -1200, y: 900, z: 300 },
        },
      ]);
      expect(markers.stamps).toEqual([
        {
          slot: 1,
          type: "Leaf",
          layer: "sky",
          position: { x: 400, y: 1000, z: -800 },
        },
      ]);

      // Write a new Green pin into slot 1 and verify backup creation + binary round-trip
      writeMapPinToSaveFile(savePath, backupsDir, {
        slot: 1,
        color: "Green",
        position: { x: -320, y: 115, z: 640 },
      });

      const backupFiles = fs.readdirSync(backupsDir);
      expect(backupFiles).toHaveLength(1);
      expect(backupFiles[0]).toMatch(/\.sav\.bak$/);

      const updatedMarkers = readMapMarkers(
        new SaveReader(fs.readFileSync(savePath)),
      );
      expect(updatedMarkers.pins).toHaveLength(3);
      expect(updatedMarkers.pins[1]).toEqual({
        slot: 1,
        color: "Green",
        isFit: false,
        position: { x: -320, y: 115, z: 640 },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("streams live player coordinates, pins and stamps from the Windows Recomp worker and writes pins into RAM", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stdin,
      kill() {
        this.emit("close", 0);
      },
    });

    const writtenCommands = [];
    stdin.on("data", (chunk) => {
      const lines = chunk.toString("utf8").trim().split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        const msg = JSON.parse(line);
        writtenCommands.push(msg);
        if (msg.cmd === "setPin") {
          stdout.write(
            JSON.stringify({ reply: "setPin", id: msg.id, ok: true }) + "\n",
          );
        }
      }
    });

    const bridge = new RecompLiveBridge({
      enabled: true,
      platform: "win32",
      locale: new LocaleManager("en-US"),
      spawnProcess: () => fakeChild,
    });
    bridge.start();

    try {
      const inv = PIN_HASH_BY_COLOR.get("Invalid");
      const yellow = PIN_HASH_BY_COLOR.get("Yellow");
      const star = STAMP_HASH_BY_TYPE.get("Star");
      const ground = murmurHash3("Ground");

      stdout.write(
        JSON.stringify({
          status: "connected",
          pid: 7788,
          processName: "totk.exe",
          canWriteMemory: true,
          playerPosition: { x: 128.5, y: 145.25, z: -412.75 },
          playerYaw: 0.75,
          pinTypes: [yellow, inv, inv, inv, inv, inv],
          pinPositions: [
            [100, 150, -200],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ],
          activeStamps: [[5, star, ground, -550, 900]],
        }) + "\n",
      );

      await new Promise((r) => setTimeout(r, 30));

      const st = bridge.state();
      expect(st.status).toBe("connected");
      expect(st.pid).toBe(7788);
      expect(st.processName).toBe("totk.exe");
      expect(st.canWriteMemory).toBe(true);
      expect(st.playerPosition).toEqual({ x: 128.5, y: 145.25, z: -412.75 });
      expect(st.pins).toEqual([
        {
          slot: 0,
          color: "Yellow",
          isFit: false,
          position: { x: 100, y: 150, z: -200 },
        },
      ]);
      expect(st.stamps).toEqual([
        {
          slot: 5,
          type: "Star",
          layer: "surface",
          position: { x: -550, y: 120, z: -900 },
        },
      ]);

      const writeRes = await bridge.writePinInMemory({
        slot: 1,
        color: "Purple",
        position: { x: 500, y: 200, z: -300 },
      });
      expect(writeRes.ok).toBe(true);
      expect(writtenCommands[0]).toMatchObject({
        cmd: "setPin",
        slot: 1,
        typeHash: PIN_HASH_BY_COLOR.get("Purple"),
        x: 500,
        y: 200,
        z: -300,
      });
    } finally {
      bridge.stop();
    }
  });
});
