import { useEffect, useState } from "react";
import { usePanelStore } from "../../stores/panelStore";

export function GlitchOverlay() {
  const { isOpen } = usePanelStore();
  const [active, setActive] = useState(false);

  useEffect(() => {
    let timer: number;
    // When panel opens, trigger the localized glitch effect
    if (isOpen) {
      setActive(true);
      // Duration matches the panel slide-in animation buffer
      timer = setTimeout(() => {
        setActive(false);
      }, 600) as unknown as number; // Slightly longer than panel transition
    } else {
      // When closing, maybe a shorter glitch? Or none.
      // User specifically mentioned "opening".
      // Let's keep it simple: only on open.
      setActive(false);
    }
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!active) return null;

  return (
    <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden rounded-md animate-fade-in">
      {/* 1. Blur Layer */}
      <div className="absolute inset-0 backdrop-blur-[2px] bg-dark/40" />

      {/* 2. Scanlines */}
      <div className="absolute inset-0 scan-lines opacity-20" />

      {/* 3. Random Glitch Blocks */}
      <div className="absolute top-1/4 left-10 w-32 h-1 bg-accent-cyan/50 blur-sm animate-pulse" />
      <div className="absolute bottom-1/3 right-20 w-48 h-px bg-accent-red/50 animate-pulse" style={{ animationDuration: "0.2s" }} />

      {/* 4. Center Tech Text */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-1">
          <div className="text-2xl font-black text-white/10 tracking-[1em] glitch-text font-display uppercase">REFRESH</div>
          <div className="text-[10px] font-mono text-accent-cyan/40 tracking-widest animate-pulse">:: DATA REFLOW ::</div>
        </div>
      </div>

      {/* 5. Chromatic Aberration Shifts */}
      <div className="absolute inset-0 bg-accent-red/5 mix-blend-screen animate-[glitch-shift_0.2s_ease-in-out_infinite]" />
      <div className="absolute inset-0 bg-accent-cyan/5 mix-blend-screen animate-[glitch-shift_0.2s_ease-in-out_infinite_reverse]" />

      {/* 6. Vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_50%,rgba(0,0,0,0.6)_100%)]" />
    </div>
  );
}
