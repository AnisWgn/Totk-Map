export const stampLabels = {
  Sword: "Espada",
  Pot: "Olla",
  Human: "Persona",
  Rhombus: "Rombo",
  Heart: "Corazón",
  Star: "Estrella",
  TreasureBox: "Cofre del tesoro",
  Skull: "Calavera",
  Leaf: "Hoja kolog",
  Ore: "Mineral",
};

export const stampImage = (type) =>
  `stamps/${Object.hasOwn(stampLabels, type) ? type : "Star"}.svg`;
