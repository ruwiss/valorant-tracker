import { useEffect } from "react";
import { usePanelStore } from "../stores/panelStore";
import { SettingsPanel } from "./SettingsPanel";
import { PlayerPanel } from "./PlayerPanel";
import { PlayerStatsPanel } from "./PlayerStatsPanel";
import { useI18n } from "../lib/i18n";

export function SidePanel() {
  const { isOpen, panelType, close } = usePanelStore();
  const { t } = useI18n();

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const getTitle = () => {
    switch (panelType) {
      case "settings":
        return t("settings.title");
      case "stats":
        return t("stats.title");
      default:
        return t("player.weaponSkins");
    }
  };

  return (
    <div className="w-65 min-w-65 max-w-65 h-full bg-[#0a0e13]/95 backdrop-blur-md border-l border-accent-cyan/20 flex flex-col shadow-[-15px_0_30px_-10px_rgba(0,0,0,0.5)] animate-slide-enter-right relative overflow-hidden flex-none z-20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-gradient-to-r from-white/5 to-transparent">
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-3 bg-accent-cyan shadow-[0_0_8px_rgba(0,212,170,0.5)]" />
          <span className="text-[11px] font-bold text-gray-200 uppercase tracking-widest">{getTitle()}</span>
        </div>
        <button
          onClick={close}
          className="w-6 h-6 flex items-center justify-center text-dim hover:text-white hover:bg-white/10 rounded transition-all duration-200 group"
          title="Close"
        >
          <svg className="w-3.5 h-3.5 transition-transform duration-300 group-hover:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {panelType === "settings" && <SettingsPanel />}
        {panelType === "player" && <PlayerPanel />}
        {panelType === "stats" && <PlayerStatsPanel />}
      </div>

      {/* Bottom accent line */}
      <div className="h-0.5 bg-linear-to-r from-transparent via-accent-cyan/50 to-transparent" />
    </div>
  );
}
