import { murmurHash3 } from "./save-reader.js";

const INVENTORY_FIELDS = [
  ["quantity", "StockNum"],
  ["durability", "Life"],
  ["modifier", "Effect.Type"],
  ["modifierValue", "Effect.Value"],
  ["fuseId", "Combined.Name"],
  ["fuseDurability", "Combined.Life"],
  ["extraDurability", "ExtraLife"],
  ["recordExtraDurability", "RecordExtraLife"],
  ["dyeColor", "ColorVariation"],
  ["getOrder", "GetOrder"],
  ["useOrder", "UseOrder"],
  ["heartsHeal", "LifeRecover"],
  ["effectMultiplier", "Effect.Level"],
  ["effectTime", "Effect.Time"],
  ["price", "Price"],
];

const POUCHES = [
  ["weapons", "Weapon"],
  ["bows", "Bow"],
  ["shields", "Shield"],
  ["armors", "Armor"],
  ["arrows", "Arrow"],
  ["materials", "Material"],
  ["food", "Food"],
  ["devices", "SpecialParts"],
  ["key", "KeyItem"],
];

function entryOffset(save, key) {
  const at = save.offsets.get(murmurHash3(key));
  return at === undefined ? -1 : at;
}

function readScalar(save, key, floating) {
  const at = entryOffset(save, key);
  if (at < 0) return null;
  const value = floating
    ? save.bytes.readFloatLE(at)
    : save.bytes.readInt32LE(at);
  return !Number.isFinite(value) || value < 0 ? null : value;
}

function readArrayData(save, key, text) {
  const entry = entryOffset(save, key);
  if (entry < 0) return null;
  const address = save.u32(entry);
  const width = text ? 64 : 4;
  if (address < save.tableEnd + 8 || address > save.bytes.length - 4) {
    return null;
  }
  const count = save.u32(address);
  if (count > 4096 || address + 4 + count * width > save.bytes.length) {
    return null;
  }

  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    const at = address + 4 + i * width;
    if (!text) {
      result[i] = save.bytes.readInt32LE(at);
      continue;
    }
    let length = 0;
    while (length < width && save.bytes[at + length] !== 0) {
      const ch = save.bytes[at + length];
      if (ch < 32 || ch > 126) return null;
      length++;
    }
    if (length === width) return null;
    result[i] = save.bytes.toString("ascii", at, at + length);
  }
  return result;
}

function arrayAt(values, slot) {
  return values !== null && slot < values.length ? values[slot] : null;
}

export function readInventory(save) {
  const inventory = {
    life: readScalar(save, "PlayerStatus.Life", false),
    maxLife: readScalar(save, "PlayerStatus.MaxLife", false),
    stamina: readScalar(save, "PlayerStatus.MaxStamina", true),
    energy: readScalar(save, "PlayerStatus.MaxEnergy", true),
    rupees: readScalar(save, "PlayerStatus.CurrentRupee", false),
    ponyPoints: readScalar(save, "HorseInnMemberPoint", false),
    groups: [],
  };

  for (const [groupId, pouchName] of POUCHES) {
    const prefix = `Pouch.${pouchName}.`;
    const names = readArrayData(save, `${prefix}Content.Name`, true);
    const valid = arrayAt(readArrayData(save, `${prefix}ValidNum`, false), 0);
    const group = {
      id: groupId,
      available: names !== null,
      capacity:
        typeof valid === "number" &&
        valid >= 0 &&
        names !== null &&
        valid <= names.length
          ? valid
          : null,
      items: [],
    };
    inventory.groups.push(group);
    if (names === null) continue;

    const fields = new Map();
    for (const [fieldKey, fieldSuffix] of INVENTORY_FIELDS) {
      fields.set(
        fieldKey,
        readArrayData(
          save,
          `${prefix}Content.${fieldSuffix}`,
          fieldKey === "fuseId",
        ),
      );
    }

    const recipe =
      groupId === "food"
        ? readArrayData(save, `${prefix}Content.MaterialName`, true)
        : null;
    const equipped = readArrayData(save, `${prefix}EquipIndex`, false);

    for (let slot = 0; slot < names.length; slot++) {
      const id = names[slot];
      if (!id) continue;
      const details = {};
      for (const [fieldKey, values] of fields) {
        details[fieldKey] = arrayAt(values, slot);
      }
      if (recipe !== null && slot * 5 + 5 <= recipe.length) {
        details.recipe = recipe.slice(slot * 5, slot * 5 + 5);
      }
      group.items.push({
        id,
        slot,
        equipped: equipped === null ? null : equipped.includes(slot),
        details,
      });
    }
  }

  return inventory;
}

export function readQuests(save, definitions) {
  return definitions.map((quest) => {
    const result = { id: quest.id, state: "unknown", step: null, raw: null };
    const offset = save.offsets.get(Number(quest.hash) >>> 0);
    if (offset === undefined) return result;

    const value = save.u32(offset);
    result.raw = value;
    const step =
      quest.steps.find((candidate) => murmurHash3(candidate) === value) ?? null;
    result.step = step;
    if (step !== null) {
      result.state =
        step === "Complete" ? "done" : step === "NotReady" ? "todo" : "active";
    }
    return result;
  });
}

const COMPENDIUM_UNOPENED = murmurHash3("Unopened");
const COMPENDIUM_PHOTO = murmurHash3("TakePhoto");
const COMPENDIUM_BOUGHT = murmurHash3("Buy");

export function readCompendium(save, definitions) {
  return definitions.map((definition) => {
    const entry = { id: definition.id, state: "unknown", raw: null };
    const offset = save.offsets.get(Number(definition.hash) >>> 0);
    if (offset !== undefined) {
      const value = save.u32(offset);
      entry.raw = value;
      entry.state =
        value === COMPENDIUM_UNOPENED
          ? "missing"
          : value === COMPENDIUM_PHOTO
            ? "photo"
            : value === COMPENDIUM_BOUGHT
              ? "bought"
              : "unknown";
    }
    return entry;
  });
}

function characterFlag(save, hash) {
  const offset = save.offsets.get(Number(hash) >>> 0);
  return offset === undefined ? null : save.u32(offset);
}

export function readCharacters(save, definitions) {
  return definitions.map((definition) => {
    const notificationRaw = characterFlag(save, definition.notificationHash);
    const newRaw = characterFlag(save, definition.newHash);
    let state = "unknown";
    if (notificationRaw === 1 || newRaw === 1) state = "discovered";
    else if (notificationRaw === 0 && newRaw === 0) state = "missing";
    return {
      id: definition.id,
      state,
      notificationRaw,
      newRaw,
    };
  });
}

export function readCollections(save, definitions) {
  return definitions.map((definition) => {
    const entry = { id: definition.id, state: "unknown", raw: null };
    const offset = save.offsets.get(Number(definition.hash) >>> 0);
    if (offset !== undefined) {
      const raw = save.u32(offset);
      entry.raw = raw;
      entry.state = raw === 1 ? "owned" : raw === 0 ? "missing" : "unknown";
    }
    return entry;
  });
}
