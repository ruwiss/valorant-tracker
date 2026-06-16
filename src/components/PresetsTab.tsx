import { useEffect, useState } from "react";
import { usePresetsStore } from "../stores/presetsStore";
import { useGameStore } from "../stores/gameStore";
import { usePanelStore } from "../stores/panelStore";
import { useI18n } from "../lib/i18n";
import { invokeCommand } from "../utils/ipc";
import { previewLayer } from "../utils/crosshair";
import { MiniCrosshair } from "./MiniCrosshair";
import type { PresetMeta, CrosshairProfileData } from "../lib/types";

function formatDate(unixSeconds: number, locale: string): string {
  try {
    return new Date(unixSeconds * 1000).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function PresetsTab() {
  const { t, locale } = useI18n();
  const { presets, loading, applyingId, armedId, refresh, capture, remove, rename, arm, disarm, syncArmed } =
    usePresetsStore();
  const status = useGameStore((s) => s.status);

  const setHoveredCrosshair = usePanelStore((s) => s.setHoveredCrosshair);

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<PresetMeta | null>(null);
  const [makeBackup, setMakeBackup] = useState(true);
  // Crosshair accordion: which preset is expanded + its loaded profiles.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [crosshairs, setCrosshairs] = useState<CrosshairProfileData | null>(null);
  const [loadingXhairs, setLoadingXhairs] = useState(false);
  // Inline rename: which preset is being edited + draft text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // Capture needs the game OPEN (fresh tokens + cloud read).
  const connected = status === "CONNECTED";

  useEffect(() => {
    refresh();
    syncArmed();
  }, [refresh, syncArmed]);

  // Listen for the backend auto-applying an armed preset on game launch.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlisten = await listen<{ ok: boolean; preset_id: string; error: string | null }>(
        "preset_auto_applied",
        async (e) => {
          const { toast } = await import("sonner");
          const preset = usePresetsStore.getState().presets.find((p) => p.id === e.payload.preset_id);
          const nm = preset?.name ?? "";
          if (e.payload.ok) {
            toast.success(t("presets.autoApplied", { name: nm }));
          } else {
            toast.error(`${t("presets.autoApplyFailed")}: ${e.payload.error ?? ""}`);
          }
          usePresetsStore.setState({ armedId: null });
          refresh();
        },
      );
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [refresh, t]);

  // Clear any lingering crosshair preview when leaving the tab.
  useEffect(() => {
    return () => setHoveredCrosshair(null);
  }, [setHoveredCrosshair]);

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const ok = await capture(name.trim());
    setSaving(false);
    if (ok) setName("");
  };

  const handleConfirmApply = async () => {
    if (!confirmTarget) return;
    const target = confirmTarget;
    setConfirmTarget(null);
    // Arm the preset: it auto-applies on the next game launch to whichever
    // account signs in (fresh token), backing up that account's settings first.
    await arm(target.id, makeBackup);
  };

  const startRename = (p: PresetMeta) => {
    setEditingId(p.id);
    setEditName(p.name);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const id = editingId;
    const newName = editName.trim();
    setEditingId(null);
    if (newName) await rename(id, newName);
  };

  // Toggle the crosshair accordion for a preset, loading its profiles on open.
  const toggleExpand = async (id: string) => {
    setHoveredCrosshair(null);
    if (expandedId === id) {
      setExpandedId(null);
      setCrosshairs(null);
      return;
    }
    setExpandedId(id);
    setCrosshairs(null);
    setLoadingXhairs(true);
    const data = await invokeCommand<CrosshairProfileData>(
      "get_preset_crosshairs",
      { id },
      { suppressErrorToast: true },
    );
    setLoadingXhairs(false);
    setCrosshairs(data ?? { currentProfile: 0, profiles: [] });
  };

  return (
    <div className="p-3 space-y-4">
      {/* Intro */}
      <p className="text-[9px] text-dim/80 leading-relaxed">{t("presets.desc")}</p>

      {/* Capture */}
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder={t("presets.namePlaceholder")}
            maxLength={40}
            disabled={!connected || saving}
            className="flex-1 h-8 px-2.5 rounded text-[11px] bg-card border border-border text-primary placeholder:text-dim/50 focus:border-accent-cyan/60 outline-none transition-all disabled:opacity-40"
          />
          <button
            onClick={handleSave}
            disabled={!connected || saving || !name.trim()}
            className="px-4 h-8 rounded text-[10px] font-bold uppercase tracking-wide whitespace-nowrap bg-accent-cyan text-dark hover:shadow-lg hover:shadow-accent-cyan/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {t("presets.save")}
          </button>
        </div>
        {!connected && <p className="text-[9px] text-accent-red/80">{t("presets.notConnected")}</p>}
      </div>

      <div className="h-px bg-border/50" />

      {/* Armed (pending auto-apply) banner */}
      {armedId && (
        <div className="flex items-center gap-2 rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 px-2.5 py-2">
          <svg className="w-3.5 h-3.5 shrink-0 text-accent-cyan animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <p className="flex-1 text-[9px] text-accent-cyan font-semibold leading-relaxed">
            {t("presets.armActive")}
          </p>
          <button
            onClick={disarm}
            className="shrink-0 text-[8px] font-black uppercase tracking-wide px-2 py-1 rounded bg-accent-red/15 text-accent-red hover:bg-accent-red/25 transition-all"
          >
            {t("presets.cancelArm")}
          </button>
        </div>
      )}

      {/* Preset list */}
      <div className="space-y-2">
        {loading && presets.length === 0 ? (
          <p className="text-[10px] text-dim text-center py-4">…</p>
        ) : presets.length === 0 ? (
          <p className="text-[10px] text-dim text-center py-4">{t("presets.empty")}</p>
        ) : (
          presets.map((p) => {
            const expanded = expandedId === p.id;
            return (
              <div
                key={p.id}
                className={`rounded-lg border bg-dark/40 transition-all ${expanded ? "border-accent-cyan/30" : "border-white/5 hover:border-white/15"}`}
              >
                {/* Row */}
                <div className="group flex items-center gap-2 pl-1 pr-1.5 py-2">
                  {editingId === p.id ? (
                    /* Inline rename */
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      maxLength={40}
                      className="flex-1 min-w-0 ml-1 h-7 px-2 rounded text-[11px] bg-card border border-accent-cyan/60 text-primary outline-none"
                    />
                  ) : (
                    /* Expand chevron + info (clickable) */
                    <button
                      onClick={() => toggleExpand(p.id)}
                      className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                      title={t("presets.crosshairs")}
                    >
                      <svg
                        className={`w-3.5 h-3.5 shrink-0 text-dim transition-transform duration-300 ${expanded ? "rotate-90 text-accent-cyan" : "group-hover:text-primary"}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[11px] font-bold text-primary truncate">{p.name}</span>
                          {p.auto_backup && (
                            <span
                              className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-green"
                              title={t("presets.autoBackupBadge")}
                            />
                          )}
                        </span>
                        {/* Date only when expanded, to keep the row clean. */}
                        {expanded && (
                          <span className="block mt-0.5 text-[8px] text-dim/70 tabular-nums">
                            {formatDate(p.created_at, locale)}
                          </span>
                        )}
                      </span>
                    </button>
                  )}

                  {editingId === p.id ? (
                    /* Edit mode: a single Save button replaces apply/edit so the
                       user can't hit Apply by accident while renaming. */
                    <button
                      onClick={commitRename}
                      title={t("presets.saveRename")}
                      className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-accent-green/20 border border-accent-green/50 text-accent-green hover:bg-accent-green/30 transition-all"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                  ) : (
                    <>
                      {/* Rename (edit) icon */}
                      <button
                        onClick={() => startRename(p)}
                        disabled={applyingId === p.id}
                        title={t("presets.rename")}
                        className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md text-dim hover:text-accent-cyan hover:bg-accent-cyan/10 transition-all disabled:opacity-25"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
                        </svg>
                      </button>

                      {/* Apply (arm) — auto-applies on next game launch. */}
                      <button
                        onClick={() => {
                          if (armedId === p.id) {
                            disarm();
                          } else {
                            setMakeBackup(true);
                            setConfirmTarget(p);
                          }
                        }}
                        disabled={applyingId === p.id}
                        title={armedId === p.id ? t("presets.cancelArm") : t("presets.apply")}
                        className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-md border transition-all disabled:opacity-25 disabled:cursor-not-allowed ${
                          armedId === p.id
                            ? "bg-accent-cyan text-dark border-accent-cyan"
                            : "bg-accent-cyan/15 border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/25"
                        }`}
                      >
                        {armedId === p.id ? (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <polyline points="12 7 12 12 15 14" />
                          </svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3v12" />
                            <polyline points="7 10 12 15 17 10" />
                            <path d="M5 21h14" />
                          </svg>
                        )}
                      </button>

                      {/* Delete */}
                      <button
                        onClick={() => remove(p.id)}
                        disabled={applyingId === p.id}
                        title={t("presets.delete")}
                        className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md text-accent-red/70 hover:text-accent-red hover:bg-accent-red/10 transition-all disabled:opacity-25"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>

                {/* Crosshair accordion */}
                {expanded && (
                  <div className="border-t border-white/5 px-2 py-2 animate-in slide-in-from-top-1 duration-200">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-[8px] font-black uppercase tracking-widest text-dim">
                        {t("presets.crosshairs")}
                      </span>
                      {crosshairs && crosshairs.profiles.length > 0 && (
                        <span className="text-[8px] text-dim/50">({crosshairs.profiles.length})</span>
                      )}
                    </div>

                    {loadingXhairs ? (
                      <p className="text-[9px] text-dim py-2 text-center">…</p>
                    ) : !crosshairs || crosshairs.profiles.length === 0 ? (
                      <p className="text-[9px] text-dim/70 py-2 text-center">{t("presets.noCrosshairs")}</p>
                    ) : (
                      <div className="space-y-0.5">
                        {crosshairs.profiles.map((prof, i) => (
                          <div
                            key={i}
                            onMouseEnter={() =>
                              setHoveredCrosshair({
                                name: prof.profileName,
                                layer: previewLayer(prof),
                              })
                            }
                            onMouseLeave={() => setHoveredCrosshair(null)}
                            className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-accent-cyan/10 cursor-default transition-colors"
                          >
                            <MiniCrosshair layer={previewLayer(prof)} size={26} />
                            <span className="flex-1 min-w-0 text-[9px] text-secondary truncate">
                              {prof.profileName}
                            </span>
                            {i === crosshairs.currentProfile && (
                              <span className="shrink-0 text-[7px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-cyan/20 text-accent-cyan">
                                {t("presets.currentProfile")}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Apply confirmation dialog */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-[300px] rounded-2xl border border-accent-cyan/20 bg-[#0a0e13] p-4 shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="text-[12px] font-black uppercase tracking-wide text-primary mb-2">
              {t("presets.applyTitleArm")}
            </h3>
            <p className="text-[10px] text-dim leading-relaxed mb-3">
              {t("presets.applyBodyArm", { name: confirmTarget.name })}
            </p>

            <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={makeBackup}
                onChange={(e) => setMakeBackup(e.target.checked)}
                className="accent-accent-cyan w-3.5 h-3.5"
              />
              <span className="text-[10px] text-secondary">{t("presets.makeBackup")}</span>
            </label>

            <div className="flex gap-2">
              <button
                onClick={() => setConfirmTarget(null)}
                className="flex-1 h-8 rounded text-[10px] font-bold uppercase border border-border text-secondary hover:bg-card-hover transition-all"
              >
                {t("presets.cancel")}
              </button>
              <button
                onClick={handleConfirmApply}
                className="flex-1 h-8 rounded text-[10px] font-bold uppercase bg-accent-cyan text-dark hover:shadow-lg hover:shadow-accent-cyan/20 transition-all"
              >
                {t("presets.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
