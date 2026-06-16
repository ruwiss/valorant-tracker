import { usePanelStore, type HoveredCrosshair } from "../stores/panelStore";
import { useState, useEffect, useRef } from "react";
import { drawCrosshair } from "../utils/crosshair";
import { useI18n } from "../lib/i18n";

// Left-area preview of a crosshair, mirroring AgentOverlay/WeaponOverlay:
// shown only while the settings panel is open and a crosshair is hovered.
export function CrosshairOverlay() {
  const { hoveredCrosshair, isOpen, panelType } = usePanelStore();
  const { t } = useI18n();
  const [display, setDisplay] = useState<HoveredCrosshair | null>(hoveredCrosshair);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce hide so moving between profile rows doesn't flicker.
  useEffect(() => {
    if (hoveredCrosshair) {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setDisplay(hoveredCrosshair);
    } else {
      hideTimeoutRef.current = setTimeout(() => setDisplay(null), 200);
    }
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [hoveredCrosshair]);

  // Render the crosshair whenever the displayed layer changes.
  useEffect(() => {
    if (display && canvasRef.current) {
      drawCrosshair(canvasRef.current, display.layer);
    }
  }, [display]);

  if (!display || !isOpen || panelType !== "settings") return null;

  return (
    <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden animate-in fade-in duration-200">
      {/* Dark backdrop */}
      <div className="absolute inset-0 bg-dark/95 backdrop-blur-sm" />

      {/* Subtle grid for aim-feel */}
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(#00d4aa 1px, transparent 1px), linear-gradient(90deg, #00d4aa 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      <div className="absolute inset-0 flex flex-col items-center justify-center p-5">
        <span className="text-[8px] font-black uppercase tracking-[0.25em] text-accent-cyan/70 mb-3">
          {t("presets.crosshairPreview")}
        </span>

        <div className="relative rounded-xl border border-accent-cyan/20 bg-[#10161d] shadow-2xl shadow-black/50 overflow-hidden">
          <canvas ref={canvasRef} width={168} height={168} className="block" />
          {/* Center reticle guide lines (faint) */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/[0.04]" />
            <div className="absolute top-1/2 left-0 right-0 h-px bg-white/[0.04]" />
          </div>
        </div>

        <h2 className="mt-3 text-[11px] font-bold text-primary text-center max-w-[240px] truncate px-4">
          {display.name}
        </h2>
      </div>
    </div>
  );
}
