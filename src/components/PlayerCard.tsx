import type { PlayerData } from "../lib/types";
import { CachedImage } from "./CachedImage";
import { AGENT_COLORS, RANK_TIERS, PARTY_COLORS } from "../lib/constants";
import { useI18n } from "../lib/i18n";
import { useAssetsStore } from "../stores/assetsStore";
import { usePanelStore } from "../stores/panelStore";
import { usePlayerStatsStore } from "../stores/playerStatsStore";
import { useState, useEffect } from "react";

interface Props {
  player: PlayerData;
  /** 1-based team slot (for anonymous "Player N" labels). */
  slotIndex?: number;
}

export function PlayerCard({ player, slotIndex = 1 }: Props) {
  const { t } = useI18n();
  const { getAgentIcon } = useAssetsStore();
  const { openPlayer, openStats, selectedPlayer, panelType } = usePanelStore();
  const { getError, getStats, fetchStats, isLoading, retryAfter } = usePlayerStatsStore();

  // Check if this player is currently selected (viewing skins)
  const isSelected = panelType === "player" && selectedPlayer?.puuid === player.puuid;

  const agentColor = AGENT_COLORS[player.agent?.toLowerCase()] || "#768079";
  const [rankName, rankColor] = RANK_TIERS[player.rank_tier] || ["", "#768079"];
  const partyIndex = player.party.startsWith("Grup-") || player.party.startsWith("Group-") ? parseInt(player.party.split("-")[1]) - 1 : -1;
  const partyColor = partyIndex >= 0 ? PARTY_COLORS[partyIndex % 4] : null;
  const agentIcon = player.agent ? getAgentIcon(player.agent) : null;
  const previousAgentIcon = player.previous_encounter_agent ? getAgentIcon(player.previous_encounter_agent) : null;
  const previousAgentName = player.previous_encounter_agent
    ? player.previous_encounter_agent.charAt(0).toUpperCase() + player.previous_encounter_agent.slice(1)
    : null;

  const statusColor = player.locked ? "bg-success" : player.agent ? "bg-warning" : "bg-dim";
  const isPrivate = getError(player.puuid) === "PROFILE_PRIVATE";
  const stats = getStats(player.puuid);
  const loading = isLoading(player.puuid);
  const hasStats = !!stats;

  // Soft player-card banner (wide art) behind the row — does not cover names.
  // Media path is wideart.png (not wide.png) per valorant-api.
  const cardBannerUrl = player.player_card_id
    ? `https://media.valorant-api.com/playercards/${player.player_card_id}/wideart.png`
    : null;

  // Hidden Riot ID: backend uses agent name when known; before agent select
  // the name is empty — match in-game "Player 1" / "1. Oyuncu" labeling.
  const displayName = (() => {
    const raw = (player.name || "").trim();
    if (raw) return raw;
    if (player.agent) {
      return player.agent.charAt(0).toUpperCase() + player.agent.slice(1);
    }
    return t("player.anonymousSlot", { n: slotIndex });
  })();

  // Rate limit logic (force re-render every second if active to update tooltip/state)
  const now = Date.now();
  const isRateLimited = retryAfter > now;
  const rateLimitRemaining = isRateLimited ? Math.ceil((retryAfter - now) / 1000) : 0;

  // Force update component when rate limit is active (for countdown)
  const [, setTick] = useState(0);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (isRateLimited) {
      const timer = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(timer);
    }
  }, [isRateLimited]);

  const handleStatsClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPrivate || loading || isRateLimited) return;

    if (hasStats) {
      openStats(player);
      return;
    }

    // Lazy load stats
    await fetchStats(player.name, player.puuid);
    // After fetch, check state again
    const newState = usePlayerStatsStore.getState();
    const newStats = newState.getStats(player.puuid);
    const newError = newState.getError(player.puuid);

    if (newStats && !newError) {
      openStats(player);
    } else {
      // Show error feedback for 2 seconds
      setFetchError(true);
      setTimeout(() => setFetchError(false), 2000);
    }
  };

  return (
    <div
      className={`group/row relative flex items-center h-10 px-2 rounded-md overflow-hidden transition-colors cursor-pointer ${
        isSelected
          ? "bg-accent-cyan/20 ring-1 ring-accent-cyan/40"
          : player.is_me
            ? "bg-[#1e2a36]"
            : "bg-card hover:bg-card-hover"
      }`}
      onClick={() => openPlayer(player)}
    >
      {/* Soft player-card banner — stronger wash when this row is selected.
          Parent opacity multiplies softOpacity so selection updates without remount. */}
      {cardBannerUrl && (
        <>
          <div
            className={`pointer-events-none absolute inset-0 transition-[opacity,filter] duration-300 ${
              isSelected
                ? "opacity-100 saturate-[0.95] brightness-105"
                : "opacity-[0.55] saturate-[0.7] brightness-95 group-hover/row:opacity-[0.7]"
            }`}
          >
            <CachedImage
              src={cardBannerUrl}
              alt=""
              silent
              softOpacity={0.4}
              className="absolute inset-0 h-full w-full object-cover object-[center_30%] select-none"
            />
          </div>
          {/* Tint toward panel colors — lighter when selected so art reads more clearly */}
          <div
            className={`pointer-events-none absolute inset-0 bg-gradient-to-r transition-colors duration-300 ${
              isSelected
                ? "from-[#1a242d]/65 via-[#1a242d]/42 to-[#1a242d]/22"
                : "from-[#1a242d]/88 via-[#1a242d]/72 to-[#1a242d]/55"
            }`}
            aria-hidden
          />
          <div
            className={`pointer-events-none absolute inset-0 transition-colors duration-300 ${
              isSelected ? "bg-[#0f1923]/05" : "bg-[#0f1923]/18"
            }`}
            aria-hidden
          />
        </>
      )}

      {/* Party indicator */}
      {partyColor && (
        <div
          className="absolute left-0.5 top-1/2 z-10 -translate-y-1/2 w-0.75 h-7 rounded-sm"
          style={{ backgroundColor: partyColor }}
        />
      )}

      {/* Agent icon or status dot */}
      <div className="relative z-10 w-7 h-7 flex items-center justify-center ml-1">
        {agentIcon ? (
          <CachedImage
            src={agentIcon}
            alt={player.agent}
            className="w-6 h-6 rounded-full object-cover"
            style={{
              boxShadow: `0 0 8px ${agentColor}40`,
              border: `1.5px solid ${agentColor}60`,
            }}
          />
        ) : (
          <div className={`w-2 h-2 rounded-full ${statusColor}`} />
        )}
      </div>

      {/* Agent name */}
      <span
        className="relative z-10 w-14 ml-1 text-[10px] font-semibold truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
        style={{ color: player.agent ? agentColor : "#4a5568" }}
      >
        {player.agent ? player.agent.charAt(0).toUpperCase() + player.agent.slice(1) : "—"}
      </span>

      {/* Name */}
      <span
        className={`relative z-10 flex-1 min-w-0 text-xs font-semibold truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)] ${
          player.is_me
            ? "text-accent-gold"
            : !player.name?.trim() && !player.agent
              ? "text-secondary italic"
              : "text-primary"
        }`}
        title={displayName}
      >
        {displayName}
      </span>

      {/* Level - left of stats button, tries initial data then stats data */}
      {(player.level > 0 || (stats?.accountLevel ?? 0) > 0) && (
        <span className="relative z-10 text-[10px] text-dim mr-2 group-hover/row:text-primary transition-colors drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
          {t("player.level")} {player.level > 0 ? player.level : (stats?.accountLevel ?? 0)}
        </span>
      )}

      {/* Previous encounter agent */}
      {player.previous_encounter && previousAgentIcon && previousAgentName && (
        <div
          className="relative z-10 mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent-cyan/35 bg-black/30 shadow-[0_0_10px_rgba(0,212,170,0.18)]"
          title={`${t(`player.recentEncounter${player.previous_encounter}`)}${player.previous_encounter_was_enemy ? t("player.encounterEnemySuffix") : ""} • ${t("player.previousAgent", { agent: previousAgentName })}`}
        >
          <CachedImage
            src={previousAgentIcon}
            alt={previousAgentName}
            className="h-5 w-5 rounded-full object-cover"
          />
        </div>
      )}

      {/* Stats button */}
      <button
        onClick={handleStatsClick}
        disabled={isPrivate || loading || isRateLimited}
        className={`relative z-10 p-1 mr-1 rounded transition-colors group flex items-center justify-center ${
          loading
            ? "cursor-wait opacity-70"
            : isRateLimited
              ? "opacity-50 cursor-not-allowed text-warning"
              : isPrivate
                ? "opacity-30 cursor-not-allowed"
                : hasStats
                  ? "hover:bg-accent-cyan/20 cursor-pointer"
                  : "opacity-50 hover:opacity-100 hover:bg-accent-cyan/20 cursor-pointer"
        }`}
        title={
          loading
            ? t("stats.loading")
            : isRateLimited
              ? `Rate Limit! Wait ${rateLimitRemaining}s`
              : isPrivate
                ? t("player.hiddenProfile")
                : t("stats.title")
        }
      >
        {loading ? (
          <svg className="w-3.5 h-3.5 animate-spin text-dim" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
        ) : isRateLimited ? (
          <span className="text-[9px] font-bold text-warning">429</span>
        ) : (
          <svg
            className={`w-3.5 h-3.5 transition-colors ${
              fetchError
                ? "text-red-500"
                : isPrivate
                  ? "text-dim"
                  : hasStats
                    ? "text-accent-cyan group-hover:text-accent-cyan/80"
                    : "text-dim group-hover:text-accent-cyan/80"
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
        )}
      </button>

      {/* Rank */}
      {player.rank_tier > 0 && (
        <span
          className="relative z-10 text-[11px] font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
          style={{ color: rankColor }}
        >
          {rankName}
        </span>
      )}
    </div>
  );
}
