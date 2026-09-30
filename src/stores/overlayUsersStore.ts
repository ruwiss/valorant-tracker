import { create } from "zustand";

const HEX32 = /^[0-9a-f]{32}$/;

export function normalizePuuid(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const normalized = raw.replace(/-/g, "").toLowerCase();
  return HEX32.test(normalized) ? normalized : null;
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
