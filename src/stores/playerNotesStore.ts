import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_NOTE = 140;

function noteKey(puuid: string): string {
  return puuid.trim().toLowerCase();
}

interface PlayerNotesStore {
  notes: Record<string, string>;
  setNote: (puuid: string, value: string) => void;
}

export const usePlayerNotesStore = create<PlayerNotesStore>()(
  persist(
    (set) => ({
      notes: {},
      setNote: (puuid, value) => {
        const id = noteKey(puuid);
        if (!id) return;
        const text = value.trim().slice(0, MAX_NOTE);
        set((state) => {
          const notes = { ...state.notes };
          if (!text) delete notes[id];
          else notes[id] = text;
          return { notes };
        });
      },
    }),
    {
      name: "valorant-tracker-player-notes",
      partialize: (state) => ({ notes: state.notes }),
    },
  ),
);

export function noteFor(notes: Record<string, string>, puuid: string): string {
  const id = noteKey(puuid);
  if (!id) return "";
  return notes[id] ?? "";
}
