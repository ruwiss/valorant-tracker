/* @refresh reset — force full remount on HMR so hook-dep length never mismatches across edits */
import { usePanelStore, type HoveredAgent } from "../stores/panelStore";
import { useState, useEffect, useRef, useCallback } from "react";

function markIfComplete(img: HTMLImageElement | null, setLoaded: (v: boolean) => void) {
  if (img && img.complete && img.naturalWidth > 0) {
    setLoaded(true);
  }
}

export function AgentOverlay() {
  const { hoveredAgent, isOpen, panelType } = usePanelStore();

  const [isGlitching, setIsGlitching] = useState(false);
  const [glitchIntensity, setGlitchIntensity] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [displayAgent, setDisplayAgent] = useState(hoveredAgent);

  /** Currently painted map splash (always the one you see). */
  const [activeSplash, setActiveSplash] = useState<string | null>(null);
  /** Previous splash while crossfading out. */
  const [fadingSplash, setFadingSplash] = useState<string | null>(null);
  const [fadeOut, setFadeOut] = useState(false);
  /** Soft Valorant-style transition tick */
  const [wipeActive, setWipeActive] = useState(false);
  const [wipeKey, setWipeKey] = useState(0);

  const prevKeyRef = useRef<string | null>(null);
  const prevAgentImageRef = useRef<string | null>(null);
  const prevMapSplashRef = useRef<string | null>(null);
  const activeSplashRef = useRef<string | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wipeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promoteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentImgRef = useRef<HTMLImageElement | null>(null);
  const pendingSplashRef = useRef<string | null>(null);

  activeSplashRef.current = activeSplash;

  const agentImgCallbackRef = useCallback((node: HTMLImageElement | null) => {
    agentImgRef.current = node;
    markIfComplete(node, setImageLoaded);
  }, []);

  // Stable ref so hover-effect deps stay a fixed-length array (avoids HMR/react warning)
  const commitSplash = useCallback((url: string, withTransition: boolean) => {
    if (promoteTimeoutRef.current) {
      clearTimeout(promoteTimeoutRef.current);
      promoteTimeoutRef.current = null;
    }

    const current = activeSplashRef.current;
    if (!current || !withTransition) {
      setActiveSplash(url);
      setFadingSplash(null);
      setFadeOut(false);
      setWipeActive(false);
      return;
    }

    if (current === url) return;

    // Keep old image visible, load new underneath, soft wipe, then swap
    setFadingSplash(current);
    setFadeOut(false);
    setActiveSplash(url);
    setWipeKey((k) => k + 1);
    setWipeActive(true);

    // Start fade of old layer next frame (new is already painted underneath)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setFadeOut(true));
    });

    if (wipeTimeoutRef.current) clearTimeout(wipeTimeoutRef.current);
    wipeTimeoutRef.current = setTimeout(() => {
      setWipeActive(false);
      setFadingSplash(null);
      setFadeOut(false);
      wipeTimeoutRef.current = null;
    }, 380);
  }, []);
  const commitSplashRef = useRef(commitSplash);
  commitSplashRef.current = commitSplash;

  // Handle hover changes — deps length must stay constant across renders
  useEffect(() => {
    if (hoveredAgent) {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }

      const nextAgentImg = hoveredAgent.mapOnly
        ? null
        : hoveredAgent.bustPortrait || hoveredAgent.displayIcon || null;
      const nextSplash = hoveredAgent.mapContext?.mapSplash || null;

      if (nextAgentImg !== prevAgentImageRef.current) {
        if (nextAgentImg) setImageLoaded(false);
        prevAgentImageRef.current = nextAgentImg;
      }

      if (nextSplash && nextSplash !== prevMapSplashRef.current) {
        const hadPrevious = !!prevMapSplashRef.current;
        prevMapSplashRef.current = nextSplash;
        pendingSplashRef.current = nextSplash;

        // Preload then commit so we never paint an empty frame
        const img = new Image();
        img.decoding = "async";
        const apply = () => {
          if (pendingSplashRef.current !== nextSplash) return;
          commitSplashRef.current(nextSplash, hadPrevious);
        };
        img.onload = () => {
          void (async () => {
            try {
              if (typeof img.decode === "function") await img.decode();
            } catch {
              /* ignore */
            }
            apply();
          })();
        };
        img.onerror = apply;
        img.src = nextSplash;
        if (img.complete && img.naturalWidth > 0) apply();
      }

      setDisplayAgent(hoveredAgent);

      requestAnimationFrame(() => {
        markIfComplete(agentImgRef.current, setImageLoaded);
      });
    } else {
      hideTimeoutRef.current = setTimeout(() => {
        setDisplayAgent(null);
        prevKeyRef.current = null;
        prevAgentImageRef.current = null;
        prevMapSplashRef.current = null;
        pendingSplashRef.current = null;
        setImageLoaded(false);
        setActiveSplash(null);
        setFadingSplash(null);
        setFadeOut(false);
        setWipeActive(false);
      }, 200);
    }

    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [hoveredAgent]);

  // Subtle agent-switch glitch — always 3 deps
  useEffect(() => {
    if (!displayAgent) return;

    const currentKey = hoverKey(displayAgent);
    if (prevKeyRef.current && prevKeyRef.current !== currentKey) {
      setIsGlitching(true);
      setGlitchIntensity(0.6);
      const fadeTimer = setTimeout(() => setGlitchIntensity(0.3), 30);
      const endTimer = setTimeout(() => {
        setGlitchIntensity(0);
        setIsGlitching(false);
      }, 60);
      prevKeyRef.current = currentKey;
      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(endTimer);
      };
    }
    prevKeyRef.current = currentKey;
  }, [displayAgent?.name, displayAgent?.mapContext?.mapName, displayAgent?.mapOnly]);

  // Cleanup timers on unmount — always empty deps
  useEffect(() => {
    return () => {
      if (wipeTimeoutRef.current) clearTimeout(wipeTimeoutRef.current);
      if (promoteTimeoutRef.current) clearTimeout(promoteTimeoutRef.current);
    };
  }, []);

  if (!displayAgent || !isOpen || panelType !== "settings") return null;

  const rgbOffset = glitchIntensity * 1.5;
  const hasMapContext = !!(displayAgent.mapContext && displayAgent.mapContext.mapSplash);
  const mapOnly = !!displayAgent.mapOnly && hasMapContext;
  const mapColor = displayAgent.mapContext?.mapColor || "#00d4aa";
  const mapName = displayAgent.mapContext?.mapName || "";
  const agentImage = displayAgent.bustPortrait || displayAgent.displayIcon || null;
  const mapOpacity = mapOnly ? 1 : 0.7;

  return (
    <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden">
      {/* Opaque base */}
      <div className="absolute inset-0 bg-[#0a0e13]" />

      {/* Map stack — active always on bottom, fading previous on top */}
      <div
        className="absolute inset-0"
        style={{
          transform: isGlitching
            ? `scale(${mapOnly ? 1.04 : 1.03}) translateX(${glitchIntensity}px)`
            : `scale(${mapOnly ? 1.02 : 1.01})`,
          transition: "transform 200ms ease-out",
        }}
      >
        {activeSplash && (
          <img
            key={`active-${activeSplash}`}
            src={activeSplash}
            alt=""
            draggable={false}
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ opacity: mapOpacity }}
          />
        )}

        {fadingSplash && (
          <img
            key={`fade-${fadingSplash}`}
            src={fadingSplash}
            alt=""
            draggable={false}
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ease-out"
            style={{ opacity: fadeOut ? 0 : mapOpacity }}
          />
        )}
      </div>

      {/* Vignette + map tint */}
      {hasMapContext && (
        <>
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{
              background: `linear-gradient(135deg, ${mapColor}18 0%, transparent 55%, ${mapColor}10 100%)`,
              opacity: activeSplash ? 1 : 0,
            }}
          />
          <div
            className={`absolute inset-0 transition-colors duration-300 ${
              mapOnly
                ? "bg-gradient-to-t from-[#0a0e13]/85 via-[#0a0e13]/20 to-[#0a0e13]/35"
                : "bg-gradient-to-br from-[#0a0e13]/60 via-[#0a0e13]/40 to-[#0a0e13]/50"
            }`}
          />
        </>
      )}

      {/* Soft Valorant-style wipe (thin line + light accent, no static) */}
      {wipeActive && (
        <div key={wipeKey} className="absolute inset-0 z-20 overflow-hidden pointer-events-none">
          {/* Soft brightness pulse */}
          <div
            className="absolute inset-0 valo-wipe-flash"
            style={{
              background: `linear-gradient(105deg, transparent 30%, ${mapColor}22 50%, transparent 70%)`,
            }}
          />
          {/* Single thin sweep line */}
          <div
            className="absolute top-0 bottom-0 w-px valo-wipe-line"
            style={{
              background: `linear-gradient(to bottom, transparent, ${mapColor}, transparent)`,
              boxShadow: `0 0 12px ${mapColor}aa, 0 0 28px ${mapColor}40`,
            }}
          />
          {/* Minimal top edge accent */}
          <div
            className="absolute top-0 left-0 right-0 h-px valo-wipe-edge"
            style={{ background: `linear-gradient(to right, transparent, ${mapColor}99, transparent)` }}
          />
        </div>
      )}

      {/* First-load spinner */}
      {hasMapContext && !activeSplash && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="w-7 h-7 border-2 rounded-full animate-spin"
            style={{
              borderColor: `${mapColor}22`,
              borderTopColor: mapColor,
            }}
          />
        </div>
      )}

      {/* Idle scan lines — very subtle */}
      <div className="absolute inset-0 overflow-hidden opacity-10">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,212,170,0.04) 2px, rgba(0,212,170,0.04) 4px)",
            animation: "scanMove 10s linear infinite",
          }}
        />
      </div>

      {/* Foreground */}
      {mapOnly ? (
        <div className="absolute inset-0 flex flex-col items-center justify-end p-8 pb-14 text-center z-10">
          <span
            className="text-[10px] font-bold uppercase tracking-[0.35em] mb-2"
            style={{ color: `${mapColor}bb` }}
          >
            HARİTA
          </span>
          <h2
            key={mapName}
            className="text-2xl font-black text-white tracking-[0.2em] uppercase drop-shadow-lg valo-title-in"
            style={{ textShadow: `0 0 24px ${mapColor}45` }}
          >
            {mapName}
          </h2>
          <div className="mt-4 flex items-center gap-3">
            <div className="w-10 h-px" style={{ background: `linear-gradient(to right, transparent, ${mapColor}70)` }} />
            <div className="w-1.5 h-1.5 rotate-45 border" style={{ borderColor: `${mapColor}70` }} />
            <div className="w-10 h-px" style={{ background: `linear-gradient(to left, transparent, ${mapColor}70)` }} />
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10">
          {hasMapContext && (
            <div className="mb-3">
              <div
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg backdrop-blur-md border"
                style={{
                  backgroundColor: `${mapColor}15`,
                  borderColor: `${mapColor}40`,
                }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: mapColor, boxShadow: `0 0 8px ${mapColor}` }}
                />
                <span className="text-[10px] font-black uppercase tracking-[0.25em]" style={{ color: mapColor }}>
                  {mapName}
                </span>
              </div>
            </div>
          )}

          <div className="mb-2">
            <span
              className="text-[10px] font-bold uppercase tracking-[0.3em]"
              style={{ color: hasMapContext ? `${mapColor}99` : "rgba(0,212,170,0.6)" }}
            >
              {hasMapContext ? "HARITA TERCİHİ" : "VARSAYILAN AJAN"}
            </span>
          </div>

          <div className="relative w-full max-w-64 h-56 flex items-center justify-center mb-4">
            <div
              className="absolute inset-0 blur-3xl rounded-full transition-all duration-500"
              style={{
                background: `radial-gradient(circle, ${hasMapContext ? mapColor : "#00d4aa"}25 0%, transparent 70%)`,
                transform: isGlitching ? "scale(1.2)" : "scale(1)",
              }}
            />

            <div className="absolute inset-4 opacity-30">
              <svg viewBox="0 0 100 100" className="w-full h-full" style={{ color: hasMapContext ? mapColor : "#00d4aa" }}>
                <polygon
                  points="50,2 95,25 95,75 50,98 5,75 5,25"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="0.5"
                  strokeDasharray="5,3"
                  className="animate-spin-slow"
                  style={{ transformOrigin: "center", animationDuration: "20s" }}
                />
              </svg>
            </div>

            {!imageLoaded && agentImage && (
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

            {agentImage && (
              <div className={`relative ${!imageLoaded ? "opacity-0" : "opacity-100"} transition-opacity duration-300`}>
                {isGlitching && (
                  <img
                    key={`red-${agentImage}`}
                    src={agentImage}
                    alt=""
                    className="absolute inset-0 max-w-full max-h-56 object-contain pointer-events-none"
                    style={{
                      transform: `translateX(-${rgbOffset}px)`,
                      filter: "url(#agentRedChannel)",
                      opacity: glitchIntensity * 0.4,
                      mixBlendMode: "screen",
                    }}
                  />
                )}

                <img
                  ref={agentImgCallbackRef}
                  key={`main-${agentImage}`}
                  src={agentImage}
                  alt=""
                  decoding="async"
                  onLoad={() => setImageLoaded(true)}
                  onError={() => setImageLoaded(true)}
                  className="relative max-w-full max-h-56 object-contain"
                  style={{
                    filter: `drop-shadow(0 0 25px ${hasMapContext ? mapColor : "#00d4aa"}50)`,
                    transform: isGlitching ? `translateX(${glitchIntensity * 0.3}px)` : "none",
                  }}
                />

                {isGlitching && (
                  <img
                    key={`cyan-${agentImage}`}
                    src={agentImage}
                    alt=""
                    className="absolute inset-0 max-w-full max-h-56 object-contain pointer-events-none"
                    style={{
                      transform: `translateX(${rgbOffset}px)`,
                      filter: "url(#agentCyanChannel)",
                      opacity: glitchIntensity * 0.4,
                      mixBlendMode: "screen",
                    }}
                  />
                )}
              </div>
            )}
          </div>

          <div className="relative">
            <h2
              className="text-lg font-black text-primary tracking-wider uppercase"
              style={{
                transform: isGlitching ? `translateX(${glitchIntensity * -1}px)` : "none",
                textShadow: hasMapContext ? `0 0 20px ${mapColor}40` : "0 0 20px rgba(0,212,170,0.3)",
              }}
            >
              {displayAgent.name}
            </h2>
          </div>

          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3">
            <div
              className="w-12 h-px"
              style={{
                background: `linear-gradient(to right, transparent, ${hasMapContext ? mapColor : "#00d4aa"}60)`,
              }}
            />
            <div
              className="w-2 h-2 rotate-45 border"
              style={{
                borderColor: `${hasMapContext ? mapColor : "#00d4aa"}60`,
                boxShadow: `0 0 10px ${hasMapContext ? mapColor : "#00d4aa"}30`,
              }}
            />
            <div
              className="w-12 h-px"
              style={{
                background: `linear-gradient(to left, transparent, ${hasMapContext ? mapColor : "#00d4aa"}60)`,
              }}
            />
          </div>
        </div>
      )}

      {/* Corner accents */}
      <div
        className="absolute top-4 left-4 w-8 h-8 border-l-2 border-t-2 z-10"
        style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }}
      />
      <div
        className="absolute top-4 right-4 w-8 h-8 border-r-2 border-t-2 z-10"
        style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }}
      />
      <div
        className="absolute bottom-4 left-4 w-8 h-8 border-l-2 border-b-2 z-10"
        style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }}
      />
      <div
        className="absolute bottom-4 right-4 w-8 h-8 border-r-2 border-b-2 z-10"
        style={{ borderColor: `${hasMapContext ? mapColor : "#00d4aa"}50` }}
      />

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

        /* Soft Valorant-like wipe */
        @keyframes valoWipeFlash {
          0% { opacity: 0; }
          35% { opacity: 1; }
          100% { opacity: 0; }
        }
        .valo-wipe-flash {
          animation: valoWipeFlash 0.35s ease-out forwards;
        }

        @keyframes valoWipeLine {
          0% { left: -2%; opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { left: 102%; opacity: 0; }
        }
        .valo-wipe-line {
          animation: valoWipeLine 0.35s cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }

        @keyframes valoWipeEdge {
          0% { opacity: 0; transform: scaleX(0.2); }
          40% { opacity: 1; transform: scaleX(1); }
          100% { opacity: 0; transform: scaleX(1); }
        }
        .valo-wipe-edge {
          transform-origin: center;
          animation: valoWipeEdge 0.35s ease-out forwards;
        }

        @keyframes valoTitleIn {
          0% { opacity: 0; transform: translateY(4px); letter-spacing: 0.35em; }
          100% { opacity: 1; transform: translateY(0); letter-spacing: 0.2em; }
        }
        .valo-title-in {
          animation: valoTitleIn 0.3s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
      `}</style>
    </div>
  );
}

function hoverKey(agent: HoveredAgent): string {
  return `${agent.mapOnly ? "map" : "agent"}-${agent.name}-${agent.mapContext?.mapName || "global"}`;
}
