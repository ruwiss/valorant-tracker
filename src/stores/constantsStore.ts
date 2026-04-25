import { create } from "zustand";
import { invokeCommand } from "../utils/ipc";

export interface AgentData {
  uuid: string;
  name: string;
  color: string;
}

export interface AppConstants {
  agents: AgentData[];
}

interface ConstantsStore {
  constants: AppConstants | null;
  loaded: boolean;
  loadConstants: () => Promise<void>;
  getAgentByUuid: (uuid: string) => AgentData | null;
  getAgentByName: (name: string) => AgentData | null;
}

export const useConstantsStore = create<ConstantsStore>((set, get) => ({
  constants: null,
  loaded: false,

  loadConstants: async () => {
    if (get().loaded) return;
    try {
      const data = await invokeCommand<AppConstants>("get_app_constants");
      set({ constants: data, loaded: true });
      console.log("[ConstantsStore] Loaded constants from Rust", data);
    } catch (e) {
      console.error("[ConstantsStore] Failed to load constants:", e);
    }
  },

  getAgentByUuid: (uuid: string) => {
    const { constants } = get();
    if (!constants) return null;
    return constants.agents.find((a) => a.uuid === uuid) || null;
  },

  getAgentByName: (name: string) => {
    const { constants } = get();
    if (!constants) return null;
    return constants.agents.find((a) => a.name.toLowerCase() === name.toLowerCase()) || null;
  }
}));
