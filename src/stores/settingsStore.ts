import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { availableMonitors } from "@tauri-apps/api/window";
import { invokeCommand } from "../utils/ipc";

/**
 * Zustand persist writes on EVERY set(), including before rehydrate finishes.
 * A pre-hydrate set() would partialize the in-memory defaults and overwrite
 * localStorage (e.g. wiping a custom auto-lock delay back to 5/6).
 * Gate writes until the first rehydrate completes.
 */
let settingsPersistWritable = false;

const hydrationSafeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (!settingsPersistWritable) return;
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      console.error("Failed to persist settings:", e);
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/** Run after settings rehydrate (or immediately if already hydrated). */
function afterSettingsHydrated(fn: () => void) {
  if (useSettingsStore.persist.hasHydrated()) {
    fn();
    return;
  }
  const unsub = useSettingsStore.persist.onFinishHydration(() => {
    unsub();
    fn();
  });
}

interface WindowPosition {
  x: number;
  y: number;
}

export type WindowStyle = "free" | "docked";

interface SettingsState {
  hotkey: string;
  windowPosition: WindowPosition | null;
  contactInfo: ContactInfo | null;
  windowStyle: WindowStyle;
  autoLockDelaySeconds: number;
  discordRpcEnabled: boolean;
  chatShortcutsEnabled: boolean;
  /** Hide to tray (true, default) vs normal taskbar minimize (false). */
  minimizeToTray: boolean;
  /** First-launch tip toast; shown once then persisted as seen. */
  hasSeenWelcome: boolean;
}

interface SettingsStore extends SettingsState {
  isHotkeyPaused: boolean;
  setHotkey: (key: string) => Promise<boolean>;
  setWindowPosition: (pos: WindowPosition) => void;
  registerHotkey: () => Promise<void>;
  pauseHotkey: () => Promise<void>;
  resumeHotkey: () => Promise<void>;
  restoreWindowPosition: () => Promise<void>;
  saveCurrentPosition: () => Promise<void>;
  hideWindow: () => Promise<void>;
  isWindowVisible: boolean;
  toggleWindow: () => Promise<void>;
  contactInfo: ContactInfo | null;
  fetchContactInfo: () => Promise<void>;
  setWindowStyle: (style: WindowStyle) => Promise<void>;
  dockWindow: () => Promise<void>;
  setAutoLockDelaySeconds: (seconds: number) => void;
  syncAutoLockDelay: () => void;
  setDiscordRpcEnabled: (enabled: boolean) => void;
  syncDiscordRpc: () => void;
  setChatShortcutsEnabled: (enabled: boolean) => void;
  syncChatShortcuts: () => void;
  setMinimizeToTray: (enabled: boolean) => void;
  markWelcomeSeen: () => void;
}

const DEFAULT_AUTO_LOCK_DELAY_SECONDS = 5;

const clampAutoLockDelay = (seconds: number) => {
  if (!Number.isFinite(seconds)) return DEFAULT_AUTO_LOCK_DELAY_SECONDS;
  return Math.min(10, Math.max(1, Math.round(seconds)));
};

export interface ContactInfo {
  telegram?: { username: string; url: string; icon: string };
  discord?: { username: string; url: string; icon: string };
  r10?: { username: string; url: string; icon: string };
  email?: { address: string; url: string; icon: string };
}

let isToggling = false;
// Re-entrancy guard for hotkey (re)registration (StrictMode double-invoke safe).
let isRegisteringHotkey = false;

// Helper to position window off-screen before showing (ALWAYS LEFT)
async function positionOffScreen(win: any) {
  try {
    const monitors = await availableMonitors();
    if (monitors.length === 0) return;
    const monitor = monitors[0]; // Assuming primary monitor
    const winSize = await win.outerSize();
    const screenHeight = monitor.size.height;

    const y = Math.round((screenHeight - winSize.height) / 2);
    const x = -winSize.width; // Just outside left edge

    await win.setPosition(new PhysicalPosition(x, y));
  } catch (e) {
    console.error("Error positioning off-screen:", e);
  }
}

