import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invokeCommand } from "../utils/ipc";
import type {
  TrackerApiResponse,
  PlayerStatsDisplay,
  Segment,
} from "../lib/playerStats.types";

interface PlayerStatsStore {
  // puuid -> stats cache (lasts until game ends)
  cache: Map<string, PlayerStatsDisplay>;
  // Loading states by puuid
  loading: Set<string>;
  // Error states by puuid
  errors: Map<string, string>;
  // Rate limit timestamp (epoch ms)
  retryAfter: number;

  fetchStats: (playerName: string, puuid: string) => Promise<void>;
  fetchBatchStats: (players: { name: string; puuid: string }[]) => Promise<void>;
  clearCache: () => void;
  getStats: (puuid: string) => PlayerStatsDisplay | null;
  isLoading: (puuid: string) => boolean;
  getError: (puuid: string) => string | null;
  clearError: (puuid: string) => void;
}

function parseTrackerResponse(data: TrackerApiResponse["data"]): PlayerStatsDisplay {
  const { platformInfo, metadata, segments } = data;

  // Find the latest season segment
  const seasonSegment = segments.find((s: Segment) => s.type === "season");
  const stats = seasonSegment?.stats || {};

  // Find top agent by matches played
  const agentSegments = segments.filter((s: Segment) => s.type === "agent");
  const topAgentSegment = agentSegments.reduce<Segment | null>((top, current) => {
    const topMatches = top?.stats?.matchesPlayed?.value || 0;
    const currentMatches = current.stats?.matchesPlayed?.value || 0;
    return currentMatches > topMatches ? current : top;
  }, null);

  // Current season name
  const currentSeason = metadata.seasons?.[0]?.shortName || metadata.defaultSeason || "Unknown";

  return {
    playerName: platformInfo.platformUserHandle,
    avatarUrl: platformInfo.avatarUrl,
    accountLevel: metadata.accountLevel || 0,
    currentSeason,
    privacy: metadata.privacy,

    // Core stats with display values
    kd: stats.kDRatio?.displayValue || "—",
    winRate: stats.matchesWinPct?.displayValue || "—",
    headshotPct: stats.headshotsPercentage?.displayValue || "—",
    acs: stats.scorePerRound?.displayValue || "—",

    // Advanced Stats
    adr: stats.damagePerRound?.displayValue || "—",
    kast: stats.kAST?.displayValue || "—",
    firstBloods: stats.firstBloods?.value || 0,
    clutches: stats.clutches?.value || 0,
    clutchWinRate: stats.clutchesPercentage?.displayValue || "—",

    // New Stats
    aces: stats.aces?.value || 0,
    econRating: stats.econRating?.displayValue || "—",
    damageDelta: stats.damageDeltaPerRound?.displayValue || "—",

    // Additional stats
    matchesPlayed: stats.matchesPlayed?.value || 0,
    kills: stats.kills?.value || 0,
    deaths: stats.deaths?.value || 0,
    assists: stats.assists?.value || 0,
    playtimeSeconds: stats.timePlayed?.value || 0,

    // Top agent
    topAgent: topAgentSegment
      ? {
          name: topAgentSegment.metadata.name,
          imageUrl: topAgentSegment.metadata.imageUrl || "",
          matches: topAgentSegment.stats?.matchesPlayed?.value || 0,
        }
      : null,
  };
}

