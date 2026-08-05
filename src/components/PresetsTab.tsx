import { useEffect, useMemo, useState } from "react";
import { usePresetsStore } from "../stores/presetsStore";
import { useGameStore } from "../stores/gameStore";
import { usePanelStore } from "../stores/panelStore";
import { useI18n } from "../lib/i18n";
import { invokeCommand } from "../utils/ipc";
import type { CrosshairProfileData, PresetMeta } from "../lib/types";
import { previewLayer } from "../utils/crosshair";
import { MiniCrosshair } from "./MiniCrosshair";

type Filter = "all" | "mine" | "backups";

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

function formatSens(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

export function PresetsTab() {
  const { t, locale } = useI18n();
  const {
    presets,
    loading,
    applyingId,
    armedId,
    refresh,
    capture,
    remove,
    rename,
    duplicate,
    arm,
    closeAndArm,
    disarm,
    syncArmed,
  } = usePresetsStore();
  const status = useGameStore((s) => s.status);
  const setHoveredCrosshair = usePanelStore((s) => s.setHoveredCrosshair);
  const setSettingsSubView = usePanelStore((s) => s.setSettingsSubView);

  const [gameRunning, setGameRunning] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<PresetMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PresetMeta | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [crosshairsById, setCrosshairsById] = useState<
    Record<string, CrosshairProfileData | "loading" | "empty">
  >({});

  const connected = status === "CONNECTED";

  useEffect(() => {
    refresh();
    syncArmed();
    return () => setHoveredCrosshair(null);
  }, [refresh, syncArmed, setHoveredCrosshair]);

  useEffect(() => {
    let active = true;
    const check = async () => {
      const running = await invokeCommand<boolean>("get_game_running", undefined, {
        suppressErrorToast: true,
      });
      if (active) setGameRunning(!!running);
    };
    check();
    const interval = setInterval(check, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

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

  useEffect(() => {
    if (!menuId) return;
    const onDown = () => setMenuId(null);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuId]);

  const filtered = useMemo(() => {
    if (filter === "mine") return presets.filter((p) => !p.auto_backup);
    if (filter === "backups") return presets.filter((p) => p.auto_backup);
    return presets;
  }, [presets, filter]);

  const loadCrosshairs = async (id: string) => {
    if (crosshairsById[id] && crosshairsById[id] !== "empty") return;
    setCrosshairsById((prev) => ({ ...prev, [id]: "loading" }));
    const data = await invokeCommand<CrosshairProfileData>("get_preset_crosshairs", { id }, {
      suppressErrorToast: true,
    });
    if (data && Array.isArray(data.profiles) && data.profiles.length > 0) {
      setCrosshairsById((prev) => ({ ...prev, [id]: data }));
    } else {
      setCrosshairsById((prev) => ({ ...prev, [id]: "empty" }));
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => {
      const next = prev === id ? null : id;
      if (next) void loadCrosshairs(next);
      return next;
    });
    setMenuId(null);
  };

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
    if (gameRunning) await closeAndArm(target.id);
    else await arm(target.id);
  };

  const startRename = (p: PresetMeta) => {
    setEditingId(p.id);
    setEditName(p.name);
    setMenuId(null);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const id = editingId;
    const newName = editName.trim();
    setEditingId(null);
    if (newName) await rename(id, newName);
  };

  const handleDuplicate = async (p: PresetMeta) => {
    setMenuId(null);
    const suffix = t("presets.duplicateSuffix");
    const base = p.name.replace(new RegExp(`\\s*\\(${suffix}\\)$`, "i"), "").trim();
    await duplicate(p.id, `${base} (${suffix})`);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    if (expandedId === id) setExpandedId(null);
    await remove(id);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Back */}
      <div className="px-3 pt-2 pb-1">
        <button
          type="button"
          onClick={() => setSettingsSubView("main")}
          className="flex items-center gap-1 text-[10px] font-semibold text-accent-cyan hover:text-accent-cyan/80 transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("settings.chatShortcutsBack")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-4">
        {/* Compact status + desc */}
        <div className="space-y-1">
          <p className="text-[9px] text-dim/80 leading-relaxed">{t("presets.desc")}</p>
          <p className="text-[8px] text-dim/60">
            <span className={connected ? "text-accent-cyan" : "text-dim"}>
              ● {connected ? t("presets.statusConnected") : t("presets.statusDisconnected")}
            </span>
            <span className="mx-1.5 text-border">·</span>
            <span className={gameRunning ? "text-[#f5d78e]" : "text-dim"}>
              {gameRunning ? t("presets.statusGameOpen") : t("presets.statusGameClosed")}
            </span>
          </p>
        </div>

        {/* Save */}
        <div className="space-y-1.5">
          <span className="text-[9px] font-bold uppercase tracking-wider text-dim">
            {t("presets.sectionCapture")}
          </span>
          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              placeholder={t("presets.namePlaceholder")}
              maxLength={40}
              disabled={!connected || saving}
              className="flex-1 h-8 px-2.5 rounded text-[11px] bg-transparent border-b border-border focus:border-accent-cyan/60 text-primary placeholder:text-dim/40 outline-none transition-colors disabled:opacity-40"
            />
            <button
              onClick={handleSave}
              disabled={!connected || saving || !name.trim()}
              className="px-3 h-8 rounded text-[10px] font-bold uppercase tracking-wide bg-accent-cyan text-dark hover:opacity-90 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {t("presets.save")}
            </button>
          </div>
          {!connected && (
            <p className="text-[9px] text-accent-red/80">{t("presets.notConnected")}</p>
          )}
        </div>

        {/* Armed */}
        {armedId && (
          <div className="flex items-center gap-2 py-1.5">
            <span className="flex-1 text-[9px] text-accent-cyan font-semibold leading-relaxed">
              {t("presets.armActive")}
            </span>
            <button
              onClick={disarm}
              className="text-[8px] font-bold uppercase text-accent-red hover:underline"
            >
              {t("presets.cancelArm")}
            </button>
          </div>
        )}

        {/* List header + filter */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] font-bold uppercase tracking-wider text-dim">
              {t("presets.sectionList")}
            </span>
            <span className="text-[8px] text-dim/60 tabular-nums">
              {t("presets.count", { n: filtered.length })}
            </span>
          </div>

          <div className="flex gap-3 text-[9px] font-semibold">
            {(
              [
                ["all", t("presets.filterAll")],
                ["mine", t("presets.filterMine")],
                ["backups", t("presets.filterBackups")],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`pb-0.5 border-b transition-colors ${
                  filter === key
                    ? "border-accent-cyan text-accent-cyan"
                    : "border-transparent text-dim hover:text-secondary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Flat list */}
          <div className="divide-y divide-white/5">
            {loading && presets.length === 0 ? (
              <p className="text-[10px] text-dim text-center py-6">…</p>
            ) : filtered.length === 0 ? (
              <p className="text-[10px] text-dim text-center py-6">{t("presets.empty")}</p>
            ) : (
              filtered.map((p) => {
                const expanded = expandedId === p.id;
                const isArmed = armedId === p.id;
                const hasSens =
                  p.sensitivity != null ||
                  p.sensitivity_ads != null ||
                  p.sensitivity_zoomed != null;
                const xh = crosshairsById[p.id];

                return (
                  <div key={p.id} className="py-2">
                    <div className="flex items-center gap-1">
                      {editingId === p.id ? (
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          maxLength={40}
                          className="flex-1 min-w-0 h-7 px-1.5 rounded text-[11px] bg-transparent border-b border-accent-cyan text-primary outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => toggleExpand(p.id)}
                          className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                        >
                          <svg
                            className={`w-3 h-3 shrink-0 text-dim/70 transition-transform ${
                              expanded ? "rotate-90 text-accent-cyan" : ""
                            }`}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                          <span className="text-[11px] font-semibold text-primary truncate">
                            {p.name}
                          </span>
                          {p.auto_backup && (
                            <span className="text-[8px] text-accent-green/80 shrink-0">
                              · {t("presets.autoBackupBadge")}
                            </span>
                          )}
                          {isArmed && (
                            <span className="text-[8px] text-accent-cyan shrink-0">
                              · {t("presets.armedBadge")}
                            </span>
                          )}
                        </button>
                      )}

                      {editingId === p.id ? (
                        <button
                          onClick={commitRename}
                          className="text-[9px] font-bold text-accent-cyan px-2"
                        >
                          {t("presets.saveRename")}
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              if (isArmed) disarm();
                              else setConfirmTarget(p);
                            }}
                            disabled={applyingId === p.id}
                            className={`shrink-0 h-6 px-2 rounded text-[9px] font-bold uppercase transition-all disabled:opacity-30 ${
                              isArmed
                                ? "text-accent-cyan"
                                : "text-accent-cyan/90 hover:bg-accent-cyan/10"
                            }`}
                          >
                            {isArmed ? t("presets.cancelArm") : t("presets.apply")}
                          </button>
                          <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => setMenuId((m) => (m === p.id ? null : p.id))}
                              className="w-6 h-6 flex items-center justify-center text-dim hover:text-primary rounded"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="5" r="1.4" />
                                <circle cx="12" cy="12" r="1.4" />
                                <circle cx="12" cy="19" r="1.4" />
                              </svg>
                            </button>
                            {menuId === p.id && (
                              <div className="absolute right-0 top-7 z-30 min-w-[110px] rounded-md border border-white/10 bg-[#0e141b] shadow-xl py-1">
                                <button
                                  type="button"
                                  className="w-full text-left px-2.5 py-1.5 text-[10px] text-secondary hover:bg-white/5"
                                  onClick={() => startRename(p)}
                                >
                                  {t("presets.rename")}
                                </button>
                                <button
                                  type="button"
                                  className="w-full text-left px-2.5 py-1.5 text-[10px] text-secondary hover:bg-white/5"
                                  onClick={() => void handleDuplicate(p)}
                                >
                                  {t("presets.duplicate")}
                                </button>
                                <button
                                  type="button"
                                  className="w-full text-left px-2.5 py-1.5 text-[10px] text-accent-red hover:bg-accent-red/10"
                                  onClick={() => {
                                    setMenuId(null);
                                    setDeleteTarget(p);
                                  }}
                                >
                                  {t("presets.delete")}
                                </button>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>

                    {expanded && (
                      <div className="mt-2 ml-4 space-y-2.5 pl-1 border-l border-white/5">
                        <p className="text-[8px] text-dim/60 tabular-nums">
                          {formatDate(p.created_at, locale)}
                        </p>

                        <div>
                          <span className="text-[8px] font-bold uppercase tracking-wider text-dim">
                            {t("presets.sensitivity")}
                          </span>
                          {!hasSens ? (
                            <p className="text-[9px] text-dim/60 mt-0.5">{t("presets.noSensitivity")}</p>
                          ) : (
                            <div className="flex gap-3 mt-1 text-[10px]">
                              <span className="text-dim">
                                {t("presets.sensHip")}{" "}
                                <span className="text-accent-cyan font-semibold tabular-nums">
                                  {formatSens(p.sensitivity)}
                                </span>
                              </span>
                              <span className="text-dim">
                                {t("presets.sensAds")}{" "}
                                <span className="text-accent-cyan font-semibold tabular-nums">
                                  {formatSens(p.sensitivity_ads)}
                                </span>
                              </span>
                              <span className="text-dim">
                                {t("presets.sensScoped")}{" "}
                                <span className="text-accent-cyan font-semibold tabular-nums">
                                  {formatSens(p.sensitivity_zoomed)}
                                </span>
                              </span>
                            </div>
                          )}
                        </div>

                        <div>
                          <span className="text-[8px] font-bold uppercase tracking-wider text-dim">
                            {t("presets.crosshairs")}
                          </span>
                          {xh === "loading" || xh === undefined ? (
                            <p className="text-[9px] text-dim/60 mt-0.5">…</p>
                          ) : xh === "empty" ? (
                            <p className="text-[9px] text-dim/60 mt-0.5">{t("presets.noCrosshairs")}</p>
                          ) : (
                            <div className="flex flex-wrap gap-2 mt-1">
                              {xh.profiles.map((profile, idx) => {
                                const layer = previewLayer(profile);
                                const label = profile.profileName || `#${idx + 1}`;
                                return (
                                  <button
                                    key={`${p.id}-xh-${idx}`}
                                    type="button"
                                    className="flex flex-col items-center gap-0.5 opacity-90 hover:opacity-100"
                                    onMouseEnter={() =>
                                      setHoveredCrosshair({ name: label, layer })
                                    }
                                    onMouseLeave={() => setHoveredCrosshair(null)}
                                    title={label}
                                  >
                                    <MiniCrosshair layer={layer} size={28} />
                                    <span className="text-[7px] text-dim max-w-[36px] truncate">
                                      {label}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Apply dialog */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-[300px] rounded-xl border border-white/10 bg-[#0a0e13] p-4 shadow-2xl">
            <h3 className="text-[12px] font-bold text-primary mb-2">
              {gameRunning ? t("presets.applyTitleClose") : t("presets.applyTitleArm")}
            </h3>
            <p className="text-[10px] text-dim leading-relaxed mb-3">
              {gameRunning
                ? t("presets.applyBodyClose", { name: confirmTarget.name })
                : t("presets.applyBodyArm", { name: confirmTarget.name })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmTarget(null)}
                className="flex-1 h-8 rounded text-[10px] font-bold border border-border text-secondary hover:bg-white/5"
              >
                {t("presets.cancel")}
              </button>
              <button
                onClick={handleConfirmApply}
                className="flex-1 h-8 rounded text-[10px] font-bold bg-accent-cyan text-dark"
              >
                {gameRunning ? t("presets.confirmClose") : t("presets.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-[300px] rounded-xl border border-white/10 bg-[#0a0e13] p-4 shadow-2xl">
            <h3 className="text-[12px] font-bold text-primary mb-2">
              {t("presets.deleteConfirmTitle")}
            </h3>
            <p className="text-[10px] text-dim leading-relaxed mb-3">
              {t("presets.deleteConfirmBody", { name: deleteTarget.name })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 h-8 rounded text-[10px] font-bold border border-border text-secondary hover:bg-white/5"
              >
                {t("presets.cancel")}
              </button>
              <button
                onClick={() => void handleConfirmDelete()}
                className="flex-1 h-8 rounded text-[10px] font-bold bg-accent-red/90 text-white"
              >
                {t("presets.confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