// Helper for slide animation (ALWAYS LEFT)
async function slideWindow(win: any, direction: "in" | "out") {
  try {
    const monitors = await availableMonitors();
    if (monitors.length === 0) return;
    const monitor = monitors[0]; // Assuming primary monitor
    const winSize = await win.outerSize();
    const screenHeight = monitor.size.height;

    const y = Math.round((screenHeight - winSize.height) / 2);
    
    // Left side logic
    const dockedX = 0;
    const offScreenX = -winSize.width;
    
    let startX: number;
    let endX: number;

    if (direction === "in") {
      startX = offScreenX;
      endX = dockedX;
    } else {
      startX = dockedX;
      endX = offScreenX;
    }

    // Animation parameters
    const duration = 300; // ms
    const steps = 15;
    const stepTime = duration / steps;
    
    // Cubic ease-in-out
    const ease = (t: number) => t < .5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const easedT = ease(t);
      const currentX = Math.round(startX + (endX - startX) * easedT);
      
      await win.setPosition(new PhysicalPosition(currentX, y));
      await new Promise(r => setTimeout(r, stepTime));
    }
  } catch (e) {
    console.error("Slide animation failed:", e);
  }
}

async function isOverlayShown(win: Awaited<ReturnType<typeof getCurrentWindow>>): Promise<boolean> {
  const visible = await win.isVisible();
  if (!visible) return false;
  return !(await win.isMinimized());
}

async function concealWindow(
  win: Awaited<ReturnType<typeof getCurrentWindow>>,
  { windowStyle, minimizeToTray }: { windowStyle: WindowStyle; minimizeToTray: boolean },
) {
  if (minimizeToTray) {
    if (windowStyle === "docked") {
      await slideWindow(win, "out");
    }
    await win.hide();
    return;
  }
  await win.minimize();
}

