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
import { Toaster, toast } from "sonner";
import { useEffect } from "react";

/** How long the first-launch tip stays visible (ms). */
const WELCOME_TOAST_DURATION_MS = 12_000;

/** Guard StrictMode double-mount so the welcome toast only fires once per session. */
let welcomeToastScheduled = false;

function showWelcomeToastIfNeeded() {
  const { hasSeenWelcome, hotkey, markWelcomeSeen } = useSettingsStore.getState();
  if (hasSeenWelcome) return;

  // Mark first so StrictMode / remount cannot queue the toast.
  markWelcomeSeen();

  const { t } = useI18n.getState();
  toast(t("welcome.title"), {
    description: (
      <div className="flex flex-col gap-1.5 text-[13px] leading-snug">
        <span>{t("welcome.hotkey", { hotkey })}</span>
        <span className="opacity-80">{t("welcome.borderless")}</span>
      </div>
    ),
    duration: WELCOME_TOAST_DURATION_MS,
    position: "bottom-right",
  });
}

function App() {
  const { gameState } = useGameStore();
  const { windowStyle } = useSettingsStore();

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

  // First launch: bottom-right tip about hotkey + Windowed Fullscreen (once).
  useEffect(() => {
    if (welcomeToastScheduled) return;
    welcomeToastScheduled = true;

    const run = () => {
      // Short delay so the window is painted before the toast appears.
      window.setTimeout(showWelcomeToastIfNeeded, 700);
    };

    if (useSettingsStore.persist.hasHydrated()) {
      run();
      return;
    }

    const unsub = useSettingsStore.persist.onFinishHydration(run);
    return unsub;
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
