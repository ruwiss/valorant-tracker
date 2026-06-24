import { create } from "zustand";
import { invokeCommand } from "../utils/ipc";
import { useI18n } from "../lib/i18n";
import type { PresetMeta } from "../lib/types";

// Presets live in the backend (full ~60KB settings blobs); this store only
// holds lightweight metadata and proxies actions to Tauri commands. No persist.
interface PresetsStore {
  presets: PresetMeta[];
  loading: boolean;
  applyingId: string | null;
  // Id of the preset armed to auto-apply on next game launch (null = none).
  armedId: string | null;

  refresh: () => Promise<void>;
  capture: (name: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<boolean>;
  apply: (id: string) => Promise<boolean>;
  arm: (id: string) => Promise<void>;
  // Close the Riot stack (game + client) and arm the preset; it auto-applies
  // on relaunch. Used when the game is open and a direct write is unsafe.
  closeAndArm: (id: string) => Promise<boolean>;
  disarm: () => Promise<void>;
  syncArmed: () => Promise<void>;
}

const t = (key: string) => useI18n.getState().t(key);

// Readable, localized label for the auto-backup created before applying.
function backupLabel(): string {
  const now = new Date();
  const stamp = now.toLocaleString(useI18n.getState().locale === "tr" ? "tr-TR" : "en-US", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${t("presets.backupName")} · ${stamp}`;
}

export const usePresetsStore = create<PresetsStore>((set, get) => ({
  presets: [],
  loading: false,
  applyingId: null,
  armedId: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const list = await invokeCommand<PresetMeta[]>("list_presets", undefined, {
        suppressErrorToast: true,
      });
      set({ presets: list ?? [] });
    } finally {
      set({ loading: false });
    }
  },

  capture: async (name: string) => {
    try {
      await invokeCommand<PresetMeta>(
        "capture_player_settings",
        { name },
        { successMessage: t("presets.captured") },
      );
      await get().refresh();
      return true;
    } catch {
      return false;
    }
  },

  remove: async (id: string) => {
    await invokeCommand("delete_preset", { id }, { successMessage: t("presets.deleted") });
    await get().refresh();
  },

  rename: async (id: string, name: string) => {
    try {
      await invokeCommand(
        "rename_preset",
        { id, name },
        { successMessage: t("presets.renamed") },
      );
      await get().refresh();
      return true;
    } catch {
      return false;
    }
  },

  apply: async (id: string) => {
    set({ applyingId: id });
    try {
      // Backup is automatic and one-per-account on the backend; we always pass a
      // label so the first apply to an account can name its safety backup.
      await invokeCommand(
        "apply_preset",
        { id, backupLabel: backupLabel() },
        { successMessage: t("presets.applied"), suppressErrorToast: true },
      );
      await get().refresh();
      return true;
    } catch (e) {
      // Map known backend error codes to friendly messages.
      const raw = typeof e === "string" ? e : String(e);
      let msg = raw;
      if (raw.includes("GAME_RUNNING")) msg = t("presets.gameRunning");
      else if (raw.includes("STALE_TOKEN")) msg = t("presets.staleToken");
      const { toast } = await import("sonner");
      toast.error(msg);
      return false;
    } finally {
      set({ applyingId: null });
    }
  },

  // Arm a preset to auto-apply on the next game launch / account login.
  arm: async (id: string) => {
    await invokeCommand(
      "arm_preset",
      { id, backupLabel: backupLabel() },
      { successMessage: t("presets.armed") },
    );
    set({ armedId: id });
  },

  // Force-close Valorant + Riot Client, then arm the preset so it applies on the
  // next launch. The backend kills the stack and drops tokens; the supervisor
  // re-applies on the fresh connection.
  closeAndArm: async (id: string) => {
    set({ applyingId: id });
    try {
      await invokeCommand(
        "close_riot_and_arm_preset",
        { id, backupLabel: backupLabel() },
        { successMessage: t("presets.closedAndArmed") },
      );
      set({ armedId: id });
      return true;
    } catch {
      return false;
    } finally {
      set({ applyingId: null });
    }
  },

  disarm: async () => {
    await invokeCommand("disarm_preset", undefined, { successMessage: t("presets.disarmed") });
    set({ armedId: null });
  },

  // Read the current armed state from the backend (on mount).
  syncArmed: async () => {
    const id = await invokeCommand<string | null>("get_armed_preset", undefined, {
      suppressErrorToast: true,
    });
    set({ armedId: id ?? null });
  },
}));
