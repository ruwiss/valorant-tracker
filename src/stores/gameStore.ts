import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import { invokeCommand } from "../utils/ipc";
import type { ConnectionEvent, GameState } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { usePanelStore } from "./panelStore";
import { useLastMatchStore } from "./lastMatchStore";
import { usePlayerStatsStore } from "./playerStatsStore";

/** Ignore a stale "connected" emit that races a just-clicked reconnect. */
const RECONNECT_MIN_VISIBLE_MS = 600;
const RECONNECT_SAFETY_MS = 20_000;

let reconnectSafetyTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectMinTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconnectTimers() {
	if (reconnectSafetyTimer) {
		clearTimeout(reconnectSafetyTimer);
		reconnectSafetyTimer = null;
	}
	if (reconnectMinTimer) {
		clearTimeout(reconnectMinTimer);
		reconnectMinTimer = null;
	}
}

// Connection status as the UI understands it. The backend supervisor is the
// single source of truth and drives this via `connection_changed` events; the
// frontend no longer runs its own reconnect/health-check timers.
export type AppConnectionStatus =
	| "IDLE"
	| "CONNECTING"
	| "CONNECTED"
	| "RIOT_CONNECTED"
	| "RECONNECTING"
	| "PAUSED"
	| "WAITING_FOR_GAME";

interface GameStore {
	// Connection state (driven by backend events)
	status: AppConnectionStatus;
	region: string;
	/** Account puuid from Riot entitlements (available in riot-only chat mode). */
	selfPuuid: string;
	gameState: GameState;

	// Map-based agent selection (persisted)
	autoLockAgent: string | null;
	mapAgentPreferences: Record<string, string>;
	pausedAutoLockAgent: string | null;

	// Match-watching pause for this session (not persisted across launches).
	pausedByUser: boolean;
	/** Set when the 5‑min no-game timer paused us — auto-resume when Riot/game returns. */
	autoPausedNoGame: boolean;

	// Kept only so existing UI (WaitingState) keeps compiling; the frontend no
	// longer tracks reconnect attempts - the backend owns reconnection.
	reconnectAttempts: number;

	// Manual reconnect: stays true until the supervisor actually cycles
	// connecting → connected/waiting. Prevents an in-flight "connected" emit
	// from wiping the spinner the instant the user clicks.
	pendingReconnect: boolean;
	reconnectAcked: boolean;
	reconnectStartedAt: number;

	/** Live autolock countdown. Null when no sequence is running. */
	autolockCountdown: { running: boolean; remainingMs: number } | null;
	setAutolockCountdown: (ev: { running: boolean; remaining_ms: number }) => void;

	// Event-driven setters
	setGameState: (newState: GameState) => void;
	applyConnectionEvent: (ev: ConnectionEvent) => void;

	// User actions -> backend commands
	setAutoLock: (agent: string | null, map?: string) => void;
	getAgentForMap: (mapName: string) => string | null;
	toggleAutoLock: () => void;
	toggleMatchWatching: () => void;
	/** Pause from the no-game timer (chat stays usable; resume when host returns). */
	autoPauseNoGame: () => void;
	reconnect: (manual?: boolean) => void;
	checkGameProcess: () => void;

	// Startup: push persisted settings + pause intent to the (fresh) backend
	pushSettingsToBackend: () => void;

	// Computed helpers
	isConnected: () => boolean;
	/** Chat/friends: Riot Client tokens are enough (game optional). */
	isChatReady: () => boolean;
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
	ally_score: null,
	enemy_score: null,
};

// Map the backend connection status string to the UI status enum.
const mapBackendStatus = (s: string): AppConnectionStatus => {
	switch (s) {
		case "connected":
			return "CONNECTED";
		case "riot_connected":
			return "RIOT_CONNECTED";
		case "connecting":
			return "CONNECTING";
		case "paused":
			return "PAUSED";
		case "waiting_for_game":
		default:
			return "WAITING_FOR_GAME";
	}
};

