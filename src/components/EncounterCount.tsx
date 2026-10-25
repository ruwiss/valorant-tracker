import { useI18n } from "../lib/i18n";

/** Compact match-count next to a player name. Hidden until you have met them. */
export function EncounterCount({ count }: { count?: number | null }) {
  const { t } = useI18n();
  const n = count ?? 0;
  if (n <= 0) return null;
  const title = n === 1 ? t("player.timesSeenOne") : t("player.timesSeen", { n });
  return (
    <span
      title={title}
      className="shrink-0 text-[9px] font-semibold tabular-nums leading-none text-white/45"
    >
      ×{n}
    </span>
  );
}
