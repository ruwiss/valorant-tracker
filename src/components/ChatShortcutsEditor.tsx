import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "../lib/i18n";
import { usePanelStore } from "../stores/panelStore";
import { invokeCommand } from "../utils/ipc";

export type MatchMode = "equals" | "contains";

export interface ChatRule {
  id: string;
  pattern: string;
  replacement: string;
  mode: MatchMode;
  enabled: boolean;
  builtin: boolean;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ChatShortcutsEditor() {
  const { t } = useI18n();
  const setSettingsSubView = usePanelStore((s) => s.setSettingsSubView);

  const [rules, setRules] = useState<ChatRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [mode, setMode] = useState<MatchMode>("equals");

  const load = useCallback(async () => {
    setLoading(true);
    const data = await invokeCommand<ChatRule[]>("get_chat_shortcut_rules", undefined, {
      suppressErrorToast: true,
    });
    setRules(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (next: ChatRule[]) => {
    setSaving(true);
    const saved = await invokeCommand<ChatRule[]>("save_chat_shortcut_rules", { rules: next }, {
      suppressErrorToast: true,
    });
    setSaving(false);
    if (saved) {
      setRules(saved);
      toast.success(t("settings.chatShortcutsSaved"));
      return true;
    }
    toast.error(t("settings.chatShortcutsError"));
    return false;
  };

  const handleDelete = async (id: string) => {
    const next = rules.filter((r) => r.id !== id);
    await persist(next);
  };

  const handleToggle = async (id: string) => {
    const next = rules.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r,
    );
    await persist(next);
  };

  const handleAdd = async () => {
    const p = pattern.trim();
    const rep = replacement; // keep spaces in replacement
    if (!p) return;
    if (p.length > 64 || rep.length > 280) return;

    const rule: ChatRule = {
      id: newId(),
      pattern: p,
      replacement: rep,
      mode,
      enabled: true,
      builtin: false,
    };
    const ok = await persist([...rules, rule]);
    if (ok) {
      setPattern("");
      setReplacement("");
      setMode("equals");
    }
  };

  const handleReset = async () => {
    setSaving(true);
    const data = await invokeCommand<ChatRule[]>("reset_chat_shortcut_rules", undefined, {
      suppressErrorToast: true,
    });
    setSaving(false);
    if (data) {
      setRules(data);
      toast.success(t("settings.chatShortcutsSaved"));
    } else {
      toast.error(t("settings.chatShortcutsError"));
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Sub-header */}
      <div className="px-3 pt-2 pb-1.5 border-b border-border/40 space-y-1.5">
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
        <p className="text-[9px] text-dim/70 leading-relaxed">{t("settings.chatShortcutsSpecialNote")}</p>
      </div>

      {/* Rules list */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent-cyan border-t-transparent rounded-full animate-spin" />
          </div>
        ) : rules.length === 0 ? (
          <p className="text-[10px] text-dim text-center py-6">{t("settings.chatShortcutsEmpty")}</p>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className={`rounded border px-2 py-1.5 space-y-1 transition-opacity ${
                rule.enabled
                  ? "border-border bg-card/60"
                  : "border-border/40 bg-card/30 opacity-60"
              }`}
            >
              <div className="flex items-start gap-1.5">
                <button
                  type="button"
                  title={rule.enabled ? t("settings.off") : t("settings.on")}
                  onClick={() => void handleToggle(rule.id)}
                  disabled={saving}
                  className={`mt-0.5 w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center transition-colors ${
                    rule.enabled
                      ? "bg-accent-cyan/20 border-accent-cyan text-accent-cyan"
                      : "border-border text-transparent"
                  }`}
                >
                  {rule.enabled && (
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 flex-wrap">
                    <code className="text-[10px] font-bold text-primary truncate max-w-[7rem]">
                      {rule.pattern}
                    </code>
                    <span className="text-[8px] text-dim">→</span>
                    <span className="text-[10px] text-secondary truncate max-w-[7rem]" title={rule.replacement}>
                      {rule.replacement || "∅"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span
                      className={`text-[8px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded ${
                        rule.mode === "equals"
                          ? "bg-accent-cyan/10 text-accent-cyan"
                          : "bg-accent-gold/10 text-[#f5d78e]"
                      }`}
                    >
                      {rule.mode === "equals"
                        ? t("settings.chatShortcutsModeEquals")
                        : t("settings.chatShortcutsModeContains")}
                    </span>
                    <span className="text-[8px] text-dim/80">
                      {rule.builtin
                        ? t("settings.chatShortcutsBuiltin")
                        : t("settings.chatShortcutsCustom")}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(rule.id)}
                  disabled={saving}
                  className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-dim hover:text-error hover:bg-error/10 transition-colors"
                  title={t("settings.chatShortcutsDelete")}
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add form */}
      <div className="border-t border-border/50 p-2 space-y-2 bg-[#0a0e13]/80">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="text-[8px] text-dim block mb-0.5">{t("settings.chatShortcutsPattern")}</label>
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              maxLength={64}
              placeholder="sa"
              className="w-full h-7 px-1.5 rounded text-[10px] bg-card border border-border text-primary placeholder:text-dim/40 focus:outline-none focus:border-accent-cyan/60"
            />
          </div>
          <div>
            <label className="text-[8px] text-dim block mb-0.5">{t("settings.chatShortcutsReplacement")}</label>
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              maxLength={280}
              placeholder="Selamun Aleyküm"
              className="w-full h-7 px-1.5 rounded text-[10px] bg-card border border-border text-primary placeholder:text-dim/40 focus:outline-none focus:border-accent-cyan/60"
            />
          </div>
        </div>

        <div>
          <label className="text-[8px] text-dim block mb-1">{t("settings.chatShortcutsMode")}</label>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setMode("equals")}
              className={`flex-1 h-7 rounded text-[9px] font-semibold border transition-all ${
                mode === "equals"
                  ? "bg-accent-cyan/15 border-accent-cyan text-accent-cyan"
                  : "border-border text-secondary hover:bg-card-hover"
              }`}
            >
              {t("settings.chatShortcutsModeEquals")}
            </button>
            <button
              type="button"
              onClick={() => setMode("contains")}
              className={`flex-1 h-7 rounded text-[9px] font-semibold border transition-all ${
                mode === "contains"
                  ? "bg-accent-cyan/15 border-accent-cyan text-accent-cyan"
                  : "border-border text-secondary hover:bg-card-hover"
              }`}
            >
              {t("settings.chatShortcutsModeContains")}
            </button>
          </div>
          <p className="text-[8px] text-dim/60 mt-1 leading-relaxed">
            {mode === "equals"
              ? t("settings.chatShortcutsModeEqualsHint")
              : t("settings.chatShortcutsModeContainsHint")}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={saving || !pattern.trim()}
          className="w-full h-8 rounded text-[10px] font-bold border border-accent-cyan/50 bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {t("settings.chatShortcutsAdd")}
        </button>

        <button
          type="button"
          onClick={() => void handleReset()}
          disabled={saving}
          className="w-full h-7 rounded text-[9px] font-semibold border border-border text-dim hover:text-secondary hover:bg-card-hover transition-all"
        >
          {t("settings.chatShortcutsReset")}
        </button>
      </div>
    </div>
  );
}
