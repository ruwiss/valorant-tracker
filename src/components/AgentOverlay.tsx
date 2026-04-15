import { usePanelStore } from "../stores/panelStore";
import { useState, useEffect, useRef } from "react";

export function AgentOverlay() {
  const { hoveredAgent, isOpen, panelType } = usePanelStore();
  const [isGlitching, setIsGlitching] = useState(false);
  const [glitchIntensity, setGlitchIntensity] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [mapImageLoaded, setMapImageLoaded] = useState(false);
  const [displayAgent, setDisplayAgent] = useState(hoveredAgent);
  const prevAgentRef = useRef<string | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Handle agent changes with debounce for gaps between buttons
  useEffect(() => {
    if (hoveredAgent) {
      // Clear any pending hide timeout
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setDisplayAgent(hoveredAgent);
    } else {
      // Delay hiding to allow moving between agents (longer delay for gaps)
      hideTimeoutRef.current = setTimeout(() => {
        setDisplayAgent(null);
        prevAgentRef.current = null;
        setImageLoaded(false);
        setMapImageLoaded(false);
      }, 200);
    }

    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [hoveredAgent]);

  // Trigger subtle glitch effect when agent changes
  useEffect(() => {
    if (!displayAgent) {
      return;
    }

    const currentKey = `${displayAgent.name}-${displayAgent.mapContext?.mapName || "global"}`;
    if (prevAgentRef.current && prevAgentRef.current !== currentKey) {
      // Don't reset loading states - keep previous image visible
      setIsGlitching(true);
      setGlitchIntensity(0.6);

      // Quick subtle fade
      const fadeTimer = setTimeout(() => setGlitchIntensity(0.3), 30);
      const endTimer = setTimeout(() => {
        setGlitchIntensity(0);
        setIsGlitching(false);
      }, 60);

      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(endTimer);
      };
    }
    prevAgentRef.current = currentKey;
  }, [displayAgent?.name, displayAgent?.mapContext?.mapName]);

  if (!displayAgent || !isOpen || panelType !== "settings") return null;

  const rgbOffset = glitchIntensity * 1.5;
  const hasMapContext = displayAgent.mapContext && displayAgent.mapContext.mapSplash;
  const mapColor = displayAgent.mapContext?.mapColor || "#00d4aa";
  const agentImage = displayAgent.bustPortrait || displayAgent.displayIcon;

  return (
    <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden">
      {/* Animated background with map or dark gradient */}
      <div className="absolute inset-0">
        {hasMapContext ? (
          <>
            {/* Map splash background with parallax effect */}
            <div
              className="absolute inset-0 transition-transform duration-700 ease-out"
              style={{
                transform: isGlitching ? `scale(1.03) translateX(${glitchIntensity}px)` : "scale(1.01)",
              }}
            >
              <img src={displayAgent.mapContext!.mapSplash!} alt="" className={`w-full h-full object-cover transition-all duration-500 ${mapImageLoaded ? "opacity-70" : "opacity-0"}`} onLoad={() => setMapImageLoaded(true)} />
            </div>
            {/* Map color overlay gradient */}
            <div
              className="absolute inset-0 transition-opacity duration-300"
              style={{
                background: `linear-gradient(135deg, ${mapColor}20 0%, transparent 50%, ${mapColor}15 100%)`,
                opacity: mapImageLoaded ? 1 : 0,
              }}
            />
            {/* Dark overlay for contrast - lighter to show map */}
            <div className="absolute inset-0 bg-gradient-to-br from-[#0a0e13]/60 via-[#0a0e13]/40 to-[#0a0e13]/50" />
          </>
        ) : (
          /* Default dark backdrop for global agents */
          <div className="absolute inset-0 bg-[#0a0e13]/95 backdrop-blur-sm" />
        )}
      </div>

      {/* Animated scan lines */}
      <div className="absolute inset-0 overflow-hidden opacity-20">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,212,170,0.03) 2px, rgba(0,212,170,0.03) 4px)",
            animation: "scanMove 8s linear infinite",
          }}
        />
      </div>

      {/* Content container */}
      <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
        {/* Map name label (if map-specific) */}
        {hasMapContext && (
          <div className="mb-3 animate-in fade-in slide-in-from-top-2 duration-500">
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg backdrop-blur-md border transition-all duration-300"
              style={{
                backgroundColor: `${mapColor}15`,
                borderColor: `${mapColor}40`,
              }}
            >
              <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: mapColor, boxShadow: `0 0 8px ${mapColor}` }} />
              <span className="text-[10px] font-black uppercase tracking-[0.25em]" style={{ color: mapColor }}>
                {displayAgent.mapContext!.mapName}
              </span>
            </div>
          </div>
        )}

        {/* Agent type label */}
        <div className="mb-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] transition-colors duration-300" style={{ color: hasMapContext ? `${mapColor}99` : "rgba(0,212,170,0.6)" }}>
            {hasMapContext ? "HARITA TERCİHİ" : "VARSAYILAN AJAN"}
          </span>
        </div>

        {/* Agent portrait - larger size */}
        <div className="relative w-full max-w-64 h-56 flex items-center justify-center mb-4">
          {/* Radial glow effect */}
          <div
            className="absolute inset-0 blur-3xl rounded-full transition-all duration-500"
            style={{
              background: `radial-gradient(circle, ${hasMapContext ? mapColor : "#00d4aa"}25 0%, transparent 70%)`,
              transform: isGlitching ? "scale(1.2)" : "scale(1)",
            }}
          />

          {/* Hexagon frame decoration */}
          <div className="absolute inset-4 opacity-30">
            <svg viewBox="0 0 100 100" className="w-full h-full" style={{ color: hasMapContext ? mapColor : "#00d4aa" }}>
              <polygon points="50,2 95,25 95,75 50,98 5,75 5,25" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="5,3" className="animate-spin-slow" style={{ transformOrigin: "center", animationDuration: "20s" }} />
            </svg>
          </div>

          {/* Loading spinner */}
          {!imageLoaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="w-10 h-10 border-2 rounded-full animate-spin"
                style={{
                  borderColor: `${hasMapContext ? mapColor : "#00d4aa"}30`,
                  borderTopColor: hasMapContext ? mapColor : "#00d4aa",
                }}
              />
            </div>
          )}

          {/* Agent image with RGB split effect */}
          <div className={`relative ${!imageLoaded ? "opacity-0" : "opacity-100"} transition-opacity duration-300`}>
            {/* Red channel - left offset (subtle) */}
            {isGlitching && (
              <img
                key={`red-${agentImage}`}
                src={agentImage}
                alt=""
                className="absolute inset-0 max-w-full max-h-56 object-contain pointer-events-none transition-all duration-75 ease-out"
                style={{
                  transform: `translateX(-${rgbOffset}px)`,
                  filter: "url(#agentRedChannel)",
                  opacity: glitchIntensity * 0.4,
                  mixBlendMode: "screen",
                }}
              />
            )}

            {/* Main agent image */}
            <img
              key={`main-${agentImage}`}
              src={agentImage}
              alt=""
              onLoad={() => setImageLoaded(true)}
              className="relative max-w-full max-h-56 object-contain transition-all duration-75 ease-out"
              style={{
                filter: `drop-shadow(0 0 25px ${hasMapContext ? mapColor : "#00d4aa"}50)`,
                transform: isGlitching ? `translateX(${glitchIntensity * 0.3}px)` : "none",
              }}
            />

            {/* Cyan channel - right offset (subtle) */}
            {isGlitching && (
              <img
                key={`cyan-${agentImage}`}
                src={agentImage}
                alt=""
                className="absolute inset-0 max-w-full max-h-56 object-contain pointer-events-none transition-all duration-75 ease-out"
                style={{
                  transform: `translateX(${rgbOffset}px)`,
                  filter: "url(#agentCyanChannel)",
                  opacity: glitchIntensity * 0.4,
                  mixBlendMode: "screen",
                }}
              />
            )}
          </div>
        </div>

        {/* Agent name */}
        <div className="relative">
          <h2
            className="text-lg font-black text-primary tracking-wider transition-all duration-75 ease-out uppercase"
            style={{
              transform: isGlitching ? `translateX(${glitchIntensity * -1}px)` : "none",
              textShadow: hasMapContext ? `0 0 20px ${mapColor}40` : "0 0 20px rgba(0,212,170,0.3)",
            }}
          >
            {displayAgent.name}
          </h2>
        </div>

        {/* Decorative bottom element */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3">
          <div
            className="w-12 h-px transition-all duration-300"
            style={{
              background: `linear-gradient(to right, transparent, ${hasMapContext ? mapColor : "#00d4aa"}60)`,
            }}
          />
          <div
            className="w-2 h-2 rotate-45 border transition-all duration-300"
            style={{
              borderColor: `${hasMapContext ? mapColor : "#00d4aa"}60`,
              boxShadow: `0 0 10px ${hasMapContext ? mapColor : "#00d4aa"}30`,
            }}
          />
          <div
            className="w-12 h-px transition-all duration-300"
            style={{
              background: `linear-gradient(to left, transparent, ${hasMapContext ? mapColor : "#00d4aa"}60)`,
            }}
          />
        </div>
      </div>

      {/* Corner accents with dynamic color */}
      <div className="absolute top-4 left-4 w-8 h-8 border-l-2 border-t-2 transition-colors duration-300" style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }} />
      <div className="absolute top-4 right-4 w-8 h-8 border-r-2 border-t-2 transition-colors duration-300" style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }} />
      <div className="absolute bottom-4 left-4 w-8 h-8 border-l-2 border-b-2 transition-colors duration-300" style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }} />
      <div className="absolute bottom-4 right-4 w-8 h-8 border-r-2 border-b-2 transition-colors duration-300" style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }} />

      {/* Animated corner particles */}
      {hasMapContext && (
        <>
          <div className="absolute top-6 left-6 w-1 h-1 rounded-full animate-ping" style={{ backgroundColor: mapColor, animationDuration: "2s" }} />
          <div className="absolute bottom-6 right-6 w-1 h-1 rounded-full animate-ping" style={{ backgroundColor: mapColor, animationDuration: "2.5s", animationDelay: "0.5s" }} />
        </>
      )}

      {/* SVG Filters for color channels */}
      <svg className="absolute w-0 h-0">
        <defs>
          <filter id="agentRedChannel">
            <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
          </filter>
          <filter id="agentCyanChannel">
            <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
          </filter>
        </defs>
      </svg>

      {/* Custom CSS animations */}
      <style>{`
        @keyframes scanMove {
          0% { transform: translateY(0); }
          100% { transform: translateY(100%); }
        }
        .animate-spin-slow {
          animation: spin 20s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
