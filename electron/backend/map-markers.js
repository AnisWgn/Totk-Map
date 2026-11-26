import fs from "node:fs";
import path from "node:path";

import { SaveReader, murmurHash3 } from "./save-reader.js";

export const MAP_PIN_COLORS = [
  "Invalid",
  "Red",
  "Blue",
  "Yellow",
  "Green",
  "Purple",
  "LightBlue",
];

export const STAMP_TYPES = [
  "Invalid",
  "Sword",
  "Pot",
  "Human",
  "Rhombus",
  "Heart",
  "Star",
  "TreasureBox",
  "Skull",
  "Leaf",
  "Ore",
];

export const STAMP_LAYERS = ["Sky", "Ground", "Underground"];

export const HASH_MAP_PIN_TYPE = 0x1b62aa42; // MapData.IconData.MapPinData.Type
export const HASH_MAP_PIN_POS = 0x5f93e70f; // MapData.IconData.MapPinData.Pos
export const HASH_MAP_PIN_IS_FIT = 0x182a9d9c; // MapData.IconData.MapPinData.IsFit
export const HASH_STAMP_TYPE = 0x14d7f4c4; // MapData.IconData.StampData.Type
export const HASH_STAMP_LAYER = 0xd2025694; // MapData.IconData.StampData.Layer
export const HASH_STAMP_POS = 0xf24fc2e7; // MapData.IconData.StampData.Pos
export const HASH_WARP_INDEX = 0xc6dc3b56; // MapData.IconData.WarpMarkerData.Index
export const HASH_WARP_POS = 0x636b4637; // MapData.IconData.WarpMarkerData.Pos
export const HASH_SAVE_POS_RAD_Y = 0x1ea93bd8; // PlayerStatus.SavePosRadY

export const PIN_COLOR_BY_HASH = new Map(
  MAP_PIN_COLORS.map((name) => [murmurHash3(name), name]),
);
export const PIN_HASH_BY_COLOR = new Map(
  MAP_PIN_COLORS.map((name) => [name, murmurHash3(name)]),
);

export const STAMP_TYPE_BY_HASH = new Map(
  STAMP_TYPES.map((name) => [murmurHash3(name), name]),
);
export const STAMP_HASH_BY_TYPE = new Map(
  STAMP_TYPES.map((name) => [name, murmurHash3(name)]),
);

export const STAMP_LAYER_BY_HASH = new Map([
  [murmurHash3("Sky"), "sky"],
  [murmurHash3("Ground"), "surface"],
  [murmurHash3("Underground"), "depths"],
]);

function readArrayHeader(save, hash, elementBytes, maxCount = 512) {
  const entry = save.offsets.get(hash >>> 0);
  if (entry === undefined) return null;
  const address = save.u32(entry);
  if (address < save.tableEnd + 8 || address > save.bytes.length - 4) {
    return null;
  }
  const count = save.u32(address);
  if (
    count > maxCount ||
    address + 4 + count * elementBytes > save.bytes.length
  ) {
    return null;
  }
  return { address, count, dataOffset: address + 4 };
}

function readBoolArray(save, hash, maxCount = 64) {
  const entry = save.offsets.get(hash >>> 0);
  if (entry === undefined) return null;
  const address = save.u32(entry);
  if (address < save.tableEnd + 8 || address > save.bytes.length - 4) {
    return null;
  }
  const count = save.u32(address);
  const byteLen = Math.ceil(count / 8);
  if (count > maxCount || address + 4 + byteLen > save.bytes.length) {
    return null;
  }
  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    const b = save.bytes[address + 4 + Math.floor(i / 8)];
    result[i] = Boolean((b >>> (i % 8)) & 1);
  }
  return result;
}

function isFiniteCoord(v) {
  return Number.isFinite(v) && Math.abs(v) <= 20000;
}

