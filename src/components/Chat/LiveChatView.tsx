import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useChatStore } from "../../stores/chatStore";
import { useGameStore } from "../../stores/gameStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useI18n } from "../../lib/i18n";
import { invokeCommand } from "../../utils/ipc";
import type { LiveChatChannel, LiveChatMessage } from "../../lib/types";

const OUTGOING_LANGS = [
  { id: "en", label: "EN" },
  { id: "tr", label: "TR" },
  { id: "es", label: "ES" },
  { id: "de", label: "DE" },
  { id: "fr", label: "FR" },
  { id: "pt", label: "PT" },
  { id: "ru", label: "RU" },
  { id: "ja", label: "JA" },
  { id: "ko", label: "KO" },
  { id: "zh-CN", label: "ZH" },
  { id: "ar", label: "AR" },
] as const;

function linkKey(channel: LiveChatChannel) {
  if (channel === "team") return "chat.linkTeam";
  if (channel === "all") return "chat.linkAll";
  return "chat.linkParty";
}

function placeholderKey(channel: LiveChatChannel) {
  if (channel === "team") return "chat.placeholderTeam";
  if (channel === "all") return "chat.placeholderAll";
  return "chat.placeholderParty";
}

type Translation = { text: string; src: string; target: string };

const incomingCache = new Map<string, Translation>();
const translating = new Set<string>();

function cacheKey(id: string, lang: string) {
  return `${id}:${lang}`;
}

function channelStyle(channel: LiveChatChannel) {
  if (channel === "team") return { text: "text-accent-cyan", border: "border-accent-cyan/40", bg: "bg-accent-cyan/12", bar: "bg-accent-cyan" };
  if (channel === "all") return { text: "text-accent-gold", border: "border-accent-gold/40", bg: "bg-accent-gold/12", bar: "bg-accent-gold" };
  return { text: "text-accent-purple", border: "border-accent-purple/40", bg: "bg-accent-purple/12", bar: "bg-accent-purple" };
}

function sameLanguage(src: string, target: string) {
  if (!src) return false;
  const a = src.toLowerCase();
  const b = target.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isActiveMatch(state: string, mapName: string | null) {
  if (state !== "pregame" && state !== "ingame") return false;
  const map = (mapName || "").toLowerCase();
  return !map.includes("range") && !map.includes("poligon") && !map.includes("poveglia");
}

function TranslateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h9M8.5 6v1.2c0 3.4-2.1 6.3-5 7.8M7 10.5h5.2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 18l3.2-8h.6L20 18M14.2 15.6h4.6" />
    </svg>
  );
}

