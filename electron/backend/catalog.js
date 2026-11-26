const CATEGORY_DEFINITIONS = [
  ["hidden_koroks", "Kologs ocultos", "Hidden Koroks", "korok_hidden"],
  ["carry_koroks", "Kologs viajeros", "Carry Koroks", "korok_carry"],
  ["shrines", "Santuarios", "Shrines", "shrine"],
  ["lightroots", "Raíces", "Lightroots", "lightroot"],
  ["caves", "Cuevas · entradas", "Caves · entrances", "cave"],
  ["bubbuls", "Fantasmos", "Bubbulfrogs", "bubbul"],
  ["wells", "Pozos", "Wells", "well"],
  ["chasms", "Abismos", "Chasms", "chasm"],
  ["locations", "Lugares", "Locations", "location"],
  ["hinoxes", "Hinox", "Hinoxes", "eye"],
  ["taluses", "Petraroks", "Taluses", "talus"],
  ["moldugas", "Moldoras", "Moldugas", "molduga"],
  ["flux_constructs", "Gólems cúbicos", "Flux Constructs", "flux_construct"],
  ["froxes", "Obsidianos", "Froxes", "frox"],
  ["gleeoks", "Griocks", "Gleeoks", "gleeok"],
  ["sages_wills", "Voluntades de sabios", "Sage's Wills", "sages_will"],
  ["old_maps", "Mapas antiguos", "Old Maps", "old_map"],
  ["addison_signposts", "Carteles de Kabalit", "Addison Signs", "addison_sign"],
  ["schema_stones", "Piedras esquemáticas", "Schema Stones", "schema_stone"],
  ["yiga_schematics", "Esquemas Yiga", "Yiga Schematics", "yiga_schematic"],
];

export class Catalog {
  constructor() {
    this.upstreamCommit = "a68ffbb083ac220c77f2e4ec3ce60d29924c1213";
    this.categories = [];
    this.points = [];
  }

  static load(mapDataText, towerDataText, shrineDataText, locale) {
    const data =
      typeof mapDataText === "string" ? JSON.parse(mapDataText) : mapDataText;
    const shrineList = (
      typeof shrineDataText === "string"
        ? JSON.parse(shrineDataText)
        : shrineDataText
    ).shrines;
    const shrines = new Map(shrineList.map((shrine) => [shrine.id, shrine]));
    const towers =
      typeof towerDataText === "string"
        ? JSON.parse(towerDataText)
        : towerDataText;

    const catalog = new Catalog();

    for (const [id, es, en, icon] of CATEGORY_DEFINITIONS) {
      const entries = data[id] || [];
      const name = locale.t(es, en);
      catalog.categories.push({ id, name, icon, count: entries.length });

      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const shrine =
          id === "shrines" && entry.internal_name
            ? (shrines.get(entry.internal_name) ?? null)
            : null;

        catalog.points.push({
          id: `${id}:${index}`,
          category: id,
          name: entry.display_name || `${name} ${index + 1}`,
          internalName: entry.internal_name ?? null,
          korokType: entry.type ?? null,
          position: entry.position ?? null,
          path: entry.path ?? null,
          hash: String(entry.completion_hash ?? 0),
          guid: entry.guid_hash ?? null,
          visitHash: shrine ? shrine.visitHash : null,
          origin: null,
          chestHashes: shrine ? shrine.chestHashes : null,
        });
      }
    }

    catalog.categories.push({
      id: "towers",
      name: locale.t("Atalayas", "Skyview Towers"),
      icon: "tower",
      count: towers.length,
    });

    for (const tower of towers) {
      catalog.points.push({
        id: `towers:${tower.id}`,
        category: "towers",
        internalName: tower.id,
        name: locale.t(tower.nameEs, tower.nameEn),
        korokType: null,
        position: tower.position,
        path: null,
        hash: tower.activationHash,
        guid: null,
        visitHash: tower.visitHash,
        origin: "Marc Robledo · Savegame Editors (MIT)",
        chestHashes: null,
      });
    }

    return catalog;
  }

  countProgress(states) {
    const counts = this.categories.map((category) => ({
      id: category.id,
      total: category.count,
      found: 0,
      unknown: 0,
    }));
    const byCategory = new Map(counts.map((count) => [count.id, count]));

    for (let index = 0; index < this.points.length; index++) {
      const count = byCategory.get(this.points[index].category);
      if (!count) continue;
      if (states[index] === 1) count.found++;
      else if (states[index] === -1) count.unknown++;
    }
    return counts;
  }
}
