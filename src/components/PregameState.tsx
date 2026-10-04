import { PlayerCard } from "./PlayerCard";
import { useGameStore } from "../stores/gameStore";
import { useI18n } from "../lib/i18n";
import { TeamHeading } from "./TeamHeading";

export function PregameState() {
  const { gameState } = useGameStore();
  const { t } = useI18n();
  const sideColor = gameState.side?.includes("SALDIRAN") || gameState.side?.includes("ATTACK") ? "text-accent-red" : "text-accent-cyan";

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-display text-[15px] font-bold tracking-[0.1em] uppercase text-warning">{t("pregame.selecting")}</span>
        <span className={`font-display text-[12px] font-bold tracking-[0.1em] px-1.5 py-0.5 rounded border border-current/30 bg-current/10 ${sideColor}`}>{gameState.side?.includes("SALDIRAN") || gameState.side?.includes("ATTACK") ? "ATK" : "DEF"}</span>
      </div>

      {/* Map info */}
      {(gameState.map_name || gameState.mode_name) && (
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-card/80 border border-white/[0.04] rounded-md mb-3">
          {gameState.map_name && <span className="font-display text-[13px] font-semibold tracking-wide text-primary">{gameState.map_name}</span>}
          {gameState.mode_name && <span className="text-[10px] font-semibold uppercase tracking-wider text-secondary">{gameState.mode_name}</span>}
        </div>
      )}

      {/* Team label */}
      <TeamHeading color="cyan" label={t("pregame.allies")} count={gameState.allies.length} />

      {/* Players */}
      <div className="space-y-1">
        {gameState.allies.map((player, i) => (
          <PlayerCard key={player.puuid} player={player} slotIndex={i + 1} />
        ))}
      </div>
    </div>
  );
}
