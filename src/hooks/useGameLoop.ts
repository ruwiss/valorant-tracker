import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useGameStore } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAssetsStore } from "../stores/assetsStore";
import { useConstantsStore } from "../stores/constantsStore";
import type { GameState } from "../lib/types";

const MAX_RECONNECT_DURATION = 30000;
const PROCESS_CHECK_INTERVAL = 3000; // Check if game process is alive every 3s

/**
 * Event-based game loop hook that manages:
 * - Subscribing to Rust 'game_state_changed' events
 * - Background game process checking
 * - Window focus listener for health checks
 */
export function useGameLoop() {
  const { initialize, setGameState, status, checkGameProcess } = useGameStore();
  const { registerHotkey, restoreWindowPosition, saveCurrentPosition } = useSettingsStore();
  const { loadAssets } = useAssetsStore();
  const { loadConstants } = useConstantsStore();

  const positionInitialized = useRef(false);

  useEffect(() => {
    // 1. Initialize core state
    const state = useGameStore.getState();
    if (state.status === 'RECONNECTING') {
      console.warn("[GameLoop] Starting from RECONNECTING state, attempting re-init");
      initialize();
    } else if (state.status !== 'PAUSED') {
      initialize();
    }

    loadAssets();
    loadConstants();

    // Set initial position
    if (!positionInitialized.current) {
      restoreWindowPosition();
      positionInitialized.current = true;
    }

    // Setup hotkey
    registerHotkey();

    // Setup window focus listener (for health checks)
    const setupFocusListener = async () => {
      try {
        const window = getCurrentWindow();
        return await window.onFocusChanged(({ payload: focused }) => {
          if (focused) {
            console.log("[GameLoop] Window focused, running health check");
            const currentState = useGameStore.getState();
            if (currentState.status === 'CONNECTED') {
              currentState.healthCheck();
            }
          }
        });
      } catch (e) {
        console.error("[GameLoop] Failed to setup focus listener:", e);
      }
    };
    
    // Setup event listener for Game State Changes from Rust (Event-Based Architecture)
    const setupStateListener = async () => {
      try {
        return await listen<GameState>("game_state_changed", (event) => {
          // This fires ONLY when the backend detects a state change
          console.debug("[GameLoop] Received game_state_changed event", event.payload.state);
          setGameState(event.payload);
        });
      } catch (e) {
        console.error("[GameLoop] Failed to setup state listener:", e);
      }
    };

    const setupOverlayListener = async () => {
        try {
            return await listen("show-overlay", async () => {
                console.log("[SingleInstance] Show overlay event received");
                const win = getCurrentWindow();
                const isVisible = await win.isVisible();
                
                if (!isVisible) {
                    await win.show();
                }
                
                if (await win.isMinimized()) {
                    await win.unminimize();
                }
                
                await win.setFocus();
            });
        } catch (e) {
            console.error("[SingleInstance] Failed to setup show-overlay listener:", e);
        }
    };

    let unlistenFocus: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;
    let unlistenShowOverlay: (() => void) | undefined;

    setupFocusListener().then(u => { unlistenFocus = u; });
    setupStateListener().then(u => { unlistenState = u; });
    setupOverlayListener().then(u => { unlistenShowOverlay = u; });

    // Background process checker (to handle 'WAITING_FOR_GAME' -> connected transitions)
    const processChecker = setInterval(() => {
        const currentStore = useGameStore.getState();
        // If we are not connected and not currently trying to connect, check if process started
        if (!currentStore.isConnected() && currentStore.status !== 'CONNECTING' && currentStore.status !== 'RECONNECTING') {
            checkGameProcess();
        }
    }, PROCESS_CHECK_INTERVAL);

    return () => {
      if (unlistenFocus) unlistenFocus();
      if (unlistenState) unlistenState();
      if (unlistenShowOverlay) unlistenShowOverlay();
      clearInterval(processChecker);
    };
  }, [initialize, loadAssets, registerHotkey, restoreWindowPosition, saveCurrentPosition, checkGameProcess]);

  // Watchdog for stuck reconnection
  useEffect(() => {
    const watchdog = setInterval(() => {
      const state = useGameStore.getState();
      
      if (state.status === "RECONNECTING") {
        const now = Date.now();
        const duration = now - state.reconnectStartTime;
        
        if (duration > MAX_RECONNECT_DURATION) {
          console.warn('[Watchdog] Reconnection stuck, forcing disconnect');
          // In the new state machine, we just set it to IDLE or handle it via a reset
          useGameStore.setState({ 
            status: "IDLE",
          });
        }
      }
    }, 5000);

    return () => clearInterval(watchdog);
  }, [status]);
}

