import { useEffect, useState } from "react";
import { CachedImage } from "./common/CachedImage";
import { usePanelStore } from "../stores/panelStore";
import { usePlayerStatsStore } from "../stores/playerStatsStore";
import { useI18n } from "../lib/i18n";
import { invokeCommand } from "../utils/ipc";

// Valorant Themed Colors
const VAL_DARK = "bg-[#0f1923]";
const VAL_WHITE = "text-[#ece8e1]";

interface PeakRankData {
  tier: number;
  rank_name: string;
  rank_color: string;
  season_id: string;
}

export function PlayerStatsPanel() {
  const { selectedPlayer } = usePanelStore();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { fetchStats, getStats, isLoading, getError, clearError } = usePlayerStatsStore();
  const { t } = useI18n();

  const puuid = selectedPlayer?.puuid || "";
  const playerName = selectedPlayer?.name || "";

  const stats = getStats(puuid);
  const loading = isLoading(puuid);
  const error = getError(puuid);

  // Peak rank state
  const [peakRank, setPeakRank] = useState<PeakRankData | null>(null);
  const [peakRankLoading, setPeakRankLoading] = useState(false);

  useEffect(() => {
    if (puuid && playerName && !stats && !loading && !error) {
      fetchStats(playerName, puuid);
    }
  }, [puuid, playerName, stats, loading, error, fetchStats]);

  // Fetch peak rank when player changes
  useEffect(() => {
    if (puuid) {
      console.log(`[PlayerStatsPanel] Fetching peak rank for ${playerName} (${puuid})`);
      setPeakRankLoading(true);
      invokeCommand<PeakRankData | null>("get_peak_rank", { puuid })
        .then((data) => {
          console.log("[PlayerStatsPanel] Peak rank received:", data);
          setPeakRank(data);
        })
        .catch((err) => {
          console.error("[PlayerStatsPanel] Failed to fetch peak rank:", err);
          setPeakRank(null);
        })
        .finally(() => {
          setPeakRankLoading(false);
        });
    } else {
      setPeakRank(null);
    }
  }, [puuid]);

  const handleRetry = () => {
    if (puuid) {
      clearError(puuid);
      fetchStats(playerName, puuid);
    }
  };

  const getErrorMessage = (err: string): string => {
    switch (err) {
      case "PROFILE_PRIVATE":
        return t("stats.private");
      case "PLAYER_NOT_FOUND":
        return t("stats.notFound");
      case "RATE_LIMITED":
        return t("stats.rateLimited");
      default:
        return t("stats.error");
    }
  };

  if (!selectedPlayer) return null;

  return (
    <div className={`flex flex-col h-full overflow-hidden ${VAL_DARK} border-l border-white/5`}>
      {/* Header Profile */}
      <div className="relative p-4 pb-2">
        <div className="flex items-center gap-4">
          {/* Avatar Hexagon Mask */}
          <div className="relative group">
            <div className="absolute -inset-0.5 bg-linear-to-br from-[#ff4655] to-dark opacity-30 blur-sm rounded-full group-hover:opacity-60 transition duration-500" />
            <div className="relative w-14 h-14 bg-[#1c252e] ring-1 ring-white/10 rounded-full flex items-center justify-center overflow-hidden">
              {stats?.avatarUrl ? <CachedImage src={stats.avatarUrl} alt="" className="w-full h-full object-cover" /> : <span className="text-xl font-bold text-white/20">?</span>}
            </div>
            {/* Rank/Level Tag */}
            {stats && (
              <div className="absolute -bottom-1 -right-1 bg-[#1c252e] border border-white/10 px-1.5 py-0.5 rounded text-[9px] font-bold text-primary">
                {t("stats.level")} {stats.accountLevel}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h2
              className={`text-base font-black tracking-wide uppercase truncate ${VAL_WHITE}`}
              title={stats?.playerName || selectedPlayer.name}
            >
              {stats?.playerName || selectedPlayer.name}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] font-bold text-white/40 tracking-wider">{stats?.currentSeason || "SEASON"}</span>
              {stats?.privacy === "private" && <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-[9px] font-bold text-[#ff4655] tracking-wider uppercase">Private</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-2 custom-scrollbar">
        {/* Loading */}
        {loading && (
          <div className="h-48 flex flex-col items-center justify-center">
            <div className="w-8 h-8 border-2 border-[#ff4655] border-t-transparent animate-spin rounded-full" />
            <div className="mt-3 text-[10px] font-bold text-white/30 tracking-[0.2em] animate-pulse">{t("stats.loading").toUpperCase()}</div>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="h-48 flex flex-col items-center justify-center text-center p-4">
            <div className="w-10 h-10 rounded bg-red-500/10 flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-[#ff4655]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p className="text-xs font-medium text-white/50 mb-4 px-4">{getErrorMessage(error)}</p>
            <button
              onClick={handleRetry}
              className="px-6 py-2 bg-[#ff4655] hover:bg-[#ff4655]/90 text-white text-[10px] font-black tracking-widest uppercase transition-all"
              style={{ clipPath: "polygon(10% 0, 100% 0, 100% 100%, 0 100%, 0 25%)" }} // Valorant Button Shape
            >
              {t("stats.retry")}
            </button>
          </div>
        )}

        {/* Stats Grid */}
        {stats && !loading && !error && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-3">
            {/* Overview Cards (K/D and Win%) */}
            <div className="grid grid-cols-2 gap-3">
              {/* Left Item: align start */}
              <Tooltip text={t("stats.desc.kd")} placement="bottom" align="start">
                <BigStatCard label={t("stats.kd")} value={stats.kd} sublabel={t("stats.ratio")} color="emerald" />
              </Tooltip>
              {/* Right Item: align end */}
              <Tooltip text={t("stats.desc.winrate")} placement="bottom" align="end">
                <BigStatCard label={t("stats.winrate")} value={stats.winRate} sublabel={`${stats.matchesPlayed} ${t("stats.matchesPlayed")}`} color="indigo" />
              </Tooltip>
            </div>

            {/* Combat Matrix (ADR, HS%, KAST, Damage Delta) */}
            <div>
              <SectionHeader title={t("stats.combatPerformance")} />
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                <Tooltip text={t("stats.desc.adr")} placement="top" align="start">
                  <CompactStat label="ADR" value={stats.adr} highlight />
                </Tooltip>

                <Tooltip text={t("stats.desc.hs")} placement="top" align="end">
                  <CompactStat label="HS%" value={stats.headshotPct} highlight />
                </Tooltip>

                <Tooltip text={t("stats.desc.kast")} placement="top" align="start">
                  <div className="bg-[#1c252e] p-2 border border-white/5 flex flex-col items-center justify-center text-center h-full hover:bg-white/5 transition-colors">
                    <div className="text-[8px] font-bold text-white/30 uppercase tracking-widest mb-0.5">KAST</div>
                    <div className="text-sm font-black text-amber-400">{stats.kast}</div>
                  </div>
                </Tooltip>

                <Tooltip text={t("stats.desc.delta")} placement="top" align="end">
                  <div className="bg-[#1c252e] p-2 border border-white/5 flex flex-col items-center justify-center text-center h-full hover:bg-white/5 transition-colors">
                    <div className="text-[8px] font-bold text-white/30 uppercase tracking-widest mb-0.5">DELTA</div>
                    <div className={`text-sm font-black ${parseInt(stats.damageDelta) > 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {parseInt(stats.damageDelta) > 0 ? "+" : ""}
                      {stats.damageDelta}
                    </div>
                  </div>
                </Tooltip>
              </div>
            </div>

            {/* K/D/A Full Width Strip */}
            <Tooltip text={t("stats.desc.kda")} placement="top" align="center">
              <div className="bg-[#1c252e] border border-white/5 p-2.5 flex items-center justify-between px-6 relative overflow-hidden group">
                {/* Background Gradient */}
                <div className="absolute inset-0 bg-linear-to-r from-emerald-500/5 via-transparent to-red-500/5 opacity-50" />

                <div className="text-center relative z-10">
                  <div className="text-xl font-black text-emerald-400 tracking-tight leading-none">{stats.kills}</div>
                  <div className="text-[9px] font-bold text-white/30 tracking-widest mt-1">{t("stats.kills").toUpperCase()}</div>
                </div>

                <div className="w-px h-8 bg-white/10 rotate-12" />

                <div className="text-center relative z-10">
                  <div className="text-xl font-black text-red-400 tracking-tight leading-none">{stats.deaths}</div>
                  <div className="text-[9px] font-bold text-white/30 tracking-widest mt-1">DEATHS</div>
                </div>

                <div className="w-px h-8 bg-white/10 rotate-12" />

                <div className="text-center relative z-10">
                  <div className="text-xl font-black text-cyan-400 tracking-tight leading-none">{stats.assists}</div>
                  <div className="text-[9px] font-bold text-white/30 tracking-widest mt-1">ASSISTS</div>
                </div>
              </div>
            </Tooltip>

            {/* Impact Stats (First Bloods, Clutches, Aces, Econ) */}
            <div>
              <SectionHeader title={t("stats.impactMetrics")} />
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                <Tooltip text={t("stats.desc.firstBloods")} placement="top" align="start">
                  <div className="bg-[#1c252e] p-2 border border-white/5 relative overflow-hidden group hover:border-white/10 transition hover:bg-white/5">
                    <div className="text-[9px] font-bold text-white/40 uppercase tracking-wider mb-1">{t("stats.firstBloods")}</div>
                    <div className="text-xl font-black text-primary">{stats.firstBloods}</div>
                  </div>
                </Tooltip>

                <Tooltip text={t("stats.desc.clutches")} placement="top" align="end">
                  <div className="bg-[#1c252e] p-2 border border-white/5 relative overflow-hidden group hover:border-white/10 transition flex flex-col justify-between hover:bg-white/5">
                    <div className="flex justify-between items-start">
                      <div className="text-[9px] font-bold text-white/40 uppercase tracking-wider">{t("stats.clutches")}</div>
                      <div className="text-[9px] font-bold text-purple-400">{stats.clutchWinRate} WR</div>
                    </div>
                    <div className="text-xl font-black text-white mt-1">
                      {stats.clutches} <span className="text-[10px] font-medium text-white/30 ml-1">{t("stats.won")}</span>
                    </div>
                  </div>
                </Tooltip>

                <Tooltip text={t("stats.desc.aces")} placement="top" align="start">
                  <div className="bg-[#1c252e] p-2 border border-white/5 relative overflow-hidden group hover:border-white/10 transition hover:bg-white/5">
                    <div className="text-[9px] font-bold text-white/40 uppercase tracking-wider mb-1">ACES</div>
                    <div className="text-xl font-black text-accent-gold">{stats.aces}</div>
                  </div>
                </Tooltip>

                <Tooltip text={t("stats.desc.econ")} placement="top" align="end">
                  <div className="bg-[#1c252e] p-2 border border-white/5 relative overflow-hidden group hover:border-white/10 transition hover:bg-white/5">
                    <div className="text-[9px] font-bold text-white/40 uppercase tracking-wider mb-1">ECON RATING</div>
                    <div className="text-xl font-black text-white/80">{stats.econRating}</div>
                  </div>
                </Tooltip>
              </div>
            </div>

            {/* Peak Rank */}
            {(peakRank || peakRankLoading) && (
              <div>
                <SectionHeader title={t("stats.peakRank") || "PEAK RANK"} />
                <div className="mt-1 bg-[#1c252e] p-3 border border-white/5 relative overflow-hidden">
                  {peakRankLoading ? (
                    <div className="flex items-center justify-center py-2">
                      <div className="w-4 h-4 border-2 border-[#ff4655] border-t-transparent animate-spin rounded-full" />
                    </div>
                  ) : peakRank ? (
                    <div className="flex items-center gap-3">
                      {/* Rank Badge */}
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center font-black text-lg"
                        style={{
                          backgroundColor: `${peakRank.rank_color}20`,
                          color: peakRank.rank_color,
                          border: `1px solid ${peakRank.rank_color}40`
                        }}
                      >
                        {peakRank.tier}
                      </div>
                      <div className="flex-1">
                        <div
                          className="text-sm font-black tracking-wide"
                          style={{ color: peakRank.rank_color }}
                        >
                          {peakRank.rank_name}
                        </div>
                        <div className="text-[9px] text-white/40 font-medium tracking-wider">
                          ALL-TIME HIGHEST
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {/* Decorative gradient */}
                  {peakRank && (
                    <div
                      className="absolute inset-0 opacity-10 pointer-events-none"
                      style={{
                        background: `linear-gradient(135deg, ${peakRank.rank_color}40 0%, transparent 50%)`
                      }}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Top Agent */}
            {stats.topAgent && (
              <div>
                <SectionHeader title={t("stats.topAgent")} />
                <div className="mt-1 flex items-center gap-3 bg-[#1c252e] p-2 border border-white/5">
                  <CachedImage src={stats.topAgent.imageUrl} className="w-8 h-8 rounded border border-white/10 bg-black/40" alt="" />
                  <div>
                    <div className="text-xs font-bold text-primary">{stats.topAgent.name}</div>
                    <div className="text-[9px] text-white/40">
                      {stats.topAgent.matches} {t("stats.matchesPlayed")}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Components --

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <div className="w-1 h-3 bg-[#ff4655]" />
      <span className="text-[10px] font-black uppercase tracking-widest text-white/30">{title}</span>
      <div className="h-px bg-white/5 flex-1" />
    </div>
  );
}

function BigStatCard({ label, value, sublabel, color }: any) {
  const colorClasses: any = {
    emerald: "text-emerald-400 border-emerald-500/20 bg-emerald-500/5",
    indigo: "text-indigo-400 border-indigo-500/20 bg-indigo-500/5",
    red: "text-[#ff4655] border-[#ff4655]/20 bg-[#ff4655]/5",
  };
  const active = colorClasses[color] || colorClasses.emerald;

  return (
    <div className={`p-4 border ${active.split(" ")[1]} ${active.split(" ")[2]} relative overflow-hidden group transition-all hover:bg-opacity-20`}>
      {/* Simple accent line at top */}
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-current opacity-20" />

      <div className="text-[9px] font-black uppercase tracking-widest text-white/40 mb-1">{label}</div>
      <div className={`text-2xl font-black ${active.split(" ")[0]} tracking-tighter`}>{value}</div>
      <div className="text-[9px] font-bold text-white/20 mt-1">{sublabel}</div>
    </div>
  );
}

function CompactStat({ label, value, highlight }: any) {
  return (
    <div className="bg-[#1c252e] p-2 border border-white/5 flex flex-col items-center justify-center text-center h-full hover:bg-white/5 transition-colors">
      <div className="text-[8px] font-bold text-white/30 uppercase tracking-widest mb-0.5">{label}</div>
      <div className={`text-sm font-black ${highlight ? "text-primary" : "text-white/60"}`}>{value}</div>
    </div>
  );
}

function Tooltip({ children, text, placement = "top", align = "center" }: { children: React.ReactNode; text: string; placement?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end" }) {
  const vertical = placement === "top" || placement === "bottom";

  // Placement positioning
  const placementClasses = {
    top: "bottom-full mb-2",
    bottom: "top-full mt-2",
    left: "right-full mr-2",
    right: "left-full ml-2",
  };

  // Alignment positioning
  const alignClasses = vertical
    ? {
        start: "left-0 translate-x-0",
        center: "left-1/2 -translate-x-1/2",
        end: "right-0 translate-x-0",
      }
    : {
        start: "top-0 translate-y-0",
        center: "top-1/2 -translate-y-1/2",
        end: "bottom-0 translate-y-0",
      };

  // Arrow positioning
  const arrowClasses = {
    top: "top-full border-t-[#0f1923] border-b-transparent border-x-transparent -mt-px",
    bottom: "bottom-full border-b-[#0f1923] border-t-transparent border-x-transparent -mb-px",
    left: "left-full border-l-[#0f1923] border-r-transparent border-y-transparent -ml-px",
    right: "right-full border-r-[#0f1923] border-l-transparent border-y-transparent -mr-px",
  };

  const arrowAlignClasses = vertical
    ? {
        start: "left-4",
        center: "left-1/2 -translate-x-1/2",
        end: "right-4",
      }
    : {
        start: "top-4",
        center: "top-1/2 -translate-y-1/2",
        end: "bottom-4",
      };

  return (
    <div className="group relative w-full h-full">
      {children}
      <div
        className={`absolute ${placementClasses[placement]} ${alignClasses[align]} hidden group-hover:block w-max max-w-45 bg-dark text-primary text-[10px] font-medium px-2 py-1.5 rounded border border-white/10 shadow-xl z-50 pointer-events-none whitespace-pre-line text-center transition-all animate-in fade-in zoom-in-95 duration-200`}
      >
        {text}
        {/* Little arrow */}
        <div className={`absolute border-4 ${arrowClasses[placement]} ${arrowAlignClasses[align]}`} />
      </div>
    </div>
  );
}