export const useGameStore = create<GameStore>()(
	persist(
		(set, get) => ({
			// Initial state - the backend supervisor starts connecting on app launch.
			status: "CONNECTING",
			region: "",
			selfPuuid: "",
			gameState: initialGameState,
			autoLockAgent: null,
			mapAgentPreferences: {},
			pausedAutoLockAgent: null,
			pausedByUser: false,
			autoPausedNoGame: false,
			reconnectAttempts: 0,
			pendingReconnect: false,
			reconnectAcked: false,
			reconnectStartedAt: 0,
			autolockCountdown: null,

			setAutolockCountdown: (ev) =>
				set({
					autolockCountdown: ev.running
						? { running: true, remainingMs: ev.remaining_ms }
						: null,
				}),

			// Computed helpers
			isConnected: () => get().status === "CONNECTED",
			isChatReady: () => {
				const s = get().status;
				return s === "CONNECTED" || s === "RIOT_CONNECTED" || s === "PAUSED";
			},
			isLoading: () =>
				get().status === "CONNECTING" ||
				get().status === "RECONNECTING" ||
				get().pendingReconnect,
			isPaused: () => get().status === "PAUSED",
			isWaitingForGame: () => {
				const s = get().status;
				return s === "WAITING_FOR_GAME" || s === "RIOT_CONNECTED";
			},

			// --- Event-driven setters (called from useGameLoop listeners) ---

			setGameState: (newState: GameState) => {
				const prev = get().gameState;
				const prevState = prev.state;
				const wasLive = prevState === "pregame" || prevState === "ingame";
				const prevMap = (prev.map_name || "").toLowerCase();
				const prevLooksLikeRange =
					prevMap.includes("range") ||
					prevMap.includes("poligon") ||
					prevMap.includes("poveglia") ||
					(prevMap === "unknown" &&
						prev.enemies.length === 0 &&
						prev.allies.length <= 1);

				set((s) => {
					const live =
						s.gameState.state === "pregame" || s.gameState.state === "ingame";

					// Transient disconnect mid-match: keep the live panel. Backend
					// reconnects and re-emits shortly; wiping here is the classic
					// "stuck on Oyun Bekleniyor" flash.
					// Game actually gone (WAITING / RIOT_CONNECTED) or a range leftover: drop it.
					if (newState.state === "disconnected" && live) {
						const st = get().status;
						if (
							st === "WAITING_FOR_GAME" ||
							st === "RIOT_CONNECTED" ||
							prevLooksLikeRange
						) {
							return { gameState: initialGameState };
						}
						return s;
					}

					// Ignore idle while we are still (re)connecting — a false idle during
					// token refresh / pregame→ingame load must not clobber the panel.
					// WAITING / RIOT_CONNECTED means Valorant is not running: accept idle.
					if (newState.state === "idle" && live) {
						const st = get().status;
						if (st === "CONNECTING" || st === "RECONNECTING") {
							return s;
						}
					}

					return { gameState: newState };
				});

				if (prev.match_id !== get().gameState.match_id) {
					usePlayerStatsStore.getState().clearCache();
				}

				if (
					wasLive &&
					!prevLooksLikeRange &&
					newState.state === "idle" &&
					get().gameState.state === "idle"
				) {
					useLastMatchStore.getState().markPending();
				}

				// Keep open player panel rank/level in sync when MMR enrichment
				// fills enemy ranks on a later poll (selectedPlayer is a snapshot).
				const selected = usePanelStore.getState().selectedPlayer;
				if (!selected) return;
				const updated = [...newState.allies, ...newState.enemies].find(
					(p) => p.puuid === selected.puuid,
				);
				if (
					updated &&
					(updated.rank_tier !== selected.rank_tier ||
						updated.level !== selected.level ||
						updated.name !== selected.name ||
						updated.agent !== selected.agent)
				) {
					usePanelStore.setState({
						selectedPlayer: { ...selected, ...updated },
					});
				}
			},

			applyConnectionEvent: (ev: ConnectionEvent) => {
				const next = mapBackendStatus(ev.status);

				// Honor the user's pause intent: ignore any non-paused status until the
				// user explicitly resumes (prevents the backend racing us back online).
				if (get().pausedByUser && next !== "PAUSED") return;

				const pending = get().pendingReconnect;
				if (pending) {
					if (next === "CONNECTING") {
						set({
							status: "RECONNECTING",
							reconnectAcked: true,
							region: ev.region || get().region,
						});
						return;
					}

					// In-flight link from the poll that was already running
					// when the user clicked — ignore until we have seen "connecting".
					if (
						(next === "CONNECTED" || next === "RIOT_CONNECTED") &&
						!get().reconnectAcked
					) {
						return;
					}

					const applyTerminal = () => {
						clearReconnectTimers();
						const t = useI18n.getState().t;
						if (next === "CONNECTED" || next === "RIOT_CONNECTED") {
							toast.success(t("toast.reconnected"), { id: "reconnect" });
						} else if (next === "WAITING_FOR_GAME") {
							toast.error(t("toast.reconnectNoGame"), { id: "reconnect" });
						} else {
							toast.dismiss("reconnect");
						}
						set({ pendingReconnect: false, reconnectAcked: false });
						get().applyConnectionEvent(ev);
					};

					const elapsed = Date.now() - (get().reconnectStartedAt || 0);
					const wait = Math.max(0, RECONNECT_MIN_VISIBLE_MS - elapsed);
					if (wait > 0) {
						if (reconnectMinTimer) clearTimeout(reconnectMinTimer);
						reconnectMinTimer = setTimeout(applyTerminal, wait);
						return;
					}
					applyTerminal();
					return;
				}

				const prev = get().status;

				set((s) => ({
					status: next,
					region: ev.region || s.region,
					selfPuuid: ev.puuid?.trim() || s.selfPuuid,
					// Pause / riot-only: no live match. WAITING_FOR_GAME + a range
					// leftover also clears — a real live match stays on WAITING, because
					// mid-match token blips must not wipe the roster.
					gameState:
						next === "PAUSED" || next === "RIOT_CONNECTED"
							? initialGameState
							: next === "WAITING_FOR_GAME" &&
								  ((s.gameState.map_name || "").toLowerCase().includes("range") ||
										((s.gameState.map_name || "").toLowerCase() === "unknown" &&
											s.gameState.enemies.length === 0 &&
											s.gameState.allies.length <= 1))
								? initialGameState
								: s.gameState,
				}));

				// Reconnected after a blip / cold start / manual refresh: pull
				// game state so the panel does not stay stale (or on "Oyun
				// Bekleniyor" if the supervisor's re-emit was suppressed).
				if (
					next === "CONNECTED" &&
					prev !== "CONNECTED" &&
					!get().pausedByUser
				) {
					invokeCommand<GameState>("get_game_state", undefined, {
						suppressErrorToast: true,
					})
						.then((fresh) => {
							if (fresh) get().setGameState(fresh);
						})
						.catch(() => {});
					useLastMatchStore.getState().fetchLastMatch(true).catch(() => {});
				}
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
					invokeCommand("set_map_preferences", { preferences: updated }).catch(
						console.error,
					);
				} else {
					set({ autoLockAgent: agent });
					invokeCommand("set_auto_lock", { agent }).catch(console.error);
				}
			},

			// Master auto-lock toggle (pause/resume the configured agent).
			toggleAutoLock: () => {
				const { autoLockAgent, pausedAutoLockAgent, mapAgentPreferences } =
					get();
				if (autoLockAgent) {
					// Active -> paused
					set({ autoLockAgent: null, pausedAutoLockAgent: autoLockAgent });
					invokeCommand("set_auto_lock", { agent: null }).catch(console.error);
					invokeCommand("set_map_preferences", { preferences: {} }).catch(
						console.error,
					);
				} else if (pausedAutoLockAgent) {
					// Paused -> active
					set({
						autoLockAgent: pausedAutoLockAgent,
						pausedAutoLockAgent: null,
					});
					invokeCommand("set_auto_lock", { agent: pausedAutoLockAgent }).catch(
						console.error,
					);
					invokeCommand("set_map_preferences", {
						preferences: mapAgentPreferences,
					}).catch(console.error);
				}
			},

			// --- Match watching (pause/resume the whole overlay) ---

			toggleMatchWatching: () => {
				const paused = get().status === "PAUSED";
				if (paused) {
					// Resume
					set({
						status: "CONNECTING",
						pausedByUser: false,
						autoPausedNoGame: false,
					});
					invokeCommand("resume_watching").catch(console.error);
				} else {
					// Manual pause — stay paused until the user hits play.
					clearReconnectTimers();
					toast.dismiss("reconnect");
					set({
						status: "PAUSED",
						pausedByUser: true,
						autoPausedNoGame: false,
						pendingReconnect: false,
						reconnectAcked: false,
						gameState: initialGameState,
					});
					invokeCommand("pause_watching").catch(console.error);
				}
			},

			autoPauseNoGame: () => {
				if (get().status === "PAUSED") return;
				clearReconnectTimers();
				toast.dismiss("reconnect");
				set({
					status: "PAUSED",
					pausedByUser: true,
					autoPausedNoGame: true,
					pendingReconnect: false,
					reconnectAcked: false,
					gameState: initialGameState,
				});
				invokeCommand("pause_watching").catch(console.error);
			},

			// Manual reconnect button - asks the supervisor to re-init now.
			reconnect: () => {
				if (get().pausedByUser) return;
				if (get().pendingReconnect) return;

				clearReconnectTimers();
				const t = useI18n.getState().t;
				set({
					status: "RECONNECTING",
					pendingReconnect: true,
					reconnectAcked: false,
					reconnectStartedAt: Date.now(),
				});
				toast.loading(t("toast.reconnecting"), { id: "reconnect" });

				reconnectSafetyTimer = setTimeout(() => {
					if (!get().pendingReconnect) return;
					clearReconnectTimers();
					set({
						pendingReconnect: false,
						reconnectAcked: false,
						status: "CONNECTING",
					});
					toast.error(t("toast.reconnectFailed"), { id: "reconnect" });
				}, RECONNECT_SAFETY_MS);

				invokeCommand("reconnect").catch((err) => {
					console.error(err);
					clearReconnectTimers();
					set({ pendingReconnect: false, reconnectAcked: false });
					toast.error(t("toast.reconnectFailed"), { id: "reconnect" });
				});
			},

			// "Check for game" button while waiting - same forced reconnect path.
			checkGameProcess: () => {
				get().reconnect();
			},

			// --- Startup sync ---

			pushSettingsToBackend: () => {
				const {
					autoLockAgent,
					pausedAutoLockAgent,
					mapAgentPreferences,
				} = get();

				// Pause is session-only — never restore "duraklatıldı" across launches
				// (auto-pause / last session used to stick and open the app paused).
				if (get().pausedByUser || get().autoPausedNoGame) {
					set({ pausedByUser: false, autoPausedNoGame: false });
				}

				console.log("Pushing settings to backend...", {
					autoLockAgent,
					pausedAutoLockAgent,
					mapCount: Object.keys(mapAgentPreferences).length,
				});

				// Auto-lock master toggle is OFF (a paused agent is saved): keep backend clean.
				if (pausedAutoLockAgent) {
					invokeCommand("set_auto_lock", { agent: null }).catch(console.error);
					invokeCommand("set_map_preferences", { preferences: {} }).catch(
						console.error,
					);
					return;
				}

				if (autoLockAgent) {
					invokeCommand("set_auto_lock", { agent: autoLockAgent }).catch(
						console.error,
					);
				}
				// Map preferences only matter when a global agent is set (backend hierarchy).
				if (autoLockAgent && Object.keys(mapAgentPreferences).length > 0) {
					invokeCommand("set_map_preferences", {
						preferences: mapAgentPreferences,
					}).catch(console.error);
				}
			},
		}),
		{
			name: "valorant-tracker-game",
			partialize: (state) => ({
				autoLockAgent: state.autoLockAgent,
				mapAgentPreferences: state.mapAgentPreferences,
				pausedAutoLockAgent: state.pausedAutoLockAgent,
			}),
			// Drop stale pause flags from older builds still sitting in localStorage.
			merge: (persisted, current) => {
				const p = (persisted ?? {}) as Partial<GameStore>;
				const { pausedByUser: _p, autoPausedNoGame: _a, ...rest } = p;
				return {
					...current,
					...rest,
					pausedByUser: false,
					autoPausedNoGame: false,
				};
			},
		},
	),
);
