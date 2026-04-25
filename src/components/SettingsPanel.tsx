import { useState, useEffect, useCallback } from "react";
import { useGameStore } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAssetsStore } from "../stores/assetsStore";
import { usePanelStore } from "../stores/panelStore";
import { useI18n } from "../lib/i18n";
import { useConstantsStore } from "../stores/constantsStore";
import { COMPETITIVE_MAPS, CompetitiveMap, MAP_METADATA } from "../lib/maps";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { CachedImage } from "./CachedImage";

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

export function SettingsPanel() {
  const { autoLockAgent, setAutoLock, mapAgentPreferences } = useGameStore();
  const { hotkey, setHotkey, pauseHotkey, resumeHotkey, contactInfo, windowStyle, setWindowStyle } = useSettingsStore();
  const { getAgentIcon, getAgentAsset, getMapSplash } = useAssetsStore();
  const { locale, setLocale, t } = useI18n();
  const { setHoveredAgent } = usePanelStore();
  const { constants } = useConstantsStore();

  const [activeTab, setActiveTab] = useState<Tab>("autolock");
  const [recording, setRecording] = useState(false);
  const [recordingDisplay, setRecordingDisplay] = useState("");
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("...");
  const [expandedMap, setExpandedMap] = useState<CompetitiveMap | null>(null);
  const [hoveredAgents, setHoveredAgents] = useState<Record<string, string | null>>({});

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  const handleHover = (context: string, agent: string | null) => {
    setHoveredAgents((prev) => ({ ...prev, [context]: agent }));
  };

  // Handle agent hover for overlay - global agents (no map context)
  const handleAgentHoverEnter = useCallback(
    (agentName: string, mapContext?: { mapName: string; mapSplash: string | null; mapColor: string }) => {
      const agentAsset = getAgentAsset(agentName);
      if (agentAsset) {
        setHoveredAgent({
          name: agentAsset.displayName,
          displayIcon: agentAsset.displayIcon,
          bustPortrait: agentAsset.bustPortrait,
          mapContext,
        });
      }
    },
    [getAgentAsset, setHoveredAgent],
  );

  const handleAgentHoverLeave = useCallback(() => {
    setHoveredAgent(null);
  }, [setHoveredAgent]);

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
        setHotkeyError(locale === "tr" ? "Geçersiz tuş" : "Invalid key");
        setTimeout(() => setHotkeyError(null), 2000);
        return;
      }
      setRecording(false);
      setRecordingDisplay("");
      const success = await setHotkey(hotkeyString);
      if (!success) {
        setHotkeyError(locale === "tr" ? "Kayıt başarısız" : "Failed");
        setTimeout(() => setHotkeyError(null), 2000);
      }
    },
    [setHotkey, locale, cancelRecording],
  );

  useEffect(() => {
    if (recording) {
      window.addEventListener("keydown", handleHotkeyRecord);
      return () => window.removeEventListener("keydown", handleHotkeyRecord);
    }
  }, [recording, handleHotkeyRecord]);

  return (
    <div className="flex flex-col h-full bg-dark/40 backdrop-blur-md">
      {/* Tabs */}
      <div className="flex p-2 gap-2 border-b border-white/5 bg-white/2">
        <button
          onClick={() => setActiveTab("autolock")}
          className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all duration-300 ${activeTab === "autolock" ? "bg-accent-cyan text-dark shadow-lg shadow-accent-cyan/20 scale-[1.02]" : "text-dim hover:text-primary hover:bg-white/5"}`}
        >
          {locale === "tr" ? "Ajan Seçimi" : "Agent Select"}
        </button>
        <button
          onClick={() => setActiveTab("general")}
          className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all duration-300 ${activeTab === "general" ? "bg-accent-cyan text-dark shadow-lg shadow-accent-cyan/20 scale-[1.02]" : "text-dim hover:text-primary hover:bg-white/5"}`}
        >
          {t("settings.title")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 selection:bg-accent-cyan/30">
        {activeTab === "autolock" ? (
          /* Agent Selection Tab - Map-based */
          <div className="flex flex-col h-full">
            {/* Global Default Section */}
            <div className="p-4 bg-linear-to-b from-white/5 to-transparent border-b border-white/5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex flex-col">
                  <label className="text-[10px] text-accent-cyan font-black uppercase tracking-[0.2em]">{locale === "tr" ? "Varsayılan Ajan" : "Global Default"}</label>
                  <div className="h-3 flex items-center">
                    {hoveredAgents["global"] ? (
                      <span className="text-[9px] text-accent-cyan font-black animate-in fade-in slide-in-from-left-1 duration-200">➔ {hoveredAgents["global"].toUpperCase()}</span>
                    ) : (
                      <span className="text-[8px] text-dim">{locale === "tr" ? "Tüm haritalar için geçerli seçim" : "Fallback for all maps"}</span>
                    )}
                  </div>
                </div>
                {autoLockAgent && (
                  <button onClick={() => setAutoLock(null)} className="p-1 px-2 text-[9px] font-bold text-accent-red hover:bg-accent-red/10 rounded-md transition-all uppercase tracking-tighter">
                    {locale === "tr" ? "Sıfırla" : "Reset"}
                  </button>
                )}
              </div>

              <div className="grid grid-cols-6 gap-2 bg-dark/60 p-2.5 rounded-xl border border-white/5">
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
                      className={`group relative aspect-square rounded-lg overflow-hidden transition-all duration-300 ${isSelected ? "ring-2 ring-accent-cyan ring-offset-2 ring-offset-dark scale-105 z-10" : "grayscale opacity-40 hover:grayscale-0 hover:opacity-100 hover:scale-110"}`}
                    >
                      {icon ? <CachedImage src={icon} alt={agentData.name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center bg-white/5 text-[8px] font-black">{agentData.name[0].toUpperCase()}</div>}
                      {isSelected && <div className="absolute inset-0 bg-accent-cyan/10" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Map-Specific Section */}
            <div className="p-4 space-y-3">
              <label className="text-[10px] text-dim font-black uppercase tracking-[0.2em] block mb-1">{locale === "tr" ? "Harita Bazlı Tercihler" : "Map-Specific Preferences"}</label>

              <div className="space-y-2.5">
                {COMPETITIVE_MAPS.map((map) => {
                  const selectedAgent = mapAgentPreferences[map];
                  const isExpanded = expandedMap === map;
                  const splash = getMapSplash(map);

                  return (
                    <div key={map} className={`group border rounded-2xl overflow-hidden transition-all duration-500 ${isExpanded ? "border-accent-cyan shadow-2xl shadow-accent-cyan/10" : "border-white/5 hover:border-white/20"}`}>
                      {/* Map Header with Background */}
                      <button
                        onClick={() => {
                          setExpandedMap(isExpanded ? null : map);
                        }}
                        className="relative w-full h-15 overflow-hidden flex items-center px-4"
                      >
                        {/* Background Splash */}
                        <div className={`absolute inset-0 transition-all duration-700 ${isExpanded ? "scale-105" : "group-hover:scale-110"}`}>
                          {splash ? <CachedImage src={splash} alt="" className={`w-full h-full object-cover transition-all duration-700 ${isExpanded ? "grayscale-0 brightness-[0.7]" : "grayscale-[0.5] brightness-[0.4]"}`} /> : <div className="w-full h-full bg-card" />}
                          <div className={`absolute inset-0 bg-linear-to-r from-dark transition-all duration-700 ${isExpanded ? "via-dark/30" : "via-dark/60"} to-transparent`} />
                        </div>

                        {/* Content */}
                        <div className="relative flex items-center justify-between w-full">
                          <div className="flex flex-col items-start translate-x-0 group-hover:translate-x-1 transition-transform">
                            <span className="text-[12px] font-black text-white uppercase tracking-wider">{map}</span>
                            <div className="h-3 flex items-center">{hoveredAgents[map] && <span className="text-[9px] text-accent-cyan font-black animate-in fade-in slide-in-from-left-1 duration-200 uppercase tracking-tighter">{hoveredAgents[map]}</span>}</div>
                          </div>

                          <div className="flex items-center gap-3">
                            {selectedAgent && (() => {
                              const agentInfo = constants?.agents.find((a) => a.uuid === selectedAgent);
                              if (!agentInfo) return null;
                              return (
                                <div className="flex items-center gap-2 bg-dark/80 backdrop-blur-md px-2.5 py-1.5 rounded-xl border border-white/10 animate-in zoom-in-90 duration-300">
                                  {getAgentIcon(agentInfo.name) && <CachedImage src={getAgentIcon(agentInfo.name)!} className="w-4 h-4 rounded-full" />}
                                  <span className="text-[9px] font-black text-accent-cyan uppercase">{agentInfo.name}</span>
                                </div>
                              );
                            })()}
                            <svg className={`w-4 h-4 text-dim transition-all duration-500 ${isExpanded ? "rotate-180 text-accent-cyan" : "group-hover:text-primary"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                            </svg>
                          </div>
                        </div>
                      </button>

                      {/* Agent Grid (Expanded) */}
                      {isExpanded && (
                        <div className="p-3 bg-dark/40 backdrop-blur-xl border-t border-white/5 animate-in slide-in-from-top-2 duration-300">
                          <div className="grid grid-cols-6 gap-2">
                            {(constants?.agents || []).map((agentData) => {
                              const isSelected = selectedAgent === agentData.uuid;
                              const icon = getAgentIcon(agentData.name);

                              return (
                                <button
                                  key={agentData.uuid}
                                  onClick={() => setAutoLock(isSelected ? null : agentData.uuid, map)}
                                  onMouseEnter={() => {
                                    handleHover(map, agentData.name);
                                    handleAgentHoverEnter(agentData.name, {
                                      mapName: map,
                                      mapSplash: splash,
                                      mapColor: MAP_METADATA[map]?.color || "#00d4aa",
                                    });
                                  }}
                                  onMouseLeave={() => {
                                    handleHover(map, null);
                                    handleAgentHoverLeave();
                                  }}
                                  className={`group relative aspect-square rounded-lg overflow-hidden transition-all duration-300 ${isSelected ? "ring-2 ring-accent-cyan ring-offset-2 ring-offset-dark scale-105 z-10" : "grayscale opacity-40 hover:grayscale-0 hover:opacity-100 hover:scale-110"}`}
                                  title={agentData.name.toUpperCase()}
                                >
                                  {icon ? <CachedImage src={icon} alt={agentData.name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center bg-white/5 text-[8px] font-black">{agentData.name[0].toUpperCase()}</div>}
                                  {isSelected && <div className="absolute inset-0 bg-accent-cyan/10" />}
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
          /* General Settings Tab */
          <div className="p-3 space-y-4">
            {/* Language */}
            <div>
              <label className="text-[10px] text-dim block mb-1.5">{t("settings.language")}</label>
              <div className="flex gap-1.5">
                <button onClick={() => setLocale("en")} className={`flex-1 h-7 rounded text-[10px] font-semibold border transition-all ${locale === "en" ? "bg-accent-cyan/15 border-accent-cyan text-accent-cyan" : "border-border text-secondary hover:bg-card-hover"}`}>
                  EN
                </button>
                <button onClick={() => setLocale("tr")} className={`flex-1 h-7 rounded text-[10px] font-semibold border transition-all ${locale === "tr" ? "bg-accent-cyan/15 border-accent-cyan text-accent-cyan" : "border-border text-secondary hover:bg-card-hover"}`}>
                  TR
                </button>
              </div>
            </div>

            {/* Window Style */}
            <div>
              <label className="text-[10px] text-dim block mb-1.5">{t("settings.windowStyle")}</label>
              <div className="flex gap-1.5">
                <button onClick={() => setWindowStyle("free")} className={`flex-1 h-7 rounded text-[10px] font-semibold border transition-all ${windowStyle === "free" ? "bg-accent-cyan/15 border-accent-cyan text-accent-cyan" : "border-border text-secondary hover:bg-card-hover"}`}>
                  {t("settings.windowStyleFree")}
                </button>
                <button onClick={() => setWindowStyle("docked")} className={`flex-1 h-7 rounded text-[10px] font-semibold border transition-all ${windowStyle === "docked" ? "bg-accent-cyan/15 border-accent-cyan text-accent-cyan" : "border-border text-secondary hover:bg-card-hover"}`}>
                  {t("settings.windowStyleDocked")}
                </button>
              </div>
            </div>

            {/* Hotkey */}
            <div>
              <label className="text-[10px] text-dim block mb-1.5">{t("settings.hotkey")}</label>
              {recording ? (
                <div className="flex gap-1.5">
                  <div className="flex-1 h-8 rounded text-[11px] font-bold border bg-accent-cyan/20 border-accent-cyan text-accent-cyan animate-pulse flex items-center justify-center">{recordingDisplay || "..."}</div>
                  <button onClick={cancelRecording} className="px-3 h-8 rounded text-[10px] font-semibold border border-error/50 text-error hover:bg-error/10 transition-all">
                    {locale === "tr" ? "İptal" : "Cancel"}
                  </button>
                </div>
              ) : (
                <button onClick={startRecording} className="w-full h-8 rounded text-[11px] font-bold border bg-card border-border text-primary hover:bg-card-hover transition-all">
                  {hotkey}
                </button>
              )}
              {hotkeyError && <p className="text-[9px] text-error mt-1">{hotkeyError}</p>}
              <p className="text-[9px] text-dim/70 mt-1.5 leading-relaxed">{t("settings.hotkeyNote")}</p>
            </div>

            <div className="h-px bg-border/50 my-2" />

            {/* Logs */}
            <div>
              <button
                onClick={() => invoke("open_log_file").catch((e) => console.error("Failed to open log file:", e))}
                className="w-full h-8 flex items-center justify-center gap-2 rounded text-[10px] font-semibold border border-border bg-card text-secondary hover:bg-card-hover hover:text-primary transition-all"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                {t("settings.openLogs")}
              </button>
              <p className="text-[8px] text-dim/60 mt-1 text-center">{t("settings.logsNote")}</p>
            </div>

            <div className="h-px bg-border/50 my-2" />

            {/* About / License Info */}
            <div>
              <h3 className="text-[10px] font-semibold text-primary mb-2">{locale === "tr" ? "Hakkında" : "About"}</h3>
              <div className="bg-card/50 rounded p-2 space-y-1.5">
                <div className="flex justify-between text-[10px]">
                  <span className="text-dim">{t("settings.version")}</span>
                  <span className="text-primary font-mono">{appVersion}</span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-dim">{locale === "tr" ? "Lisans Durumu" : "License Status"}</span>
                  <span className="text-success font-semibold">{locale === "tr" ? "Ömür Boyu (Ücretsiz)" : "Lifetime (Free)"}</span>
                </div>
              </div>
            </div>
            {/* Contact / Social Links */}
            {contactInfo && (
              <div className="pt-2">
                <div className="flex items-center justify-center gap-4 py-2 border-t border-border/30 mt-2">
                  {contactInfo.telegram && (
                    <button onClick={() => openUrl(contactInfo.telegram!.url)} className="group p-1.5 rounded-full hover:bg-accent-cyan/10 transition-all" title={`Telegram: ${contactInfo.telegram.username}`}>
                      <svg className="w-5 h-5 text-dim group-hover:text-accent-cyan transition-all" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                          fillRule="evenodd"
                          clipRule="evenodd"
                          d="M23.1117 4.49449C23.4296 2.94472 21.9074 1.65683 20.4317 2.227L2.3425 9.21601C0.694517 9.85273 0.621087 12.1572 2.22518 12.8975L6.1645 14.7157L8.03849 21.2746C8.13583 21.6153 8.40618 21.8791 8.74917 21.968C9.09216 22.0568 9.45658 21.9576 9.70712 21.707L12.5938 18.8203L16.6375 21.8531C17.8113 22.7334 19.5019 22.0922 19.7967 20.6549L23.1117 4.49449ZM3.0633 11.0816L21.1525 4.0926L17.8375 20.2531L13.1 16.6999C12.7019 16.4013 12.1448 16.4409 11.7929 16.7928L10.5565 18.0292L10.928 15.9861L18.2071 8.70703C18.5614 8.35278 18.5988 7.79106 18.2947 7.39293C17.9906 6.99479 17.4389 6.88312 17.0039 7.13168L6.95124 12.876L3.0633 11.0816ZM8.17695 14.4791L8.78333 16.6015L9.01614 15.321C9.05253 15.1209 9.14908 14.9366 9.29291 14.7928L11.5128 12.573L8.17695 14.4791Z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  )}
                  {contactInfo.discord && (
                    <button onClick={() => openUrl(contactInfo.discord!.url)} className="group p-1.5 rounded-full hover:bg-[#5865F2]/10 transition-all" title={`Discord: ${contactInfo.discord.username}`}>
                      <svg className="w-5 h-5 text-dim group-hover:text-[#5865F2] transition-all" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                          d="M18.59 5.88997C17.36 5.31997 16.05 4.89997 14.67 4.65997C14.5 4.95997 14.3 5.36997 14.17 5.69997C12.71 5.47997 11.26 5.47997 9.83001 5.69997C9.69001 5.36997 9.49001 4.95997 9.32001 4.65997C7.94001 4.89997 6.63001 5.31997 5.40001 5.88997C2.92001 9.62997 2.25001 13.28 2.58001 16.87C4.23001 18.1 5.82001 18.84 7.39001 19.33C7.78001 18.8 8.12001 18.23 8.42001 17.64C7.85001 17.43 7.31001 17.16 6.80001 16.85C6.94001 16.75 7.07001 16.64 7.20001 16.54C10.33 18 13.72 18 16.81 16.54C16.94 16.65 17.07 16.75 17.21 16.85C16.7 17.16 16.15 17.42 15.59 17.64C15.89 18.23 16.23 18.8 16.62 19.33C18.19 18.84 19.79 18.1 21.43 16.87C21.82 12.7 20.76 9.08997 18.61 5.88997H18.59ZM8.84001 14.67C7.90001 14.67 7.13001 13.8 7.13001 12.73C7.13001 11.66 7.88001 10.79 8.84001 10.79C9.80001 10.79 10.56 11.66 10.55 12.73C10.55 13.79 9.80001 14.67 8.84001 14.67ZM15.15 14.67C14.21 14.67 13.44 13.8 13.44 12.73C13.44 11.66 14.19 10.79 15.15 10.79C16.11 10.79 16.87 11.66 16.86 12.73C16.86 13.79 16.11 14.67 15.15 14.67Z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  )}
                  {contactInfo.r10 && (
                    <button onClick={() => openUrl(contactInfo.r10!.url)} className="group p-1.5 rounded-full hover:bg-accent-gold/10 transition-all" title={`R10: ${contactInfo.r10.username}`}>
                      <div className="w-5 h-5 flex items-center justify-center text-dim group-hover:text-accent-gold font-black text-[7px] border border-dim group-hover:border-accent-gold rounded transition-all">R10</div>
                    </button>
                  )}
                  {contactInfo.email && (
                    <button onClick={() => openUrl(contactInfo.email!.url)} className="group p-1.5 rounded-full hover:bg-white/10 transition-all" title={`Email: ${contactInfo.email.address}`}>
                      <svg className="w-5 h-5 text-dim group-hover:text-white transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer / Attribution - Always visible */}
      <div className="p-2 border-t border-border">
        <p className="text-[9px] text-dim text-center">
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
