import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CachedImage } from "./CachedImage";
import { usePanelStore } from "../stores/panelStore";
import { usePlayerStatsStore } from "../stores/playerStatsStore";
import { getLocalizedRank, useI18n } from "../lib/i18n";
import { RANK_TIERS } from "../lib/constants";
import { useAssetsStore } from "../stores/assetsStore";

const VAL_DARK = "bg-[#0f1923]";
const VAL_WHITE = "text-[#ece8e1]";

export function PlayerStatsPanel() {
  const { selectedPlayer } = usePanelStore();
  const { fetchStats, getStats, isLoading, getError, clearError, retryAfter } = usePlayerStatsStore();
  const { t, locale } = useI18n();
  const getAgentIcon = useAssetsStore((s) => s.getAgentIcon);

  const puuid = selectedPlayer?.puuid || "";
  const stats = getStats(puuid);
  const loading = isLoading(puuid);
  const error = getError(puuid);
  const isRateLimited = retryAfter > Date.now();
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isRateLimited) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isRateLimited]);

  useEffect(() => {
    if (puuid && !stats && !loading && !error && !isRateLimited) {
      fetchStats(puuid);
    }
  }, [puuid, stats, loading, error, isRateLimited, fetchStats]);

  const handleRetry = () => {
    if (!puuid || isRateLimited) return;
    clearError(puuid);
    fetchStats(puuid);
  };

  if (!selectedPlayer) return null;

  const level = selectedPlayer.level > 0 ? selectedPlayer.level : (stats?.account_level ?? 0);
  const tier = stats?.current_tier || selectedPlayer.rank_tier || 0;
  const rr = stats?.current_rr || selectedPlayer.rank_rr || 0;
  const [, rankColor] = RANK_TIERS[tier] || ["", "#768079"];
  const peakTier = stats?.peak_tier ?? 0;
  const [, peakColor] = RANK_TIERS[peakTier] || ["", "#768079"];
  const cardUrl = selectedPlayer.player_card_id
    ? `https://media.valorant-api.com/playercards/${selectedPlayer.player_card_id}/smallart.png`
    : null;
  const topAgentIcon = stats?.top_agent ? getAgentIcon(stats.top_agent) : null;
  const decided = stats ? stats.wins + stats.losses : 0;
  const record = decided > 0 ? t("stats.record", { wins: stats!.wins, losses: stats!.losses }) : "";
  const windowLabel = !stats
    ? t("stats.title")
    : stats.matches === 0
      ? t("stats.empty")
      : record
        ? `${t("stats.window", { n: stats.matches })} · ${record}`
        : t("stats.window", { n: stats.matches });
  const overview = [
    hasStat(stats?.kd) && {
      label: t("stats.kd"),
      value: stats!.kd,
      sublabel: t("stats.ratio"),
      hint: t("stats.desc.kd"),
      color: "emerald",
    },
    hasStat(stats?.win_rate) && {
      label: t("stats.winrate"),
      value: stats!.win_rate,
      sublabel: record,
      hint: t("stats.desc.winrate"),
      color: "indigo",
    },
  ].filter((card): card is StatCard => Boolean(card));
  const combat = [
    hasStat(stats?.acs) && { label: "ACS", value: stats!.acs, hint: t("stats.desc.acs") },
    hasStat(stats?.hs_pct) && { label: "HS%", value: stats!.hs_pct, hint: t("stats.desc.hs") },
    hasStat(stats?.adr) && { label: "ADR", value: stats!.adr, hint: t("stats.desc.adr") },
  ].filter((card): card is CombatCard => Boolean(card));

  return (
    <div data-stats-panel className={`relative flex flex-col h-full overflow-hidden ${VAL_DARK} border-l border-white/5`}>
      <div className="relative p-4 pb-2">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <div className="absolute -inset-0.5 bg-linear-to-br from-[#ff4655] to-dark opacity-30 blur-sm rounded-full" />
            <div className="relative w-14 h-14 bg-[#1c252e] ring-1 ring-white/10 rounded-full flex items-center justify-center overflow-hidden">
              {cardUrl && <CachedImage src={cardUrl} alt="" className="w-full h-full object-cover" />}
            </div>
            {level > 0 && (
              <Tooltip text={t("stats.desc.level")} className="absolute -bottom-1 -right-1 z-10">
                <div className="bg-[#1c252e] border border-white/10 px-1.5 py-0.5 rounded text-[9px] font-bold text-primary">
                  {t("stats.level")} {level}
                </div>
              </Tooltip>
            )}
          </div>

          <div className="flex-1 min-w-0">
            {selectedPlayer.name && (
              <h2 className={`text-base font-black tracking-wide uppercase truncate ${VAL_WHITE}`} title={selectedPlayer.name}>
                {selectedPlayer.name}
              </h2>
            )}
            <Tooltip text={t("stats.desc.window")} className="relative mt-0.5">
              <div className="text-[10px] font-bold text-white/40 tracking-wider">{windowLabel}</div>
            </Tooltip>
            {tier > 0 && (
              <Tooltip text={t("stats.desc.rank")} className="relative mt-1">
                <div className="text-[11px] font-black tracking-wide" style={{ color: rankColor }}>
                  {getLocalizedRank(tier, locale)}
                  {rr > 0 ? ` · ${rr} RR` : ""}
                </div>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2 custom-scrollbar">
        {loading && (
          <div className="h-48 flex flex-col items-center justify-center">
            <div className="w-8 h-8 border-2 border-[#ff4655] border-t-transparent animate-spin rounded-full" />
            <div className="mt-3 text-[10px] font-bold text-white/30 tracking-[0.2em] animate-pulse">
              {t("stats.loading").toUpperCase()}
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="h-48 flex flex-col items-center justify-center text-center p-4">
            <p className="text-xs font-medium text-white/50 mb-4 px-4">{t("stats.error")}</p>
            <button
              onClick={handleRetry}
              disabled={isRateLimited}
              className="px-6 py-2 bg-[#ff4655] hover:bg-[#ff4655]/90 disabled:opacity-40 text-white text-[10px] font-black tracking-widest uppercase transition-all"
              style={{ clipPath: "polygon(10% 0, 100% 0, 100% 100%, 0 100%, 0 25%)" }}
            >
              {t("stats.retry")}
            </button>
          </div>
        )}

        {stats && !loading && !error && (
          <div className="space-y-4 pb-3">
            {stats.matches === 0 ? (
              <div className="h-28 flex items-center justify-center text-center px-4">
                <p className="text-xs font-medium text-white/45">{t("stats.empty")}</p>
              </div>
            ) : (
              <>
                {overview.length > 0 && (
                  <div className={`grid gap-3 ${overview.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                    {overview.map((card) => (
                      <Tooltip key={card.label} text={card.hint}>
                        <BigStatCard label={card.label} value={card.value} sublabel={card.sublabel} color={card.color} />
                      </Tooltip>
                    ))}
                  </div>
                )}

                {combat.length > 0 && (
                  <div>
                    <SectionHeader title={t("stats.combatPerformance")} />
                    <div
                      className="grid gap-2 mt-1.5"
                      style={{ gridTemplateColumns: `repeat(${combat.length}, minmax(0, 1fr))` }}
                    >
                      {combat.map((card) => (
                        <Tooltip key={card.label} text={card.hint}>
                          <CompactStat label={card.label} value={card.value} highlight />
                        </Tooltip>
                      ))}
                    </div>
                  </div>
                )}

                <Tooltip text={t("stats.desc.kda")}>
                  <div className="bg-[#1c252e] border border-white/5 p-2.5 flex items-center justify-between px-6 relative overflow-hidden">
                    <div className="absolute inset-0 bg-linear-to-r from-emerald-500/5 via-transparent to-red-500/5 opacity-50" />
                    <KdaCell value={stats.kills} label={t("stats.kills")} color="text-emerald-400" />
                    <div className="w-px h-8 bg-white/10 rotate-12" />
                    <KdaCell value={stats.deaths} label={t("stats.deaths")} color="text-red-400" />
                    <div className="w-px h-8 bg-white/10 rotate-12" />
                    <KdaCell value={stats.assists} label={t("stats.assists")} color="text-cyan-400" />
                  </div>
                </Tooltip>
              </>
            )}

            {stats.act_games > 0 && (
              <Tooltip text={t("stats.desc.act")}>
                <div className="bg-[#1c252e] border border-white/5 px-3 py-2 flex items-center justify-between">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-white/35">{t("stats.act")}</span>
                  <span className="text-xs font-black text-primary">
                    {t("stats.actLine", { wins: stats.act_wins, games: stats.act_games })}
                  </span>
                </div>
              </Tooltip>
            )}

            {peakTier > 0 && (
              <div>
                <SectionHeader title={t("stats.peakRank")} />
                <Tooltip text={t("stats.desc.peak")}>
                <div className="mt-1 bg-[#1c252e] p-3 border border-white/5 relative overflow-hidden">
                  <div>
                    <div className="text-sm font-black tracking-wide" style={{ color: peakColor }}>
                      {getLocalizedRank(peakTier, locale)}
                    </div>
                    <div className="text-[9px] text-white/40 font-medium tracking-wider">
                      {t("stats.peakHint")}
                    </div>
                  </div>
                </div>
                </Tooltip>
              </div>
            )}

            {stats.top_agent && (
              <div>
                <SectionHeader title={t("stats.topAgent")} />
                <Tooltip text={t("stats.desc.agent")}>
                <div className="mt-1 flex items-center gap-3 bg-[#1c252e] p-2 border border-white/5">
                  {topAgentIcon && (
                    <CachedImage src={topAgentIcon} className="w-8 h-8 rounded border border-white/10 bg-black/40" alt="" />
                  )}
                  <div>
                    <div className="text-xs font-bold text-primary capitalize">{stats.top_agent}</div>
                    <div className="text-[9px] text-white/40">
                      {stats.top_agent_matches} {t("stats.matchesPlayed")}
                    </div>
                  </div>
                </div>
                </Tooltip>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function hasStat(value: string | undefined): boolean {
  return !!value && value !== "—" && value !== "-";
}

interface StatCard {
  label: string;
  value: string;
  sublabel: string;
  hint: string;
  color: string;
}

interface CombatCard {
  label: string;
  value: string;
  hint: string;
}

function KdaCell({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="text-center relative z-10">
      <div className={`text-xl font-black tracking-tight leading-none ${color}`}>{value}</div>
      <div className="text-[9px] font-bold text-white/30 tracking-widest mt-1">{label.toUpperCase()}</div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <div className="w-1 h-3 bg-[#ff4655]" />
      <span className="text-[10px] font-black uppercase tracking-widest text-white/30">{title}</span>
      <div className="h-px bg-white/5 flex-1" />
    </div>
  );
}

function BigStatCard({ label, value, sublabel, color }: { label: string; value: string; sublabel: string; color: string }) {
  const colorClasses: Record<string, string> = {
    emerald: "text-emerald-400 border-emerald-500/20 bg-emerald-500/5",
    indigo: "text-indigo-400 border-indigo-500/20 bg-indigo-500/5",
  };
  const active = colorClasses[color] || colorClasses.emerald;
  const [text, border, bg] = active.split(" ");
  return (
    <div className={`p-4 border ${border} ${bg} relative overflow-hidden`}>
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-current opacity-20" />
      <div className="text-[9px] font-black uppercase tracking-widest text-white/40 mb-1">{label}</div>
      <div className={`text-2xl font-black ${text} tracking-tighter`}>{value}</div>
      <div className="text-[9px] font-bold text-white/20 mt-1">{sublabel}</div>
    </div>
  );
}

function CompactStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-[#1c252e] p-2 border border-white/5 flex flex-col items-center justify-center text-center h-full">
      <div className="text-[8px] font-bold text-white/30 uppercase tracking-widest mb-0.5">{label}</div>
      <div className={`text-sm font-black ${highlight ? "text-primary" : "text-white/60"}`}>{value}</div>
    </div>
  );
}

function Tooltip({
  children,
  text,
  className = "relative w-full h-full",
}: {
  children: React.ReactNode;
  text: string;
  className?: string;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; panel: HTMLElement } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const aboveRef = useRef(true);

  const place = (e: React.MouseEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.closest("[data-stats-panel]");
    if (!(panel instanceof HTMLElement)) return;
    const bounds = panel.getBoundingClientRect();
    const cursorX = e.clientX - bounds.left;
    const cursorY = e.clientY - bounds.top;
    const tipW = tipRef.current?.offsetWidth ?? 120;
    const tipH = tipRef.current?.offsetHeight ?? 24;
    const pad = 8;
    const gap = 12;

    // Stay centered on the cursor. Near an edge it stops, it does not jump
    // to the other side.
    const x = Math.max(pad, Math.min(cursorX - tipW / 2, bounds.width - tipW - pad));

    const aboveY = cursorY - tipH - gap;
    if (aboveRef.current && aboveY < pad - 20) aboveRef.current = false;
    else if (!aboveRef.current && aboveY > pad + 20) aboveRef.current = true;
    const rawY = aboveRef.current ? aboveY : cursorY + gap;
    const y = Math.max(pad, Math.min(rawY, bounds.height - tipH - pad));

    setTip({ x, y, panel });
  };

  return (
    <div
      className={className}
      onMouseEnter={place}
      onMouseMove={place}
      onMouseLeave={() => {
        aboveRef.current = true;
        setTip(null);
      }}
    >
      {children}
      {tip &&
        createPortal(
          <div
            ref={tipRef}
            className="absolute z-50 pointer-events-none w-max max-w-36 rounded border border-white/20 bg-[#1c252e] px-2 py-1 text-[10px] font-semibold leading-tight text-white shadow-[0_6px_16px_rgba(0,0,0,0.55)]"
            style={{ left: tip.x, top: tip.y }}
          >
            {text}
          </div>,
          tip.panel,
        )}
    </div>
  );
}
