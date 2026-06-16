import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invokeCommand } from "../utils/ipc";
import type { ConnectionEvent, GameState } from "../lib/types";

// Connection status as the UI understands it. The backend supervisor is the
// single source of truth and drives this via `connection_changed` events; the
// frontend no longer runs its own reconnect/health-check timers.
export type AppConnectionStatus =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'PAUSED'
  | 'WAITING_FOR_GAME';

interface GameStore {
  // Connection state (driven by backend events)
  status: AppConnectionStatus;
  region: string;
  gameState: GameState;

  // Map-based agent selection (persisted)
  autoLockAgent: string | null;
  mapAgentPreferences: Record<string, string>;
  pausedAutoLockAgent: string | null;

  // Whether the user paused match watching (persisted across restarts)
  pausedByUser: boolean;

  // Kept only so existing UI (WaitingState) keeps compiling; the frontend no
  // longer tracks reconnect attempts - the backend owns reconnection.
  reconnectAttempts: number;

  // Event-driven setters
  setGameState: (newState: GameState) => void;
  applyConnectionEvent: (ev: ConnectionEvent) => void;

  // User actions -> backend commands
  setAutoLock: (agent: string | null, map?: string) => void;
  getAgentForMap: (mapName: string) => string | null;
  toggleAutoLock: () => void;
  toggleMatchWatching: () => void;
  reconnect: (manual?: boolean) => void;
  checkGameProcess: () => void;

  // Startup: push persisted settings + pause intent to the (fresh) backend
  pushSettingsToBackend: () => void;

  // Computed helpers
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

// Map the backend connection status string to the UI status enum.
const mapBackendStatus = (s: string): AppConnectionStatus => {
  switch (s) {
    case "connected":
      return 'CONNECTED';
    case "connecting":
      return 'CONNECTING';
    case "paused":
      return 'PAUSED';
    case "waiting_for_game":
    default:
      return 'WAITING_FOR_GAME';
  }
};

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      // Initial state - the backend supervisor starts connecting on app launch.
      status: 'CONNECTING',
      region: "",
      gameState: initialGameState,
      autoLockAgent: null,
      mapAgentPreferences: {},
      pausedAutoLockAgent: null,
      pausedByUser: false,
      reconnectAttempts: 0,

      // Computed helpers
      isConnected: () => get().status === 'CONNECTED',
      isLoading: () => get().status === 'CONNECTING' || get().status === 'RECONNECTING',
      isPaused: () => get().status === 'PAUSED',
      isWaitingForGame: () => get().status === 'WAITING_FOR_GAME',

      // --- Event-driven setters (called from useGameLoop listeners) ---

      setGameState: (newState: GameState) => {
        set({ gameState: newState });
      },

      applyConnectionEvent: (ev: ConnectionEvent) => {
        const next = mapBackendStatus(ev.status);

        // Honor the user's pause intent: ignore any non-paused status until the
        // user explicitly resumes (prevents the backend racing us back online).
        if (get().pausedByUser && next !== 'PAUSED') return;

        set((s) => ({
          status: next,
          region: ev.region || s.region,
          // While not in an active, connected session there is no live match
          // data, so reset the view to avoid showing a stale pregame/ingame panel.
          gameState:
            next === 'WAITING_FOR_GAME' || next === 'PAUSED' ? initialGameState : s.gameState,
        }));
      },

      // --- Auto-lock agent selection ---

      getAgentForMap: (mapName: string) => {
        const { mapAgentPreferences, autoLockAgent } = get();
        return mapAgentPreferences[mapName] || autoLockAgent;
      },

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
          invokeCommand("set_map_preferences", { preferences: updated }).catch(console.error);
        } else {
          set({ autoLockAgent: agent });
          invokeCommand("set_auto_lock", { agent }).catch(console.error);
        }
      },

      // Master auto-lock toggle (pause/resume the configured agent).
      toggleAutoLock: () => {
        const { autoLockAgent, pausedAutoLockAgent, mapAgentPreferences } = get();
        if (autoLockAgent) {
          // Active -> paused
          set({ autoLockAgent: null, pausedAutoLockAgent: autoLockAgent });
          invokeCommand("set_auto_lock", { agent: null }).catch(console.error);
          invokeCommand("set_map_preferences", { preferences: {} }).catch(console.error);
        } else if (pausedAutoLockAgent) {
          // Paused -> active
          set({ autoLockAgent: pausedAutoLockAgent, pausedAutoLockAgent: null });
          invokeCommand("set_auto_lock", { agent: pausedAutoLockAgent }).catch(console.error);
          invokeCommand("set_map_preferences", { preferences: mapAgentPreferences }).catch(console.error);
        }
      },

      // --- Match watching (pause/resume the whole overlay) ---

      toggleMatchWatching: () => {
        const paused = get().status === 'PAUSED';
        if (paused) {
          // Resume
          set({ status: 'CONNECTING', pausedByUser: false });
          invokeCommand("resume_watching").catch(console.error);
        } else {
          // Pause
          set({ status: 'PAUSED', pausedByUser: true, gameState: initialGameState });
          invokeCommand("pause_watching").catch(console.error);
        }
      },

      // Manual reconnect button - asks the supervisor to re-init now.
      reconnect: () => {
        if (get().pausedByUser) return;
        set({ status: 'RECONNECTING' });
        invokeCommand("reconnect").catch(console.error);
      },

      // "Check for game" button while waiting - also a forced reconnect.
      checkGameProcess: () => {
        if (get().pausedByUser) return;
        invokeCommand("reconnect").catch(console.error);
      },

      // --- Startup sync ---

      pushSettingsToBackend: () => {
        const { autoLockAgent, pausedAutoLockAgent, mapAgentPreferences, pausedByUser } = get();
        console.log("Pushing settings to backend...", {
          autoLockAgent,
          pausedAutoLockAgent,
          mapCount: Object.keys(mapAgentPreferences).length,
          pausedByUser,
        });

        // Restore the user's match-watching pause intent (reflect it in the UI
        // immediately so we don't flash a "connecting" state before the backend
        // confirms the pause).
        if (pausedByUser) {
          set({ status: 'PAUSED' });
          invokeCommand("pause_watching").catch(console.error);
        }

        // Auto-lock master toggle is OFF (a paused agent is saved): keep backend clean.
        if (pausedAutoLockAgent) {
          invokeCommand("set_auto_lock", { agent: null }).catch(console.error);
          invokeCommand("set_map_preferences", { preferences: {} }).catch(console.error);
          return;
        }

        if (autoLockAgent) {
          invokeCommand("set_auto_lock", { agent: autoLockAgent }).catch(console.error);
        }
        // Map preferences only matter when a global agent is set (backend hierarchy).
        if (autoLockAgent && Object.keys(mapAgentPreferences).length > 0) {
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
        pausedByUser: state.pausedByUser,
      }),
    }
  )
);
