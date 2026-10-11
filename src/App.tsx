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
import { useIncomingMessageAlert } from "./hooks/useIncomingMessageAlert";
import { useI18n } from "./lib/i18n";
import { changelogDevPreview, changelogText, planChangelog } from "./changelog";
import { getVersion } from "@tauri-apps/api/app";
import { Toaster } from "sonner";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";

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
let changelogScheduled = false;

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
          <X className="w-3 h-3" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function ChangelogCard({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/60 p-5 animate-smooth-appear">
      <div
        role="dialog"
        aria-label={t("changelog.title")}
        className="relative flex h-[72%] w-full max-w-[440px] flex-col rounded-2xl border border-white/10 bg-[#0c1218] px-5 pb-5 pt-4 shadow-2xl"
      >
        <button
          type="button"
          onClick={onDismiss}
          className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-white/10 hover:text-white"
          aria-label={t("header.close")}
        >
          <X className="h-4 w-4" strokeWidth={2.5} />
        </button>
        <div className="mb-3 pr-10 text-[13px] font-black tracking-[0.16em] text-accent-cyan">
          {t("changelog.title")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[15px] leading-relaxed text-primary">
          {text || t("changelog.empty")}
        </div>
      </div>
    </div>
  );
}

function App() {
  const { gameState, status, pendingReconnect } = useGameStore();
  const { windowStyle, hotkey, changelogPreviewTick } = useSettingsStore();
  const { t, locale } = useI18n();
  const [showWelcomeTip, setShowWelcomeTip] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [changelogIsPreview, setChangelogIsPreview] = useState(false);
  const changelogVersionRef = useRef<string | null>(null);
  const showReconnectBar =
    (pendingReconnect || status === "RECONNECTING") &&
    (gameState.state === "pregame" || gameState.state === "ingame");

  // Subscribe to backend connection/game-state events (backend owns the loop)
  useGameLoop();
  useIncomingMessageAlert();

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

  useEffect(() => {
    if (!changelogPreviewTick) return;
    setChangelogIsPreview(true);
    setShowChangelog(true);
  }, [changelogPreviewTick]);

  useEffect(() => {
    if (changelogScheduled) return;
    changelogScheduled = true;

    const run = async () => {
      if (import.meta.env.DEV && changelogDevPreview) {
        setChangelogIsPreview(true);
        setShowChangelog(true);
        return;
      }

      let version = "";
      try {
        version = await getVersion();
      } catch {
        return;
      }

      const { lastSeenChangelogVersion, hasSeenWelcome, markChangelogSeen } = useSettingsStore.getState();
      const notes = changelogText(useI18n.getState().locale);
      const plan = planChangelog({
        notes,
        currentVersion: version,
        seenVersion: lastSeenChangelogVersion,
        hasUsedAppBefore: hasSeenWelcome,
      });
      if (plan.markSeen) markChangelogSeen(version);
      if (plan.show) {
        changelogVersionRef.current = version;
        setChangelogIsPreview(false);
        setShowChangelog(true);
      }
    };

    if (useSettingsStore.persist.hasHydrated()) {
      void run();
      return;
    }
    return useSettingsStore.persist.onFinishHydration(() => {
      void run();
    });
  }, []);

  const dismissChangelog = () => {
    if (!changelogIsPreview && changelogVersionRef.current) {
      useSettingsStore.getState().markChangelogSeen(changelogVersionRef.current);
    }
    setShowChangelog(false);
  };

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
    <div className={`relative h-full flex bg-dark/95 backdrop-blur-md overflow-hidden border border-white/[0.06] ${windowStyle === "docked" ? "rounded-r-2xl" : "rounded-2xl"}`}>
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
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent-gold shrink-0" strokeWidth={2.5} />
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

      {showChangelog && (
        <ChangelogCard text={changelogText(locale)} onDismiss={dismissChangelog} />
      )}

      <Toaster position="top-right" richColors theme="dark" />
    </div>
  );
}

export default App;
