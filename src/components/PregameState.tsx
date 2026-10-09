import { useEffect, useState } from "react";
import { PlayerCard } from "./PlayerCard";
import { useGameStore } from "../stores/gameStore";
import { tLocale, useI18n } from "../lib/i18n";
import { isAttackSide, localeForGame, modeI18nKey } from "../lib/matchLabels";
import { invokeCommand } from "../utils/ipc";
import { TeamHeading } from "./TeamHeading";

export function PregameState() {
  const { gameState } = useGameStore();
  const { t, locale } = useI18n();
  const [clientLocale, setClientLocale] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invokeCommand<string | null>("get_client_locale", undefined, {
      suppressErrorToast: true,
    }).then((value) => {
      if (!cancelled) setClientLocale(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const labelLocale = localeForGame(clientLocale, locale);
  const attack = isAttackSide(gameState.side) === true;
  const sideColor = attack ? "text-accent-red" : "text-accent-cyan";
  const sideLabel = tLocale(labelLocale, attack ? "side.attack" : "side.defense");
  const modeKey = modeI18nKey(gameState.queue_id, gameState.mode_name);
  const modeLabel = modeKey ? tLocale(labelLocale, modeKey) : gameState.mode_name;
  const shownMode = modeLabel && modeLabel !== modeKey ? modeLabel : gameState.mode_name;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-display text-[15px] font-bold tracking-[0.1em] uppercase text-warning">{t("pregame.selecting")}</span>
        <span className={`font-display text-[12px] font-bold tracking-[0.1em] px-1.5 py-0.5 rounded border border-current/30 bg-current/10 ${sideColor}`}>{sideLabel}</span>
      </div>

      {/* Map info */}
      {(gameState.map_name || shownMode) && (
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-card/80 border border-white/[0.04] rounded-md mb-3">
          {gameState.map_name && <span className="font-display text-[13px] font-semibold tracking-wide text-primary">{gameState.map_name}</span>}
          {shownMode && <span className="text-[10px] font-semibold uppercase tracking-wider text-secondary">{shownMode}</span>}
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
