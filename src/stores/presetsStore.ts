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
  apply: (id: string, makeBackup: boolean) => Promise<boolean>;
  arm: (id: string, makeBackup: boolean) => Promise<void>;
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

  apply: async (id: string, makeBackup: boolean) => {
    set({ applyingId: id });
    try {
      await invokeCommand(
        "apply_preset",
        { id, makeBackup, backupLabel: makeBackup ? backupLabel() : null },
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
      else if (raw.startsWith("BACKUP_FAILED")) msg = t("presets.backupFailed");
      const { toast } = await import("sonner");
      toast.error(msg);
      return false;
    } finally {
      set({ applyingId: null });
    }
  },

  // Arm a preset to auto-apply on the next game launch / account login.
  arm: async (id: string, makeBackup: boolean) => {
    await invokeCommand(
      "arm_preset",
      { id, makeBackup, backupLabel: makeBackup ? backupLabel() : null },
      { successMessage: t("presets.armed") },
    );
    set({ armedId: id });
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
