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
  /** Splash URLs fully warmed in the browser image cache. */
  preloadedMapSplashes: Record<string, true>;
  loadAssets: () => Promise<void>;
  preloadMapSplashes: () => void;
  getAgentIcon: (agentName: string) => string | null;
  getAgentAsset: (agentName: string) => AgentAsset | null;
  getMapSplash: (mapName: string) => string | null;
  isMapSplashReady: (url: string | null | undefined) => boolean;
}

function preloadImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(url);
    img.onerror = () => reject(new Error(`Failed to preload ${url}`));
    img.src = url;
    if (img.complete && img.naturalWidth > 0) {
      resolve(url);
    }
  });
}

export const useAssetsStore = create<AssetsStore>((set, get) => ({
  agents: new Map(),
  maps: new Map(),
  loaded: false,
  preloadedMapSplashes: {},

  loadAssets: async () => {
    // Allow retry if a previous attempt marked loaded but produced no data
    if (get().loaded && get().agents.size > 0) return;

    try {
      const [agentsRes, mapsRes] = await Promise.all([
        fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true"),
        fetch("https://valorant-api.com/v1/maps"),
      ]);

      if (!agentsRes.ok || !mapsRes.ok) {
        throw new Error(`valorant-api HTTP ${agentsRes.status}/${mapsRes.status}`);
      }

      const agentsData = await agentsRes.json();
      const mapsData = await mapsRes.json();

      const agentsMap = new Map<string, AgentAsset>();
      const mapsMap = new Map<string, MapAsset>();

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

      if (agentsMap.size === 0) {
        throw new Error("valorant-api returned 0 agents");
      }

      set({ agents: agentsMap, maps: mapsMap, loaded: true });
      // Warm map splashes in the background (non-blocking, low priority)
      get().preloadMapSplashes();
    } catch (error) {
      console.error("Failed to load assets:", error);
      // Do NOT set loaded:true on failure — allows a later retry
      set({ loaded: false });
    }
  },

  preloadMapSplashes: () => {
    const urls: string[] = [];
    for (const map of get().maps.values()) {
      if (map.splash) urls.push(map.splash);
    }
    // Stagger so we don't hammer the network / image decoder
    urls.forEach((url, i) => {
      window.setTimeout(() => {
        void preloadImage(url)
          .then(() => {
            set((s) => ({
              preloadedMapSplashes: { ...s.preloadedMapSplashes, [url]: true },
            }));
          })
          .catch(() => {});
      }, i * 80);
    });
  },

  getAgentIcon: (agentName: string) => {
    const agent = get().agents.get(agentName.toLowerCase());
    const icon = agent?.displayIconSmall || agent?.displayIcon || "";
    return icon || null;
  },

  getAgentAsset: (agentName: string) => {
    return get().agents.get(agentName.toLowerCase()) || null;
  },

  getMapSplash: (mapName: string) => {
    const map = get().maps.get(mapName.toLowerCase());
    return map?.splash || map?.listViewIcon || null;
  },

  isMapSplashReady: (url) => {
    if (!url) return false;
    return !!get().preloadedMapSplashes[url];
  },
}));
