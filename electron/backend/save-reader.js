// Read-only TOTK progress.sav binary parser (formats 1.0, 1.1/1.2 and 1.4 / Recomp).
const VERSIONS = new Map([
  [2307552, { header: 0x0046c3c8, metadata: 0x0003c050, label: "1.0" }],
  [2307656, { header: 0x0047e0f4, metadata: 0x0003c088, label: "1.1 / 1.2" }],
  [
    2307856,
    { header: 0x0049e946, metadata: 0x0003c138, label: "1.4 / Recomp 1.4.3" },
  ],
]);

// MurmurHash3 x86_32 with seed 0 over ASCII GameData keys.
export function murmurHash3(name) {
  const data = Buffer.from(String(name), "ascii");
  let h = 0;
  let i = 0;

  for (; i + 4 <= data.length; i += 4) {
    let k = data.readUInt32LE(i);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let k = 0;
  for (let j = 0; i + j < data.length; j++) {
    k |= data[i + j] << (8 * j);
  }
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;

  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const defaultLocale = {
  t: (_es, en) => en,
};

export class SaveReader {
  constructor(data, locale = defaultLocale) {
    this.locale = locale;
    if (!data || !(data instanceof Uint8Array)) {
      throw new Error(
        locale.t(
          "Selecciona un progress.sav válido, no caption.sav ni un archivo .nro.",
          "Select a valid progress.sav file, not caption.sav or an .nro file.",
        ),
      );
    }

    this.bytes = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    if (this.bytes.length < 40 || this.u32(0) !== 0x01020304) {
      throw new Error(
        locale.t(
          "Selecciona un progress.sav válido, no caption.sav ni un archivo .nro.",
          "Select a valid progress.sav file, not caption.sav or an .nro file.",
        ),
      );
    }

    const version = VERSIONS.get(this.bytes.length);
    if (
      !version ||
      this.u32(4) !== version.header ||
      this.u32(8) !== version.metadata
    ) {
      throw new Error(
        locale.t(
          "Formato no reconocido. Se admiten guardados originales 1.0, 1.1/1.2 y 1.4.",
          "Unrecognized format. Save formats 1.0, 1.1/1.2 and 1.4 are supported.",
        ),
      );
    }

    this.format = version.label;
    this.tableEnd = 0;
    this.guidStart = 0;
    this.playtime = 0;
    this.offsets = new Map();
    this.guids = new Set();

    const scanLimit = Math.min(this.bytes.length - 8, 0x60000);
    for (let position = 40; position < scanLimit; position += 8) {
      const key = this.u32(position);
      if (key === 0xa3db7114) {
        this.tableEnd = position;
        const rawGuidStart = this.u32(position + 4);
        if (rawGuidStart > 0x7fffffff) {
          throw new Error(
            locale.t(
              "No se encuentra una tabla de progreso válida.",
              "No valid progress table was found.",
            ),
          );
        }
        this.guidStart = rawGuidStart;
        break;
      }
      if (key === 0) continue;
      if (this.offsets.has(key)) {
        throw new Error(
          locale.t("Tabla de hashes duplicada.", "Duplicate hash table entry."),
        );
      }
      this.offsets.set(key, position + 4);
    }

    if (
      this.tableEnd === 0 ||
      this.guidStart < this.tableEnd ||
      this.guidStart > this.bytes.length - 8
    ) {
      throw new Error(
        locale.t(
          "No se encuentra una tabla de progreso válida.",
          "No valid progress table was found.",
        ),
      );
    }

    for (
      let position = this.guidStart;
      position <= this.bytes.length - 8;
      position += 8
    ) {
      const guid = this.bytes.readBigUInt64LE(position);
      if (guid === 0n) break;
      this.guids.add(guid);
    }

    const playtimeOffset = this.offsets.get(0xe573f564);
    if (playtimeOffset !== undefined) {
      this.playtime = this.u32(playtimeOffset);
    }
  }

  check(position, length) {
    if (position < 0 || position > this.bytes.length - length) {
      throw new Error(
        this.locale.t(
          "El archivo está incompleto o contiene una dirección inválida.",
          "The file is incomplete or contains an invalid offset.",
        ),
      );
    }
  }

  u32(position) {
    this.check(position, 4);
    return this.bytes.readUInt32LE(position);
  }

  playerPosition() {
    const entry = this.offsets.get(0xc884818d);
    if (entry === undefined) return null;
    const address = this.u32(entry);
    if (address < this.tableEnd + 8 || address > this.bytes.length - 12) {
      return null;
    }

    const x = this.bytes.readFloatLE(address);
    const y = this.bytes.readFloatLE(address + 4);
    const z = this.bytes.readFloatLE(address + 8);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }
    return { x, y, z };
  }

  currentMap() {
    const entry = this.offsets.get(0x1d6189da);
    if (entry === undefined) return null;
    const address = this.u32(entry);
    if (address < this.tableEnd + 8 || address > this.bytes.length - 64) {
      return null;
    }

    let length = 0;
    while (length < 64 && this.bytes[address + length] !== 0) {
      const ch = this.bytes[address + length];
      if (ch < 32 || ch > 126) return null;
      length++;
    }
    return length === 0 || length === 64
      ? null
      : this.bytes.toString("ascii", address, address + length);
  }

  booleanState(hash) {
    if (!hash) return -1;
    const key = Number(hash) >>> 0;
    const entry = this.offsets.get(key);
    if (entry === undefined) return -1;
    return this.u32(entry) !== 0 ? 1 : 0;
  }

  readChests(point) {
    if (point.category !== "shrines") return null;
    const result = { opened: 0, total: 0, unknown: 0 };
    if (!point.chestHashes) return result;
    result.total = point.chestHashes.length;
    for (const hash of point.chestHashes) {
      const state = this.booleanState(hash);
      if (state === 1) result.opened++;
      else if (state === -1) result.unknown++;
    }
    return result;
  }

  static resolveContext(map, raw, points) {
    const result = {
      kind: "unknown",
      mapId: map || "",
      shrineId: null,
      shrineName: null,
      mapPosition: null,
    };
    if (!map) return result;
    if (map === "MainField") {
      result.kind = "world";
      result.mapPosition = raw;
      return result;
    }

    const shrine = points.find(
      (point) => point.category === "shrines" && point.internalName === map,
    );
    if (shrine) {
      result.kind = "shrine";
      result.shrineId = shrine.id;
      result.shrineName = shrine.name;
      result.mapPosition = shrine.position;
    }
    return result;
  }

  state(point) {
    if (point.guid) {
      const found = this.guids.has(BigInt(point.guid));
      return {
        state: found ? 1 : 0,
        raw: found
          ? this.locale.t("GUID presente", "GUID present")
          : this.locale.t("GUID ausente", "GUID absent"),
      };
    }

    const key = Number(point.hash) >>> 0;
    const offset = this.offsets.get(key);
    if (offset === undefined) {
      return {
        state: -1,
        raw: this.locale.t(
          "Hash ausente del guardado",
          "Hash missing from the save",
        ),
      };
    }

    const status = this.u32(offset);
    const raw =
      "0x" +
      status.toString(16).toUpperCase().padStart(8, "0") +
      ` (${status})`;

    if (point.category === "shrines" || point.category === "carry_koroks") {
      return { state: status === 1654019904 ? 1 : 0, raw };
    }
    if (point.category === "lightroots") {
      return { state: status === 404286466 ? 1 : 0, raw };
    }
    return { state: status !== 0 ? 1 : 0, raw };
  }
}
