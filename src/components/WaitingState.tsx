import { useGameStore } from "../stores/gameStore";
import { useI18n } from "../lib/i18n";

export function WaitingState() {
  const { status, reconnectAttempts, toggleMatchWatching, checkGameProcess } = useGameStore();
  const { t } = useI18n();

  // Derive states from status
  const isPaused = status === "PAUSED";
  const isWaitingForGame = status === "WAITING_FOR_GAME";
  const isLoading = status === "CONNECTING" || status === "RECONNECTING" || status === "IDLE";

  // Determine current active view for the key
  const activeView = isPaused ? "paused" : isWaitingForGame ? "waitingForGame" : isLoading ? "loading" : "waiting";

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4 relative">
      {/* State Container with Transition Key */}
      <div key={activeView} className="flex flex-col items-center animate-smooth-appear">
        {isPaused ? (
          <>
            {/* Paused state - clickable to resume */}
            <button onClick={toggleMatchWatching} className="group relative w-16 h-16 mb-4 cursor-pointer transition-transform hover:scale-105 active:scale-95" title={t("waiting.clickToResume")}>
              <div className="absolute inset-0 bg-card rounded-full shadow-[0_0_20px_rgba(236,178,46,0.1)]" />
              <div className="absolute inset-4 bg-accent-gold/40 rounded-full" />
              {/* Play icon */}
              <svg className="absolute inset-0 w-16 h-16 p-5 text-accent-gold group-hover:text-accent-gold/80 transition-colors" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
            <h2 className="text-base font-semibold text-accent-gold mb-1">{t("waiting.paused")}</h2>
            <p className="text-xs text-dim text-center px-8">{t("waiting.pausedDesc")}</p>
          </>
        ) : isWaitingForGame ? (
          <>
            {/* Waiting for game to launch - clickable to retry */}
            <button onClick={() => checkGameProcess()} className="group relative w-[72px] h-[72px] mb-5 cursor-pointer transition-transform hover:scale-105 active:scale-95" title="Oyun kontrolü yap">
              {/* Outer pulsing ring */}
              <div className="absolute -inset-1.5 rounded-full border border-blue-500/20 animate-[ping_3s_cubic-bezier(0,0,0.2,1)_infinite] opacity-60" />
              {/* Subtle ambient glow */}
              <div className="absolute -inset-2 rounded-full bg-blue-500/5 blur-md group-hover:bg-blue-400/10 transition-colors duration-500" />
              {/* Background circle with gradient border */}
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-card via-card to-blue-950/60 shadow-[0_0_24px_rgba(59,130,246,0.12),inset_0_1px_0_rgba(255,255,255,0.04)]" />
              {/* Inner glow core */}
              <div className="absolute inset-[18px] rounded-full bg-blue-500/20 backdrop-blur-sm animate-pulse group-hover:animate-none group-hover:bg-blue-400/30 transition-all duration-300" />
              {/* Modern gamepad icon - outline style */}
              <svg
                className="absolute inset-0 w-[72px] h-[72px] p-[22px] text-blue-400 group-hover:text-blue-300 transition-colors duration-300 drop-shadow-[0_0_6px_rgba(96,165,250,0.4)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 11h4M8 9v4" />
                <circle cx="15" cy="10" r="0.75" fill="currentColor" stroke="none" />
                <circle cx="17.5" cy="12.5" r="0.75" fill="currentColor" stroke="none" />
                <path d="M7.5 6h9a5 5 0 0 1 5 5v0a7 7 0 0 1-7 7h-5a7 7 0 0 1-7-7v0a5 5 0 0 1 5-5z" />
              </svg>
            </button>
            <h2 className="text-base font-semibold text-blue-400 mb-1">Oyun Bekleniyor</h2>
            <p className="text-xs text-dim text-center px-8">Valorant'ı başlatın, otomatik bağlanacak</p>
          </>
        ) : isLoading ? (
          <>
            {/* Loading/Reconnecting animation - clickable to pause */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleMatchWatching();
              }}
              className="group relative w-16 h-16 mb-4 cursor-pointer active:scale-95 transition-transform"
              title={t("waiting.clickToPause")}
            >
              <div className="absolute inset-0 bg-card rounded-full" />
              <div className="absolute inset-0 border-2 border-accent-gold border-t-transparent rounded-full animate-spin" />
              <div className="absolute inset-4 bg-accent-gold/20 rounded-full" />
              {/* Pause icon - appears on hover */}
              <svg className="absolute inset-0 w-16 h-16 p-5 text-white/0 group-hover:text-accent-gold transition-colors z-10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            </button>
            <h2 className="text-base font-semibold text-accent-gold mb-1">{status === "CONNECTING" || status === "IDLE" ? t("header.connecting") : t("waiting.reconnecting")}</h2>
            {status === "RECONNECTING" && (
              <p className="text-xs text-dim">
                {t("waiting.attempt")} {reconnectAttempts + 1}
              </p>
            )}
          </>
        ) : (
          <>
            {/* Normal waiting state (connected, waiting for match) - clickable to pause */}
            <button onClick={toggleMatchWatching} className="group relative w-16 h-16 mb-4 cursor-pointer transition-transform hover:scale-105 active:scale-95" title={t("waiting.clickToPause")}>
              <div className="absolute inset-0 bg-card rounded-full shadow-[0_0_20px_rgba(0,212,170,0.05)]" />
              <div className="absolute inset-4 bg-accent-cyan rounded-full animate-pulse group-hover:animate-none" />
              {/* Pause icon - appears on hover */}
              <svg className="absolute inset-0 w-16 h-16 p-5 text-white/0 group-hover:text-white/80 transition-colors" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            </button>
            <h2 className="text-base font-semibold text-primary mb-1">{t("waiting.title")}</h2>
            <p className="text-xs text-dim text-center px-8">{t("waiting.desc")}</p>
          </>
        )}
      </div>
    </div>
  );
}
