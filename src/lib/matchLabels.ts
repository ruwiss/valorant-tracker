import type { Locale } from "./i18n";

/** Game-client locale wins over the overlay language. Unknown → overlay locale. */
export function localeForGame(
  clientLocale: string | null | undefined,
  fallback: Locale,
): Locale {
  const raw = (clientLocale || "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return fallback;
  if (raw.startsWith("tr")) return "tr";
  return "en";
}

const QUEUE_ALIASES: Record<string, string> = {
  ranked: "competitive",
  escalation: "ggteam",
  replication: "onefa",
  teamdeathmatch: "hurm",
  tdm: "hurm",
  customgame: "custom",
  snowballfight: "snowball",
  premierteam: "premier",
  tournamentmode: "premier",
  skirmish: "newmap",
};

function queueToken(value: string): string {
  const leaf = value.trim().replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return leaf
    .toLowerCase()
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]/g, "");
}

/** i18n key for a Riot queue id, or null when it is not a known mode. */
export function queueI18nKey(queueId: string | null | undefined): string | null {
  const token = queueToken(queueId || "");
  if (!token) return null;
  const key = QUEUE_ALIASES[token] || token;
  return `queue.${key}`;
}

/** English mode labels the backend still emits, mapped back to queue keys. */
const MODE_NAME_KEYS: Record<string, string> = {
  swiftplay: "queue.swiftplay",
  spikerush: "queue.spikerush",
  deathmatch: "queue.deathmatch",
  escalation: "queue.ggteam",
  replication: "queue.onefa",
  teamdeathmatch: "queue.hurm",
  competitive: "queue.competitive",
  unrated: "queue.unrated",
  premier: "queue.premier",
  custom: "queue.custom",
  normal: "queue.unrated",
  rekabetci: "queue.competitive",
  derecesiz: "queue.unrated",
  tamgaz: "queue.swiftplay",
  ozeloyun: "queue.custom",
};

export function modeI18nKey(
  queueId: string | null | undefined,
  modeName: string | null | undefined,
): string | null {
  return queueI18nKey(queueId) || MODE_NAME_KEYS[queueToken(modeName || "")] || null;
}

/** true = attack, false = defense, null = unknown. */
export function isAttackSide(side: string | null | undefined): boolean | null {
  const value = (side || "").toUpperCase();
  if (!value) return null;
  if (value.includes("SALDIR") || value.includes("ATTACK") || value.includes("ATK")) return true;
  if (value.includes("SAVUN") || value.includes("DEFEN") || value.includes("DEF")) return false;
  return null;
}
