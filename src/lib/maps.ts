export const COMPETITIVE_MAPS = [
  "Ascent",
  "Bind",
  "Haven",
  "Split",
  "Icebox",
  "Breeze",
  "Fracture",
  "Pearl",
  "Lotus",
  "Sunset",
  "Abyss",
  "Corrode",
] as const;

export type CompetitiveMap = typeof COMPETITIVE_MAPS[number];

// Map display order and metadata
export const MAP_METADATA: Record<CompetitiveMap, { displayName: string; color: string }> = {
  "Ascent": { displayName: "Ascent", color: "#00d4aa" },
  "Bind": { displayName: "Bind", color: "#ecb22e" },
  "Haven": { displayName: "Haven", color: "#bd3fff" },
  "Split": { displayName: "Split", color: "#ff4655" },
  "Icebox": { displayName: "Icebox", color: "#4a90d9" },
  "Breeze": { displayName: "Breeze", color: "#00d4aa" },
  "Fracture": { displayName: "Fracture", color: "#ff9f43" },
  "Pearl": { displayName: "Pearl", color: "#59a5ac" },
  "Lotus": { displayName: "Lotus", color: "#00d4aa" },
  "Sunset": { displayName: "Sunset", color: "#ff6b35" },
  "Abyss": { displayName: "Abyss", color: "#bd3fff" },
  "Corrode": { displayName: "Corrode", color: "#8b7355" },
};
