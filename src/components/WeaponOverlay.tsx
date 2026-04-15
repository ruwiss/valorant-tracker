import { usePanelStore } from "../stores/panelStore";
import { useI18n } from "../lib/i18n";
import { useState, useEffect, useRef } from "react";

export function WeaponOverlay() {
  const { hoveredWeapon, isOpen, panelType } = usePanelStore();
  const { t } = useI18n();
  const [isGlitching, setIsGlitching] = useState(false);
  const [glitchIntensity, setGlitchIntensity] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const prevWeaponRef = useRef<string | null>(null);

  // Trigger smooth glitch effect when weapon changes
  useEffect(() => {
    if (!hoveredWeapon) {
      prevWeaponRef.current = null;
      setImageLoaded(false);
      return;
    }

    const currentKey = `${hoveredWeapon.weaponType}-${hoveredWeapon.name}`;
    if (prevWeaponRef.current && prevWeaponRef.current !== currentKey) {
      setImageLoaded(false); // Reset loading state
      setIsGlitching(true);
      setGlitchIntensity(1);

      // Smooth fade out
      const fadeTimer = setTimeout(() => setGlitchIntensity(0.5), 30);
      const endTimer = setTimeout(() => {
        setGlitchIntensity(0);
        setIsGlitching(false);
      }, 80);

      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(endTimer);
      };
    }
    prevWeaponRef.current = currentKey;
  }, [hoveredWeapon?.weaponType, hoveredWeapon?.name]);

  if (!hoveredWeapon || !isOpen || panelType !== "player") return null;

  const rgbOffset = glitchIntensity * 2;

  return (
    <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden">
      {/* Dark backdrop */}
      <div className="absolute inset-0 bg-[#0a0e13]/90 backdrop-blur-sm" />

      {/* Content container */}
      <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
        {/* Weapon type */}
        <div className="mb-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-accent-cyan/60">{hoveredWeapon.weaponType}</span>
        </div>

        {/* Weapon image */}
        <div className="relative w-full max-w-70 h-30 flex items-center justify-center mb-4">
          {/* Glow effect */}
          <div className="absolute inset-0 bg-accent-cyan/10 blur-3xl rounded-full" />

          {/* Scan line effect */}
          <div className="absolute inset-0 overflow-hidden opacity-30">
            <div className="absolute inset-0 scan-lines" />
          </div>

          {!imageLoaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
            </div>
          )}

          {/* Weapon image with smooth RGB split */}
          <div className={`relative ${!imageLoaded ? "opacity-0" : "opacity-100"} transition-opacity duration-200`}>
            {/* Red channel - left offset */}
            {isGlitching && (
              <img
                key={`red-${hoveredWeapon.icon}`}
                src={hoveredWeapon.icon}
                alt=""
                className="absolute inset-0 max-w-full max-h-30 object-contain pointer-events-none transition-all duration-75 ease-out"
                style={{
                  transform: `translateX(-${rgbOffset}px)`,
                  filter: "url(#redChannel)",
                  opacity: glitchIntensity * 0.6,
                  mixBlendMode: "screen",
                }}
              />
            )}

            {/* Main image */}
            <img
              key={`main-${hoveredWeapon.icon}`}
              src={hoveredWeapon.icon}
              alt=""
              onLoad={() => setImageLoaded(true)}
              className="relative max-w-full max-h-30 object-contain drop-shadow-[0_0_30px_rgba(0,212,170,0.4)] transition-transform duration-75 ease-out"
              style={{
                transform: isGlitching ? `translateX(${glitchIntensity * 0.5}px)` : "none",
              }}
            />

            {/* Cyan channel - right offset */}
            {isGlitching && (
              <img
                key={`cyan-${hoveredWeapon.icon}`}
                src={hoveredWeapon.icon}
                alt=""
                className="absolute inset-0 max-w-full max-h-30 object-contain pointer-events-none transition-all duration-75 ease-out"
                style={{
                  transform: `translateX(${rgbOffset}px)`,
                  filter: "url(#cyanChannel)",
                  opacity: glitchIntensity * 0.6,
                  mixBlendMode: "screen",
                }}
              />
            )}
          </div>
        </div>

        {/* Weapon name */}
        <h2 className="text-lg font-black text-primary tracking-wide transition-transform duration-75 ease-out" style={{ transform: isGlitching ? `translateX(${glitchIntensity * -1}px)` : "none" }}>
          {hoveredWeapon.name}
        </h2>

        {/* Buddy section */}
        {hoveredWeapon.buddy && (
          <div className="mt-4 flex items-center gap-2 px-3 py-2 bg-card/50 rounded-lg border border-border/30">
            <img src={hoveredWeapon.buddy.icon} alt="" className="w-8 h-8 object-contain drop-shadow-[0_0_8px_rgba(236,178,46,0.4)]" />
            <div className="text-left">
              <div className="text-[8px] uppercase tracking-wider text-accent-gold/60">{t("weapons.buddy")}</div>
              <div className="text-[10px] text-primary font-medium">{hoveredWeapon.buddy.name}</div>
            </div>
          </div>
        )}

        {/* Decorative lines */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2">
          <div className="w-8 h-px bg-linear-to-r from-transparent to-accent-cyan/50" />
          <div className="w-1.5 h-1.5 rotate-45 border border-accent-cyan/50" />
          <div className="w-8 h-px bg-linear-to-l from-transparent to-accent-cyan/50" />
        </div>
      </div>

      {/* Corner accents */}
      <div className="absolute top-4 left-4 w-6 h-6 border-l-2 border-t-2 border-accent-cyan/40" />
      <div className="absolute top-4 right-4 w-6 h-6 border-r-2 border-t-2 border-accent-cyan/40" />
      <div className="absolute bottom-4 left-4 w-6 h-6 border-l-2 border-b-2 border-accent-cyan/40" />
      <div className="absolute bottom-4 right-4 w-6 h-6 border-r-2 border-b-2 border-accent-cyan/40" />

      {/* SVG Filters for color channels */}
      <svg className="absolute w-0 h-0">
        <defs>
          <filter id="redChannel">
            <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
          </filter>
          <filter id="cyanChannel">
            <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
          </filter>
        </defs>
      </svg>
    </div>
  );
}
