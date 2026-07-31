import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { WaitingState } from "./components/WaitingState";
import { PregameState } from "./components/PregameState";
import { IngameState } from "./components/IngameState";
import { SidePanel } from "./components/SidePanel";
import { WeaponOverlay } from "./components/WeaponOverlay";
import { AgentOverlay } from "./components/AgentOverlay";
import { CrosshairOverlay } from "./components/CrosshairOverlay";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { useGameStore } from "./stores/gameStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useGameLoop } from "./hooks/useGameLoop";
import { useI18n } from "./lib/i18n";
import { Toaster } from "sonner";
import { useEffect, useState } from "react";

/** How long the first-launch tip stays under the header (ms). */
const WELCOME_TIP_DURATION_MS = 6_500;

/** Guard StrictMode double-mount so the tip only schedules once per session. */
let welcomeTipScheduled = false;

function WelcomeTipBanner({
  hotkey,
  onDismiss,
}: {
  hotkey: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="mb-2 shrink-0 rounded-lg border border-accent-cyan/20 bg-accent-cyan/[0.07] px-2.5 py-1.5 animate-smooth-appear"
      role="status"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-accent-cyan/90 mb-0.5">
            {t("welcome.title")}
          </div>
          <p className="text-[10px] leading-snug text-primary/85">
            {t("welcome.hotkey", { hotkey })}
          </p>
          <p className="text-[9px] leading-snug text-dim/90 mt-0.5">
            {t("welcome.borderless")}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-dim/70 hover:text-primary hover:bg-white/10 transition-colors"
          aria-label="Dismiss"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function App() {
  const { gameState } = useGameStore();
  const { windowStyle, hotkey } = useSettingsStore();
  const [showWelcomeTip, setShowWelcomeTip] = useState(false);

  // Subscribe to backend connection/game-state events (backend owns the loop)
  useGameLoop();

  // Disable context menu (right-click) globally
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    document.addEventListener("contextmenu", handleContextMenu);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  // First launch: compact tip under the VALORANT header (once).
  useEffect(() => {
    if (welcomeTipScheduled) return;
    welcomeTipScheduled = true;

    let hideTimer: number | undefined;
    let showTimer: number | undefined;

    const run = () => {
      const { hasSeenWelcome, markWelcomeSeen } = useSettingsStore.getState();
      if (hasSeenWelcome) return;

      // Short delay so the window is painted first.
      showTimer = window.setTimeout(() => {
        markWelcomeSeen();
        setShowWelcomeTip(true);
        hideTimer = window.setTimeout(() => setShowWelcomeTip(false), WELCOME_TIP_DURATION_MS);
      }, 500);
    };

    if (useSettingsStore.persist.hasHydrated()) {
      run();
    } else {
      const unsub = useSettingsStore.persist.onFinishHydration(run);
      return () => {
        unsub();
        if (showTimer) window.clearTimeout(showTimer);
        if (hideTimer) window.clearTimeout(hideTimer);
      };
    }

    return () => {
      if (showTimer) window.clearTimeout(showTimer);
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, []);

  const renderContent = () => {
    switch (gameState.state) {
      case "pregame":
        return <PregameState />;
      case "ingame":
        return <IngameState />;
      default:
        return <WaitingState />;
    }
  };

  return (
    <div className={`h-full flex bg-dark/95 backdrop-blur-md overflow-hidden border border-white/[0.06] ${windowStyle === "docked" ? "rounded-r-2xl" : "rounded-2xl"}`}>
      {/* Main content - Fixed width to prevent jumping during resize */}
      <div className="relative w-[380px] flex-none flex flex-col p-4 pl-5">
        <Header />
        {showWelcomeTip && (
          <WelcomeTipBanner
            hotkey={hotkey}
            onDismiss={() => setShowWelcomeTip(false)}
          />
        )}
        {renderContent()}
        <Footer />

        {/* Weapon hover overlay */}
        <WeaponOverlay />

        {/* Agent hover overlay for settings */}
        <AgentOverlay key="agent-overlay" />

        {/* Crosshair hover preview for presets */}
        <CrosshairOverlay />
      </div>

      {/* Side panel */}
      <SidePanel />

      {/* Chat Panel Overlay */}
      <ChatPanel />

      <Toaster position="top-right" richColors theme="dark" />
    </div>
  );
}

export default App;