export function decodeRawMapPins(typeHashes, positions, isFitFlags = null) {
  const pins = [];
  const count = Math.min(typeHashes?.length || 0, positions?.length || 0);
  for (let slot = 0; slot < count; slot++) {
    const color = PIN_COLOR_BY_HASH.get(typeHashes[slot] >>> 0) || "Invalid";
    if (color === "Invalid") continue;
    const pos = positions[slot];
    if (
      !pos ||
      !isFiniteCoord(pos.x) ||
      !isFiniteCoord(pos.y) ||
      !isFiniteCoord(pos.z)
    ) {
      continue;
    }
    if (pos.x === 0 && pos.y === 0 && pos.z === 0) continue;
    pins.push({
      slot,
      color,
      isFit: Array.isArray(isFitFlags) ? Boolean(isFitFlags[slot]) : false,
      position: { x: pos.x, y: pos.y, z: pos.z },
    });
  }
  return pins;
}

export function decodeRawStamps(typeHashes, layerHashes, positions2d) {
  const stamps = [];
  const count = Math.min(
    typeHashes?.length || 0,
    layerHashes?.length || 0,
    positions2d?.length || 0,
  );
  for (let slot = 0; slot < count; slot++) {
    const type = STAMP_TYPE_BY_HASH.get(typeHashes[slot] >>> 0) || "Invalid";
    if (type === "Invalid") continue;
    const layer = STAMP_LAYER_BY_HASH.get(layerHashes[slot] >>> 0) || "surface";
    const pos = positions2d[slot];
    if (!pos || !isFiniteCoord(pos.x) || !isFiniteCoord(pos.north)) continue;
    const y = layer === "depths" ? -250 : layer === "sky" ? 1000 : 120;
    stamps.push({
      slot,
      type,
      layer,
      position: { x: pos.x, y, z: -pos.north },
    });
  }
  return stamps;
}

export function readMapMarkers(save) {
  let playerYaw = null;
  const yawOffset = save.offsets.get(HASH_SAVE_POS_RAD_Y);
  if (yawOffset !== undefined && yawOffset <= save.bytes.length - 4) {
    const rad = save.bytes.readFloatLE(yawOffset);
    if (Number.isFinite(rad)) {
      playerYaw = rad;
    }
  }

  const pinTypesHdr = readArrayHeader(save, HASH_MAP_PIN_TYPE, 4, 16);
  const pinPosHdr = readArrayHeader(save, HASH_MAP_PIN_POS, 12, 16);
  const pinFit = readBoolArray(save, HASH_MAP_PIN_IS_FIT, 16);

  let pins = [];
  if (pinTypesHdr && pinPosHdr) {
    const count = Math.min(pinTypesHdr.count, pinPosHdr.count);
    const typeHashes = new Array(count);
    const positions = new Array(count);
    for (let i = 0; i < count; i++) {
      typeHashes[i] = save.bytes.readUInt32LE(pinTypesHdr.dataOffset + i * 4);
      const base = pinPosHdr.dataOffset + i * 12;
      positions[i] = {
        x: save.bytes.readFloatLE(base),
        y: save.bytes.readFloatLE(base + 4),
        z: save.bytes.readFloatLE(base + 8),
      };
    }
    pins = decodeRawMapPins(typeHashes, positions, pinFit);
  }

  const stampTypeHdr = readArrayHeader(save, HASH_STAMP_TYPE, 4, 512);
  const stampLayerHdr = readArrayHeader(save, HASH_STAMP_LAYER, 4, 512);
  const stampPosHdr = readArrayHeader(save, HASH_STAMP_POS, 8, 512);

  let stamps = [];
  if (stampTypeHdr && stampLayerHdr && stampPosHdr) {
    const count = Math.min(
      stampTypeHdr.count,
      stampLayerHdr.count,
      stampPosHdr.count,
    );
    const typeHashes = new Array(count);
    const layerHashes = new Array(count);
    const pos2d = new Array(count);
    for (let i = 0; i < count; i++) {
      typeHashes[i] = save.bytes.readUInt32LE(stampTypeHdr.dataOffset + i * 4);
      layerHashes[i] = save.bytes.readUInt32LE(
        stampLayerHdr.dataOffset + i * 4,
      );
      const base = stampPosHdr.dataOffset + i * 8;
      pos2d[i] = {
        x: save.bytes.readFloatLE(base),
        north: save.bytes.readFloatLE(base + 4),
      };
    }
    stamps = decodeRawStamps(typeHashes, layerHashes, pos2d);
  }

  const warpIdxHdr = readArrayHeader(save, HASH_WARP_INDEX, 4, 16);
  const warpPosHdr = readArrayHeader(save, HASH_WARP_POS, 12, 16);
  const warpMarkers = [];
  if (warpIdxHdr && warpPosHdr) {
    const count = Math.min(warpIdxHdr.count, warpPosHdr.count);
    for (let slot = 0; slot < count; slot++) {
      const idx = save.bytes.readInt32LE(warpIdxHdr.dataOffset + slot * 4);
      if (idx < 0) continue;
      const base = warpPosHdr.dataOffset + slot * 12;
      const x = save.bytes.readFloatLE(base);
      const y = save.bytes.readFloatLE(base + 4);
      const z = save.bytes.readFloatLE(base + 8);
      if (!isFiniteCoord(x) || !isFiniteCoord(y) || !isFiniteCoord(z)) continue;
      if (x === 0 && y === 0 && z === 0) continue;
      warpMarkers.push({ slot, index: idx, position: { x, y, z } });
    }
  }

  return { pins, stamps, warpMarkers, playerYaw };
}

