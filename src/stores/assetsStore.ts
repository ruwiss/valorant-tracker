import { create } from "zustand";

interface AgentAsset {
  displayName: string;
  displayIcon: string;
  displayIconSmall: string;
  bustPortrait: string | null;
}

interface MapAsset {
  displayName: string;
  splash: string;
  displayIcon: string;
  listViewIcon: string;
}

interface AssetsStore {
  agents: Map<string, AgentAsset>;
  maps: Map<string, MapAsset>;
  loaded: boolean;
  loadAssets: () => Promise<void>;
  getAgentIcon: (agentName: string) => string | null;
  getAgentAsset: (agentName: string) => AgentAsset | null;
  getMapSplash: (mapName: string) => string | null;
}

export const useAssetsStore = create<AssetsStore>((set, get) => ({
  agents: new Map(),
  maps: new Map(),
  loaded: false,

  loadAssets: async () => {
    if (get().loaded) return;

    try {
      // Fetch agents and maps in parallel
      const [agentsRes, mapsRes] = await Promise.all([
        fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true"),
        fetch("https://valorant-api.com/v1/maps"),
      ]);

      const agentsData = await agentsRes.json();
      const mapsData = await mapsRes.json();

      const agentsMap = new Map<string, AgentAsset>();
      const mapsMap = new Map<string, MapAsset>();

      // Process agents
      for (const agent of agentsData.data || []) {
        const name = agent.displayName?.replace(/\//g, "").toLowerCase();
        if (name) {
          agentsMap.set(name, {
            displayName: agent.displayName,
            displayIcon: agent.displayIcon || "",
            displayIconSmall: agent.displayIconSmall || agent.displayIcon || "",
            bustPortrait: agent.bustPortrait || null,
          });
        }
      }

      // Process maps
      for (const map of mapsData.data || []) {
        const name = map.displayName;
        if (name) {
          mapsMap.set(name.toLowerCase(), {
            displayName: name,
            splash: map.splash || "",
            displayIcon: map.displayIcon || "",
            listViewIcon: map.listViewIcon || "",
          });
        }
      }

      set({ agents: agentsMap, maps: mapsMap, loaded: true });
    } catch (error) {
      console.error("Failed to load assets:", error);
      set({ loaded: true }); // Mark as loaded to prevent retry loops
    }
  },

  getAgentIcon: (agentName: string) => {
    const agent = get().agents.get(agentName.toLowerCase());
    return agent?.displayIconSmall || agent?.displayIcon || null;
  },

  getAgentAsset: (agentName: string) => {
    return get().agents.get(agentName.toLowerCase()) || null;
  },

  getMapSplash: (mapName: string) => {
    const map = get().maps.get(mapName.toLowerCase());
    return map?.splash || map?.listViewIcon || null;
  },
}));
