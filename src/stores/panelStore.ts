import { create } from "zustand";
import { currentMonitor, monitorFromPoint, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { useChatStore } from "./chatStore";
import { useSettingsStore } from "./settingsStore";
import { BASE_WIDTH, planWindowLayout, type ExpansionSide } from "../lib/windowLayout";
import type { PlayerData, CrosshairLayer } from "../lib/types";

type PanelType = "settings" | "player" | "stats" | "shop" | null;
export type SettingsSubView = "main" | "presets";
export type PlayerSubView = "skins" | "regulars";
export type PlayerSource = "roster" | "friends";

const WINDOW_HEIGHT = 800;

export interface HoveredWeapon {
  name: string;
  icon: string;
  weaponType: string;
  buddy?: {
    name: string;
    icon: string;
  };
  price?: {
    vp: number;
    discountPercent?: number;
    discountedVp?: number;
  };
  tierColor?: string;
  upgradeLevel?: { current: number; total: number };
  note?: string;
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
  /** When true, left overlay shows only the map (no agent portrait). */
  mapOnly?: boolean;
}

export interface HoveredCrosshair {
  name: string;
  layer: CrosshairLayer;
}

interface PanelStore {
  settingsReady: boolean;
  expansionSide: ExpansionSide;
  expansionWidth: number;
  chatInline: boolean;
  dismissForChat: () => void;
  isOpen: boolean;
  panelType: PanelType;
  /** Nested view when panelType is "settings". */
  settingsSubView: SettingsSubView;
  /** Nested view when panelType is "player". */
  playerSubView: PlayerSubView;
  /** Who opened the player panel — friends hides skins / back. */
  playerSource: PlayerSource;
  selectedPlayer: PlayerData | null;
  hoveredWeapon: HoveredWeapon | null;
  hoveredAgent: HoveredAgent | null;
  hoveredCrosshair: HoveredCrosshair | null;
  /** Bumped only by the last-match note icon, together with noteFocusPuuid. */
  noteFocusToken: number;
  /** Player whose note field should be focused. Cleared for every other open. */
  noteFocusPuuid: string | null;

  openSettings: () => Promise<void>;
  openPlayer: (
    player: PlayerData,
    source?: PlayerSource,
    opts?: { focusNote?: boolean },
  ) => Promise<void>;
  openStats: (player: PlayerData) => Promise<void>;
  openShop: () => Promise<void>;
  close: () => Promise<void>;
  /** Match window width to panel content: keep a real pane, collapse an empty one. */
  syncWindowToState: (options?: { reposition?: boolean; restore?: boolean }) => Promise<void>;
  setSettingsSubView: (view: SettingsSubView) => void;
  setPlayerSubView: (view: PlayerSubView) => void;
  setHoveredWeapon: (weapon: HoveredWeapon | null) => void;
  setHoveredAgent: (agent: HoveredAgent | null) => void;
  setHoveredCrosshair: (crosshair: HoveredCrosshair | null) => void;
}

const CLOSED_PANEL = {
  settingsReady: false,
  isOpen: false,
  panelType: null as PanelType,
  settingsSubView: "main" as SettingsSubView,
  playerSubView: "skins" as PlayerSubView,
  playerSource: "roster" as PlayerSource,
  selectedPlayer: null,
  hoveredWeapon: null,
  hoveredAgent: null,
  hoveredCrosshair: null,
};

function hasRenderablePanel(state: {
  isOpen: boolean;
  panelType: PanelType;
  selectedPlayer: PlayerData | null;
}): boolean {
  if (!state.isOpen || !state.panelType) return false;
  if (state.panelType === "player" || state.panelType === "stats") {
    return state.selectedPlayer != null;
  }
  return true;
}

// Native mutations run in order and always read the latest requested UI state.
// Rapid open/close/hide calls cannot let an old resize win over a newer selection.
let layoutQueue: Promise<void> = Promise.resolve();
let appliedLeftWidth = 0;
let appliedPane = "none";

export async function mainOverlayPosition() {
  await layoutQueue;
  const win = getCurrentWindow();
  const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
  return { x: pos.x + Math.round(appliedLeftWidth * scale), y: pos.y };
}

export async function positionMainOverlay(x: number, y: number) {
  await layoutQueue;
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  await win.setPosition(new PhysicalPosition(x - Math.round(appliedLeftWidth * scale), y));
}

function syncLayout(options?: { reposition?: boolean; restore?: boolean }) {
  layoutQueue = layoutQueue.catch(() => {}).then(async () => {
    const state = usePanelStore.getState();
    const inlineChat = useChatStore.getState().isOpen && useSettingsStore.getState().chatSidePanel;
    const pane = inlineChat ? "chat" : hasRenderablePanel(state) ? "side" : "none";
    const win = getCurrentWindow();
    const [size, scale, pos] = await Promise.all([win.innerSize(), win.scaleFactor(), win.outerPosition()]);
    const expectedWidth = BASE_WIDTH + state.expansionWidth;
    // In particular, do not reposition a hidden docked window off its slide path.
    if (!options?.restore && appliedPane === pane && Math.abs(size.width / scale - expectedWidth) < 2) {
      if (!options?.reposition || !(await win.isVisible()) || await win.isMinimized()) {
        if (pane === "side" && state.panelType === "settings") {
          usePanelStore.setState({ settingsReady: true });
        }
        return;
      }
    }
    const anchorX = pos.x + Math.round(appliedLeftWidth * scale);
    const monitor = await monitorFromPoint(anchorX + BASE_WIDTH * scale / 2, pos.y + size.height / 2)
      ?? await currentMonitor();
    if (!monitor) throw new Error("Cannot determine overlay monitor");
    const bounds = monitor.workArea;
    const layout = planWindowLayout(anchorX, scale, { x: bounds.position.x, width: bounds.size.width }, pane);
    const leftWidth = layout.side === "left" ? layout.panelWidth : 0;
    if (options?.restore || Math.abs(size.width / scale - layout.width) >= 1) {
      await win.setSize(new LogicalSize(layout.width, WINDOW_HEIGHT));
    }
    // Record the native offset immediately, including if positioning later fails.
    appliedLeftWidth = leftWidth;
    if (Math.abs(layout.x - pos.x) >= 1) {
      await win.setPosition(new PhysicalPosition(layout.x, pos.y));
    }
    appliedPane = pane;
    usePanelStore.setState({
      expansionSide: layout.side, expansionWidth: layout.panelWidth, chatInline: inlineChat,
      settingsReady: pane === "side" && state.panelType === "settings",
    });
  }).catch((error) => {
    console.error("Failed to synchronize overlay layout:", error);
  });
  return layoutQueue;
}

function closeChatForPanel() {
  useChatStore.setState({ isOpen: false });
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  settingsReady: false,
  expansionSide: "right",
  expansionWidth: 0,
  chatInline: false,
  dismissForChat: () => set({ ...CLOSED_PANEL }),
  isOpen: false,
  panelType: null,
  settingsSubView: "main",
  playerSubView: "skins",
  playerSource: "roster",
  selectedPlayer: null,
  hoveredWeapon: null,
  hoveredAgent: null,
  hoveredCrosshair: null,
  noteFocusToken: 0,
  noteFocusPuuid: null,

  openSettings: async () => {
    closeChatForPanel();
    set({
      isOpen: true,
      panelType: "settings",
      settingsReady: false,
      settingsSubView: "main",
      playerSource: "roster",
      selectedPlayer: null,
      hoveredWeapon: null,
      hoveredAgent: null,
    });
    await syncLayout();
  },

  setSettingsSubView: (view) => set({ settingsSubView: view }),
  setPlayerSubView: (view) => set({ playerSubView: view }),

  openShop: async () => {
    const { isOpen, panelType } = get();

    // Toggle: if shop already open, close it
    if (isOpen && panelType === "shop") {
      await get().close();
      return;
    }

    closeChatForPanel();
    set({ isOpen: true, panelType: "shop", playerSource: "roster", selectedPlayer: null, hoveredWeapon: null, hoveredAgent: null });
    await syncLayout();
  },

  openPlayer: async (player, source = "roster", opts) => {
    const { isOpen, panelType, selectedPlayer, playerSource } = get();
    const focusNote = !!opts?.focusNote;

    // Toggle: if same player from the same origin clicked again, close panel.
    // A note request keeps the profile open and focuses the field instead.
    const same =
      isOpen &&
      panelType === "player" &&
      selectedPlayer?.puuid === player.puuid &&
      playerSource === source;
    if (same && !focusNote) {
      await get().close();
      return;
    }

    if (!same) {
      closeChatForPanel();
      set((s) => ({
        isOpen: true,
        panelType: "player",
        playerSubView: source === "friends" ? "regulars" : "skins",
        playerSource: source,
        selectedPlayer: player,
        hoveredWeapon: null,
        hoveredAgent: null,
        noteFocusPuuid: focusNote ? player.puuid : null,
        noteFocusToken: focusNote ? s.noteFocusToken + 1 : s.noteFocusToken,
      }));
      await syncLayout();
    } else if (focusNote) {
      set((s) => ({
        noteFocusPuuid: player.puuid,
        noteFocusToken: s.noteFocusToken + 1,
      }));
    }
  },

  openStats: async (player) => {
    const { isOpen, panelType, selectedPlayer } = get();

    // Toggle: if same player stats panel clicked again, close
    if (isOpen && panelType === "stats" && selectedPlayer?.puuid === player.puuid) {
      await get().close();
      return;
    }

    closeChatForPanel();
    set({ isOpen: true, panelType: "stats", selectedPlayer: player, hoveredWeapon: null, hoveredAgent: null });
    await syncLayout();
  },

  close: async () => {
    set({ ...CLOSED_PANEL });
    await syncLayout();
  },

  syncWindowToState: syncLayout,

  setHoveredWeapon: (weapon) => {
    set({ hoveredWeapon: weapon });
  },

  setHoveredAgent: (agent) => {
    set({ hoveredAgent: agent });
  },

  setHoveredCrosshair: (crosshair) => {
    set({ hoveredCrosshair: crosshair });
  },
}));
