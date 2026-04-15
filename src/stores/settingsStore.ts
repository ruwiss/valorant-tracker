import { create } from "zustand";
import { persist } from "zustand/middleware";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { availableMonitors } from "@tauri-apps/api/window";

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
}

export interface ContactInfo {
  telegram?: { username: string; url: string; icon: string };
  discord?: { username: string; url: string; icon: string };
  r10?: { username: string; url: string; icon: string };
  email?: { address: string; url: string; icon: string };
}

let isToggling = false;

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

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      hotkey: "F2",
      windowPosition: null,
      isHotkeyPaused: false,
      isWindowVisible: true,
      contactInfo: null,
      windowStyle: "docked" as WindowStyle, // Default docked

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
        const { hotkey } = get();
        try {
          // Always try to unregister first to clear any stale state
          await unregister(hotkey).catch(() => {});

          const { toggleWindow } = get();
          await register(hotkey, toggleWindow);
          console.log(`Hotkey ${hotkey} registered successfully`);
        } catch (error) {
          console.error("Failed to register hotkey:", error);
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
          console.log(`Hotkey ${hotkey} resumed`);
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
          const { windowStyle } = get();

          if (windowStyle === "docked") {
            // Slide out animation
            await slideWindow(win, "out");
          }

          await win.hide();
          set({ isWindowVisible: false });
        } catch (error) {
          console.error("Failed to hide window:", error);
        }
      },

      toggleWindow: async () => {
        if (isToggling) return;
        isToggling = true;

        const win = getCurrentWindow();
        const visible = await win.isVisible();
        const { windowStyle } = get();

        if (visible) {
          if (windowStyle === "docked") {
            await slideWindow(win, "out");
          }
          await win.hide();
          set({ isWindowVisible: false });
        } else {
          if (windowStyle === "docked") {
            // Position off-screen first, then show and slide in
            await positionOffScreen(win);
          }
          await win.show();
          await win.setFocus();
          set({ isWindowVisible: true });
          if (windowStyle === "docked") {
            await slideWindow(win, "in");
          }
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
          console.log(`Window docked to LEFT at (${x}, ${y})`);
        } catch (error) {
          console.error("Failed to dock window:", error);
        }
      },
    }),
    {
      name: "valorant-tracker-settings-v3", // Version bumped to clear old state
      partialize: (state): SettingsState => ({
        hotkey: state.hotkey,
        windowPosition: state.windowPosition,
        contactInfo: state.contactInfo,
        windowStyle: state.windowStyle,
      }),
    }
  )
);
