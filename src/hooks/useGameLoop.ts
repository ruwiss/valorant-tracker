import { useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useGameStore } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAssetsStore } from "../stores/assetsStore";

// Polling interval configuration
const POLL_INTERVAL_CONNECTED = 1000;
const POLL_INTERVAL_DISCONNECTED = 2000;
const POLL_INTERVAL_INGAME = 1000;
const POLL_INTERVAL_RECONNECTING = 3000;
const POLL_INTERVAL_WAITING_FOR_GAME = 5000; // Throttled polling when waiting for game
const MAX_RECONNECT_DURATION = 30000;
const SILENT_REFRESH_INTERVAL = 100000; // 100 seconds - seamless background data refresh

/**
 * Central game loop hook that manages:
 * - Adaptive polling based on connection and game state
 * - Watchdog for stuck reconnection detection
 * - Window focus listener for health checks
 * - License expiration monitoring
 */
export function useGameLoop() {
  const { initialize, fetchGameState, gameState, status, isConnected, isLoading, isWaitingForGame, checkGameProcess } = useGameStore();
  const { registerHotkey, restoreWindowPosition, saveCurrentPosition } = useSettingsStore();
  const { loadAssets } = useAssetsStore();

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const positionInitialized = useRef(false);

  // Determine optimal poll interval based on state
  const getPollInterval = useCallback(() => {
    // When waiting for game, use throttled interval
    if (isWaitingForGame()) return POLL_INTERVAL_WAITING_FOR_GAME;
    if (!isConnected()) return POLL_INTERVAL_DISCONNECTED;
    if (gameState.state === "ingame" || gameState.state === "pregame") {
      return POLL_INTERVAL_INGAME;
    }
    return POLL_INTERVAL_CONNECTED;
  }, [isConnected, isWaitingForGame, gameState.state]);

  // Start adaptive polling
  const startPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    const pollInterval = getPollInterval();
    intervalRef.current = setInterval(() => {
      const state = useGameStore.getState();

      // Skip polling if reconnecting or connecting
      if (state.status === "RECONNECTING" || state.status === "CONNECTING") return;

      // If waiting for game, use checkGameProcess instead of fetchGameState
      if (state.status === "WAITING_FOR_GAME") {
        // checkGameProcess handles its own throttling, but we still call it periodically
        state.checkGameProcess();
        return;
      }

      // If PAUSED, only poll if autolock is active (autolock needs fetchGameState)
      const hasAutoLock = state.autoLockAgent || state.pausedAutoLockAgent || Object.keys(state.mapAgentPreferences).length > 0;
      if (state.status === "PAUSED" && !hasAutoLock) return;

      fetchGameState();
    }, pollInterval);
  }, [getPollInterval, fetchGameState]);

  // Startup tasks
  useEffect(() => {
    useSettingsStore.getState().fetchContactInfo();
  }, []);

  const isInitialized = useRef(false);

  // Initial setup
  useEffect(() => {
    if (isInitialized.current) return;

    isInitialized.current = true;

    // Start with checkGameProcess instead of initialize to avoid immediate retry loops
    // This will detect if the game is running and connect, or wait if not
    const state = useGameStore.getState();
    if (state.status === 'WAITING_FOR_GAME') {
      console.log("[GameLoop] Starting in WAITING_FOR_GAME state, checking for game...");
      checkGameProcess();
    } else if (state.status !== 'PAUSED') {
      initialize();
    }

    loadAssets();

    // Setup hotkey
    const setupHotkey = async () => {
      try {
        await registerHotkey();
      } catch (e) {
        console.error("Hotkey registration failed", e);
      }
    };
    setupHotkey();

    // Restore window position
    if (!positionInitialized.current) {
      positionInitialized.current = true;
      restoreWindowPosition();
    }

    // Window move listener
    let unlisten: (() => void) | null = null;
    const setupMoveListener = async () => {
      const win = getCurrentWindow();
      unlisten = await win.onMoved(() => {
        saveCurrentPosition();
      });
    };
    setupMoveListener();

    // Window focus listener for health checks
    let unlistenFocus: (() => void) | null = null;
    const setupFocusListener = async () => {
      const win = getCurrentWindow();
      unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          console.log("Window focused, checking connection...");
          useSettingsStore.setState({ isWindowVisible: true });

          const state = useGameStore.getState();
          if (state.status !== "RECONNECTING" && state.status !== "CONNECTING") {
            state.healthCheck();
          }
        }
      });
    };
    setupFocusListener();

    // Listen for show-overlay event from another instance trying to start
    let unlistenShowOverlay: (() => void) | null = null;
    const setupShowOverlayListener = async () => {
      unlistenShowOverlay = await listen("show-overlay", async () => {
        console.log("Received show-overlay signal from another instance");
        const win = getCurrentWindow();
        const isVisible = await win.isVisible();
        if (!isVisible) {
          await win.show();
        }
        await win.setFocus();
        useSettingsStore.setState({ isWindowVisible: true });
      });
    };
    setupShowOverlayListener();

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (unlisten) unlisten();
      if (unlistenFocus) unlistenFocus();
      if (unlistenShowOverlay) unlistenShowOverlay();
    };
  }, [initialize, loadAssets, registerHotkey, restoreWindowPosition, saveCurrentPosition, checkGameProcess]);

  // Watchdog for stuck reconnection
  useEffect(() => {
    const watchdog = setInterval(() => {
      const state = useGameStore.getState();
      // Don't interfere if user paused or waiting for game (which has its own throttling)
      if (state.status === "PAUSED" || state.status === "WAITING_FOR_GAME") return;

      if (state.status === "RECONNECTING" && state.reconnectStartTime > 0) {
        const stuckDuration = Date.now() - state.reconnectStartTime;
        if (stuckDuration > MAX_RECONNECT_DURATION) {
          console.warn("[Watchdog] Reconnection stuck for", Math.round(stuckDuration / 1000), "seconds, switching to waiting state");
          // Instead of force reset and immediate init, switch to waiting for game
          useGameStore.setState({
            status: 'WAITING_FOR_GAME',
            consecutiveErrors: 0,
            reconnectAttempts: 0,
            reconnectStartTime: 0
          });
          // Let checkGameProcess handle the throttled retry
          setTimeout(() => state.checkGameProcess(), 1000);
        }
      }
    }, 5000);

    return () => clearInterval(watchdog);
  }, []);

  // Silent background refresh every 100 seconds
  // Seamlessly refreshes connection tokens and game data without UI disruption
  useEffect(() => {
    const silentRefreshInterval = setInterval(() => {
      const state = useGameStore.getState();
      // Only trigger if connected and not in a transitional state
      // Skip if waiting for game - checkGameProcess handles that
      if (state.status === 'CONNECTED') {
        state.silentRefresh();
      }
    }, SILENT_REFRESH_INTERVAL);

    return () => clearInterval(silentRefreshInterval);
  }, []);

  // Adaptive polling based on connection state
  useEffect(() => {
    if (!isLoading()) {
      startPolling();
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        console.log("[Background] Health check during reconnection...");
        const state = useGameStore.getState();
        if (state.status === "CONNECTED") {
          console.log("[Background] Connection recovered, resuming normal polling");
          startPolling();
        }
      }, POLL_INTERVAL_RECONNECTING);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [status, gameState.state, startPolling, isLoading]);
}