export function LiveChatView() {
  const {
    liveMessages,
    liveSendChannel,
    setLiveSendChannel,
    sendLiveMessage,
    friends,
  } = useChatStore();
  const { gameState } = useGameStore();
  const {
    chatAutoTranslate,
    setChatAutoTranslate,
    chatTranslateOnSend,
    setChatTranslateOnSend,
    chatOutgoingLang,
    setChatOutgoingLang,
  } = useSettingsStore();
  const { t, locale } = useI18n();

  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [, setTick] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const lastIdRef = useRef<string | null>(null);
  const forceBottomRef = useRef(true);

  const myPuuid = gameState.allies.find((a) => a.is_me)?.puuid;
  const incomingLang = locale === "tr" ? "tr" : "en";
  const inMatch = isActiveMatch(gameState.state, gameState.map_name);
  const channelEnabled = (ch: LiveChatChannel) => (inMatch ? ch === "team" || ch === "all" : ch === "party");

  useEffect(() => {
    if (inMatch && liveSendChannel === "party") setLiveSendChannel("team");
    if (!inMatch && liveSendChannel !== "party") setLiveSendChannel("party");
  }, [inMatch, liveSendChannel, setLiveSendChannel]);

  useEffect(() => {
    if (!langOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!langRef.current?.contains(e.target as Node)) setLangOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [langOpen]);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior });
        nearBottomRef.current = true;
        setShowScrollButton(false);
      });
    });
  };

  useEffect(() => {
    forceBottomRef.current = true;
    scrollToBottom("auto");
  }, []);

  useEffect(() => {
    if (liveMessages.length === 0) return;
    const last = liveMessages[liveMessages.length - 1];
    const first = lastIdRef.current === null;
    if (last.id !== lastIdRef.current || forceBottomRef.current) {
      if (nearBottomRef.current || first || forceBottomRef.current) {
        scrollToBottom(forceBottomRef.current || first ? "auto" : "smooth");
        forceBottomRef.current = false;
      }
      lastIdRef.current = last.id;
    }
  }, [liveMessages]);

  useEffect(() => {
    if (!chatAutoTranslate) return;
    let cancelled = false;
    const pending = liveMessages.filter((msg) => {
      if (msg.puuid === myPuuid) return false;
      const key = cacheKey(msg.id, incomingLang);
      return !incomingCache.has(key) && !translating.has(key) && msg.body.trim();
    });
    if (pending.length === 0) return;

    const run = async () => {
      for (const msg of pending.slice(-20)) {
        const key = cacheKey(msg.id, incomingLang);
        translating.add(key);
        try {
          const result = await invokeCommand<{ text: string; source_lang: string }>(
            "translate_text",
            { text: msg.body, targetLang: incomingLang },
            { suppressErrorToast: true },
          );
          if (!result?.text?.trim()) continue;
          incomingCache.set(key, {
            text: result.text.trim(),
            src: result.source_lang || "",
            target: incomingLang,
          });
          if (!cancelled) setTick((n) => n + 1);
        } catch {
          // leave uncached so the next poll can retry
        } finally {
          translating.delete(key);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [liveMessages, chatAutoTranslate, incomingLang, myPuuid]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const distance = scrollHeight - scrollTop - clientHeight;
    nearBottomRef.current = distance < 100;
    setShowScrollButton(distance > 300);
  };

  const resolveName = (msg: LiveChatMessage, isMe: boolean) => {
    if (msg.game_name && msg.game_name !== "AGENT" && msg.game_name !== "AJAN") {
      return msg.game_name;
    }
    if (isMe) {
      const me = gameState.allies.find((a) => a.puuid === myPuuid);
      if (me?.name) return me.name.split("#")[0];
    }
    const friend = friends.find((f) => f.puuid === msg.puuid);
    if (friend) return friend.game_name;
    const roster = [...gameState.allies, ...gameState.enemies].find((p) => p.puuid === msg.puuid);
    if (roster?.name) return roster.name.split("#")[0];
    return t("chat.agent_fallback");
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text || sending || !channelEnabled(liveSendChannel)) return;
    setSending(true);
    const previous = inputValue;
    setInputValue("");
    try {
      const ok = await sendLiveMessage(text, liveSendChannel);
      if (ok) {
        forceBottomRef.current = true;
        nearBottomRef.current = true;
        scrollToBottom("smooth");
      } else {
        setInputValue(previous);
      }
    } catch {
      setInputValue(previous);
    } finally {
      setSending(false);
    }
  };

  const handlePreviewTranslate = async () => {
    const text = inputValue.trim();
    if (!text || previewing) return;
    setPreviewing(true);
    try {
      const result = await invokeCommand<{ text: string; source_lang: string }>(
        "translate_text",
        { text, targetLang: chatOutgoingLang },
        { errorMessage: t("chat.translateFailed") },
      );
      if (result?.text?.trim()) setInputValue(result.text.trim());
    } finally {
      setPreviewing(false);
    }
  };

  const visibleMessages = useMemo(
    () => liveMessages.filter((msg) => (inMatch ? msg.channel === "team" || msg.channel === "all" : msg.channel === "party")),
    [liveMessages, inMatch],
  );
  const empty = visibleMessages.length === 0;
  const canSend = channelEnabled(liveSendChannel);
  const outgoingLang = OUTGOING_LANGS.find((l) => l.id === chatOutgoingLang) ?? OUTGOING_LANGS[0];
  const hasDraft = Boolean(inputValue.trim());

  const channels = useMemo(
    () => (inMatch ? (["team", "all"] as const) : (["party"] as const)),
    [inMatch],
  );

  const pickOutgoingLang = (id: string | null) => {
    if (!id) {
      setChatTranslateOnSend(false);
    } else {
      setChatOutgoingLang(id);
      setChatTranslateOnSend(true);
    }
    setLangOpen(false);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-black/25">
        <div className="flex items-center gap-1">
          {channels.map((id) => {
            const on = liveSendChannel === id;
            const theme = channelStyle(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => setLiveSendChannel(id)}
                className={clsx(
                  "h-8 px-3 rounded-md text-[12px] font-semibold tracking-wide transition-colors",
                  on ? clsx(theme.bg, theme.text, "ring-1", theme.border.replace("border-", "ring-")) : "text-white/55 hover:text-white hover:bg-white/6",
                )}
              >
                {t(linkKey(id))}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setChatAutoTranslate(!chatAutoTranslate)}
            className={clsx(
              "h-8 w-8 rounded-md flex items-center justify-center transition-colors",
              chatAutoTranslate ? "bg-accent-cyan/15 text-accent-cyan" : "text-white/40 hover:text-white hover:bg-white/6",
            )}
            title={t("chat.autoTranslate")}
          >
            <TranslateIcon className="w-4 h-4" />
          </button>

          <div ref={langRef} className="relative">
            <button
              type="button"
              onClick={() => setLangOpen((v) => !v)}
              className={clsx(
                "h-8 px-2 rounded-md text-[11px] font-semibold tracking-wide flex items-center gap-1.5 transition-colors",
                chatTranslateOnSend ? "bg-accent-gold/15 text-accent-gold" : "text-white/45 hover:text-white hover:bg-white/6",
              )}
              title={t("chat.outgoingLang")}
            >
              <span>{chatTranslateOnSend ? outgoingLang.label : t("chat.translateOnSendShort")}</span>
              <svg className={clsx("w-2.5 h-2.5 opacity-60 transition-transform", langOpen && "rotate-180")} viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.2 4.2L6 8l3.8-3.8" />
              </svg>
            </button>
            {langOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-44 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-dark/96 shadow-[0_12px_32px_rgba(0,0,0,0.55)] p-1">
                <button
                  type="button"
                  onClick={() => pickOutgoingLang(null)}
                  className={clsx(
                    "w-full text-left px-2.5 py-1.5 text-[12px] rounded-md",
                    !chatTranslateOnSend ? "bg-white/10 text-white" : "text-white/55 hover:bg-white/5 hover:text-white",
                  )}
                >
                  {t("chat.langOff")}
                </button>
                <div className="my-1 h-px bg-white/8" />
                {OUTGOING_LANGS.map((lang) => {
                  const active = chatTranslateOnSend && chatOutgoingLang === lang.id;
                  return (
                    <button
                      key={lang.id}
                      type="button"
                      onClick={() => pickOutgoingLang(lang.id)}
                      className={clsx(
                        "w-full flex items-center justify-between px-2.5 py-1.5 text-[12px] rounded-md",
                        active ? "bg-accent-gold/15 text-accent-gold" : "text-white/80 hover:bg-white/5 hover:text-white",
                      )}
                    >
                      <span>{t(`chat.lang.${lang.id}`)}</span>
                      <span className="font-mono text-[10px] opacity-45">{lang.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent min-h-0"
      >
        {empty ? (
          <div className="h-full flex flex-col items-center justify-center px-8 text-center">
            <span className="text-[13px] font-semibold text-white/70">{t("chat.no_messages")}</span>
            <p className="mt-1.5 text-[11px] text-white/35 leading-relaxed">{t(inMatch ? "chat.liveEmptyMatch" : "chat.liveEmptyLobby")}</p>
          </div>
        ) : (
          visibleMessages.map((msg) => {
            const isMe = msg.puuid === myPuuid;
            const time = new Date(Number(msg.time)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const name = resolveName(msg, isMe);
            const theme = channelStyle(msg.channel);
            const translated = chatAutoTranslate && !isMe ? incomingCache.get(cacheKey(msg.id, incomingLang)) : undefined;
            const showTranslation =
              translated &&
              translated.text &&
              translated.text !== msg.body &&
              !sameLanguage(translated.src, incomingLang);

            return (
              <div
                id={`live-msg-${msg.id}`}
                key={msg.id}
                className={clsx("flex flex-col gap-1 w-full max-w-[90%]", isMe ? "ml-auto items-end" : "items-start")}
              >
                <div className="flex items-center gap-1.5 px-1 text-[10px]">
                  <span className={clsx("px-1.5 py-px rounded text-[9px] font-semibold", theme.bg, theme.text)}>
                    {t(linkKey(msg.channel))}
                  </span>
                  <span className={clsx("font-semibold", isMe ? "text-accent-red" : "text-white/70")}>{name}</span>
                  <span className="text-white/30 font-mono">{time}</span>
                </div>
                <div
                  className={clsx(
                    "px-3 py-2 text-[13px] leading-relaxed wrap-break-word rounded-md",
                    isMe ? "bg-accent-red/15 text-white" : "bg-white/6 text-white/90",
                  )}
                >
                  <p className="select-text cursor-text">{msg.body}</p>
                  {showTranslation && (
                    <p className="mt-1.5 pt-1.5 border-t border-white/8 text-[12px] text-white/55 select-text">{translated.text}</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {showScrollButton && (
        <button
          type="button"
          onClick={() => {
            forceBottomRef.current = true;
            scrollToBottom("smooth");
          }}
          className="absolute bottom-20 right-5 z-20 w-8 h-8 rounded-full bg-accent-red text-white shadow-lg flex items-center justify-center hover:bg-accent-red/90 transition-all"
          title={t("chat.scroll_down")}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}

      <form onSubmit={handleSend} className="shrink-0 px-3 py-3 border-t border-white/8 bg-black/30 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={canSend ? t(placeholderKey(liveSendChannel)) : t("chat.liveNeedGame")}
            disabled={!canSend || sending}
            className={clsx(
              "w-full h-11 bg-white/6 border border-white/10 rounded-lg text-[13px] text-white placeholder-white/30 focus:border-white/25 focus:bg-white/8 focus:outline-none transition-colors disabled:opacity-35 disabled:cursor-not-allowed",
              hasDraft ? "pl-3.5 pr-11" : "px-3.5",
            )}
          />
          {hasDraft && (
            <button
              type="button"
              disabled={previewing}
              onClick={() => void handlePreviewTranslate()}
              title={t("chat.translateDraft")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 rounded-md flex items-center justify-center text-accent-gold/80 hover:text-accent-gold hover:bg-white/8 transition-colors"
            >
              {previewing ? <span className="text-[11px]">…</span> : <TranslateIcon className="w-4 h-4" />}
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={!hasDraft || !canSend || sending}
          className={clsx(
            "h-11 w-11 rounded-lg flex items-center justify-center transition-colors shrink-0",
            hasDraft && canSend ? "bg-accent-red text-white hover:bg-accent-red/85" : "bg-white/6 text-white/25",
          )}
        >
          <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        </button>
      </form>
    </div>
  );
}
