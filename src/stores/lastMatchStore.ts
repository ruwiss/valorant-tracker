import { create } from "zustand";
import { invokeCommand } from "../utils/ipc";
import type { LastMatch } from "../lib/types";

interface LastMatchStore {
  match: LastMatch | null;
  loading: boolean;
  refreshing: boolean;
  pending: boolean;
  error: string | null;
  expanded: boolean;
  fetchLastMatch: (force?: boolean) => Promise<LastMatch | null>;
  setMatch: (match: LastMatch | null) => void;
  setExpanded: (expanded: boolean) => void;
  markPending: () => void;
}

export const useLastMatchStore = create<LastMatchStore>((set, get) => ({
  match: null,
  loading: false,
  refreshing: false,
  pending: false,
  error: null,
  expanded: false,

  setMatch: (match) =>
    set((s) => ({
      match,
      error: null,
      pending: false,
      refreshing: false,
      loading: false,
      expanded:
        s.match && match && s.match.match_id !== match.match_id ? false : s.expanded,
    })),

  setExpanded: (expanded) => set({ expanded }),

  markPending: () => set({ pending: true, refreshing: true, expanded: false }),

  fetchLastMatch: async (force = false) => {
    const had = !!get().match;
    set({
      loading: !had,
      refreshing: had,
      error: null,
    });

    try {
      const result = await invokeCommand<LastMatch | null>("get_last_match", { force }, {
        suppressErrorToast: true,
      });
      if (result) {
        const { pending, match: current } = get();
        if (pending && current && result.match_id === current.match_id) {
          set({ loading: false, refreshing: true, error: null });
          return result;
        }
        get().setMatch(result);
        return result;
      }
      set({
        loading: false,
        refreshing: false,
        error: had ? null : "empty",
      });
      return null;
    } catch {
      set({
        loading: false,
        refreshing: false,
        error: had ? null : "error",
      });
      return null;
    }
  },
}));
