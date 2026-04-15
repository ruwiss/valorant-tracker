import { useState, useEffect, useRef } from "react";
import { invokeCommand } from "../utils/ipc";
import { useGameStore } from "../stores/gameStore";
import { usePanelStore } from "../stores/panelStore";
import { useAssetsStore } from "../stores/assetsStore";
import { useI18n, SKIN_API_LOCALES } from "../lib/i18n";
import { WEAPON_NAMES, AGENT_COLORS, RANK_TIERS } from "../lib/constants";
import { CachedImage } from "./CachedImage";

interface WeaponSkin {
  weapon_id: string;
  skin_id: string;
  chroma_id: string | null;
  buddy_id: string | null;
}
interface PlayerSkinData {
  puuid: string;
  skins: WeaponSkin[];
}
interface SkinInfo {
  name: string;
  icon: string;
}
interface BuddyInfo {
  name: string;
  icon: string;
}
interface WeaponInfo {
  displayIcon: string;
}

interface PeakRankData {
  tier: number;
  rank_name: string;
  rank_color: string;
  season_id: string;
}

// Weapon categories for better organization
const WEAPON_CATEGORIES = {
  primary: [
    "9c82e19d-4575-0200-1a81-3eacf00cf872", // Vandal
    "ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a", // Phantom
    "a03b24d3-4319-996d-0f8c-94bbfba1dfc7", // Operator
    "4ade7faa-4cf1-8376-95ef-39884480959b", // Guardian
    "ae3de142-4d85-2547-dd26-4e90bed35cf7", // Bulldog
    "c4883e50-4494-202c-3ec3-6b8a9284f00b", // Marshal
    "5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c", // Outlaw
    "462080d1-4035-2937-7c09-27aa2a5c27a7", // Spectre
  ],
  secondary: [
    "f7e1b454-4ad4-1063-ec0a-159e56b58941", // Stinger
    "e336c6b8-418d-9340-d77f-7a9e4cfe0702", // Sheriff
    "1baa85b4-4c70-1284-64bb-6481dfc3bb4e", // Ghost
    "29a0cfab-485b-f5d5-779a-b59f85e204a8", // Classic
    "42da8ccc-40d5-affc-beec-15aa47b42eda", // Shorty
    "44d4e95c-4157-0037-81b2-17841bf2e8e3", // Frenzy
    "410b2e0b-4ceb-1321-1727-20858f7f3477", // Bandit
  ],
  other: [
    "63e6c2b6-4a8e-869c-3d4c-e38355226584", // Odin
    "55d8a0f4-4274-ca67-fe2c-06ab45efdf58", // Ares
    "ec845bf4-4f79-ddda-a3da-0db3774b2794", // Judge
    "910be174-449b-c412-ab22-d0873436b21b", // Bucky
    "2f59173c-4bed-b6c3-2191-dea9b58be9c7", // Melee
  ],
};

const skinMetaCache = new Map<string, Map<string, SkinInfo>>();
const buddyMetaCache = new Map<string, Map<string, BuddyInfo>>();
const weaponIconCache = new Map<string, WeaponInfo>();

