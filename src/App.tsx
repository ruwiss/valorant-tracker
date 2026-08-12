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

/** WebView / browser chrome shortcuts that should never surface in the overlay. */
function isBrowserChromeShortcut(e: KeyboardEvent): boolean {
  if (e.key === "F3" || e.key === "F5") return true;

  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;

  switch (e.key.toLowerCase()) {
    case "f": // find
    case "g": // find next
    case "p": // print
    case "s": // save
    case "u": // view source
    case "h": // history
    case "j": // downloads
    case "r": // reload
    case "+":
    case "-":
    case "=":
    case "_":
    case "0":
      return true;
    default:
      return false;
  }
}

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
  const { gameState, status, pendingReconnect } = useGameStore();
  const { windowStyle, hotkey } = useSettingsStore();
  const { t } = useI18n();
  const [showWelcomeTip, setShowWelcomeTip] = useState(false);
  const showReconnectBar =
    (pendingReconnect || status === "RECONNECTING") &&
    (gameState.state === "pregame" || gameState.state === "ingame");

  // Subscribe to backend connection/game-state events (backend owns the loop)
  useGameLoop();

  // Disable context menu and WebView chrome shortcuts (find, print, reload, zoom…)
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isBrowserChromeShortcut(e)) {
        e.preventDefault();
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    document.addEventListener("contextmenu", handleContextMenu);
    // Capture so we beat focused inputs; native WebView2 Find is also
    // disabled in Rust via AreBrowserAcceleratorKeysEnabled=false.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("wheel", handleWheel);
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
        {showReconnectBar && (
          <div
            className="mb-2 shrink-0 flex items-center gap-2 rounded-lg border border-accent-gold/25 bg-accent-gold/[0.08] px-2.5 py-1.5 animate-smooth-appear"
            role="status"
          >
            <svg className="w-3.5 h-3.5 animate-spin text-accent-gold shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            <span className="text-[10px] font-bold tracking-wider text-accent-gold uppercase">
              {t("waiting.reconnecting")}
            </span>
          </div>
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
