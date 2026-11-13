import { createListenerScope } from "../lib/listenerScope";
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useGameStore } from "../stores/gameStore";
import { isWindowTransitioning, setWebviewVisible, useSettingsStore } from "../stores/settingsStore";
import { usePanelStore } from "../stores/panelStore";
import { useAssetsStore } from "../stores/assetsStore";
import { useConstantsStore } from "../stores/constantsStore";
import { useLastMatchStore } from "../stores/lastMatchStore";
import { useOverlayUsersStore } from "../stores/overlayUsersStore";
import { invokeCommand } from "../utils/ipc";
import type { ConnectionEvent, GameState, LastMatch } from "../lib/types";

/** Guard StrictMode double-mount so we don't spam backend / console on boot. */
let bootstrapped = false;

/** Auto-pause if Valorant never shows up while we are watching for it. */
const NO_GAME_AUTO_PAUSE_MS = 5 * 60 * 1000;

function isWatchingForGame(status: string): boolean {
  return (
    status === "WAITING_FOR_GAME" ||
    status === "RIOT_CONNECTED" ||
    status === "CONNECTING" ||
    status === "RECONNECTING"
  );
}

/**
 * Event-driven game loop. The backend supervisor OWNS the connection lifecycle
 * (connect, watch, self-reconnect, autolock); this hook is a thin consumer:
 *  - subscribes to `connection_changed` and `game_state_changed` events
 *  - pushes persisted settings to the (fresh) backend on startup
 *  - does a one-shot initial sync so the UI renders immediately
 */
