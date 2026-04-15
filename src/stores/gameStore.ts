import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invokeCommand } from "../utils/ipc";
import type { ConnectionStatus as ApiConnectionStatus, GameState } from "../lib/types";
import { usePlayerStatsStore } from "./playerStatsStore";
import { usePanelStore } from "./panelStore";

// State machine for connection status - replaces multiple boolean flags
export type AppConnectionStatus =
  | 'IDLE'              // App started, no connection attempt yet
  | 'CONNECTING'        // Initial connection attempt
  | 'CONNECTED'         // Connected and active
  | 'RECONNECTING'      // Connection lost, attempting to reconnect
  | 'PAUSED'            // User paused match watching
  | 'WAITING_FOR_GAME'; // Game not detected, waiting for launch

interface GameStore {
  // Connection state machine
  status: AppConnectionStatus;
  region: string;
  gameState: GameState;

  // Map-based agent selection
  autoLockAgent: string | null;
  mapAgentPreferences: Record<string, string>;
  pausedAutoLockAgent: string | null;

  // Connection metrics
  consecutiveErrors: number;
  reconnectAttempts: number;
  lastSuccessfulFetch: number;
  reconnectStartTime: number;

  // Actions
  initialize: (force?: boolean) => Promise<void>;
  fetchGameState: () => Promise<void>;
  reconnect: (manual?: boolean) => Promise<void>;
  healthCheck: () => Promise<boolean>;
  setAutoLock: (agent: string | null, map?: string) => void;
  getAgentForMap: (mapName: string) => string | null;
  toggleAutoLock: () => void;
  toggleMatchWatching: () => void;
  resetConnectionState: () => void;
  forceResetConnection: () => void;
  restoreBackendState: () => void;
  silentRefresh: () => Promise<void>;
  checkGameProcess: () => Promise<void>;

  // Computed helpers (for backward compatibility)
  isConnected: () => boolean;
  isLoading: () => boolean;
  isPaused: () => boolean;
  isWaitingForGame: () => boolean;
}

const initialGameState: GameState = {
  state: "idle",
  match_id: null,
  map_name: null,
  mode_name: null,
  side: null,
  allies: [],
  enemies: [],
};

// Connection configuration
const INSTANT_RETRY_THRESHOLD = 1;
const BASE_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 10000;
const HEALTH_CHECK_INTERVAL = 30000;
const STALE_CONNECTION_THRESHOLD = 45000; // Increased to allow StateGuard (15s) to finish its check
const MAX_RECONNECT_DURATION = 30000;

// Game detection configuration - throttled retry when game is not running
const GAME_CHECK_INTERVAL = 5000;       // Check for game every 5 seconds when waiting
const GAME_NOT_FOUND_RETRY_DELAY = 10000; // Wait 10 seconds before retry when game not found

// Race condition guard - prevents older fetch responses from overwriting newer data
let fetchSequence = 0;

const getRetryDelay = (attempt: number): number => {
  if (attempt <= INSTANT_RETRY_THRESHOLD) return 500; // Increased from 100ms to allow backend to catch up
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(1.3, attempt - 1), MAX_RETRY_DELAY);
  return delay + Math.random() * 500;
};

// Track game check timer to prevent multiple timers
let gameCheckTimer: ReturnType<typeof setTimeout> | null = null;

