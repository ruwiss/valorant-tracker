import { PlayerCard } from "./PlayerCard";
import { useGameStore } from "../stores/gameStore";
import { useI18n } from "../lib/i18n";
import { TeamHeading } from "./TeamHeading";

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
        <span className={`flex items-center gap-1.5 font-display text-[15px] font-bold tracking-[0.1em] ${isRange ? "text-accent-gold" : "text-accent-red"}`}>
          {!isRange && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent-red opacity-60 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-red" />
            </span>
          )}
          {isRange ? t("ingame.range") : t("ingame.live")}
        </span>
        {gameState.map_name && (
          <span className="font-display text-[13px] font-semibold tracking-wide text-primary/85">
            {isRange ? t("ingame.rangeMap") : gameState.map_name}
          </span>
        )}
      </div>

      {/* Allies */}
      <TeamHeading color="cyan" label={isRange ? t("ingame.rangeYou") : t("ingame.allies")} count={gameState.allies.length} />
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
          <TeamHeading color="red" label={t("ingame.enemies")} count={gameState.enemies.length} />
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
