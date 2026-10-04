import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "../utils/ipc";

/**
 * Updates download silently in the Rust backend and install on the next
 * restart. The UI only shows that one is ready and offers an optional
 * "restart now".
 */
interface UpdateStore {
  /** Version downloaded and waiting for the next restart. */
  readyVersion: string | null;
  isRestarting: boolean;

  init: () => void;
  restartToUpdate: () => Promise<void>;
}

let initialized = false;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  readyVersion: null,
  isRestarting: false,

  init: () => {
    if (initialized) return;
    initialized = true;

    listen<string>("update_ready", (e) => set({ readyVersion: e.payload })).catch(console.error);
    invokeCommand<string | null>("get_ready_update", undefined, { suppressErrorToast: true })
      .then((version) => {
        if (version) set({ readyVersion: version });
      })
      .catch(console.error);
  },

  restartToUpdate: async () => {
    if (!get().readyVersion || get().isRestarting) return;
    set({ isRestarting: true });
    try {
      await invokeCommand("restart_to_update");
    } catch {
      set({ isRestarting: false });
    }
  },
}));
