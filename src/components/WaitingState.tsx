import { useGameStore } from "../stores/gameStore";
import { useI18n } from "../lib/i18n";

export function WaitingState() {
  const { status, reconnectAttempts, toggleMatchWatching, checkGameProcess } = useGameStore();
  const { t } = useI18n();

  const isPaused = status === "PAUSED";
  const isWaitingForGame = status === "WAITING_FOR_GAME";
  const isLoading = status === "CONNECTING" || status === "RECONNECTING" || status === "IDLE";

  const activeView = isPaused ? "paused" : isWaitingForGame ? "waitingForGame" : isLoading ? "loading" : "waiting";

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4 relative overflow-hidden">
      
      {/* Hafif organik arka plan aydınlatması */}
      <div className="absolute inset-0 pointer-events-none opacity-30">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-accent-cyan/10 rounded-full blur-[80px]" />
      </div>

      <div key={activeView} className="flex flex-col items-center animate-smooth-appear relative z-10 w-full max-w-[280px]">
        {/* Çok hafif belirgin olan saydam yuvarlak arka plan (card) */}
        <div className="flex flex-col items-center w-full bg-dark/20 backdrop-blur-sm rounded-[2rem] p-6 relative overflow-hidden">

          {isPaused ? (
             <div className="flex flex-col items-center text-center w-full">
                 <button onClick={toggleMatchWatching} className="group relative w-16 h-16 mb-5 flex items-center justify-center cursor-pointer transition-transform active:scale-95 shrink-0" title={t("waiting.clickToResume")}>
                    <div className="absolute inset-0 rounded-full border-2 border-accent-gold/20 bg-accent-gold/5 group-hover:border-accent-gold/40 group-hover:bg-accent-gold/10 transition-colors" />
                    <svg className="relative z-10 w-6 h-6 text-accent-gold group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                 </button>
                 <h2 className="text-[14px] font-black text-accent-gold tracking-widest mb-1.5">{t("waiting.paused")}</h2>
                 <p className="text-[12px] text-dim/80 leading-relaxed font-medium">{t("waiting.pausedDesc")}</p>
             </div>
          ) : isWaitingForGame ? (
             <div className="flex flex-col items-center text-center w-full">
                 <button onClick={() => checkGameProcess()} className="group relative w-20 h-20 mb-5 flex items-center justify-center cursor-pointer transition-transform active:scale-95 shrink-0" title="Oyun kontrolü yap">
                    {/* Dairesel Radar Animasyonu */}
                    <div className="absolute inset-0 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 group-hover:border-accent-cyan/50 group-hover:bg-accent-cyan/10 transition-colors" />
                    <div className="absolute inset-[-6px] rounded-full border border-dashed border-accent-cyan/20 animate-[spin_10s_linear_infinite]" />
                    <div className="absolute inset-[-12px] rounded-full border border-accent-cyan/10 opacity-0 group-hover:opacity-100 transition-opacity animate-pulse" />
                    
                    {/* VALORANT Logo SVG */}
                    <svg className="relative z-10 w-10 h-10 animate-breathe-red-green transition-transform group-hover:scale-110" viewBox="0 0 32 32" fill="currentColor">
                      <path d="M19.8,26.1h-0.2c-2.4,0-4.8,0-7.2,0c-0.3,0-0.5-0.1-0.6-0.3c-2.5-3.2-5.1-6.3-7.6-9.5C4.1,16.1,4,16,4,15.8 c0-3.1,0-6.1,0-9.2c0-0.1,0-0.2,0.1-0.2h0.1c5.2,6.5,10.4,13,15.5,19.5c0,0,0,0.1,0.1,0.1L19.8,26.1L19.8,26.1z"/>
                      <path d="M27.8,16.3c-0.7,0.9-1.5,1.8-2.2,2.8c-0.2,0.2-0.4,0.3-0.6,0.3c-2.4,0-4.8,0-7.1,0c0,0-0.1,0-0.1,0c-0.1,0-0.2-0.1-0.1-0.2 c0,0,0-0.1,0.1-0.1c2.4-3,4.7-5.9,7.1-8.9c1-1.2,2-2.5,2.9-3.7c0-0.1,0.1-0.1,0.2-0.1c0,0,0.1,0,0.1,0c0,0.1,0,0.1,0,0.2 c0,3,0,6.1,0,9.1C28,16,27.9,16.2,27.8,16.3L27.8,16.3z"/>
                    </svg>
                 </button>
                 <h2 className="text-[14px] font-black text-accent-cyan tracking-widest mb-1.5 drop-shadow-[0_0_5px_rgba(0,212,170,0.3)]">OYUN BEKLENİYOR</h2>
                 <p className="text-[12px] text-dim/80 leading-relaxed font-medium">Valorant'ı başlatın, otomatik bağlanacak</p>
             </div>
          ) : isLoading ? (
             <div className="flex flex-col items-center text-center w-full">
                 <button onClick={(e) => { e.stopPropagation(); toggleMatchWatching(); }} className="group relative w-16 h-16 mb-5 flex items-center justify-center cursor-pointer transition-transform active:scale-95 shrink-0" title={t("waiting.clickToPause")}>
                    <div className="absolute inset-0 rounded-full border-2 border-accent-gold/10 bg-accent-gold/5" />
                    
                    {/* Dairesel Yüklenme (Spin) Animasyonu */}
                    <div className="absolute inset-0 rounded-full border-2 border-accent-gold/60 border-t-transparent animate-spin" style={{ animationDuration: '1.5s' }} />

                    <svg className="relative z-10 w-6 h-6 text-transparent group-hover:text-accent-gold transition-colors" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                    </svg>
                 </button>
                 <h2 className="text-[14px] font-black text-accent-gold tracking-widest mb-1.5">
                    {status === "CONNECTING" || status === "IDLE" ? t("header.connecting") : t("waiting.reconnecting")}
                 </h2>
                 {status === "RECONNECTING" && (
                   <div className="flex items-center justify-center gap-1.5 mt-1 bg-dark/30 px-3 py-1 rounded-full">
                     <span className="relative flex h-2 w-2">
                       <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-gold opacity-75"></span>
                       <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-gold"></span>
                     </span>
                     <span className="text-[10px] font-bold tracking-wider text-dim">{t("waiting.attempt")} {reconnectAttempts + 1}</span>
                   </div>
                 )}
             </div>
          ) : (
             <div className="flex flex-col items-center text-center w-full">
                 <button onClick={toggleMatchWatching} className="group relative w-16 h-16 mb-5 flex items-center justify-center cursor-pointer transition-transform active:scale-95 shrink-0" title={t("waiting.clickToPause")}>
                    {/* Yumuşak Yuvarlak Halka */}
                    <div className="absolute inset-0 rounded-full border-2 border-accent-cyan/20 bg-accent-cyan/10 group-hover:border-accent-cyan/40 group-hover:bg-accent-cyan/20 transition-colors shadow-[0_0_15px_rgba(0,212,170,0.1)] group-hover:shadow-[0_0_20px_rgba(0,212,170,0.2)]" />
                    <div className="absolute inset-[-4px] rounded-full border border-accent-cyan/10 scale-110 opacity-0 group-hover:opacity-100 transition-all duration-300" />
                    
                    <svg className="relative z-10 w-6 h-6 text-accent-cyan/80 group-hover:text-accent-cyan transition-colors" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                    </svg>
                 </button>
                 <h2 className="text-[14px] font-black text-white tracking-widest mb-1.5">{t("waiting.title")}</h2>
                 <p className="text-[12px] text-dim/80 leading-relaxed font-medium">{t("waiting.desc")}</p>
             </div>
          )}
        </div>
      </div>
    </div>
  );
}
