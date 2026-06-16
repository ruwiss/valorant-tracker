import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useGameStore } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAssetsStore } from "../stores/assetsStore";
import { useConstantsStore } from "../stores/constantsStore";
import { invokeCommand } from "../utils/ipc";
import type { ConnectionEvent, GameState } from "../lib/types";

/**
 * Event-driven game loop. The backend supervisor OWNS the connection lifecycle
 * (connect, watch, self-reconnect, autolock); this hook is a thin consumer:
 *  - subscribes to `connection_changed` and `game_state_changed` events
 *  - pushes persisted settings to the (fresh) backend on startup
 *  - does a one-shot initial sync so the UI renders immediately
 */
export function useGameLoop() {
  const { setGameState, applyConnectionEvent, pushSettingsToBackend } = useGameStore();
  const { registerHotkey, restoreWindowPosition, syncAutoLockDelay } = useSettingsStore();
  const { loadAssets } = useAssetsStore();
  const { loadConstants } = useConstantsStore();

  useEffect(() => {
    // 1. One-time setup: assets, constants, window, hotkey, autolock delay.
    loadAssets();
    loadConstants();
    restoreWindowPosition();
    registerHotkey();
    syncAutoLockDelay();

    // 2. Push persisted settings (autolock + pause intent) to the backend,
    //    which starts with an empty AppState on each launch.
    pushSettingsToBackend();

    // 3. Subscribe to backend events.
    const setupConnectionListener = () =>
      listen<ConnectionEvent>("connection_changed", (event) => {
        useGameStore.getState().applyConnectionEvent(event.payload);
      });

    const setupStateListener = () =>
      listen<GameState>("game_state_changed", (event) => {
        useGameStore.getState().setGameState(event.payload);
      });

    const setupOverlayListener = () =>
      listen("show-overlay", async () => {
        const win = getCurrentWindow();
        if (!(await win.isVisible())) await win.show();
        if (await win.isMinimized()) await win.unminimize();
        await win.setFocus();
      });

    // 4. Initial sync - render correct state without waiting for the next event.
    const initialSync = async () => {
      try {
        const conn = await invokeCommand<ConnectionEvent>("get_connection_status", undefined, {
          suppressErrorToast: true,
        });
        if (conn) applyConnectionEvent(conn);

        const gs = await invokeCommand<GameState>("get_game_state", undefined, {
          suppressErrorToast: true,
        });
        if (gs) setGameState(gs);
      } catch (e) {
        console.debug("[GameLoop] Initial sync skipped:", e);
      }
    };

    let unlistenConnection: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;
    let unlistenShowOverlay: (() => void) | undefined;

    setupConnectionListener().then((u) => { unlistenConnection = u; });
    setupStateListener().then((u) => { unlistenState = u; });
    setupOverlayListener().then((u) => { unlistenShowOverlay = u; }).catch((e) =>
      console.error("[GameLoop] Failed to setup show-overlay listener:", e)
    );
    initialSync();

    return () => {
      if (unlistenConnection) unlistenConnection();
      if (unlistenState) unlistenState();
      if (unlistenShowOverlay) unlistenShowOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
