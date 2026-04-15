import { PlayerCard } from "./PlayerCard";
import { useGameStore } from "../stores/gameStore";
import { useI18n } from "../lib/i18n";

export function IngameState() {
  const { gameState } = useGameStore();
  const { t } = useI18n();

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-black text-accent-red">LIVE</span>
        {gameState.map_name && <span className="text-xs font-semibold text-secondary">{gameState.map_name}</span>}
      </div>

      {/* Allies */}
      <div className="mb-1">
        <span className="text-[10px] font-semibold text-accent-cyan">{t("ingame.allies")}</span>
      </div>
      <div className="space-y-1 mb-3">
        {gameState.allies.map((player) => (
          <PlayerCard key={player.puuid} player={player} />
        ))}
      </div>

      {/* Divider */}
      <div className="h-px bg-border my-3" />

      {/* Enemies */}
      <div className="mb-1">
        <span className="text-[10px] font-semibold text-accent-red">{t("ingame.enemies")}</span>
      </div>
      <div className="space-y-1">
        {gameState.enemies.map((player) => (
          <PlayerCard key={player.puuid} player={player} />
        ))}
      </div>
    </div>
  );
}