// Helper to detect if error indicates game is not running
const isGameNotRunningError = (error: unknown): boolean => {
  if (typeof error === 'string') {
    const lowerError = error.toLowerCase();
    return lowerError.includes('404') ||
           lowerError.includes('not found') ||
           lowerError.includes('connection refused') ||
           lowerError.includes('lockfile') ||
           lowerError.includes('no riot client') ||
           lowerError.includes('game not running') ||
           lowerError.includes('failed to connect');
  }
  return false;
};

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      // Initial state - Start in WAITING_FOR_GAME to avoid immediate retry loops
      status: 'WAITING_FOR_GAME',
      region: "",
      gameState: initialGameState,
      autoLockAgent: null,
      mapAgentPreferences: {},
      pausedAutoLockAgent: null,
      consecutiveErrors: 0,
      reconnectAttempts: 0,
      lastSuccessfulFetch: 0,
      reconnectStartTime: 0,

      // Computed helpers
      isConnected: () => get().status === 'CONNECTED',
      isLoading: () => get().status === 'CONNECTING' || get().status === 'RECONNECTING',
      isPaused: () => get().status === 'PAUSED',
      isWaitingForGame: () => get().status === 'WAITING_FOR_GAME',

      // Get agent for specific map (map-specific has priority over global)
      getAgentForMap: (mapName: string) => {
        const { mapAgentPreferences, autoLockAgent } = get();
        return mapAgentPreferences[mapName] || autoLockAgent;
      },

      // Set auto-lock agent (global or map-specific)
      setAutoLock: (agent: string | null, map?: string) => {
        if (map) {
          const { mapAgentPreferences } = get();
          const updated = { ...mapAgentPreferences };
          if (agent === null) {
            delete updated[map];
          } else {
            updated[map] = agent;
          }
          set({ mapAgentPreferences: updated });
          // Sync to backend immediately
          invokeCommand("set_map_preferences", { preferences: updated }).catch(console.error);
        } else {
          set({ autoLockAgent: agent });
          invokeCommand("set_auto_lock", { agent }).catch(console.error);
        }
      },

      toggleMatchWatching: () => {
        const { status } = get();
        const shouldPause = status !== 'PAUSED';
        console.log(shouldPause ? "Pausing match watching..." : "Resuming match watching...");

        if (shouldPause) {
          // Reset error counters to prevent pending reconnects from triggering
          set({ status: 'PAUSED', consecutiveErrors: 0, reconnectAttempts: 0 });
        } else {
          set({ status: 'CONNECTED' });
          get().fetchGameState();
        }
      },

      resetConnectionState: () => {
        set({
          consecutiveErrors: 0,
          reconnectAttempts: 0,
          reconnectStartTime: 0,
        });
      },

      forceResetConnection: () => {
        console.log("Force resetting all connection state");
        set({
          status: 'IDLE',
          gameState: initialGameState,
          consecutiveErrors: 0,
          reconnectAttempts: 0,
          lastSuccessfulFetch: 0,
          reconnectStartTime: 0,
        });
      },

      restoreBackendState: () => {
         const { autoLockAgent, pausedAutoLockAgent, mapAgentPreferences } = get();
         console.log("Restoring backend state...", { autoLockAgent, pausedAutoLockAgent, mapCount: Object.keys(mapAgentPreferences).length });

         // Only restore autolock settings if NOT paused (master toggle is ON)
         // When paused, we intentionally don't send anything to backend to keep it disabled
         if (pausedAutoLockAgent) {
           // Autolock is paused (master toggle OFF) - ensure backend has no autolock settings
           invokeCommand("set_auto_lock", { agent: null }).catch(console.error);
           invokeCommand("set_map_preferences", { preferences: {} }).catch(console.error);
           return;
         }

         if (autoLockAgent) {
           invokeCommand("set_auto_lock", { agent: autoLockAgent }).catch(console.error);
         }
         // Only send map preferences if global autolock is enabled
         // This ensures map-based locking respects the master toggle hierarchy
         if (autoLockAgent && Object.keys(mapAgentPreferences).length > 0) {
           invokeCommand("set_map_preferences", { preferences: mapAgentPreferences }).catch(console.error);
         }
      },

      // Check for game process and start connection when found
      checkGameProcess: async () => {
        const { status } = get();
        
        // Only check if we're waiting for game
        if (status !== 'WAITING_FOR_GAME') return;
        
        // Clear any existing timer
        if (gameCheckTimer) {
          clearTimeout(gameCheckTimer);
          gameCheckTimer = null;
        }
        
        try {
          // Try to initialize - this will detect if game is running
          const apiStatus = await invokeCommand<ApiConnectionStatus>("initialize", undefined, { suppressErrorToast: true });
          
          if (apiStatus) {
            // Game found! Transition to connected
            console.log("[GameCheck] Game detected, connecting...");
            set({
              status: 'CONNECTED',
              region: apiStatus.region,
              consecutiveErrors: 0,
              reconnectAttempts: 0,
              lastSuccessfulFetch: Date.now(),
            });
            get().restoreBackendState();
          } else {
            throw new Error("Init returned null");
          }
        } catch (error) {
          // Game not running - schedule next check with throttled delay
          if (isGameNotRunningError(error)) {
            console.log("[GameCheck] Oyun tespit edilmedi, bekliyor...");
          } else {
            console.log("[GameCheck] Bağlantı hatası, tekrar denenecek...");
          }
          
          // Schedule next check - throttled to prevent spam
          gameCheckTimer = setTimeout(() => {
            const currentStatus = get().status;
            if (currentStatus === 'WAITING_FOR_GAME') {
              get().checkGameProcess();
            }
          }, GAME_CHECK_INTERVAL);
        }
      },

      healthCheck: async () => {
        const { lastSuccessfulFetch, status } = get();

        if (status === 'RECONNECTING' || status === 'CONNECTING' || status === 'PAUSED' || status === 'WAITING_FOR_GAME') {
          return false; // Not connected yet or paused by user or waiting for game
        }

        const now = Date.now();
        const timeSinceLastSuccess = now - lastSuccessfulFetch;

        if (status === 'CONNECTED' && timeSinceLastSuccess > STALE_CONNECTION_THRESHOLD) {
          console.log("Connection seems stale, triggering health check reconnect...");
          get().reconnect();
          return false;
        }

        return status === 'CONNECTED';
      },

      initialize: async (force = false) => {
        const { status } = get();

        // Respect user's pause - never auto-init when paused
        if (status === 'PAUSED') return;
        
        // If waiting for game, use the throttled game check instead
        if (status === 'WAITING_FOR_GAME' && !force) {
          get().checkGameProcess();
          return;
        }

        // Don't re-initialize if already connecting/reconnecting (unless forced)
        if (!force && (status === 'CONNECTING' || status === 'RECONNECTING')) return;

        // If forced, we might already be in RECONNECTING state, so keep it
        if (!force) {
            set({ status: status === 'IDLE' || status === 'WAITING_FOR_GAME' ? 'CONNECTING' : 'RECONNECTING' });
        }

        try {
          // Suppress error toast for initialize as we handle retries internally
          const apiStatus = await invokeCommand<ApiConnectionStatus>("initialize", undefined, { suppressErrorToast: true });
          if (!apiStatus) throw new Error("Init failed");

          set({
            status: 'CONNECTED',
            region: apiStatus.region,
            consecutiveErrors: 0,
            reconnectAttempts: 0,
            lastSuccessfulFetch: Date.now(),
          });

          // Restore backend state
          get().restoreBackendState();

        } catch (error) {
          const currentStatus = get().status;

          // If user paused during connection attempt, respect it
          if (currentStatus === 'PAUSED') {
            console.log("Connection attempt finished but user paused. Stopping retries.");
            return;
          }

          // Check if this is a "game not running" error
          if (isGameNotRunningError(error)) {
            console.log("[Initialize] Oyun çalışmıyor, bekleme moduna geçiliyor...");
            set({
              status: 'WAITING_FOR_GAME',
              consecutiveErrors: 0,
              reconnectAttempts: 0,
            });
            
            // Start throttled game checking
            gameCheckTimer = setTimeout(() => {
              get().checkGameProcess();
            }, GAME_NOT_FOUND_RETRY_DELAY);
            return;
          }

          const attempts = get().reconnectAttempts + 1;
          const delay = getRetryDelay(attempts);

          console.log(`Connection failed (attempt ${attempts}), retrying in ${Math.round(delay)}ms...`);

          set({
            status: 'IDLE',
            reconnectAttempts: attempts,
          });

          // Limit retry attempts to prevent infinite loops
          if (attempts >= 10) {
            console.log("[Initialize] Çok fazla başarısız deneme, bekleme moduna geçiliyor...");
            set({ status: 'WAITING_FOR_GAME', reconnectAttempts: 0 });
            gameCheckTimer = setTimeout(() => {
              get().checkGameProcess();
            }, GAME_NOT_FOUND_RETRY_DELAY);
            return;
          }

          // Retry with exponential backoff
          setTimeout(() => {
            const state = get();
            // Only retry if IDLE and not paused by user
            if (state.status === 'IDLE') {
              get().initialize();
            }
            // If PAUSED or WAITING_FOR_GAME, don't auto-retry here
          }, delay);
        }
      },

      reconnect: async (manual = false) => {
        const { status, reconnectStartTime } = get();

        // Check if stuck in reconnecting for too long
        if (status === 'RECONNECTING' && reconnectStartTime > 0) {
          const stuckDuration = Date.now() - reconnectStartTime;
          if (stuckDuration > MAX_RECONNECT_DURATION) {
            console.warn("Reconnection stuck for too long, forcing reset to waiting state");
            set({
              status: 'WAITING_FOR_GAME',
              consecutiveErrors: 0,
              reconnectAttempts: 0,
              reconnectStartTime: 0
            });
            // Start throttled game checking
            gameCheckTimer = setTimeout(() => {
              get().checkGameProcess();
            }, GAME_NOT_FOUND_RETRY_DELAY);
            return;
          }
        }

        // Manual reconnect always forces
        if (manual) {
          console.log("Manual reconnect requested");
          set({
            status: 'RECONNECTING',
            gameState: initialGameState,
            consecutiveErrors: 0,
            reconnectAttempts: 0,
            reconnectStartTime: Date.now(),
          });

          try {
            await get().initialize(true); // Force initialize
            if (get().status === 'CONNECTED') {
              get().restoreBackendState();
              await get().fetchGameState();
            }
          } catch (error) {
            console.error("Manual reconnect failed:", error);
            // Check if game not running
            if (isGameNotRunningError(error)) {
              set({ status: 'WAITING_FOR_GAME', reconnectStartTime: 0 });
              gameCheckTimer = setTimeout(() => {
                get().checkGameProcess();
              }, GAME_NOT_FOUND_RETRY_DELAY);
              return;
            }
          } finally {
            // Only change status if not paused by user during async operation
            const currentStatus = get().status;
            if (currentStatus === 'RECONNECTING') {
              set({ status: 'IDLE', reconnectStartTime: 0 });
            }
          }
          return;
        }

        // Skip if already reconnecting, paused, or waiting for game
        if (status === 'RECONNECTING' || status === 'PAUSED' || status === 'WAITING_FOR_GAME') return;

        // Quick re-init if already connected
        if (status === 'CONNECTED') {
          set({ status: 'RECONNECTING', reconnectStartTime: Date.now() });
          try {
            await get().initialize(true); // Force initialize
          } catch (error) {
            if (isGameNotRunningError(error)) {
              set({ status: 'WAITING_FOR_GAME', reconnectStartTime: 0 });
              gameCheckTimer = setTimeout(() => {
                get().checkGameProcess();
              }, GAME_NOT_FOUND_RETRY_DELAY);
              return;
            }
          } finally {
            // Only change status if not paused by user during async operation
            const currentStatus = get().status;
            if (currentStatus === 'RECONNECTING') {
              set({ status: 'CONNECTED', reconnectStartTime: 0 });
            }
          }
          return;
        }

        set({
          status: 'RECONNECTING',
          gameState: initialGameState,
          consecutiveErrors: 0,
          reconnectStartTime: Date.now(),
        });

        try {
          await get().initialize(true); // Force initialize
          if (get().status === 'CONNECTED') {
            get().restoreBackendState();
            await get().fetchGameState();
          }
        } catch (error) {
          console.error("Auto reconnect failed:", error);
          if (isGameNotRunningError(error)) {
            set({ status: 'WAITING_FOR_GAME', reconnectStartTime: 0 });
            gameCheckTimer = setTimeout(() => {
              get().checkGameProcess();
            }, GAME_NOT_FOUND_RETRY_DELAY);
            return;
          }
        } finally {
          // Only change status if not paused by user during async operation
          const currentStatus = get().status;
          if (currentStatus === 'RECONNECTING') {
            set({ status: 'IDLE', reconnectStartTime: 0 });
          }
        }
      },

      fetchGameState: async () => {
        const { status, autoLockAgent, pausedAutoLockAgent } = get();

        // Skip fetch if paused (unless auto-lock is active)
        const hasAutoLock = autoLockAgent || pausedAutoLockAgent;
        if (status === 'PAUSED' && !hasAutoLock) return;

        // Skip during connection attempts or when waiting for game
        if (status === 'RECONNECTING' || status === 'CONNECTING' || status === 'WAITING_FOR_GAME') return;

        // Trigger reconnect if not connected
        if (status !== 'CONNECTED' && status !== 'PAUSED') {
          get().reconnect();
          return;
        }

        // Race condition guard: capture current sequence before async call
        // This prevents older responses from overwriting newer state
        const currentSequence = ++fetchSequence;

        try {
          // Suppress error toast for frequent polling
          const state = await invokeCommand<GameState>("get_game_state", undefined, { suppressErrorToast: true });
          
          // Race condition check: if a newer fetch started, discard this result
          if (currentSequence !== fetchSequence) {
            console.log(`[fetchGameState] Discarding stale response (seq ${currentSequence} < ${fetchSequence})`);
            return;
          }
          
          if (!state) throw new Error("Fetch failed");

          // CRITICAL: Always update fetch time on success to prevent health check from triggering
          set({ lastSuccessfulFetch: Date.now() });

          // Check if disconnected state returned
          if (state.state === "disconnected") {
            const errors = get().consecutiveErrors + 1;
            set({ consecutiveErrors: errors });

            // Don't auto-reconnect if user explicitly paused
            if (get().status === 'PAUSED') {
              return;
            }

            if (errors >= 3) {
              console.log("Disconnected state received multiple times, reconnecting...");
              set({ status: 'IDLE' });
              // Add a small delay to break potential tight loops
              setTimeout(() => {
                 // Double-check PAUSED wasn't set during the delay
                 if (get().status !== 'PAUSED') {
                   get().reconnect();
                 }
              }, 1000);
            }
            return;
          }

          // SUCCESS: Reset errors (but don't change status if PAUSED)
          const currentStatus = get().status;
          set({
            consecutiveErrors: 0,
            status: currentStatus === 'PAUSED' ? 'PAUSED' : 'CONNECTED',
            reconnectAttempts: 0
          });

          // If paused, just ensure connectivity is maintained
          if (status === 'PAUSED') {
            return;
          }

          const currentState = get().gameState.state;

          // Map-aware auto-lock
          // Map-aware auto-lock logic is now handled in the backend (Rust)
          // via set_map_preferences to avoid race conditions and global state pollution.
          if (state.state === "pregame" && state.map_name) {
             const previousMatchId = get().gameState.match_id;
             const isNewMatch = previousMatchId !== state.match_id;
             if (isNewMatch) {
                 console.log(`[AutoLock] New pregame on ${state.map_name} (Handled by backend worker)`);
             }
          }

          // Handle transition to idle (Game End / Dodge) - No waiting
          if ((currentState === "ingame" || currentState === "pregame") && state.state === "idle") {
            console.log(`[Transition] ${currentState} -> idle. Cleaning up...`);
            usePlayerStatsStore.getState().clearCache();
            usePanelStore.getState().close();
          }

          // Success (preserve PAUSED status if set)
          const finalStatus = get().status;
          set({
            gameState: state,
            consecutiveErrors: 0,
            status: finalStatus === 'PAUSED' ? 'PAUSED' : 'CONNECTED',
            lastSuccessfulFetch: Date.now(),
            reconnectAttempts: 0,
          });
        } catch (error) {
          const errors = get().consecutiveErrors + 1;
          set({ consecutiveErrors: errors });

          console.log(`Fetch error (${errors}):`, error);

          // Don't auto-reconnect if user explicitly paused
          if (get().status === 'PAUSED') {
            return;
          }

          // Check if this indicates game is not running
          if (isGameNotRunningError(error)) {
            console.log("[FetchGameState] Oyun kapanmış olabilir, bekleme moduna geçiliyor...");
            set({
              status: 'WAITING_FOR_GAME',
              consecutiveErrors: 0,
              gameState: initialGameState
            });
            // Start throttled game checking
            gameCheckTimer = setTimeout(() => {
              get().checkGameProcess();
            }, GAME_NOT_FOUND_RETRY_DELAY);
            return;
          }

          // If we have consecutive errors, it likely means the port changed or client closed
          if (errors >= 5) {
             const currentState = get().gameState.state;
             const isInGame = currentState === 'ingame' || currentState === 'pregame';

             if (isInGame) {
                console.log("Multiple fetch errors during game. Persistent reconnecting...", errors);
                // Don't go IDLE, stay in RECONNECTING/CONNECTED but force re-init
                // We want to keep the "Game" UI visible, just show a warning
                set({ status: 'RECONNECTING' });

                // Retry in 2-3 seconds (as requested)
                setTimeout(() => {
                   const currentStatus = get().status;
                   if (currentStatus !== 'PAUSED' && currentStatus !== 'WAITING_FOR_GAME') {
                     get().reconnect(true);
                   }
                }, 2500);
             } else {
                console.log("Multiple fetch errors, checking game status...");
                // Transition to waiting for game instead of aggressive retry
                set({
                  status: 'WAITING_FOR_GAME',
                  consecutiveErrors: 0,
                  gameState: initialGameState
                });
                
                gameCheckTimer = setTimeout(() => {
                  get().checkGameProcess();
                }, GAME_NOT_FOUND_RETRY_DELAY);
             }
          } else {
             // First few errors, just try soft reconnect or wait
             console.log("Fetch error, waiting/soft reconnect...");
             if (errors >= 2 && get().status !== 'PAUSED') {
                get().reconnect();
             }
          }
        }
      },

      silentRefresh: async () => {
        const { status } = get();
        
        // Skip only if user explicitly paused - allow refresh in all other states
        // This enables token recovery even when disconnected or in transitional states
        if (status === 'PAUSED') {
          console.log("[SilentRefresh] Skipped - user paused");
          return;
        }

        console.log("[SilentRefresh] Triggering seamless background refresh (status:", status, ")...");
        try {
          // Re-initialize without changing status to RECONNECTING
          // This silently refreshes the connection tokens and can recover from disconnected state
          const apiStatus = await invokeCommand<ApiConnectionStatus>("initialize", undefined, { suppressErrorToast: true });
          if (apiStatus) {
            // Update region and mark as connected if successful
            set({
              status: 'CONNECTED',
              region: apiStatus.region,
              lastSuccessfulFetch: Date.now(),
              consecutiveErrors: 0,
            });
          }
          
          // Immediately follow up with a game state fetch to refresh player data
          // This uses the existing fetchGameState which already handles race conditions
          await get().fetchGameState();
          
          console.log("[SilentRefresh] Seamless update completed");
        } catch (error) {
          // Silently fail - don't disrupt the user
          console.error("[SilentRefresh] Failed (silent):", error);
        }
      },

      toggleAutoLock: () => {
        const { autoLockAgent, pausedAutoLockAgent, mapAgentPreferences } = get();
        if (autoLockAgent || (autoLockAgent === null && pausedAutoLockAgent === null && Object.keys(mapAgentPreferences).length > 0)) {
           // Case 1: Active -> Paused
           // We treat it as paused if there is an active global agent OR active map preferences
           // (If everything is null/empty, toggle does nothing or maybe just sets a flag, but here we assume mostly standard usage)

           // If we have an agent, save it. If not, save a placeholder or handle null?
           // actually pausedAutoLockAgent expects a string.
           // If autoLockAgent is null but we have map prefs, we might need a way to say "Paused".
           // But existing logic assumes autoLockAgent is truthy to pause.

           if (autoLockAgent) {
             set({ autoLockAgent: null, pausedAutoLockAgent: autoLockAgent });
             invokeCommand("set_auto_lock", { agent: null }).catch(console.error);
             // Clear backend map prefs to stop map locking
             invokeCommand("set_map_preferences", { preferences: {} }).catch(console.error);
           }
        } else if (pausedAutoLockAgent) {
          // Case 2: Paused -> Active
          set({ autoLockAgent: pausedAutoLockAgent, pausedAutoLockAgent: null });
          invokeCommand("set_auto_lock", { agent: pausedAutoLockAgent }).catch(console.error);
          // Restore backend map prefs
          invokeCommand("set_map_preferences", { preferences: mapAgentPreferences }).catch(console.error);
        }
      },
    }),
    {
      name: "valorant-tracker-game",
      partialize: (state) => ({
        autoLockAgent: state.autoLockAgent,
        mapAgentPreferences: state.mapAgentPreferences,
        pausedAutoLockAgent: state.pausedAutoLockAgent,
        // Persist pause state, otherwise start in WAITING_FOR_GAME
        status: state.status === 'PAUSED' ? 'PAUSED' : 'WAITING_FOR_GAME',
      }),
    }
  )
);

// Global listeners
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const state = useGameStore.getState();
      if (state.status === 'CONNECTED') {
        console.log("App visible, checking connection health...");
        state.healthCheck();
      } else if (state.status === 'WAITING_FOR_GAME') {
        // Trigger a game check when app becomes visible
        console.log("App visible, checking for game...");
        state.checkGameProcess();
      }
    }
  });

  setInterval(() => {
    const state = useGameStore.getState();
    if (state.status === 'CONNECTED') {
      state.healthCheck();
    }
  }, HEALTH_CHECK_INTERVAL);
}
