import { PlayerCard } from "./PlayerCard";
import { useGameStore } from "../stores/gameStore";
import { useI18n } from "../lib/i18n";

function isRangeSession(mapName?: string | null, modeName?: string | null) {
  const blob = `${mapName || ""} ${modeName || ""}`.toLowerCase();
  return (
    blob.includes("range") ||
    blob.includes("poligon") ||
    blob.includes("poveglia")
  );
}

export function IngameState() {
  const { gameState } = useGameStore();
  const { t } = useI18n();
  const isRange = isRangeSession(gameState.map_name, gameState.mode_name);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className={`text-sm font-black ${isRange ? "text-accent-gold" : "text-accent-red"}`}>
          {isRange ? t("ingame.range") : "LIVE"}
        </span>
        {gameState.map_name && (
          <span className="text-xs font-semibold text-secondary">
            {isRange ? t("ingame.rangeMap") : gameState.map_name}
          </span>
        )}
      </div>

      {/* Allies */}
      <div className="mb-1">
        <span className="text-[10px] font-semibold text-accent-cyan">
          {isRange ? t("ingame.rangeYou") : t("ingame.allies")}
        </span>
      </div>
      <div className="space-y-1 mb-3">
        {gameState.allies.map((player, i) => (
          <PlayerCard key={player.puuid} player={player} slotIndex={i + 1} />
        ))}
      </div>

      {!isRange && (
        <>
          {/* Divider */}
          <div className="h-px bg-border my-3" />

          {/* Enemies */}
          <div className="mb-1">
            <span className="text-[10px] font-semibold text-accent-red">{t("ingame.enemies")}</span>
          </div>
          <div className="space-y-1">
            {gameState.enemies.map((player, i) => (
              <PlayerCard key={player.puuid} player={player} slotIndex={i + 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