export function useGameLoop() {
  const { setGameState, applyConnectionEvent, pushSettingsToBackend } = useGameStore();
  const status = useGameStore((s) => s.status);
  const autoPausedNoGame = useGameStore((s) => s.autoPausedNoGame);
  const { registerHotkey, restoreWindowPosition, syncAutoLockDelay, syncDiscordRpc } = useSettingsStore();
  const { loadAssets } = useAssetsStore();
  const { loadConstants } = useConstantsStore();
  const syncPanelLayout = usePanelStore((s) => s.syncWindowToState);
  const waitingSinceRef = useRef<number | null>(null);

  // No game/Riot for 5 minutes → pause match watching only (chat can come back
  // on its own when the host returns — see auto-resume below).
  useEffect(() => {
    if (status === "CONNECTED" || status === "PAUSED" || !isWatchingForGame(status)) {
      waitingSinceRef.current = null;
      return;
    }

    if (waitingSinceRef.current === null) {
      waitingSinceRef.current = Date.now();
    }

    const remaining = Math.max(
      0,
      NO_GAME_AUTO_PAUSE_MS - (Date.now() - waitingSinceRef.current),
    );

    const id = window.setTimeout(() => {
      const store = useGameStore.getState();
      if (store.status === "CONNECTED" || store.status === "PAUSED") return;
      if (!isWatchingForGame(store.status)) return;
      waitingSinceRef.current = null;
      store.autoPauseNoGame();
    }, remaining);

    return () => window.clearTimeout(id);
  }, [status]);

  // After auto-pause: when Riot Client or Valorant comes back, resume watching
  // so we don't stay stuck on "Duraklatıldı" until the overlay is restarted.
  useEffect(() => {
    if (status !== "PAUSED" || !autoPausedNoGame) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const up = await invokeCommand<boolean>("get_chat_host_running", undefined, {
          suppressErrorToast: true,
        });
        if (cancelled || !up) return;
        const store = useGameStore.getState();
        if (store.status === "PAUSED" && store.autoPausedNoGame) {
          store.toggleMatchWatching();
        }
      } catch {
        // still down
      }
    };

    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status, autoPausedNoGame]);

  // The native shortcut registration survives React/module refreshes. Bind it
  // to the current dispatcher whenever this store instance changes.
  useEffect(() => {
    void registerHotkey();
  }, [registerHotkey]);

  useEffect(() => {
    // 1. One-time setup: assets, constants, window, hotkey, autolock delay.
    // React StrictMode mounts twice in dev — only bootstrap once per page load.
    if (!bootstrapped) {
      bootstrapped = true;
      loadAssets();
      loadConstants();
      restoreWindowPosition();
      void usePanelStore.getState().syncWindowToState();
      syncAutoLockDelay();
      syncDiscordRpc();

      // 2. Push persisted settings (autolock + pause intent) to the backend,
      //    which starts with an empty AppState on each launch.
      pushSettingsToBackend();
    }

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
        await usePanelStore.getState().syncWindowToState();
        const win = getCurrentWindow();
        await setWebviewVisible(true);
        if (!(await win.isVisible())) await win.show();
        if (await win.isMinimized()) await win.unminimize();
        await win.setFocus();
        await usePanelStore.getState().syncWindowToState({ restore: true });
        useSettingsStore.setState({ isWindowVisible: true });
      });

    const setupVisibilityListener = async () => {
      const win = getCurrentWindow();
      const sync = async () => {
        if (isWindowTransitioning()) return;
        const visible = await win.isVisible();
        const minimized = await win.isMinimized();
        useSettingsStore.setState({ isWindowVisible: visible && !minimized });
      };
      const unlistenFocus = await win.onFocusChanged(async ({ payload: focused }) => {
        if (isWindowTransitioning()) return;
        if (focused) {
          if (!useSettingsStore.getState().isWindowVisible) {
            await usePanelStore.getState().syncWindowToState({ restore: true });
          }
          useSettingsStore.setState({ isWindowVisible: true });
          return;
        }
        await sync();
      });
      const unlistenResize = await win.onResized(sync);
      // Remember free-mode drags (debounced; saveCurrentPosition skips docked).
      let moveTimer: number | undefined;
      const unlistenMove = await win.onMoved(() => {
        window.clearTimeout(moveTimer);
        if (isWindowTransitioning()) return;
        moveTimer = window.setTimeout(() => {
          void (async () => {
            if (isWindowTransitioning()) return;
            const win = getCurrentWindow();
            if (!(await win.isVisible()) || await win.isMinimized()) return;
            await usePanelStore.getState().syncWindowToState({ reposition: true });
            await useSettingsStore.getState().saveCurrentPosition();
          })().catch(console.error);
        }, 400);
      });
      return () => {
        window.clearTimeout(moveTimer);
        unlistenFocus();
        unlistenResize();
        unlistenMove();
      };
    };

    const setupLastMatchListener = () =>
      listen<LastMatch>("last_match_updated", (event) => {
        if (event.payload) {
          useLastMatchStore.getState().setMatch(event.payload);
        }
      });

    const setupOverlayUsersListener = () =>
      listen<{ puuids: string[] }>("overlay_users", (event) => {
        const incoming = event.payload?.puuids;
        if (!incoming?.length) return;
        useOverlayUsersStore.getState().add(incoming);
      });

    const setupAutolockListener = () =>
      listen<{ running: boolean; remaining_ms: number }>("autolock_countdown", (event) => {
        if (!event.payload) return;
        useGameStore.getState().setAutolockCountdown(event.payload);
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

    const listeners = createListenerScope();
    void listeners.add(setupConnectionListener()).catch(console.error);
    void listeners.add(setupStateListener()).catch(console.error);
    void listeners.add(setupOverlayListener()).catch((e) =>
      console.error("[GameLoop] Failed to setup show-overlay listener:", e)
    );
    void listeners.add(setupVisibilityListener()).catch((e) =>
      console.error("[GameLoop] Failed to setup visibility listener:", e)
    );
    void listeners.add(setupLastMatchListener()).catch((e) =>
      console.error("[GameLoop] Failed to setup last-match listener:", e)
    );
    void listeners.add(setupOverlayUsersListener()).catch((e) =>
      console.error("[GameLoop] Failed to setup overlay-users listener:", e)
    );
    void listeners.add(setupAutolockListener()).catch((e) =>
      console.error("[GameLoop] Failed to setup autolock listener:", e)
    );
    initialSync();

    return () => listeners.dispose();
  }, [
    setGameState, applyConnectionEvent, pushSettingsToBackend,
    restoreWindowPosition, syncAutoLockDelay, syncDiscordRpc,
    loadAssets, loadConstants, syncPanelLayout,
  ]);
}
