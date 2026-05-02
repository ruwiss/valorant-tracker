import { useGameStore } from "../stores/gameStore";
import { usePanelStore } from "../stores/panelStore";
import { useI18n } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";
import { useConstantsStore } from "../stores/constantsStore";

export function Footer() {
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
  const getAgentByUuid = useConstantsStore((s) => s.getAgentByUuid);

  const getAutoLockStatus = () => {
    const resolveName = (uuid: string | null) => uuid ? (getAgentByUuid(uuid)?.name || uuid).toUpperCase() : null;

    if (gameState.map_name) {
      const agentUuid = getAgentForMap(gameState.map_name);
      if (agentUuid) return resolveName(agentUuid);
    }
    if (autoLockAgent) {
      if (Object.keys(mapAgentPreferences).length > 0) {
        return t("locale") === "tr" ? "ÖZEL" : "CUSTOM";
      }
      return resolveName(autoLockAgent);
    }
    if (Object.keys(mapAgentPreferences).length > 0) {
      return t("locale") === "tr" ? "ÖZEL" : "CUSTOM";
    }
    if (pausedAutoLockAgent) {
      if (Object.keys(mapAgentPreferences).length > 0) {
        return t("locale") === "tr" ? "ÖZEL" : "CUSTOM";
      }
      return resolveName(pausedAutoLockAgent);
    }
    return t("footer.inactive");
  };

  const statusText = getAutoLockStatus();
  const isSwitchOn = !!autoLockAgent || (Object.keys(mapAgentPreferences).length > 0 && !pausedAutoLockAgent);

  const handleSettingsClick = () => {
    if (isOpen && panelType === "settings") {
      close();
    } else {
      openSettings();
    }
  };

  return (
    <footer className="flex items-center justify-between px-4 h-[52px] bg-card/40 backdrop-blur-md rounded-xl border border-white/[0.04] mt-2 shadow-sm relative z-20 shrink-0">
      <div className="flex items-center gap-3 shrink-0">
        {/* Modern Toggle Switch */}
        <button 
          onClick={toggleAutoLock} 
          className={`relative w-9 h-4.5 rounded-full transition-all duration-300 cursor-pointer border shrink-0 ${isSwitchOn ? "bg-accent-cyan/20 border-accent-cyan/50" : "bg-dark/80 border-white/10 hover:border-white/20"}`} 
          title={isSwitchOn ? t("waiting.clickToDisable") : t("waiting.clickToEnable")}
        >
          <div className={`absolute top-0.5 bottom-0.5 w-3.5 rounded-full transition-all duration-300 shadow-sm ${isSwitchOn ? "left-[19px] bg-accent-cyan shadow-[0_0_10px_rgba(0,212,170,0.5)]" : "left-0.5 bg-dim"}`} />
        </button>
        
        {/* Helper Text */}
        <div className="flex flex-col justify-center min-w-0">
          <span className="text-[8px] text-dim uppercase tracking-[0.1em] font-semibold mb-0.5 truncate">{t("footer.autoLock")}</span>
          <span className={`text-[11px] font-black leading-none tracking-wide truncate ${isSwitchOn ? "text-accent-cyan drop-shadow-[0_0_5px_rgba(0,212,170,0.3)]" : "text-dim"}`}>{statusText}</span>
        </div>
      </div>
      
      <div className="flex items-center gap-2 shrink-0">
        {updateAvailable && (
          <button
            onClick={downloadAndInstall}
            disabled={isDownloading}
            className="h-8 px-2.5 flex items-center gap-1.5 rounded-lg cursor-pointer bg-accent-gold/10 border border-accent-gold/20 text-accent-gold hover:bg-accent-gold/20 hover:border-accent-gold/40 transition-all shrink-0"
            title={isDownloading ? `${downloadProgress}%` : `${t("header.update")} v${updateVersion}`}
          >
            {isDownloading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-accent-gold border-t-transparent rounded-full animate-spin" />
                <span className="text-[10px] font-bold">{downloadProgress}%</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                <span className="text-[10px] font-bold whitespace-nowrap">v{updateVersion}</span>
              </>
            )}
          </button>
        )}
        <button
          onClick={handleSettingsClick}
          className={`w-8 h-8 flex items-center justify-center rounded-lg cursor-pointer border transition-all duration-300 shrink-0 ${isOpen && panelType === "settings" ? "text-white bg-accent-cyan border-accent-cyan shadow-[0_0_15px_rgba(0,212,170,0.4)]" : "text-dim hover:text-white bg-dark/60 border-white/10 hover:border-white/20 hover:bg-white/5"}`}
          title={t("settings.title")}
        >
          <svg className="w-[16px] h-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </footer>
  );
}