export const usePlayerStatsStore = create<PlayerStatsStore>()(
  persist(
    (set, get) => ({
      cache: new Map(),
      loading: new Set(),
      errors: new Map(),
      retryAfter: 0,

      fetchStats: async (playerName: string, puuid: string) => {
        const { cache, loading, errors, retryAfter } = get();

        // Global Rate Limit Check
        if (Date.now() < retryAfter) {
          console.warn("[PlayerStats] Global rate limit active. Request blocked.");
          return;
        }

        // Already cached
        if (cache.has(puuid)) return;

        // Already fetching (or recently failed with private profile)
        if (loading.has(puuid)) return;

        // Don't retry private profiles automatically
        if (errors.get(puuid) === "PROFILE_PRIVATE") return;

        // Start loading
        set((state) => {
          const newLoading = new Set(state.loading);
          newLoading.add(puuid);
          const newErrors = new Map(state.errors);
          newErrors.delete(puuid); // Clear previous errors to try again
          return { loading: newLoading, errors: newErrors };
        });

        try {
          // Fetch stats via Rust backend to avoid CORS issues
          // Suppress error toast because we handle errors granularly in UI via 'errors' map
          const json = await invokeCommand<TrackerApiResponse>("get_tracker_stats", { playerName }, { suppressErrorToast: true });

          if (!json) throw new Error("Fetch failed");

          // Check for private profile
          if (json.data.metadata.privacy === "private") {
            throw new Error("PROFILE_PRIVATE");
          }

          const parsed = parseTrackerResponse(json.data);

          set((state) => {
            const newCache = new Map(state.cache);
            newCache.set(puuid, parsed);
            const newLoading = new Set(state.loading);
            newLoading.delete(puuid);
            return { cache: newCache, loading: newLoading };
          });
        } catch (error) {
          console.error(`[PlayerStats] Fetch failed for ${playerName}:`, error);
          const errorMessage = typeof error === "string" ? error : (error instanceof Error ? error.message : "UNKNOWN_ERROR");

          let translatedError = errorMessage;

          // Handle Rate Limiting (HTTP 429)
          if (errorMessage.includes("HTTP 429")) {
            translatedError = "RATE_LIMITED";
            // Extract retry-after seconds if available (Format: HTTP 429:3600)
            // Extract retry-after seconds if available (Format: HTTP 429:3600)
            const match = errorMessage.match(/HTTP 429:(\d+)/);
            let seconds = 60; // Default 1 minute
            if (match && match[1]) {
                const parsed = parseInt(match[1]);
                if (!isNaN(parsed)) seconds = parsed;
            }

            // Set global retry timestamp
            const retryTimestamp = Date.now() + (seconds * 1000);
            console.warn(`[PlayerStats] RATE LIMITED! Blocking requests until ${new Date(retryTimestamp).toLocaleTimeString()}`);

            set(() => ({
                retryAfter: retryTimestamp,
                loading: new Set(), // Clear all loading states
            }));

            // We return early here because we just wiped loading states
            return;
          }

          // Other Errors
          if (errorMessage.includes("HTTP 404")) translatedError = "PLAYER_NOT_FOUND";
          else if (errorMessage.includes("HTTP 403")) translatedError = "PROFILE_PRIVATE";
          else if (errorMessage.includes("HTTP 451")) translatedError = "PROFILE_PRIVATE";

          set((state) => {
            const newLoading = new Set(state.loading);
            newLoading.delete(puuid);
            const newErrors = new Map(state.errors);
            newErrors.set(puuid, translatedError);
            return { loading: newLoading, errors: newErrors };
          });
        }
      },

      fetchBatchStats: async (_players: { name: string; puuid: string }[]) => {
          // Deprecated/No-op to prevent batch fetching loops
          console.warn("[PlayerStats] fetchBatchStats is deprecated to prevent rate limiting.");
      },

      clearCache: () => {
        console.log("[PlayerStats] Clearing cache (game ended)");
        set({ cache: new Map(), loading: new Set(), errors: new Map() });
      },

      getStats: (puuid: string) => {
        return get().cache.get(puuid) || null;
      },

      isLoading: (puuid: string) => {
        return get().loading.has(puuid);
      },

      getError: (puuid: string) => {
        return get().errors.get(puuid) || null;
      },

      clearError: (puuid: string) => {
        set((state) => {
          const newErrors = new Map(state.errors);
          newErrors.delete(puuid);
          return { errors: newErrors };
        });
      },
    }),
    {
      name: "player-stats-storage",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ retryAfter: state.retryAfter }), // Only persist retryAfter
    }
  )
);
