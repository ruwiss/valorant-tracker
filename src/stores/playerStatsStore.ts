import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invokeCommand } from "../utils/ipc";
import type { RecentForm } from "../lib/playerStats.types";

interface PlayerStatsStore {
  // puuid -> form. Memory only; cleared when the match id changes.
  cache: Map<string, RecentForm>;
  loading: Set<string>;
  errors: Map<string, string>;
  retryAfter: number;

  fetchStats: (puuid: string) => Promise<void>;
  clearCache: () => void;
  getStats: (puuid: string) => RecentForm | null;
  isLoading: (puuid: string) => boolean;
  getError: (puuid: string) => string | null;
  clearError: (puuid: string) => void;
}

export const usePlayerStatsStore = create<PlayerStatsStore>()(
  persist(
    (set, get) => ({
      cache: new Map(),
      loading: new Set(),
      errors: new Map(),
      retryAfter: 0,

      fetchStats: async (puuid: string) => {
        const { cache, loading, retryAfter } = get();
        if (!puuid) return;

        // Same player: never hit Riot again until the match cache is cleared.
        if (cache.has(puuid)) return;

        if (Date.now() < retryAfter) return;
        if (loading.has(puuid)) return;

        set((state) => {
          const nextLoading = new Set(state.loading);
          nextLoading.add(puuid);
          const nextErrors = new Map(state.errors);
          nextErrors.delete(puuid);
          return { loading: nextLoading, errors: nextErrors };
        });

        try {
          const json = await invokeCommand<RecentForm>(
            "get_recent_form",
            { puuid },
            { suppressErrorToast: true },
          );
          if (!json) throw new Error("FETCH_FAILED");

          if (json.status === "rate_limited") {
            const seconds = json.retry_after_secs > 0 ? json.retry_after_secs : 20;
            set(() => ({
              retryAfter: Date.now() + seconds * 1000,
              loading: new Set(),
            }));
            return;
          }

          if (json.status === "error") {
            throw new Error("FETCH_FAILED");
          }

          set((state) => {
            const nextCache = new Map(state.cache);
            nextCache.set(puuid, json);
            const nextLoading = new Set(state.loading);
            nextLoading.delete(puuid);
            return { cache: nextCache, loading: nextLoading };
          });
        } catch (error) {
          const errorMessage =
            typeof error === "string"
              ? error
              : error instanceof Error
                ? error.message
                : "UNKNOWN_ERROR";
          set((state) => {
            const nextLoading = new Set(state.loading);
            nextLoading.delete(puuid);
            const nextErrors = new Map(state.errors);
            nextErrors.set(puuid, errorMessage);
            return { loading: nextLoading, errors: nextErrors };
          });
        }
      },

      clearCache: () => {
        set({ cache: new Map(), loading: new Set(), errors: new Map() });
      },

      getStats: (puuid: string) => get().cache.get(puuid) || null,
      isLoading: (puuid: string) => get().loading.has(puuid),
      getError: (puuid: string) => get().errors.get(puuid) || null,
      clearError: (puuid: string) => {
        set((state) => {
          const nextErrors = new Map(state.errors);
          nextErrors.delete(puuid);
          return { errors: nextErrors };
        });
      },
    }),
    {
      name: "player-stats-storage",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ retryAfter: state.retryAfter }),
    },
  ),
);
