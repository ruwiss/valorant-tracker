import { create } from "zustand";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import type { PlayerData } from "../lib/types";

type PanelType = "settings" | "player" | "stats" | null;

const BASE_WIDTH = 380;
const PANEL_WIDTH = 260;
const WINDOW_HEIGHT = 800;

export interface HoveredWeapon {
  name: string;
  icon: string;
  weaponType: string;
  buddy?: {
    name: string;
    icon: string;
  };
}

export interface HoveredAgent {
  name: string;
  displayIcon: string;
  bustPortrait: string | null;
  mapContext?: {
    mapName: string;
    mapSplash: string | null;
    mapColor: string;
  };
}

interface PanelStore {
  isOpen: boolean;
  panelType: PanelType;
  selectedPlayer: PlayerData | null;
  hoveredWeapon: HoveredWeapon | null;
  hoveredAgent: HoveredAgent | null;

  openSettings: () => Promise<void>;
  openPlayer: (player: PlayerData) => Promise<void>;
  openStats: (player: PlayerData) => Promise<void>;
  close: () => Promise<void>;
  setHoveredWeapon: (weapon: HoveredWeapon | null) => void;
  setHoveredAgent: (agent: HoveredAgent | null) => void;
}

async function resizeWindow(expanded: boolean) {
  try {
    const win = getCurrentWindow();
    const width = expanded ? BASE_WIDTH + PANEL_WIDTH : BASE_WIDTH;
    await win.setSize(new LogicalSize(width, WINDOW_HEIGHT));
  } catch (error) {
    console.error("Failed to resize window:", error);
  }
}

async function waitForResize(targetLogicalWidth: number) {
  const win = getCurrentWindow();
  const startTime = Date.now();

  // Get scale factor to convert logical target to physical pixels
  // Fallback to 1 if fails, though unlikely
  const factor = await win.scaleFactor().catch(() => 1);
  const targetPhysicalWidth = targetLogicalWidth * factor;

  while (Date.now() - startTime < 300) { // Max 300ms timeout
    const size = await win.innerSize(); // Returns physical pixels

    // Check if we are close enough (allow generous margin for float/rounding errors)
    // Compare physical actual size vs physical target size
    if (Math.abs(size.width - targetPhysicalWidth) < 4) {
      return;
    }
    await new Promise(r => setTimeout(r, 10)); // Check every 10ms
  }
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  isOpen: false,
  panelType: null,
  selectedPlayer: null,
  hoveredWeapon: null,
  hoveredAgent: null,

  openSettings: async () => {
    const wasOpen = get().isOpen;
    if (!wasOpen) {
      const targetWidth = BASE_WIDTH + PANEL_WIDTH;
      await resizeWindow(true);
      await waitForResize(targetWidth);
    }
    set({ isOpen: true, panelType: "settings", selectedPlayer: null, hoveredWeapon: null, hoveredAgent: null });
  },

  openPlayer: async (player) => {
    const { isOpen, panelType, selectedPlayer } = get();

    // Toggle: if same player clicked again, close panel
    if (isOpen && panelType === "player" && selectedPlayer?.puuid === player.puuid) {
      await get().close();
      return;
    }

    const wasOpen = isOpen;
    if (!wasOpen) {
      const targetWidth = BASE_WIDTH + PANEL_WIDTH;
      await resizeWindow(true);
      await waitForResize(targetWidth);
    }
    set({ isOpen: true, panelType: "player", selectedPlayer: player, hoveredWeapon: null, hoveredAgent: null });
  },

  openStats: async (player) => {
    const { isOpen, panelType, selectedPlayer } = get();

    // Toggle: if same player stats panel clicked again, close
    if (isOpen && panelType === "stats" && selectedPlayer?.puuid === player.puuid) {
      await get().close();
      return;
    }

    const wasOpen = isOpen;
    if (!wasOpen) {
      const targetWidth = BASE_WIDTH + PANEL_WIDTH;
      await resizeWindow(true);
      await waitForResize(targetWidth);
    }
    set({ isOpen: true, panelType: "stats", selectedPlayer: player, hoveredWeapon: null, hoveredAgent: null });
  },

  close: async () => {
    set({ isOpen: false, panelType: null, selectedPlayer: null, hoveredWeapon: null, hoveredAgent: null });
    // Wait for exit animation or state update to clear
    await new Promise(resolve => setTimeout(resolve, 300));
    await resizeWindow(false);
  },

  setHoveredWeapon: (weapon) => {
    set({ hoveredWeapon: weapon });
  },

  setHoveredAgent: (agent) => {
    set({ hoveredAgent: agent });
  },
}));