export function writeMapPinToSaveBuffer(
  sourceBytes,
  { slot, color, position },
  locale,
) {
  const nextBytes = Buffer.from(sourceBytes);
  const save = new SaveReader(nextBytes, locale);

  if (!Number.isInteger(slot) || slot < 0 || slot > 5) {
    throw new Error("Pin slot must be between 0 and 5.");
  }
  const colorHash = PIN_HASH_BY_COLOR.get(color);
  if (colorHash === undefined) {
    throw new Error("Invalid pin color.");
  }

  const pinTypesHdr = readArrayHeader(save, HASH_MAP_PIN_TYPE, 4, 16);
  const pinPosHdr = readArrayHeader(save, HASH_MAP_PIN_POS, 12, 16);
  if (
    !pinTypesHdr ||
    !pinPosHdr ||
    slot >= pinTypesHdr.count ||
    slot >= pinPosHdr.count
  ) {
    throw new Error(
      locale
        ? locale.t(
            "Este guardado no contiene la tabla de balizas del mapa.",
            "This save does not contain the map pins table.",
          )
        : "This save does not contain the map pins table.",
    );
  }

  const x = color === "Invalid" ? 0 : Number(position?.x ?? 0);
  const y = color === "Invalid" ? 0 : Number(position?.y ?? 120);
  const z = color === "Invalid" ? 0 : Number(position?.z ?? 0);
  if (!isFiniteCoord(x) || !isFiniteCoord(y) || !isFiniteCoord(z)) {
    throw new Error("Invalid pin coordinates.");
  }

  nextBytes.writeUInt32LE(colorHash >>> 0, pinTypesHdr.dataOffset + slot * 4);
  const posBase = pinPosHdr.dataOffset + slot * 12;
  nextBytes.writeFloatLE(x, posBase);
  nextBytes.writeFloatLE(y, posBase + 4);
  nextBytes.writeFloatLE(z, posBase + 8);

  return nextBytes;
}

export function writeMapPinToSaveFile(
  filePath,
  backupsDir,
  pinSpec,
  locale = undefined,
) {
  const resolved = path.resolve(filePath);
  const original = fs.readFileSync(resolved);
  const updated = writeMapPinToSaveBuffer(original, pinSpec, locale);

  if (backupsDir) {
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupsDir, `progress-${stamp}.sav.bak`);
    fs.writeFileSync(backupPath, original);
  }

  const tmpPath = `${resolved}.hyrulesync-${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, updated);
  fs.renameSync(tmpPath, resolved);
  return updated;
}
