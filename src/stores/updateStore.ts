import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";


interface UpdateStore {
  updateAvailable: boolean;
  updateVersion: string | null;
  isChecking: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  error: string | null;

  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
}

let pendingUpdate: Update | null = null;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  updateAvailable: false,
  updateVersion: null,
  isChecking: false,
  isDownloading: false,
  downloadProgress: 0,
  error: null,

  checkForUpdate: async () => {
    if (get().isChecking) return;

    set({ isChecking: true, error: null });

    try {
      const update = await check();

      if (update) {
        pendingUpdate = update;
        set({
          updateAvailable: true,
          updateVersion: update.version,
          isChecking: false,
        });
      } else {
        set({ isChecking: false });
      }
    } catch (error) {
      console.error("Update check failed:", error);
      set({ isChecking: false, error: String(error) });
    }
  },

  downloadAndInstall: async () => {
    if (!pendingUpdate || get().isDownloading) return;

    set({ isDownloading: true, downloadProgress: 0, error: null });

    try {
      let downloaded = 0;
      let contentLength = 0;

      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength || 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              set({ downloadProgress: Math.round((downloaded / contentLength) * 100) });
            }
            break;
          case "Finished":
            set({ downloadProgress: 100 });
            break;
        }
      });

      // Exit and let installer handle restart
      // await exit(0);
      console.log("Installer launched");
    } catch (error) {
      console.error("Update failed:", error);
      set({ isDownloading: false, error: String(error) });
    }
  },
}));
