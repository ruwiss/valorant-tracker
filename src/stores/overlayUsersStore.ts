import { create } from "zustand";
import { AUTHOR_PUUID } from "../lib/constants";
import { useGameStore } from "./gameStore";

const HEX32 = /^[0-9a-f]{32}$/;

export function normalizePuuid(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const normalized = raw.replace(/-/g, "").toLowerCase();
  return HEX32.test(normalized) ? normalized : null;
}

const AUTHOR_KEY = normalizePuuid(AUTHOR_PUUID);

/**
 * True when Riot did not give us a live `Name#Tag` for this player: the name
 * is blank, an agent fallback, or recalled from an older match.
 */
export function isHiddenName(name: string | null | undefined, fromHistory?: boolean): boolean {
  if (fromHistory) return true;
  const raw = (name || "").trim();
  return !raw.includes("#");
}

interface OverlayUsersStore {
  puuids: string[];
  add: (incoming: string[]) => void;
}

export const useOverlayUsersStore = create<OverlayUsersStore>((set, get) => ({
  puuids: [],
  add: (incoming) => {
    if (!incoming?.length) return;
    const current = get().puuids;
    const known = new Set(current);
    const added: string[] = [];
    for (const raw of incoming) {
      const normalized = normalizePuuid(raw);
      if (!normalized || known.has(normalized)) continue;
      known.add(normalized);
      added.push(normalized);
    }
    if (added.length === 0) return;
    set({ puuids: current.concat(added) });
  },
}));

/** The local player is the tracker author (admin). */
export function useViewerIsAuthor(): boolean {
  return useGameStore((s) => {
    const me = s.gameState?.allies?.find((a) => a.is_me)?.puuid || s.selfPuuid;
    return AUTHOR_KEY != null && normalizePuuid(me || "") === AUTHOR_KEY;
  });
}

/**
 * Whether to show the tracker-user mark for a player. Players with a visible
 * Riot ID are marked for everyone. Players who hide their name are marked only
 * for the author, so the mark does not help others unmask them.
 */
export function showTrackerUserMark(
  puuids: string[],
  viewerIsAuthor: boolean,
  puuid: string,
  nameHidden: boolean,
): boolean {
  const key = normalizePuuid(puuid);
  if (key == null || key === AUTHOR_KEY) return false;
  if (!puuids.includes(key)) return false;
  return !nameHidden || viewerIsAuthor;
}

export function useTrackerUserMark(puuid: string, nameHidden: boolean): boolean {
  const puuids = useOverlayUsersStore((s) => s.puuids);
  const viewerIsAuthor = useViewerIsAuthor();
  return showTrackerUserMark(puuids, viewerIsAuthor, puuid, nameHidden);
}
