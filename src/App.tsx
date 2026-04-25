import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { WaitingState } from "./components/WaitingState";
import { PregameState } from "./components/PregameState";
import { IngameState } from "./components/IngameState";
import { SidePanel } from "./components/SidePanel";
import { WeaponOverlay } from "./components/WeaponOverlay";
import { AgentOverlay } from "./components/AgentOverlay";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { useGameStore } from "./stores/gameStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useGameLoop } from "./hooks/useGameLoop";
import { Toaster } from "sonner";
import { useEffect } from "react";

function App() {
  const { gameState } = useGameStore();
  const { windowStyle } = useSettingsStore();

  // Initialize game loop (polling, watchdog, listeners)
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
        <AgentOverlay />
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
