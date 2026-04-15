import { PlayerCard } from "./PlayerCard";
import { useGameStore } from "../stores/gameStore";
import { useI18n } from "../lib/i18n";

export function PregameState() {
  const { gameState } = useGameStore();
  const { t } = useI18n();
  const sideColor = gameState.side?.includes("SALDIRAN") || gameState.side?.includes("ATTACK") ? "text-accent-red" : "text-accent-cyan";

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-black text-warning">{t("pregame.selecting")}</span>
        <span className={`text-xs font-semibold ${sideColor}`}>{gameState.side?.includes("SALDIRAN") || gameState.side?.includes("ATTACK") ? "ATK" : "DEF"}</span>
      </div>

      {/* Map info */}
      {(gameState.map_name || gameState.mode_name) && (
        <div className="flex items-center justify-between px-2 py-1 bg-card rounded-md mb-3">
          {gameState.map_name && <span className="text-[11px] font-semibold text-primary">{gameState.map_name}</span>}
          {gameState.mode_name && <span className="text-[10px] text-secondary">{gameState.mode_name}</span>}
        </div>
      )}

      {/* Team label */}
      <div className="mb-2">
        <span className="text-[10px] font-semibold text-dim">{t("pregame.allies")}</span>
      </div>

      {/* Players */}
      <div className="space-y-1">
        {gameState.allies.map((player) => (
          <PlayerCard key={player.puuid} player={player} />
        ))}
      </div>
    </div>
  );
}
