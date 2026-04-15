import { useGameStore } from "../stores/gameStore";
import { usePanelStore } from "../stores/panelStore";
import { useI18n } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";

export function Footer() {
  // Atomic selectors for performance
  const autoLockAgent = useGameStore((s) => s.autoLockAgent);
  const mapAgentPreferences = useGameStore((s) => s.mapAgentPreferences);
  const gameState = useGameStore((s) => s.gameState);
  const getAgentForMap = useGameStore((s) => s.getAgentForMap);
  const toggleAutoLock = useGameStore((s) => s.toggleAutoLock);
  const pausedAutoLockAgent = useGameStore((s) => s.pausedAutoLockAgent);
  const isOpen = usePanelStore((s) => s.isOpen);
  const panelType = usePanelStore((s) => s.panelType);
  const openSettings = usePanelStore((s) => s.openSettings);
  const close = usePanelStore((s) => s.close);
  const updateAvailable = useUpdateStore((s) => s.updateAvailable);
  const updateVersion = useUpdateStore((s) => s.updateVersion);
  const isDownloading = useUpdateStore((s) => s.isDownloading);
  const downloadProgress = useUpdateStore((s) => s.downloadProgress);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);
  const { t } = useI18n();

  // Determine what to display for auto-lock status
  const getAutoLockStatus = () => {
    // 1. If we are in a match/pregame, show the EFFECTIVE agent being locked
    if (gameState.map_name) {
      const agent = getAgentForMap(gameState.map_name);
      if (agent) return agent.toUpperCase();
    }

    // 2. If NO match active:
    // Case A: Has Global Default
    if (autoLockAgent) {
      // Also has some map specifics? Show "CUSTOM"
      if (Object.keys(mapAgentPreferences).length > 0) {
        return t("locale") === "tr" ? "ÖZEL" : "CUSTOM";
      }
      return autoLockAgent.toUpperCase();
    }

    // Case B: No Global, but has Map Specifics -> "CUSTOM"
    if (Object.keys(mapAgentPreferences).length > 0) {
      return t("locale") === "tr" ? "ÖZEL" : "CUSTOM";
    }

    // Case C: Paused but has config
    if (pausedAutoLockAgent) {
      if (Object.keys(mapAgentPreferences).length > 0) {
        return t("locale") === "tr" ? "ÖZEL" : "CUSTOM";
      }
      return pausedAutoLockAgent.toUpperCase();
    }

    return t("footer.inactive");
  };

  const statusText = getAutoLockStatus();
  // Active if we have an autoLockAgent OR (no global agent but map preferences exist and NOT paused)
  // Actually simpler: if statusText isn't 'Inactive', it's functionally active or configured
  // But strictly for the switch state, we check if autoLockAgent is set
  const isSwitchOn = !!autoLockAgent || (Object.keys(mapAgentPreferences).length > 0 && !pausedAutoLockAgent);

  const handleSettingsClick = () => {
    if (isOpen && panelType === "settings") {
      close();
    } else {
      openSettings();
    }
  };

  return (
    <footer className="flex items-center justify-between px-4 h-10 bg-card rounded-md mt-2">
      <div className="flex items-center gap-3">
        {/* Helper Text */}
        <div className="flex flex-col">
          <span className="text-[10px] text-dim uppercase tracking-wider font-bold">{t("footer.autoLock")}</span>
          <span className={`text-[11px] font-black leading-none ${isSwitchOn ? "text-accent-cyan" : "text-dim"}`}>{statusText}</span>
        </div>

        {/* Switch */}
        <button onClick={toggleAutoLock} className={`w-8 h-4 rounded-full relative transition-colors cursor-pointer ${isSwitchOn ? "bg-accent-cyan" : "bg-white/10"}`} title={isSwitchOn ? t("waiting.clickToDisable") : t("waiting.clickToEnable")}>
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm ${isSwitchOn ? "left-4.5" : "left-0.5"}`} />
        </button>
      </div>
      <div className="flex items-center gap-1">
        {updateAvailable && (
          <button
            onClick={downloadAndInstall}
            disabled={isDownloading}
            className="w-8 h-8 flex items-center justify-center rounded-md cursor-pointer border border-transparent text-accent-gold hover:bg-accent-gold/10 transition-colors"
            title={isDownloading ? `${downloadProgress}%` : `${t("header.update")} v${updateVersion}`}
          >
            {isDownloading ? (
              <div className="w-4 h-4 border-2 border-accent-gold border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
            )}
          </button>
        )}
        <button
          onClick={handleSettingsClick}
          className={`w-8 h-8 flex items-center justify-center rounded-md cursor-pointer border transition-colors ${isOpen && panelType === "settings" ? "text-accent-cyan bg-accent-cyan/20 border-accent-cyan" : "text-accent-cyan hover:bg-accent-cyan/20 bg-card-hover border-border"}`}
          title={t("settings.title")}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </footer>
  );
}
