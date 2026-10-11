import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useGameStore } from "../stores/gameStore";
import { setWebviewVisible, useSettingsStore } from "../stores/settingsStore";
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
  const { registerHotkey, restoreWindowPosition, syncAutoLockDelay, syncDiscordRpc } = useSettingsStore();
  const { loadAssets } = useAssetsStore();
  const { loadConstants } = useConstantsStore();
  const waitingSinceRef = useRef<number | null>(null);

  // No Valorant for 5 minutes → pause watching (one click resume later).
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
      store.toggleMatchWatching();
    }, remaining);

    return () => window.clearTimeout(id);
  }, [status]);

  useEffect(() => {
    // 1. One-time setup: assets, constants, window, hotkey, autolock delay.
    // React StrictMode mounts twice in dev — only bootstrap once per page load.
    if (!bootstrapped) {
      bootstrapped = true;
      loadAssets();
      loadConstants();
      restoreWindowPosition();
      void usePanelStore.getState().syncWindowToState();
      registerHotkey();
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
        useSettingsStore.setState({ isWindowVisible: true });
      });

    const setupVisibilityListener = async () => {
      const win = getCurrentWindow();
      const sync = async () => {
        const visible = await win.isVisible();
        const minimized = await win.isMinimized();
        useSettingsStore.setState({ isWindowVisible: visible && !minimized });
      };
      const unlistenFocus = await win.onFocusChanged(async ({ payload: focused }) => {
        if (focused) {
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
        moveTimer = window.setTimeout(() => {
          void useSettingsStore.getState().saveCurrentPosition();
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

    let unlistenConnection: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;
    let unlistenShowOverlay: (() => void) | undefined;
    let unlistenVisibility: (() => void) | undefined;
    let unlistenLastMatch: (() => void) | undefined;
    let unlistenOverlayUsers: (() => void) | undefined;
    let unlistenAutolock: (() => void) | undefined;

    setupConnectionListener().then((u) => { unlistenConnection = u; });
    setupStateListener().then((u) => { unlistenState = u; });
    setupOverlayListener().then((u) => { unlistenShowOverlay = u; }).catch((e) =>
      console.error("[GameLoop] Failed to setup show-overlay listener:", e)
    );
    setupVisibilityListener().then((u) => { unlistenVisibility = u; }).catch((e) =>
      console.error("[GameLoop] Failed to setup visibility listener:", e)
    );
    setupLastMatchListener().then((u) => { unlistenLastMatch = u; }).catch((e) =>
      console.error("[GameLoop] Failed to setup last-match listener:", e)
    );
    setupOverlayUsersListener().then((u) => { unlistenOverlayUsers = u; }).catch((e) =>
      console.error("[GameLoop] Failed to setup overlay-users listener:", e)
    );
    setupAutolockListener().then((u) => { unlistenAutolock = u; }).catch((e) =>
      console.error("[GameLoop] Failed to setup autolock listener:", e)
    );
    initialSync();

    return () => {
      if (unlistenConnection) unlistenConnection();
      if (unlistenState) unlistenState();
      if (unlistenShowOverlay) unlistenShowOverlay();
      if (unlistenVisibility) unlistenVisibility();
      if (unlistenLastMatch) unlistenLastMatch();
      if (unlistenOverlayUsers) unlistenOverlayUsers();
      if (unlistenAutolock) unlistenAutolock();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
