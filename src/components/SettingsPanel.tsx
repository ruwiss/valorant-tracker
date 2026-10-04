import { useState, useEffect, useCallback, useRef } from "react";
import { useGameStore } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAssetsStore } from "../stores/assetsStore";
import { usePanelStore } from "../stores/panelStore";
import { useI18n } from "../lib/i18n";
import { useConstantsStore } from "../stores/constantsStore";
import { COMPETITIVE_MAPS, CompetitiveMap, MAP_METADATA } from "../lib/maps";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { CachedImage } from "./CachedImage";
import { PresetsTab } from "./PresetsTab";
import { invokeCommand } from "../utils/ipc";
import {
  AppWindow,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Info,
  Keyboard,
  Languages,
  Settings2,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

const STANDALONE_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "Insert", "Delete", "Home", "End", "PageUp", "PageDown", "Pause", "ScrollLock", "NumLock"];
const BLOCKED_KEYS = ["Escape", "Tab", "CapsLock", "Enter", "Backspace", "Space"];
const MODIFIERS = ["Control", "Alt", "Shift", "Meta"];

function buildHotkeyString(e: KeyboardEvent): string | null {
  const key = e.key;
  if (BLOCKED_KEYS.includes(key) || MODIFIERS.includes(key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let normalizedKey = key;
  if (key.match(/^F\d{1,2}$/i)) normalizedKey = key.toUpperCase();
  else if (key.length === 1 && key.match(/[a-zA-Z]/)) normalizedKey = key.toUpperCase();
  if (parts.length === 0) {
    if (STANDALONE_KEYS.includes(normalizedKey)) return normalizedKey;
    if (normalizedKey.length === 1 && normalizedKey.match(/[A-Z0-9]/)) return normalizedKey;
    return null;
  }
  parts.push(normalizedKey);
  return parts.join("+");
}

type Tab = "autolock" | "general";

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.84a13.8 13.8 0 0 0-.63 1.29 18.4 18.4 0 0 0-5.53 0 13.6 13.6 0 0 0-.64-1.29 19.7 19.7 0 0 0-4.93 1.53C.53 9.05-.32 13.6.1 18.1a19.9 19.9 0 0 0 6.03 3.05c.49-.66.92-1.36 1.29-2.1a12.9 12.9 0 0 1-2.03-.98l.5-.38a14.2 14.2 0 0 0 12.22 0l.5.38c-.65.39-1.33.71-2.04.98.37.74.8 1.44 1.29 2.1a19.8 19.8 0 0 0 6.03-3.05c.5-5.2-.84-9.72-3.57-13.73ZM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42s.95-2.42 2.16-2.42 2.18 1.1 2.16 2.42c0 1.33-.95 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42 2.18 1.1 2.16 2.42c0 1.33-.94 2.42-2.16 2.42Z" />
    </svg>
  );
}

/** Section heading followed by flat rows split by hairlines (no boxed card). */
function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="section-title text-accent-cyan/80 px-3 pt-4 pb-1">{title}</div>
      <div className="divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