async function revealWindow(
  win: Awaited<ReturnType<typeof getCurrentWindow>>,
  windowStyle: WindowStyle,
  fromMinimize: boolean,
) {
  if (fromMinimize) {
    await win.unminimize();
    await win.show();
    await win.setFocus();
    return;
  }
  if (windowStyle === "docked") {
    await positionOffScreen(win);
  }
  await win.show();
  await win.setFocus();
  if (windowStyle === "docked") {
    await slideWindow(win, "in");
  }
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      hotkey: "F2",
      windowPosition: null,
      isHotkeyPaused: false,
      isWindowVisible: true,
      contactInfo: null,
      windowStyle: "docked" as WindowStyle, // Default docked
      autoLockDelaySeconds: DEFAULT_AUTO_LOCK_DELAY_SECONDS,
      discordRpcEnabled: true,
      chatShortcutsEnabled: true,
      minimizeToTray: true,
      hasSeenWelcome: false,

      markWelcomeSeen: () => {
        set({ hasSeenWelcome: true });
      },

      setAutoLockDelaySeconds: (seconds: number) => {
        const autoLockDelaySeconds = clampAutoLockDelay(seconds);
        set({ autoLockDelaySeconds });
        invokeCommand("set_auto_lock_delay", { seconds: autoLockDelaySeconds }).catch(console.error);
      },

      // Push persisted delay to backend only AFTER rehydrate (never write defaults first).
      syncAutoLockDelay: () => {
        afterSettingsHydrated(() => {
          const autoLockDelaySeconds = clampAutoLockDelay(get().autoLockDelaySeconds);
          invokeCommand("set_auto_lock_delay", { seconds: autoLockDelaySeconds }).catch(console.error);
        });
      },

      setDiscordRpcEnabled: (enabled: boolean) => {
        set({ discordRpcEnabled: enabled });
        invokeCommand("set_discord_rpc", { enabled }).catch(console.error);
      },

      // Push the persisted Discord RPC preference to the (fresh) backend on startup.
      syncDiscordRpc: () => {
        afterSettingsHydrated(() => {
          invokeCommand("set_discord_rpc", { enabled: get().discordRpcEnabled }).catch(console.error);
        });
      },

      setChatShortcutsEnabled: (enabled: boolean) => {
        set({ chatShortcutsEnabled: enabled });
        invokeCommand("set_chat_shortcuts", { enabled }).catch(console.error);
      },

      // Push the persisted chat-shortcut preference to the (fresh) backend.
      syncChatShortcuts: () => {
        afterSettingsHydrated(() => {
          invokeCommand("set_chat_shortcuts", { enabled: get().chatShortcutsEnabled }).catch(console.error);
        });
      },

      setMinimizeToTray: (enabled: boolean) => {
        set({ minimizeToTray: enabled });
      },

      fetchContactInfo: async () => {
        try {
          const response = await fetch("https://raw.githubusercontent.com/ruwiss/valorant-tracker/main/raw/contact.json");
          if (response.ok) {
            const data = await response.json();
            set({ contactInfo: data });
          }
        } catch (e) {
          console.error("Failed to fetch contact info:", e);
        }
      },

      setHotkey: async (newKey: string) => {
        const currentKey = get().hotkey;

        // If same key, just resume
        if (newKey === currentKey) {
          await get().resumeHotkey();
          return true;
        }

        try {
          // Unregister old hotkey first
          try {
            await unregister(currentKey);
          } catch {}

          // Register new hotkey
          const { toggleWindow } = get();
          await register(newKey, toggleWindow);
          set({ hotkey: newKey, isHotkeyPaused: false });
          return true;
        } catch (error) {
          console.error("Failed to register hotkey:", error);
          // Restore old hotkey
          try {
            const { toggleWindow } = get();
            await register(currentKey, toggleWindow);
          } catch {}
          set({ isHotkeyPaused: false });
          return false;
        }
      },

      setWindowPosition: (pos: WindowPosition) => {
        set({ windowPosition: pos });
      },

      registerHotkey: async () => {
        // Guard against concurrent calls (e.g. React StrictMode double-invokes
        // the effect in dev): without it, both calls unregister, find nothing,
        // then both register -> "HotKey already registered".
        if (isRegisteringHotkey) return;
        isRegisteringHotkey = true;
        try {
          const { hotkey, toggleWindow } = get();
          // Always try to unregister first to clear any stale state
          await unregister(hotkey).catch(() => {});
          await register(hotkey, toggleWindow);
        } catch (error) {
          console.error("Failed to register hotkey:", error);
        } finally {
          isRegisteringHotkey = false;
        }
      },

      pauseHotkey: async () => {
        const { hotkey, isHotkeyPaused } = get();
        if (isHotkeyPaused) return;

        try {
          await unregister(hotkey);
          set({ isHotkeyPaused: true });
        } catch (error) {
          console.error("Failed to pause hotkey:", error);
        }
      },

      resumeHotkey: async () => {
        const { hotkey, isHotkeyPaused } = get();
        if (!isHotkeyPaused) return;

        try {
          // Always try to unregister first
          await unregister(hotkey).catch(() => {});

          const { toggleWindow } = get();
          await register(hotkey, toggleWindow);
          set({ isHotkeyPaused: false });
        } catch (error) {
          console.error("Failed to resume hotkey:", error);
        }
      },

      restoreWindowPosition: async () => {
        const { windowPosition, windowStyle } = get();

        // If docked mode, use dockWindow instead
        if (windowStyle === "docked") {
          await get().dockWindow();
          return;
        }

        if (windowPosition) {
          try {
            const win = getCurrentWindow();

            // Self-healing: If position is off-screen (e.g. due to minimize bug), reset to center
            if (windowPosition.x < -100 || windowPosition.y < -100) {
               console.warn("Detected off-screen position, resetting to center");
               await win.center();
               set({ windowPosition: null });
               return;
            }

            await win.setPosition(new PhysicalPosition(windowPosition.x, windowPosition.y));
          } catch (error) {
            console.error("Failed to restore window position:", error);
          }
        }
      },

      saveCurrentPosition: async () => {
        // Don't save position in docked mode (position is managed by dockWindow)
        if (get().windowStyle === "docked") return;

        try {
          const win = getCurrentWindow();
          const isMaximized = await win.isMaximized();
          const isMinimized = await win.isMinimized();

          if (isMaximized || isMinimized) return;

          const pos = await win.outerPosition();

          // Guard against off-screen coordinates (windows minimize behavior)
          if (pos.x < -10000 || pos.y < -10000) return;

          set({ windowPosition: { x: pos.x, y: pos.y } });
        } catch (error) {
          console.error("Failed to save window position:", error);
        }
      },

      hideWindow: async () => {
        try {
          const win = getCurrentWindow();
          await concealWindow(win, get());
          set({ isWindowVisible: false });
        } catch (error) {
          console.error("Failed to hide window:", error);
        }
      },

      toggleWindow: async () => {
        if (isToggling) return;
        isToggling = true;

        try {
          const win = getCurrentWindow();
          const { windowStyle } = get();
          const shown = await isOverlayShown(win);

          if (shown) {
            await concealWindow(win, get());
            set({ isWindowVisible: false });
          } else {
            const minimized = await win.isMinimized();
            await revealWindow(win, windowStyle, minimized);
            set({ isWindowVisible: true });
          }
        } catch (error) {
          console.error("Failed to toggle window:", error);
        }

        setTimeout(() => {
          isToggling = false;
        }, 350);
      },

      setWindowStyle: async (style: WindowStyle) => {
        set({ windowStyle: style });
        if (style === "docked") {
          await get().dockWindow();
        }
      },

      dockWindow: async () => {
        try {
          const win = getCurrentWindow();
          const monitors = await availableMonitors();
          if (monitors.length === 0) return;

          // Use primary monitor (first one)
          const monitor = monitors[0];
          const screenHeight = monitor.size.height;

          // Get window size
          const winSize = await win.outerSize();

          // ALWAYS LEFT
          const x = 0;

          // Center vertically
          const y = Math.round((screenHeight - winSize.height) / 2);

          await win.setPosition(new PhysicalPosition(x, y));
        } catch (error) {
          console.error("Failed to dock window:", error);
        }
      },
    }),
    {
      name: "valorant-tracker-settings-v3", // Version bumped to clear old state
      storage: createJSONStorage(() => hydrationSafeStorage),
      partialize: (state): SettingsState => ({
        hotkey: state.hotkey,
        windowPosition: state.windowPosition,
        contactInfo: state.contactInfo,
        windowStyle: state.windowStyle,
        autoLockDelaySeconds: state.autoLockDelaySeconds,
        discordRpcEnabled: state.discordRpcEnabled,
        chatShortcutsEnabled: state.chatShortcutsEnabled,
        minimizeToTray: state.minimizeToTray,
        hasSeenWelcome: state.hasSeenWelcome,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          // Always clamp so a corrupt / legacy value cannot break the slider.
          autoLockDelaySeconds: clampAutoLockDelay(
            p.autoLockDelaySeconds ?? current.autoLockDelaySeconds,
          ),
          // Legacy saves without this key keep the default (tray).
          minimizeToTray: p.minimizeToTray ?? current.minimizeToTray,
        };
      },
      onRehydrateStorage: () => (_state, error) => {
        // Unlock persistence only after storage was read & merged into memory.
        // Pre-hydrate set() calls were no-ops so they could not wipe a custom delay.
        settingsPersistWritable = true;
        if (error) {
          console.error("Settings rehydrate failed:", error);
        }
      },
    }
  )
);
