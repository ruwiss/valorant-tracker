import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useGameStore } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAssetsStore } from "../stores/assetsStore";
import { useUpdateStore } from "../stores/updateStore";
import { useChatStore } from "../stores/chatStore";
import { usePanelStore } from "../stores/panelStore"; 
import { useI18n } from "../lib/i18n";
import { MessageSquare, Minus, PanelLeftClose, RefreshCw, X } from "lucide-react";

export function Header() {
  const region = useGameStore((s) => s.region);
  const gameState = useGameStore((s) => s.gameState);
  const status = useGameStore((s) => s.status);
  const pendingReconnect = useGameStore((s) => s.pendingReconnect);
  const reconnect = useGameStore((s) => s.reconnect);
  const hotkey = useSettingsStore((s) => s.hotkey);
  const hideWindow = useSettingsStore((s) => s.hideWindow);
  const windowStyle = useSettingsStore((s) => s.windowStyle);
  const getMapSplash = useAssetsStore((s) => s.getMapSplash);
  const initUpdates = useUpdateStore((s) => s.init);
  const setIsOpen = useChatStore((s) => s.setIsOpen);
  const closeSidePanel = usePanelStore((s) => s.close);
  const { t } = useI18n();

  useEffect(() => {
    initUpdates();
  }, []);

  const mapSplash = gameState.map_name ? getMapSplash(gameState.map_name) : null;
  const isReconnecting = pendingReconnect || status === "RECONNECTING";
  const isBusy = isReconnecting || status === "CONNECTING";

  const closeApp = async () => {
    const isConfirmed = await confirm(t("dialog.closeMessage"), {
      title: t("dialog.closeTitle"),
      kind: 'warning',
      okLabel: t("dialog.yes"),
      cancelLabel: t("dialog.no")
    });

    if (isConfirmed) {
      await getCurrentWindow().close();
    }
  };

  const startDrag = async (e: React.MouseEvent) => {
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
    await closeSidePanel();
    setIsOpen(true);
  };

  return (
    <header className={`relative flex items-center justify-between px-4 py-3 mb-2 select-none overflow-hidden rounded-xl border border-white/[0.04] bg-card/30 backdrop-blur-md shadow-sm shrink-0 ${windowStyle === "docked" ? "cursor-default" : "cursor-move"}`} onMouseDown={startDrag}>
      {mapSplash && (
        <div
          className="absolute inset-0 z-0 transition-opacity duration-700 pointer-events-none"
          style={{
            backgroundImage: `url(${mapSplash})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            opacity: 0.2,
            maskImage: "linear-gradient(to right, black, transparent)",
            WebkitMaskImage: "linear-gradient(to right, black, transparent)"
          }}
        />
      )}
      <div className="absolute inset-0 z-0 bg-gradient-to-r from-dark/90 via-dark/50 to-dark/90 pointer-events-none" />

      {/* Left: Minimal Title & Status */}
      <div className="relative z-10 flex flex-col justify-center pointer-events-none shrink-0 pl-1">
        <div className="flex items-center gap-2">
          {/* Durum Göstergesi (Minimal Sinyal Noktası) */}
          <div 
            className={`relative w-2 h-2 rounded-full shrink-0 ${
              status === 'CONNECTED' && !pendingReconnect ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]' :
              status === 'CONNECTING' || status === 'RECONNECTING' || pendingReconnect ? 'bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.6)] animate-pulse' :
              status === 'WAITING_FOR_GAME' ? 'bg-accent-cyan shadow-[0_0_8px_rgba(0,212,170,0.6)] animate-pulse' :
              'bg-accent-red shadow-[0_0_8px_rgba(255,70,85,0.6)]'
            }`}
            title={`${t("header.status")}: ${
             status === 'CONNECTED' ? t("status.connected") || 'LINKED' :
             status === 'CONNECTING' ? t("status.connecting") || 'LINKING' :
             status === 'RECONNECTING' ? t("status.reconnecting") || 'RETRYING' :
             status === 'WAITING_FOR_GAME' ? t("waiting.forGame") :
             t("status.offline") || 'OFFLINE'
            }`}
          />
          <h1 className="font-display text-[17px] font-bold text-white tracking-[0.14em] leading-none drop-shadow-md truncate">VALORANT</h1>
          {region && <span className="text-[9px] font-bold text-accent-cyan uppercase bg-accent-cyan/10 border border-accent-cyan/20 px-1 py-0.5 rounded-md tracking-widest leading-none shadow-[0_0_5px_rgba(0,212,170,0.2)] shrink-0">{region}</span>}
        </div>
        <span className={`text-[9px] uppercase tracking-[0.2em] font-semibold mt-1.5 ml-4 truncate ${isReconnecting ? "text-accent-gold" : isBusy ? "text-accent-gold/80" : "text-secondary"}`}>
          {isReconnecting ? t("waiting.reconnecting") : isBusy ? t("header.connecting") : `${hotkey} Overlay`}
        </span>
      </div>

      {/* Right: Actions */}
      <div className="relative z-10 flex items-center gap-1 bg-dark/40 p-1 rounded-xl border border-white/[0.03] shrink-0">
        <button onClick={handleOpenChat} className="icon-btn" title={t("header.chat")}>
          <MessageSquare className="w-[15px] h-[15px]" />
        </button>

        <button
          type="button"
          onClick={() => reconnect()}
          disabled={isBusy}
          className={`icon-btn ${isBusy ? "text-accent-gold! bg-accent-gold/15 cursor-wait" : ""}`}
          title={isReconnecting ? t("waiting.reconnecting") : t("header.reconnect")}
        >
          <RefreshCw className={`w-[15px] h-[15px] ${isBusy ? "animate-spin" : ""}`} />
        </button>

        <button onClick={hideWindow} className="icon-btn" title={`${t("header.hide")} (${hotkey})`}>
          {windowStyle === "docked" ? <PanelLeftClose className="w-[15px] h-[15px]" /> : <Minus className="w-[15px] h-[15px]" />}
        </button>

        <div className="w-[1px] h-3.5 bg-white/10 mx-0.5 shrink-0" />

        <button onClick={closeApp} className="icon-btn hover:bg-accent-red/80!" title={t("header.close")}>
          <X className="w-[15px] h-[15px]" />
        </button>
      </div>
    </header>
  );
}