/** One setting: inline icon, label + description, control on the right. */
function SettingsRow({
  icon: Icon,
  iconNode,
  label,
  desc,
  control,
  below,
  onClick,
}: {
  icon?: LucideIcon;
  iconNode?: ReactNode;
  label: string;
  desc?: string;
  control?: ReactNode;
  below?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-start gap-2.5">
        <span className="mt-px shrink-0 text-secondary">
          {Icon ? <Icon className="w-3.5 h-3.5" strokeWidth={2} /> : iconNode}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold text-primary leading-tight">{label}</div>
          {desc && <div className="text-[9px] text-secondary/85 leading-snug mt-0.5">{desc}</div>}
        </div>
        {control && <div className="shrink-0 self-center">{control}</div>}
      </div>
      {below && <div className="mt-2 pl-6">{below}</div>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="w-full text-left px-3 py-2.5 hover:bg-white/[0.03] transition-colors cursor-pointer">
        {body}
      </button>
    );
  }
  return <div className="px-3 py-2.5">{body}</div>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative w-8 h-[18px] shrink-0 rounded-full border transition-colors cursor-pointer ${
        checked ? "bg-accent-cyan/25 border-accent-cyan/60" : "bg-dark/80 border-white/15 hover:border-white/25"
      }`}
    >
      <span
        className={`absolute top-[2px] w-3 h-3 rounded-full transition-all duration-200 ${
          checked ? "left-[15px] bg-accent-cyan shadow-[0_0_8px_rgba(0,212,170,0.5)]" : "left-[2px] bg-secondary"
        }`}
      />
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex p-0.5 rounded-md bg-black/30 border border-white/[0.06]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-2 h-5 rounded-[4px] text-[10px] font-semibold transition-colors cursor-pointer ${
            value === o.value ? "bg-accent-cyan/20 text-accent-cyan" : "text-secondary hover:text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel() {
  const { autoLockAgent, setAutoLock, mapAgentPreferences } = useGameStore();
  const { hotkey, setHotkey, pauseHotkey, resumeHotkey, windowStyle, setWindowStyle, autoLockDelaySeconds, setAutoLockDelaySeconds, discordRpcEnabled, setDiscordRpcEnabled, minimizeToTray, setMinimizeToTray } = useSettingsStore();
  const { getAgentIcon, getAgentAsset, getMapSplash, loadAssets, agents: assetAgents } = useAssetsStore();
  const { locale, setLocale, t } = useI18n();
  const { constants } = useConstantsStore();
  const { settingsSubView, setSettingsSubView, setHoveredAgent } = usePanelStore();

  const [activeTab, setActiveTab] = useState<Tab>("autolock");
  const [recording, setRecording] = useState(false);
  const [recordingDisplay, setRecordingDisplay] = useState("");
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("...");
  const [installs, setInstalls] = useState<number | null>(null);
  const [expandedMap, setExpandedMap] = useState<CompetitiveMap | null>(null);
  const [hoveredAgents, setHoveredAgents] = useState<Record<string, string | null>>({});
  /** Debounce map-only restore so agent-to-agent moves don't flash the map title. */
  const mapOnlyRestoreRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion);
    invokeCommand<number | null>("get_install_count", undefined, { suppressErrorToast: true })
      .then((n) => {
        if (typeof n === "number" && Number.isFinite(n)) setInstalls(n);
      })
      .catch(() => {});
  }, []);

  const formattedInstalls =
    installs !== null ? installs.toLocaleString(locale === "tr" ? "tr-TR" : "en-US") : "";

  // If a previous failed load left us with empty icons, retry when settings opens
  useEffect(() => {
    if (assetAgents.size === 0) {
      void loadAssets();
    }
  }, [assetAgents.size, loadAssets]);

  useEffect(() => {
    return () => {
      if (mapOnlyRestoreRef.current) clearTimeout(mapOnlyRestoreRef.current);
    };
  }, []);

  const handleHover = (context: string, agent: string | null) => {
    setHoveredAgents((prev) => ({ ...prev, [context]: agent }));
  };

  const cancelMapOnlyRestore = useCallback(() => {
    if (mapOnlyRestoreRef.current) {
      clearTimeout(mapOnlyRestoreRef.current);
      mapOnlyRestoreRef.current = null;
    }
  }, []);

  // Handle agent hover for overlay - global agents (no map context)
  const handleAgentHoverEnter = useCallback(
    (agentName: string, mapContext?: { mapName: string; mapSplash: string | null; mapColor: string }) => {
      cancelMapOnlyRestore();
      const agentAsset = getAgentAsset(agentName);
      if (agentAsset) {
        setHoveredAgent({
          name: agentAsset.displayName,
          displayIcon: agentAsset.displayIcon,
          bustPortrait: agentAsset.bustPortrait,
          mapContext,
          mapOnly: false,
        });
      }
    },
    [getAgentAsset, setHoveredAgent, cancelMapOnlyRestore],
  );

  const handleAgentHoverLeave = useCallback(() => {
    cancelMapOnlyRestore();
    setHoveredAgent(null);
  }, [setHoveredAgent, cancelMapOnlyRestore]);

  /** Left panel: map splash only (no agent). Used when hovering a map row. */
  const handleMapHoverEnter = useCallback(
    (mapName: string, mapSplash: string | null, mapColor: string) => {
      cancelMapOnlyRestore();
      setHoveredAgent({
        name: mapName,
        displayIcon: "",
        bustPortrait: null,
        mapContext: { mapName, mapSplash, mapColor },
        mapOnly: true,
      });
    },
    [setHoveredAgent, cancelMapOnlyRestore],
  );

  /** Delayed map-only — only fires if we didn't enter another agent quickly. */
  const scheduleMapOnlyRestore = useCallback(
    (mapName: string, mapSplash: string | null, mapColor: string) => {
      cancelMapOnlyRestore();
      mapOnlyRestoreRef.current = setTimeout(() => {
        mapOnlyRestoreRef.current = null;
        setHoveredAgent({
          name: mapName,
          displayIcon: "",
          bustPortrait: null,
          mapContext: { mapName, mapSplash, mapColor },
          mapOnly: true,
        });
      }, 180);
    },
    [setHoveredAgent, cancelMapOnlyRestore],
  );

  const startRecording = useCallback(async () => {
    await pauseHotkey();
    setRecording(true);
    setRecordingDisplay("");
    setHotkeyError(null);
  }, [pauseHotkey]);

  const cancelRecording = useCallback(async () => {
    setRecording(false);
    setRecordingDisplay("");
    await resumeHotkey();
  }, [resumeHotkey]);

  const handleHotkeyRecord = useCallback(
    async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        cancelRecording();
        return;
      }
      const modParts: string[] = [];
      if (e.ctrlKey) modParts.push("Ctrl");
      if (e.altKey) modParts.push("Alt");
      if (e.shiftKey) modParts.push("Shift");
      if (MODIFIERS.includes(e.key)) {
        setRecordingDisplay(modParts.length > 0 ? modParts.join("+") + "+" : "");
        return;
      }
      const hotkeyString = buildHotkeyString(e);
      if (!hotkeyString) {
        setHotkeyError(t("settings.invalidKey"));
        setTimeout(() => setHotkeyError(null), 2000);
        return;
      }
      setRecording(false);
      setRecordingDisplay("");
      const success = await setHotkey(hotkeyString);
      if (!success) {
        setHotkeyError(t("settings.hotkeyFailed"));
        setTimeout(() => setHotkeyError(null), 2000);
      }
    },
    [setHotkey, t, cancelRecording],
  );

  useEffect(() => {
    if (recording) {
      window.addEventListener("keydown", handleHotkeyRecord);
      return () => window.removeEventListener("keydown", handleHotkeyRecord);
    }
  }, [recording, handleHotkeyRecord]);

  // Nested editor views (after all hooks — rules of hooks).
  if (settingsSubView === "presets") {
    return <PresetsTab />;
  }

  return (
    <div className="flex flex-col h-full bg-dark/40 backdrop-blur-md">
      {/* Tabs: Agent | Options */}
      <div className="flex px-2 border-b border-white/[0.06]">
        {([
          ["autolock", UserRound, t("settings.tabAgent")],
          ["general", Settings2, t("settings.title")],
        ] as const).map(([tab, Icon, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`relative flex-1 h-9 flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-wide whitespace-nowrap transition-colors cursor-pointer after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors ${
              activeTab === tab ? "text-accent-cyan after:bg-accent-cyan" : "text-secondary hover:text-primary after:bg-transparent"
            }`}
          >
            <Icon className="w-3.5 h-3.5" strokeWidth={2.4} />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 selection:bg-accent-cyan/30">
        {activeTab === "autolock" ? (
          /* Agent Selection Tab - Map-based */
          <div className="flex flex-col h-full">
            {/* Global Default Section */}
            <div className="p-4 bg-linear-to-b from-white/5 to-transparent border-b border-white/5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex flex-col">
                  <label className="section-title text-accent-cyan">{t("settings.defaultAgent")}</label>
                  <div className="h-3 flex items-center">
                    {hoveredAgents["global"] ? (
                      <span className="text-[9px] text-accent-cyan font-black animate-in fade-in slide-in-from-left-1 duration-200">➔ {hoveredAgents["global"].toUpperCase()}</span>
                    ) : (
                      <span className="text-[9px] text-secondary">{t("settings.defaultAgentDesc")}</span>
                    )}
                  </div>
                </div>
                {autoLockAgent && (
                  <button onClick={() => setAutoLock(null)} className="p-1 px-2 text-[9px] font-bold text-accent-red hover:bg-accent-red/10 rounded-md transition-all uppercase tracking-tighter">
                    {t("settings.reset")}
                  </button>
                )}
              </div>

              <div className="grid grid-cols-4 gap-3 bg-dark/60 p-3.5 rounded-xl border border-white/5">
                {(constants?.agents || []).map((agentData) => {
                  const isSelected = autoLockAgent === agentData.uuid;
                  const icon = getAgentIcon(agentData.name);

                  return (
                    <button
                      key={agentData.uuid}
                      onClick={() => setAutoLock(isSelected ? null : agentData.uuid)}
                      onMouseEnter={() => {
                        handleHover("global", agentData.name);
                        handleAgentHoverEnter(agentData.name);
                      }}
                      onMouseLeave={() => {
                        handleHover("global", null);
                        handleAgentHoverLeave();
                      }}
                      className={`group relative aspect-square rounded-xl overflow-hidden border transition-all duration-200 cursor-pointer ${
                        isSelected
                          ? "ring-2 ring-accent-cyan ring-offset-2 ring-offset-dark border-accent-cyan/40 z-10"
                          : "border-white/[0.04] grayscale opacity-50 hover:grayscale-0 hover:opacity-100 hover:border-white/25 hover:bg-white/5 active:scale-95"
                      }`}
                    >
                      {icon ? <CachedImage src={icon} alt={agentData.name} className="w-full h-full object-cover pointer-events-none" /> : <div className="w-full h-full flex items-center justify-center bg-white/5 text-[10px] font-black">{agentData.name[0].toUpperCase()}</div>}
                      {isSelected && <div className="absolute inset-0 bg-accent-cyan/10 pointer-events-none" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="px-4 py-3 bg-dark/40 border-b border-white/5">
              <div className="flex items-center justify-between mb-2">
                <label className="section-title text-secondary">{t("settings.lockDelay")}</label>
                <span className="text-[10px] font-black text-accent-green tabular-nums">{autoLockDelaySeconds}s</span>
              </div>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={autoLockDelaySeconds}
                onChange={(event) => setAutoLockDelaySeconds(Number(event.target.value))}
                className="w-full accent-[#3fffbd] cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-secondary/80 font-bold mt-1">
                <span>1s</span>
                <span>{t("settings.lockDelayDefault")}</span>
                <span>10s</span>
              </div>
            </div>

            {/* Map-Specific Section */}
            <div className="p-4 space-y-3">
              <label className="section-title text-secondary block mb-1">{t("settings.mapPrefs")}</label>

              <div className="space-y-2.5">
                {COMPETITIVE_MAPS.map((map) => {
                  const selectedAgent = mapAgentPreferences[map];
                  const isMapOverride = !!selectedAgent;
                  // Map override wins; otherwise fall back to global default for display.
                  const displayAgentUuid = selectedAgent || autoLockAgent;
                  const displayAgent = displayAgentUuid
                    ? constants?.agents.find((a) => a.uuid === displayAgentUuid)
                    : undefined;
                  const displayIcon = displayAgent ? getAgentIcon(displayAgent.name) : null;
                  const isExpanded = expandedMap === map;
                  const splash = getMapSplash(map);

                  const mapColor = MAP_METADATA[map]?.color || "#00d4aa";
                  const mapCtx = { mapName: map, mapSplash: splash, mapColor };

                  return (
                    <div
                      key={map}
                      className={`group border rounded-2xl overflow-hidden transition-all duration-500 ${isExpanded ? "border-accent-cyan shadow-2xl shadow-accent-cyan/10" : "border-white/5 hover:border-white/20"}`}
                      onMouseEnter={() => handleMapHoverEnter(map, splash, mapColor)}
                      onMouseLeave={handleAgentHoverLeave}
                    >
                      {/* Map Header with Background */}
                      <button
                        onClick={() => {
                          setExpandedMap(isExpanded ? null : map);
                        }}
                        className="relative w-full h-16 overflow-hidden"
                      >
                        {/* Background Splash — darken center so splash art agents don't fight the badge */}
                        <div className={`absolute inset-0 transition-all duration-700 ${isExpanded ? "scale-105" : "group-hover:scale-110"}`}>
                          {splash ? (
                            <CachedImage
                              src={splash}
                              alt=""
                              className={`w-full h-full object-cover object-left transition-all duration-700 ${isExpanded ? "grayscale-0 brightness-[0.65]" : "grayscale-[0.4] brightness-[0.35]"}`}
                            />
                          ) : (
                            <div className="w-full h-full bg-card" />
                          )}
                          <div className={`absolute inset-0 bg-linear-to-r from-dark via-dark/75 to-dark/45 transition-all duration-700 ${isExpanded ? "via-dark/40 to-dark/25" : ""}`} />
                          <div className="absolute inset-0 bg-linear-to-t from-dark/70 via-transparent to-transparent" />
                        </div>

                        {/* Map name — top-left */}
                        <div className="absolute top-2.5 left-3.5 z-10 flex flex-col items-start">
                          <span className="text-[12px] font-black text-white uppercase tracking-wider drop-shadow-md">{map}</span>
                          {hoveredAgents[map] && (
                            <span className="text-[9px] text-accent-cyan font-black animate-in fade-in slide-in-from-left-1 duration-200 uppercase tracking-tighter">
                              {hoveredAgents[map]}
                            </span>
                          )}
                        </div>

                        {/* Expand chevron — top-right */}
                        <ChevronDown
                          className={`absolute top-3 right-3 z-10 w-4 h-4 transition-all duration-500 ${isExpanded ? "rotate-180 text-accent-cyan" : "text-secondary group-hover:text-primary"}`}
                          strokeWidth={2.5}
                        />

                        {/* Soft agent chip — bottom-right.
                            Map override: icon + name (clear).
                            Inherited default: icon only (quiet, no "Varsayılan" spam). */}
                        {displayAgent && (
                          isMapOverride ? (
                            <div className="absolute bottom-1.5 right-2.5 z-10 flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full bg-black/50 backdrop-blur-md border border-accent-cyan/35 shadow-[0_4px_14px_rgba(0,0,0,0.35)] pointer-events-none animate-in fade-in zoom-in-95 duration-300">
                              {displayIcon ? (
                                <CachedImage
                                  src={displayIcon}
                                  alt={displayAgent.name}
                                  className="w-5 h-5 rounded-full object-cover ring-1 ring-accent-cyan/45"
                                />
                              ) : (
                                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black bg-accent-cyan/20 text-accent-cyan">
                                  {displayAgent.name[0]?.toUpperCase()}
                                </div>
                              )}
                              <span className="text-[9px] font-bold uppercase tracking-wide leading-none text-accent-cyan">
                                {displayAgent.name}
                              </span>
                            </div>
                          ) : (
                            <div
                              className="absolute bottom-1.5 right-2.5 z-10 pointer-events-none animate-in fade-in duration-300"
                              title={t("settings.defaultOf", { agent: displayAgent.name })}
                            >
                              {displayIcon ? (
                                <CachedImage
                                  src={displayIcon}
                                  alt={displayAgent.name}
                                  className="w-6 h-6 rounded-full object-cover opacity-55 ring-1 ring-white/15 shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
                                />
                              ) : (
                                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-black bg-black/40 text-white/40 ring-1 ring-white/10">
                                  {displayAgent.name[0]?.toUpperCase()}
                                </div>
                              )}
                            </div>
                          )
                        )}
                      </button>

                      {/* Agent Grid (Expanded) — 4 cols, airy spacing */}
                      {isExpanded && (
                        <div className="p-3.5 bg-dark/40 backdrop-blur-xl border-t border-white/5 animate-in slide-in-from-top-2 duration-300">
                          <div className="grid grid-cols-4 gap-3">
                            {(constants?.agents || []).map((agentData) => {
                              const isSelected = selectedAgent === agentData.uuid;
                              // Soft-select global default when this map has no override
                              const isDefaultPreview = !selectedAgent && autoLockAgent === agentData.uuid;
                              const icon = getAgentIcon(agentData.name);

                              return (
                                <button
                                  key={agentData.uuid}
                                  onClick={() => setAutoLock(isSelected ? null : agentData.uuid, map)}
                                  onMouseEnter={() => {
                                    handleHover(map, agentData.name);
                                    // Agent + map background (cancels pending map-only restore)
                                    handleAgentHoverEnter(agentData.name, mapCtx);
                                  }}
                                  onMouseLeave={() => {
                                    handleHover(map, null);
                                    // Debounced: only restore map-only if we didn't hop to another agent
                                    scheduleMapOnlyRestore(map, splash, mapColor);
                                  }}
                                  className={`group relative aspect-square rounded-xl overflow-hidden border transition-all duration-200 cursor-pointer ${
                                    isSelected
                                      ? "ring-2 ring-accent-cyan ring-offset-2 ring-offset-dark border-accent-cyan/40 z-10"
                                      : isDefaultPreview
                                        ? "ring-1 ring-white/25 border-white/15 opacity-85 grayscale-0"
                                        : "border-white/[0.04] grayscale opacity-50 hover:grayscale-0 hover:opacity-100 hover:border-white/25 hover:bg-white/5 active:scale-95"
                                  }`}
                                  title={
                                    isDefaultPreview
                                      ? `${agentData.name.toUpperCase()} (${t("settings.defaultTag")})`
                                      : agentData.name.toUpperCase()
                                  }
                                >
                                  {icon ? (
                                    <CachedImage src={icon} alt={agentData.name} className="w-full h-full object-cover pointer-events-none" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center bg-white/5 text-[10px] font-black">
                                      {agentData.name[0].toUpperCase()}
                                    </div>
                                  )}
                                  {isSelected && <div className="absolute inset-0 bg-accent-cyan/10 pointer-events-none" />}
                                  {isDefaultPreview && !isSelected && (
                                    <div className="absolute inset-x-0 bottom-0 py-0.5 bg-black/55 text-[8px] font-bold text-white/70 uppercase tracking-tighter text-center pointer-events-none">
                                      {t("settings.defaultTagShort")}
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          /* General Settings Tab — grouped rows */
          <div className="pb-3">
            <SettingsGroup title={t("settings.sectionAppearance")}>
              <SettingsRow
                icon={Languages}
                label={t("settings.language")}
                desc={t("settings.languageDesc")}
                control={
                  <Segmented
                    value={locale}
                    onChange={setLocale}
                    options={[
                      { value: "tr", label: "TR" },
                      { value: "en", label: "EN" },
                    ]}
                  />
                }
              />
              <SettingsRow
                icon={AppWindow}
                label={t("settings.windowStyle")}
                desc={t("settings.windowStyleDesc")}
                control={
                  <Segmented
                    value={windowStyle}
                    onChange={setWindowStyle}
                    options={[
                      { value: "free", label: t("settings.windowStyleFreeShort") },
                      { value: "docked", label: t("settings.windowStyleDockedShort") },
                    ]}
                  />
                }
              />
              <SettingsRow
                icon={ArrowDownToLine}
                label={t("settings.minimizeToTray")}
                desc={t("settings.minimizeToTrayDesc")}
                control={<Toggle checked={minimizeToTray} onChange={setMinimizeToTray} label={t("settings.minimizeToTray")} />}
              />
            </SettingsGroup>

            <SettingsGroup title={t("settings.sectionControls")}>
              <SettingsRow
                icon={Keyboard}
                label={t("settings.hotkey")}
                desc={t("settings.hotkeyNote")}
                control={
                  recording ? (
                    <div className="min-w-12 h-7 px-2 rounded-md text-[11px] font-bold border bg-accent-cyan/20 border-accent-cyan text-accent-cyan animate-pulse flex items-center justify-center">
                      {recordingDisplay || "..."}
                    </div>
                  ) : (
                    <button
                      onClick={startRecording}
                      title={t("settings.hotkeyChange")}
                      className="min-w-12 h-7 px-2 rounded-md text-[11px] font-bold font-mono border border-white/15 border-b-2 bg-dark/70 text-primary hover:border-accent-cyan/60 hover:text-accent-cyan transition-colors cursor-pointer"
                    >
                      {hotkey}
                    </button>
                  )
                }
                below={
                  recording || hotkeyError ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[9px] ${hotkeyError ? "text-error" : "text-accent-cyan"}`}>
                        {hotkeyError ?? t("settings.hotkeyRecording")}
                      </span>
                      {recording && (
                        <button onClick={cancelRecording} className="px-2 h-6 rounded-md text-[10px] font-semibold border border-error/50 text-error hover:bg-error/10 transition-colors cursor-pointer">
                          {t("settings.cancel")}
                        </button>
                      )}
                    </div>
                  ) : undefined
                }
              />
            </SettingsGroup>

            <SettingsGroup title={t("settings.sectionIntegrations")}>
              <SettingsRow
                iconNode={<DiscordIcon className="w-3.5 h-3.5" />}
                label={t("settings.discordRpc")}
                desc={t("settings.discordRpcDesc")}
                control={<Toggle checked={discordRpcEnabled} onChange={setDiscordRpcEnabled} label={t("settings.discordRpc")} />}
              />
              <SettingsRow
                icon={SlidersHorizontal}
                label={t("settings.sectionPresetsOpen")}
                desc={t("settings.sectionPresetsDesc")}
                onClick={() => setSettingsSubView("presets")}
                control={<ChevronRight className="w-4 h-4 text-secondary shrink-0" />}
              />
            </SettingsGroup>

            <SettingsGroup title={t("settings.sectionAbout")}>
              <SettingsRow
                icon={FileText}
                label={t("settings.openLogs")}
                desc={t("settings.logsNote")}
                onClick={() => invoke("open_log_file").catch((e) => console.error("Failed to open log file:", e))}
                control={<ExternalLink className="w-3.5 h-3.5 text-secondary shrink-0" />}
              />
              <SettingsRow
                icon={Info}
                label={t("settings.version")}
                control={<span className="text-[11px] font-mono text-primary">{appVersion}</span>}
              />
              {installs !== null && (
                <SettingsRow
                  icon={Download}
                  label={t("settings.installs")}
                  control={
                    <span className="text-[11px] font-mono text-secondary" title={t("settings.installsHint", { n: formattedInstalls })}>
                      {formattedInstalls}
                    </span>
                  }
                />
              )}
            </SettingsGroup>
          </div>
        )}
      </div>

      {/* Footer / Attribution - Always visible */}
      <div className="p-2 border-t border-border">
        <p className="text-[9px] text-secondary text-center">
          {t("settings.madeBy")}{" "}
          <a
            href="https://github.com/ruwiss/"
            className="text-accent-cyan hover:underline font-semibold"
            onClick={(e) => {
              e.preventDefault();
              import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl("https://github.com/ruwiss/"));
            }}
          >
            @ruwiss
          </a>
        </p>
      </div>
    </div>
  );
}
