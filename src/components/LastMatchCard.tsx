import { useEffect, useState } from "react";
import { CachedImage } from "./CachedImage";
import { useAssetsStore } from "../stores/assetsStore";
import { useLastMatchStore } from "../stores/lastMatchStore";
import { useGameStore } from "../stores/gameStore";
import { useChatStore } from "../stores/chatStore";
import { AGENT_COLORS, RANK_TIERS, PARTY_COLORS } from "../lib/constants";
import { getLocalizedRank, useI18n } from "../lib/i18n";
import type { LastMatchPlayer } from "../lib/types";

function parseRiotId(name: string): { gameName: string; gameTag: string } | null {
  const hash = name.lastIndexOf("#");
  if (hash <= 0 || hash >= name.length - 1) return null;
  const gameName = name.slice(0, hash).trim();
  const gameTag = name.slice(hash + 1).trim();
  if (!gameName || !gameTag) return null;
  return { gameName, gameTag };
}

function queueLabel(queueId: string, t: (key: string) => string): string {
  const key = `queue.${queueId.toLowerCase()}`;
  const label = t(key);
  return label === key ? queueId : label;
}

function formatAgo(ms: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!ms) return "";
  const delta = Date.now() - ms;
  if (delta < 60_000) return t("lastMatch.justNow");
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return t("lastMatch.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("lastMatch.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("lastMatch.daysAgo", { n: days });
}

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function LastMatchPlayerRow({
  player,
  slotIndex,
  showPlacement,
}: {
  player: LastMatchPlayer;
  slotIndex: number;
  showPlacement?: boolean;
}) {
  const { t, locale } = useI18n();
  const getAgentIcon = useAssetsStore((s) => s.getAgentIcon);
  const friends = useChatStore((s) => s.friends);
  const outgoingRequests = useChatStore((s) => s.outgoingRequests);
  const sendFriendRequest = useChatStore((s) => s.sendFriendRequest);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);

  const agentColor = AGENT_COLORS[player.agent?.toLowerCase()] || "#768079";
  const rankColor = RANK_TIERS[player.rank_tier]?.[1] || "#768079";
  const rankName = getLocalizedRank(player.rank_tier, locale);
  const agentIcon = player.agent ? getAgentIcon(player.agent) : null;
  const partyIndex =
    player.party.startsWith("Grup-") || player.party.startsWith("Group-")
      ? parseInt(player.party.split("-")[1], 10) - 1
      : -1;
  const partyColor = partyIndex >= 0 ? PARTY_COLORS[partyIndex % 4] : null;
  const rawName = (player.name || "").trim();
  const displayName = rawName || t("player.anonymousSlot", { n: slotIndex });
  const shortName = displayName.includes("#") ? displayName.split("#")[0] : displayName;
  const riotId = parseRiotId(rawName);
  const isFriend = friends.some((f) => f.puuid === player.puuid);
  const isPending = outgoingRequests.some((r) => r.puuid === player.puuid);
  const canAdd = !player.is_me && !!riotId && !isFriend && !isPending;

  const copyName = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!rawName) return;
    try {
      await navigator.clipboard.writeText(rawName);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  const addFriend = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canAdd || !riotId || adding) return;
    setAdding(true);
    try {
      await sendFriendRequest(riotId.gameName, riotId.gameTag, player.puuid);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className={`relative h-8 rounded px-1.5 ${
        player.is_me ? "bg-white/[0.04]" : "bg-white/[0.025]"
      }`}
      style={{ display: "flex", width: "100%", alignItems: "center", boxSizing: "border-box" }}
    >
      {partyColor && (
        <div
          className="absolute left-0.5 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-sm opacity-70"
          style={{ backgroundColor: partyColor }}
        />
      )}

      {showPlacement && (
        <span className="shrink-0 text-center text-[9px] font-bold text-dim/80 tabular-nums" style={{ width: 14 }}>
          {slotIndex}
        </span>
      )}
      <div className="shrink-0 flex items-center justify-center" style={{ width: 20 }}>
        {agentIcon ? (
          <CachedImage
            src={agentIcon}
            alt={player.agent}
            className="rounded-full object-cover opacity-90"
            style={{ width: 18, height: 18, border: `1px solid ${agentColor}40` }}
          />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-dim" />
        )}
      </div>
      <button
        type="button"
        onClick={(e) => void copyName(e)}
        disabled={!rawName}
        title={rawName ? t("lastMatch.copyName") : undefined}
        className={`text-[11px] font-medium text-left ${
          player.is_me ? "text-accent-gold/80" : "text-primary/80 hover:text-primary"
        } ${rawName ? "cursor-pointer" : "cursor-default"}`}
        style={{
          flex: "1 1 0%",
          minWidth: 0,
          marginLeft: 6,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {copied ? t("player.copied") : shortName}
      </button>

      <div
        className="shrink-0 flex items-center"
        style={{ marginLeft: "auto", gap: 4 }}
      >
        <div className="flex items-center justify-center" style={{ width: 20 }}>
          {!player.is_me && riotId ? (
            <button
              type="button"
              onClick={(e) => void addFriend(e)}
              disabled={!canAdd || adding}
              title={
                isFriend
                  ? t("lastMatch.alreadyFriend")
                  : isPending
                    ? t("lastMatch.alreadyPending")
                    : t("lastMatch.addFriend")
              }
              className={`flex items-center justify-center rounded-full transition-colors ${
                isFriend
                  ? "text-accent-cyan/40 cursor-default"
                  : isPending
                    ? "text-accent-gold/45 cursor-default"
                    : adding
                      ? "text-accent-cyan/70 cursor-wait"
                      : "text-secondary/80 hover:text-accent-cyan hover:bg-accent-cyan/15 hover:ring-1 hover:ring-accent-cyan/40 cursor-pointer"
              }`}
              style={{ width: 18, height: 18 }}
            >
              {isFriend ? (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : isPending ? (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="8" />
                  <path d="M12 8v4l2.5 1.5" strokeLinecap="round" />
                </svg>
              ) : adding ? (
                <span className="block w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin" />
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" strokeLinecap="round" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M19 8v6M16 11h6" strokeLinecap="round" />
                </svg>
              )}
            </button>
          ) : null}
        </div>
        <span
          className="text-right text-[10px] font-medium tabular-nums text-primary/55"
          style={{ width: 48 }}
        >
          {player.kills}/{player.deaths}/{player.assists}
        </span>
        <span
          className="text-right text-[9px] font-medium tabular-nums text-dim"
          style={{ width: 28 }}
        >
          {player.acs || "—"}
        </span>
        {player.rank_tier > 0 && (
          <span
            className="text-right text-[9px] font-medium opacity-80"
            style={{
              width: 52,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: rankColor,
            }}
          >
            {rankName}
          </span>
        )}
      </div>
    </div>
  );
}

export function LastMatchCard() {
  const { t } = useI18n();
  const status = useGameStore((s) => s.status);
  const { match, loading, refreshing, pending, error, expanded, fetchLastMatch, setExpanded } =
    useLastMatchStore();
  const getMapSplash = useAssetsStore((s) => s.getMapSplash);
  const getAgentIcon = useAssetsStore((s) => s.getAgentIcon);
  const fetchFriends = useChatStore((s) => s.fetchFriends);
  const fetchOutgoingRequests = useChatStore((s) => s.fetchOutgoingRequests);

  const connected = status === "CONNECTED";

  useEffect(() => {
    if (connected && !pending) {
      void fetchLastMatch(false);
    }
  }, [connected, pending, fetchLastMatch]);

  if (!connected && !match) return null;

  if ((loading || pending) && !match) {
    return (
      <div className="shrink-0 rounded-lg border border-white/[0.04] bg-black/20 px-2.5 py-1.5">
        <div className="flex items-center gap-2 text-[10px] text-dim">
          <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-accent-cyan/50 border-t-transparent animate-spin" />
          {pending ? t("lastMatch.processing") : t("lastMatch.loading")}
        </div>
      </div>
    );
  }

  if (!match) {
    if (error === "error") {
      return (
        <button
          type="button"
          onClick={() => void fetchLastMatch(true)}
          className="shrink-0 rounded-lg border border-white/[0.04] bg-black/20 px-2.5 py-1.5 text-left hover:bg-white/[0.03] transition-colors"
        >
          <span className="text-[9px] font-black uppercase tracking-[0.14em] text-dim mr-2">
            {t("lastMatch.title")}
          </span>
          <span className="text-[10px] text-secondary">{t("lastMatch.error")}</span>
        </button>
      );
    }
    return null;
  }

  const splash = getMapSplash(match.map_name);
  const meIcon = match.me.agent ? getAgentIcon(match.me.agent) : null;
  const resultKey =
    match.won === true ? "lastMatch.victory" : match.won === false ? "lastMatch.defeat" : "lastMatch.draw";
  const resultColor =
    match.won === true
      ? "text-accent-cyan/55"
      : match.won === false
        ? "text-accent-red/50"
        : "text-accent-gold/50";
  const surrendered = match.completion_state.toLowerCase() === "surrendered";
  const ago = formatAgo(match.game_start_millis, t);
  const duration = formatDuration(match.game_length_millis);
  const mode = queueLabel(match.queue_id, t);

  const handleToggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    void fetchFriends();
    void fetchOutgoingRequests();
    await fetchLastMatch(true);
  };

  return (
    <div
      className={`shrink-0 flex flex-col rounded-lg border border-white/[0.04] bg-black/20 overflow-hidden ${
        pending ? "opacity-70" : ""
      }`}
      style={{ width: "100%", alignSelf: "stretch" }}
    >
      <button
        type="button"
        onClick={() => void handleToggle()}
        className="relative shrink-0 w-full h-[44px] text-left hover:bg-white/[0.02] transition-colors"
      >
        {splash && (
          <div
            className="absolute inset-y-0 left-0 w-14 pointer-events-none opacity-20"
            style={{
              backgroundImage: `url(${splash})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              maskImage: "linear-gradient(to right, black 30%, transparent)",
              WebkitMaskImage: "linear-gradient(to right, black 30%, transparent)",
            }}
          />
        )}

        <div className="relative z-10 h-full flex items-center gap-2 px-2">
          {meIcon && (
            <CachedImage
              src={meIcon}
              alt={match.me.agent}
              className="w-6 h-6 rounded-full object-cover shrink-0 opacity-75"
            />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold tracking-wide text-primary/80 truncate">
                {match.map_name}
              </span>
              <span className="text-[9px] font-medium text-dim truncate">{mode}</span>
              {surrendered && (
                <span className="text-[8px] font-bold uppercase tracking-wider text-warning/70">
                  {t("lastMatch.surrender")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-px">
              <span className="text-[10px] font-medium tabular-nums text-primary/50">
                {match.me.kills}/{match.me.deaths}/{match.me.assists}
              </span>
              {ago && <span className="text-[9px] text-dim/80">{ago}</span>}
              {duration && <span className="text-[9px] text-dim/50">· {duration}</span>}
              {(refreshing || loading || pending) && (
                <span className="inline-block w-2 h-2 rounded-full border border-dim/60 border-t-transparent animate-spin" />
              )}
            </div>
          </div>

          <div className="shrink-0 text-right leading-none">
            {match.is_ffa ? (
              <>
                <div className={`text-[8px] font-bold uppercase tracking-wider ${resultColor}`}>
                  {match.placement ? `#${match.placement}` : t(resultKey)}
                </div>
                <div className="mt-0.5 text-[13px] font-bold tabular-nums text-primary/70">
                  {match.me.kills}
                </div>
              </>
            ) : (
              <>
                <div className={`text-[8px] font-bold uppercase tracking-[0.12em] ${resultColor}`}>
                  {t(resultKey)}
                </div>
                <div className="mt-0.5 text-[13px] font-bold tabular-nums tracking-tight text-primary/70">
                  <span>{match.ally_score}</span>
                  <span className="mx-0.5 text-dim/50 text-[11px]">–</span>
                  <span>{match.enemy_score}</span>
                </div>
              </>
            )}
          </div>

          <svg
            className={`w-3 h-3 shrink-0 text-dim/50 transition-transform ${expanded ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div
          className="relative z-10 max-h-[220px] overflow-x-hidden overflow-y-auto px-1.5 pb-1.5 pt-1 border-t border-white/[0.03]"
          style={{ width: "100%" }}
        >
          {match.is_ffa ? (
            <>
              <div className="px-1 mb-1 text-[9px] font-black tracking-widest text-dim">
                {t("lastMatch.placement")}
              </div>
              <div className="space-y-0.5">
                {[match.me, ...match.enemies]
                  .sort((a, b) => b.kills - a.kills || b.score - a.score)
                  .map((p, i) => (
                    <LastMatchPlayerRow key={p.puuid} player={p} slotIndex={i + 1} showPlacement />
                  ))}
              </div>
            </>
          ) : (
            <>
              <div className="px-1 mb-1 text-[9px] font-black tracking-widest text-accent-cyan">
                {t("lastMatch.allies")}
              </div>
              <div className="w-full min-w-0 space-y-0.5 mb-2">
                {match.allies.map((p, i) => (
                  <LastMatchPlayerRow key={p.puuid} player={p} slotIndex={i + 1} />
                ))}
              </div>
              <div className="px-1 mb-1 text-[9px] font-black tracking-widest text-accent-red">
                {t("lastMatch.enemies")}
              </div>
              <div className="w-full min-w-0 space-y-0.5">
                {match.enemies.map((p, i) => (
                  <LastMatchPlayerRow key={p.puuid} player={p} slotIndex={i + 1} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
