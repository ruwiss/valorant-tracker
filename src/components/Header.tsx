import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useGameStore } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAssetsStore } from "../stores/assetsStore";
import { useUpdateStore } from "../stores/updateStore";
import { useChatStore } from "../stores/chatStore";
import { usePanelStore } from "../stores/panelStore"; // Import PanelStore
import { useI18n } from "../lib/i18n";

export function Header() {
  // Atomic selectors for performance - only re-render when these specific values change
  const region = useGameStore((s) => s.region);
  const gameState = useGameStore((s) => s.gameState);
  const status = useGameStore((s) => s.status);
  const reconnect = useGameStore((s) => s.reconnect);
  const hotkey = useSettingsStore((s) => s.hotkey);
  const hideWindow = useSettingsStore((s) => s.hideWindow);
  const windowStyle = useSettingsStore((s) => s.windowStyle);
  const getMapSplash = useAssetsStore((s) => s.getMapSplash);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const setIsOpen = useChatStore((s) => s.setIsOpen);
  const closeSidePanel = usePanelStore((s) => s.close);
  const { t } = useI18n();

  // Check for updates on mount
  useEffect(() => {
    checkForUpdate();
  }, []);

  const mapSplash = gameState.map_name ? getMapSplash(gameState.map_name) : null;

  const closeApp = async () => {
    await getCurrentWindow().close();
  };

  const startDrag = async (e: React.MouseEvent) => {
    // Disable dragging in docked mode
    if (windowStyle === "docked") return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;

    try {
      await getCurrentWindow().startDragging();
    } catch (err) {
      console.error("Drag failed:", err);
    }
  };

  const handleOpenChat = async () => {
    // Close side panel to restore window width BEFORE opening chat
    await closeSidePanel();
    setIsOpen(true);
  };

  return (
    <header className={`relative flex items-center justify-between px-4 py-4 select-none overflow-hidden rounded-lg ${windowStyle === "docked" ? "cursor-default" : "cursor-move"}`} onMouseDown={startDrag}>
      {/* Map backdrop */}
      {mapSplash && (
        <div
          className="absolute inset-0 z-0 transition-opacity duration-500 pointer-events-none"
          style={{
            backgroundImage: `url(${mapSplash})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            opacity: 0.12,
            filter: "blur(1px)",
          }}
        />
      )}
      {/* Gradient overlay */}
      <div className="absolute inset-0 z-0 bg-linear-to-r from-dark/90 via-dark/70 to-dark/90 pointer-events-none" />

      {/* Left: Logo & Title */}
      <div className="relative z-10 flex items-center gap-2.5 pointer-events-none">
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-300 pointer-events-auto cursor-help ${
            status === 'CONNECTED' ? 'bg-green-500/20 shadow-[0_0_10px_rgba(34,197,94,0.2)]' :
            status === 'CONNECTING' || status === 'RECONNECTING' ? 'bg-yellow-500/20 animate-pulse' :
            status === 'WAITING_FOR_GAME' ? 'bg-blue-500/20 animate-pulse' :
            'bg-accent-red/20'
          }`}
          title={`${t("header.status")}: ${
             status === 'CONNECTED' ? t("status.connected") || 'LINKED' :
             status === 'CONNECTING' ? t("status.connecting") || 'LINKING' :
             status === 'RECONNECTING' ? t("status.reconnecting") || 'RETRYING' :
             status === 'WAITING_FOR_GAME' ? 'Oyunun açılması bekleniyor...' :
             t("status.offline") || 'OFFLINE'
          }`}
        >
          <svg
            className={`w-5 h-5 transition-colors duration-300 ${
              status === 'CONNECTED' ? 'text-green-500' :
              status === 'CONNECTING' || status === 'RECONNECTING' ? 'text-yellow-500' :
              status === 'WAITING_FOR_GAME' ? 'text-blue-400' :
              'text-accent-red'
            }`}
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 2L2 12l10 10 10-10L12 2z" />
          </svg>
        </div>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-black text-primary tracking-wider">VALORANT</h1>
            {region && <span className="text-[9px] font-bold text-accent-cyan uppercase bg-accent-cyan/10 px-1.5 py-0.5 rounded-sm tracking-widest leading-none">{region}</span>}
          </div>
          <span className="text-[8px] text-dim/60 uppercase tracking-widest">{hotkey} Overlay</span>
        </div>
      </div>

      {/* Right: Actions */}
      <div className="relative z-10 flex items-center gap-1">

        {/* Chat */}
        <button onClick={handleOpenChat} className="w-8 h-8 flex items-center justify-center text-dim hover:text-white hover:bg-white/5 rounded-lg transition-all" title={t("header.chat") || "Open Chat"}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        {/* Reconnect */}
        <button onClick={() => reconnect(false)} className="w-8 h-8 flex items-center justify-center text-dim hover:text-white hover:bg-white/5 rounded-lg transition-all" title={t("header.reconnect")}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>

        {/* Minimize - RESTORED */}
        <button onClick={hideWindow} className="w-8 h-8 flex items-center justify-center text-dim hover:text-white hover:bg-white/5 rounded-lg transition-all" title={`${t("header.hide")} (${hotkey})`}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {windowStyle === "docked" ? <path d="M15 18l-6-6 6-6" /> : <path d="M5 12h14" />}
          </svg>
        </button>

        {/* Close - RESTORED */}
        <button onClick={closeApp} className="w-8 h-8 flex items-center justify-center text-dim hover:text-accent-red hover:bg-accent-red/10 rounded-lg transition-all" title={t("header.close")}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </header>
  );
}