export function PlayerPanel() {
  const { selectedPlayer, setHoveredWeapon } = usePanelStore();
  const { getAgentIcon } = useAssetsStore();
  const matchId = useGameStore((state) => state.gameState.match_id); // Get match_id
  const { t, locale } = useI18n();
  const [skins, setSkins] = useState<WeaponSkin[]>([]);
  const [skinMeta, setSkinMeta] = useState<Map<string, SkinInfo>>(new Map());
  const [buddyMeta, setBuddyMeta] = useState<Map<string, BuddyInfo>>(new Map());
  const [weaponIcons, setWeaponIcons] = useState<Map<string, WeaponInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [translatedName, setTranslatedName] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [peakRank, setPeakRank] = useState<PeakRankData | null>(null);
  const fetchedRef = useRef<string | null>(null);

  // Reset state when player changes
  useEffect(() => {
    setTranslatedName(null);
    setIsTranslating(false);
    setPeakRank(null);

    if (selectedPlayer?.puuid) {
      invokeCommand<PeakRankData | null>("get_peak_rank", { puuid: selectedPlayer.puuid })
        .then(setPeakRank)
        .catch(console.error);
    }
  }, [selectedPlayer?.puuid]);

  useEffect(() => {
    if (!selectedPlayer) {
      fetchedRef.current = null;
      return;
    }
    // Include matchId in cache key to force refetch on new match
    const cacheKey = `${selectedPlayer.puuid}-${matchId}-${locale}`;
    if (fetchedRef.current === cacheKey) return;
    fetchLoadout();
  }, [selectedPlayer?.puuid, matchId, locale]);

  // Fetch weapon icons once
  useEffect(() => {
    if (weaponIconCache.size === 0) {
      fetchWeaponIcons();
    } else {
      setWeaponIcons(new Map(weaponIconCache));
    }
  }, []);

  const fetchWeaponIcons = async () => {
    try {
      const res = await fetch("https://valorant-api.com/v1/weapons");
      if (!res.ok) return;
      const json = await res.json();
      for (const weapon of json.data || []) {
        weaponIconCache.set(weapon.uuid.toLowerCase(), { displayIcon: weapon.displayIcon || "" });
      }
      setWeaponIcons(new Map(weaponIconCache));
    } catch {}
  };

  const fetchLoadout = async () => {
    if (!selectedPlayer) return;
    fetchedRef.current = `${selectedPlayer.puuid}-${locale}`;
    setLoading(true);
    setError(null);
    try {
      const data = await invokeCommand<PlayerSkinData | null>("get_player_loadout", { puuid: selectedPlayer.puuid });
      if (!data) {
        setError(t("player.loadoutNotFound"));
        setLoading(false);
        return;
      }

      setSkins(data.skins);
      const apiLocale = SKIN_API_LOCALES[locale];

      // Skin meta cache
      if (!skinMetaCache.has(apiLocale)) skinMetaCache.set(apiLocale, new Map());
      const localeCache = skinMetaCache.get(apiLocale)!;
      const uncachedIds = data.skins.map((s) => s.chroma_id || s.skin_id).filter((id) => !localeCache.has(id.toLowerCase()));
      if (uncachedIds.length > 0) await fetchSkinMeta(uncachedIds, apiLocale, localeCache);
      const meta = new Map<string, SkinInfo>();
      data.skins.forEach((s) => {
        const id = (s.chroma_id || s.skin_id).toLowerCase();
        const c = localeCache.get(id);
        if (c) meta.set(id, c);
      });
      setSkinMeta(meta);

      // Buddy meta cache
      if (!buddyMetaCache.has(apiLocale)) buddyMetaCache.set(apiLocale, new Map());
      const buddyCache = buddyMetaCache.get(apiLocale)!;
      const buddyIds = data.skins.map((s) => s.buddy_id).filter((id): id is string => !!id && !buddyCache.has(id));
      if (buddyIds.length > 0) await fetchBuddyMeta(buddyIds, apiLocale, buddyCache);
      const bMeta = new Map<string, BuddyInfo>();
      data.skins.forEach((s) => {
        if (s.buddy_id) {
          const b = buddyCache.get(s.buddy_id);
          if (b) bMeta.set(s.buddy_id, b);
        }
      });
      setBuddyMeta(bMeta);
    } catch {
      setError(t("player.connectionError"));
    } finally {
      setLoading(false);
    }
  };

  const fetchSkinMeta = async (skinIds: string[], apiLocale: string, cache: Map<string, SkinInfo>) => {
    try {
      const res = await fetch(`https://valorant-api.com/v1/weapons/skins?language=${apiLocale}`);
      if (!res.ok) return;
      const json = await res.json();
      // Normalize skinIds to lowercase for consistent comparison
      const lowerSkinIds = skinIds.map((id) => id.toLowerCase());
      for (const skin of json.data || []) {
        const skinUuidLower = skin.uuid.toLowerCase();
        if (lowerSkinIds.includes(skinUuidLower)) {
          cache.set(skinUuidLower, { name: skin.displayName || "Unknown", icon: skin.displayIcon || skin.chromas?.[0]?.displayIcon || "" });
        }
        for (const chroma of skin.chromas || []) {
          const chromaUuidLower = chroma.uuid.toLowerCase();
          if (lowerSkinIds.includes(chromaUuidLower)) {
            cache.set(chromaUuidLower, { name: chroma.displayName || skin.displayName || "Unknown", icon: chroma.displayIcon || chroma.fullRender || skin.displayIcon || "" });
          }
        }
      }
    } catch {}
  };

  const fetchBuddyMeta = async (buddyIds: string[], apiLocale: string, cache: Map<string, BuddyInfo>) => {
    try {
      const res = await fetch(`https://valorant-api.com/v1/buddies?language=${apiLocale}`);
      if (!res.ok) return;
      const json = await res.json();
      for (const buddy of json.data || []) {
        if (buddyIds.includes(buddy.uuid)) {
          cache.set(buddy.uuid, { name: buddy.displayName || "Unknown", icon: buddy.displayIcon || "" });
        }
        for (const level of buddy.levels || []) {
          if (buddyIds.includes(level.uuid)) {
            cache.set(level.uuid, { name: buddy.displayName || "Unknown", icon: level.displayIcon || buddy.displayIcon || "" });
          }
        }
      }
    } catch {}
  };

  const handleTranslate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedPlayer || isTranslating || translatedName) return;

    setIsTranslating(true);
    try {
      const nickname = selectedPlayer.name.split("#")[0];
      const targetLang = locale === "tr" ? "Turkish" : "English";
      const prompt = `You are a translator for gaming nicknames.
Nickname: "${nickname}"
Target Language: ${targetLang}

Instructions:
1. Translate the semantic meaning of the nickname to the target language.
2. If the nickname is a common name (e.g. "Bahar"), translate its literal meaning (e.g. "Spring").
3. If the nickname is a gamer tag with a clear meaning (e.g. "HeadHunter"), translate it.
4. If the nickname has NO clear meaning, is a made-up word, or just a distinct proper noun (e.g. "Kratos"), return "-".
5. Do NOT return the original nickname unless it is also the translation.
6. Respond with ONLY the translated text or "-".`;

      const apiKey = atob("c2stb3ItdjEtZjFhZmYwNjIyNDJmZjdhMjYyYjhlZjIwYjQ2OTM1YTMzNmRhNDFmYTM2ODUwNmM2ZWM0YWU4MzEzODJhMGNhYg==");

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://valorant-tracker.app", // Required by OpenRouter
          "X-Title": "Valorant Helper", // Optional
        },
        body: JSON.stringify({
          model: "google/gemini-2.0-flash-001",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });

      if (!res.ok) throw new Error("Translation failed");

      const data = await res.json();
      const cleanText = data.choices?.[0]?.message?.content?.trim();

      if (!cleanText) throw new Error("Translation returned empty");
      setTranslatedName(cleanText);
    } catch (err) {
      console.error("Translation error:", err);
    } finally {
      setIsTranslating(false);
    }
  };

  const copyName = () => {
    if (selectedPlayer) {
      navigator.clipboard.writeText(selectedPlayer.name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  if (!selectedPlayer) return null;

  const agentIcon = selectedPlayer.agent ? getAgentIcon(selectedPlayer.agent) : null;
  const agentColor = AGENT_COLORS[selectedPlayer.agent?.toLowerCase()] || "#768079";
  
  // Helper to localize rank name
  const getLocalizedRank = (tier: number) => {
    if (tier < 3) return t("rank.unranked");
    if (tier >= 27) return t("rank.radiant");
    
    const ranks = [
      "rank.iron", "rank.bronze", "rank.silver", "rank.gold",
      "rank.platinum", "rank.diamond", "rank.ascendant", "rank.immortal"
    ];
    
    const rankIndex = Math.floor((tier - 3) / 3);
    const level = (tier - 3) % 3 + 1;
    
    if (rankIndex >= 0 && rankIndex < ranks.length) {
      return `${t(ranks[rankIndex])} ${level}`;
    }
    return "";
  };

  const [, rankColor] = RANK_TIERS[selectedPlayer.rank_tier] || ["", "#768079"];
  const rankName = getLocalizedRank(selectedPlayer.rank_tier);

  // Group skins by category - lowercase keys for case-insensitive matching
  const skinsByWeaponId = new Map(skins.map((s) => [s.weapon_id.toLowerCase(), s]));

  const getWeaponIcon = (skin: WeaponSkin): string => {
    const id = (skin.chroma_id || skin.skin_id).toLowerCase();
    const meta = skinMeta.get(id);
    // Use skin icon if available, otherwise fallback to weapon default icon
    if (meta?.icon) return meta.icon;
    return weaponIcons.get(skin.weapon_id.toLowerCase())?.displayIcon || "";
  };

  const handleWeaponHover = (skin: WeaponSkin | null) => {
    if (!skin) {
      setHoveredWeapon(null);
      return;
    }
    const id = (skin.chroma_id || skin.skin_id).toLowerCase();
    const meta = skinMeta.get(id);
    const weaponType = WEAPON_NAMES[skin.weapon_id.toLowerCase()] || "?";
    const icon = getWeaponIcon(skin);
    const buddy = skin.buddy_id ? buddyMeta.get(skin.buddy_id.toLowerCase()) : undefined;
    setHoveredWeapon({ name: meta?.name || weaponType, icon, weaponType, buddy });
  };

  const renderWeaponCard = (weaponId: string, isPrimary = false) => {
    const skin = skinsByWeaponId.get(weaponId.toLowerCase());
    // Don't return null here - we want to render the weapon even if no skin data

    const id = (skin?.chroma_id || skin?.skin_id || "").toLowerCase();
    const meta = id ? skinMeta.get(id) : undefined;
    const weaponName = WEAPON_NAMES[weaponId.toLowerCase()] || "?";

    // Get icon: skin icon -> weapon default icon
    const icon = skin ? getWeaponIcon(skin) : weaponIcons.get(weaponId.toLowerCase())?.displayIcon || "";
    const hasBuddy = skin?.buddy_id && buddyMeta.has(skin.buddy_id.toLowerCase());

    // Mock skin object for hover handler if real skin is missing
    const hoverSkin = skin || { weapon_id: weaponId, skin_id: "", chroma_id: null, buddy_id: null };

    if (isPrimary) {
      // Large card for primary weapons (Vandal, Phantom, Operator)
      return (
        <div key={weaponId} className="group relative bg-linear-to-br from-card/80 to-card/40 rounded-lg p-2 cursor-pointer border border-border/20 hover:border-accent-cyan/40 transition-all duration-200 hover:scale-[1.02]" onMouseEnter={() => handleWeaponHover(hoverSkin)}>
          {/* Weapon type badge */}
          <div className="absolute top-1.5 left-2 z-10">
            <span className="text-[8px] font-bold uppercase tracking-wider text-accent-cyan/70">{weaponName}</span>
          </div>

          {/* Buddy indicator */}
          {hasBuddy && (
            <div className="absolute top-1.5 right-2 z-10">
              <div className="w-2 h-2 rounded-full bg-accent-gold/80 shadow-[0_0_6px_rgba(236,178,46,0.6)]" />
            </div>
          )}

          {/* Weapon image */}
          <div className="h-14 flex items-center justify-center mt-3">
            {icon && <CachedImage src={icon} alt="" className={`max-w-full max-h-full object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)] transition-all ${skin ? "group-hover:drop-shadow-[0_4px_12px_rgba(0,212,170,0.3)]" : "opacity-80"}`} />}
          </div>

          {/* Skin name */}
          <div className="mt-1.5 text-center">
            <div className="text-[9px] text-primary/90 font-medium truncate px-1">{skin ? meta?.name || "Standard" : "Standard"}</div>
          </div>
        </div>
      );
    }

    // Compact card for secondary/other weapons
    return (
      <div key={weaponId} className="group flex items-center gap-2 p-1.5 rounded-md cursor-pointer hover:bg-card/60 transition-all" onMouseEnter={() => handleWeaponHover(hoverSkin)}>
        <div className="w-12 h-7 flex items-center justify-center shrink-0">{icon && <CachedImage src={icon} alt="" className={`max-w-full max-h-full object-contain transition-opacity ${skin ? "opacity-80 group-hover:opacity-100" : "opacity-60"}`} />}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[8px] text-dim uppercase tracking-wide">{weaponName}</div>
          <div className="text-[9px] text-primary/80 truncate">{skin ? meta?.name || "Standard" : "Standard"}</div>
        </div>
        {hasBuddy && <div className="w-1.5 h-1.5 rounded-full bg-accent-gold/60 shrink-0" />}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Player Header - Compact */}
      <div className="p-2.5 border-b border-border/50 bg-linear-to-b from-[#0d1117] to-transparent">
        <div className="flex items-center gap-2.5">
          {agentIcon ? <img src={agentIcon} alt="" className="w-10 h-10 rounded-full object-cover" style={{ boxShadow: `0 0 12px ${agentColor}40`, border: `2px solid ${agentColor}` }} /> : <div className="w-10 h-10 rounded-full bg-card border border-border" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <button onClick={copyName} className="text-xs font-bold text-primary hover:text-accent-cyan transition-colors truncate text-left max-w-30">
                {selectedPlayer.name}
              </button>

              {/* Recent Encounter Badge */}
              {selectedPlayer.previous_encounter && (
                <div 
                  className="px-1.5 py-0.5 rounded-[4px] bg-accent-cyan/10 border border-accent-cyan/30 flex items-center gap-1 shrink-0 animate-pulse"
                  title={t(`player.recentEncounter${selectedPlayer.previous_encounter}`)}
                >
                  <div className="w-1 h-1 rounded-full bg-accent-cyan" />
                  <span className="text-[7px] font-bold text-accent-cyan uppercase tracking-tighter">
                    {locale === 'tr' 
                      ? (selectedPlayer.previous_encounter === 1 ? "GEÇEN MAÇ" : "2 MAÇ ÖNCE")
                      : (selectedPlayer.previous_encounter === 1 ? "LAST MATCH" : "2 MATCHES AGO")
                    }
                  </span>
                </div>
              )}

              {/* Translate Button */}
              <button
                onClick={handleTranslate}
                className={`p-1 rounded-full transition-colors ${isTranslating ? "text-accent-cyan cursor-wait" : translatedName ? "text-success cursor-default" : "text-dim hover:text-accent-cyan hover:bg-card-hover"}`}
                title={translatedName ? "Translated" : "Translate Name"}
              >
                {isTranslating ? (
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                  </svg>
                )}
              </button>
            </div>

            {translatedName && <div className="text-[10px] text-accent-gold/80 italic -mt-0.5 truncate">{translatedName}</div>}

            {copied && <span className="text-[8px] text-success block -mt-0.5">{t("player.copied")}</span>}

            <div className="flex items-center gap-1.5 mt-0.5">
              {selectedPlayer.agent && (
                <span className="text-[9px] font-semibold" style={{ color: agentColor }}>
                  {selectedPlayer.agent.charAt(0).toUpperCase() + selectedPlayer.agent.slice(1)}
                </span>
              )}
              {selectedPlayer.rank_tier > 0 && (
                <span className="text-[9px] font-medium" style={{ color: rankColor }}>
                  {rankName}
                </span>
              )}
              
              {/* Peak Rank Compact Display */}
              {peakRank && peakRank.tier > selectedPlayer.rank_tier && (
                <>
                  <span className="text-[8px] text-dim/50">•</span>
                  <div className="flex items-center gap-1" title={`${t("player.peak")}: ${getLocalizedRank(peakRank.tier)}`}>
                    <span className="text-[8px] font-bold text-dim uppercase tracking-wider">{t("player.peak")}</span>
                    <span className="text-[9px] font-bold" style={{ color: peakRank.rank_color }}>
                      {getLocalizedRank(peakRank.tier)}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Skins Content */}
      <div className="flex-1 overflow-y-auto" onMouseLeave={() => setHoveredWeapon(null)}>
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent-cyan border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {error && <div className="text-center py-6 text-error text-[10px]">{error}</div>}

        {!loading && !error && skins.length > 0 && (
          <div className="p-2 space-y-3">
            {/* PRIMARY - Grid of large cards */}
            <section>
              <div className="flex items-center gap-1.5 mb-1.5 px-1">
                <div className="w-1 h-3 bg-accent-cyan rounded-full" />
                <span className="text-[9px] font-bold uppercase tracking-wider text-accent-cyan/80">{t("weapons.primary")}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">{WEAPON_CATEGORIES.primary.map((id) => renderWeaponCard(id, true))}</div>
            </section>

            {/* SECONDARY - Compact list */}
            <section>
              <div className="flex items-center gap-1.5 mb-1 px-1">
                <div className="w-1 h-3 bg-accent-gold/70 rounded-full" />
                <span className="text-[9px] font-bold uppercase tracking-wider text-accent-gold/70">{t("weapons.secondary")}</span>
              </div>
              <div className="space-y-0.5">{WEAPON_CATEGORIES.secondary.map((id) => renderWeaponCard(id))}</div>
            </section>

            {/* OTHER - Compact list */}
            <section>
              <div className="flex items-center gap-1.5 mb-1 px-1">
                <div className="w-1 h-3 bg-dim/50 rounded-full" />
                <span className="text-[9px] font-bold uppercase tracking-wider text-dim/70">{t("weapons.other")}</span>
              </div>
              <div className="space-y-0.5">{WEAPON_CATEGORIES.other.map((id) => renderWeaponCard(id))}</div>
            </section>
          </div>
        )}

        {!loading && !error && skins.length === 0 && <div className="text-center py-6 text-dim text-[10px]">{t("player.noSkinData")}</div>}
      </div>
    </div>
  );
}
