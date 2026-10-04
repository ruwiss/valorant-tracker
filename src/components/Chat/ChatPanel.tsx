import { useEffect, useRef, useState, useMemo, useLayoutEffect } from "react";
import { useChatStore, Tab, isLiveConversation } from "../../stores/chatStore";
import { useGameStore } from "../../stores/gameStore";
import { useSettingsStore } from "../../stores/settingsStore"; // Import Settings Store
import { usePanelStore } from "../../stores/panelStore";
import { useI18n } from "../../lib/i18n";
import type { Friend } from "../../lib/types";
import clsx from "clsx";
import { ArrowDown, ChevronDown, IdCard, MessageSquare, MessagesSquare, Minus, Search, SendHorizontal, Users } from "lucide-react";

/** Stable per-name hue so each friend keeps the same avatar colour. */
function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function FriendAvatar({ name, online }: { name: string; online: boolean }) {
  const hue = avatarHue(name || "?");
  return (
    <div className="relative shrink-0">
      <div
        className={clsx("w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold uppercase", !online && "grayscale-[0.6] opacity-70")}
        style={{ background: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 80% 78%)` }}
      >
        {(name || "?").charAt(0)}
      </div>
      <span
        className={clsx(
          "absolute -bottom-px -right-px w-2.5 h-2.5 rounded-full ring-2 ring-[#0f1923]",
          online ? "bg-success" : "bg-[#55606d]",
        )}
      />
    </div>
  );
}

export function ChatPanel() {
  const {
    isOpen,
    setIsOpen,
    conversations,
    activeCid,
    setActiveCid,
    activeTab,
    setActiveTab, // Use from store
    messages,
    friends,
    outgoingRequests,
    cancellingPuuid,
    fetchConversations,
    fetchMessages,
    fetchFriends,
    fetchOutgoingRequests,
    cancelOutgoingRequest,
    loadMoreMessages,
    sendMessage,
    startDm,
    hasMore,
    loading,
  } = useChatStore();
  const openPlayer = usePanelStore((s) => s.openPlayer);
  const { isConnected, gameState } = useGameStore();
  const { hideWindow, isWindowVisible } = useSettingsStore(); // Get hideWindow & visibility state
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState("");
  const [friendSearch, setFriendSearch] = useState("");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const friendListRef = useRef<HTMLDivElement>(null);
  const friendScrollPos = useRef(0);

  // Helper to generate a consistent color based on string
  const getStringColor = (str: string) => {
    const colors = [
      { border: "border-accent-cyan/40", bg: "bg-accent-cyan/10", text: "text-accent-cyan" },
      { border: "border-accent-purple/40", bg: "bg-accent-purple/10", text: "text-accent-purple" },
      { border: "border-accent-gold/40", bg: "bg-accent-gold/10", text: "text-accent-gold" },
      { border: "border-accent-green/40", bg: "bg-accent-green/10", text: "text-accent-green" },
      { border: "border-accent-red/40", bg: "bg-accent-red/10", text: "text-accent-red" },
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const isNearBottomRef = useRef(true); // Default to true so initial load scrolls down
  const prevFirstMessageIdRef = useRef<string | null>(null);
  /** When true, next message paint should jump straight to the bottom (open / switch chat). */
  const forceScrollBottomRef = useRef(true);
  const scrollAnimRef = useRef<number | null>(null);

  const cancelScrollAnim = () => {
    if (scrollAnimRef.current !== null) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
  };

  /** Jump to latest message. Instant by default so open never leaves the viewport mid-history. */
  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    cancelScrollAnim();
    // Double-rAF: wait for layout after messages paint (images/fonts can shift height).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!scrollContainerRef.current) return;
        scrollContainerRef.current.scrollTo({
          top: scrollContainerRef.current.scrollHeight,
          behavior,
        });
        isNearBottomRef.current = true;
        setShowScrollButton(false);
      });
    });
  };

  useLayoutEffect(() => {
    // If we have messages and we had a previous first message
    if (messages.length > 0 && prevFirstMessageIdRef.current && scrollContainerRef.current) {
      const prevFirstId = prevFirstMessageIdRef.current;
      const currentFirstId = messages[0].id;

      // If the first message ID changed (prepended messages)
      if (prevFirstId !== currentFirstId) {
        const prevEl = document.getElementById(`msg-${prevFirstId}`);
        if (prevEl) {
          // Restore scroll position instantly to the previous top element
          scrollContainerRef.current.scrollTop = prevEl.offsetTop - 16;
        }
      }
    }

    // Update ref for next render
    if (messages.length > 0) {
      prevFirstMessageIdRef.current = messages[0].id;
    } else {
      prevFirstMessageIdRef.current = null;
    }
  }, [messages]);

  // Get my PUUID
  const myPuuid = gameState.allies.find((a) => a.is_me)?.puuid;

  useEffect(() => {
    if (!isOpen || !isConnected()) return;

    // Initial fetch whenever we open or reconnect or BECOME VISIBLE
    if (isWindowVisible) {
      fetchConversations();
      fetchMessages(true);
      fetchFriends();
      fetchOutgoingRequests();
    }

    // Only set interval if visible
    if (!isWindowVisible) return;

    const interval = setInterval(() => {
      fetchConversations();
      if (activeTab === "DM") {
        fetchMessages();
      }
      fetchFriends();
      fetchOutgoingRequests();
    }, 2000);

    return () => clearInterval(interval);
  }, [isOpen, isConnected, activeCid, isWindowVisible, activeTab]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => cancelScrollAnim();
  }, []);

  // Scroll restoration for friend list tab
  useLayoutEffect(() => {
    if (activeTab === "FRIENDS" && friendListRef.current) {
      friendListRef.current.scrollTop = friendScrollPos.current;
    }
  }, [activeTab]);

  // Panel opened → always land on the latest message
  useEffect(() => {
    if (!isOpen) return;
    forceScrollBottomRef.current = true;
    isNearBottomRef.current = true;
    lastMessageIdRef.current = null;
    if (messages.length > 0 && activeTab === "DM") {
      scrollToBottom("auto");
    }
  }, [isOpen]);

  // Smart Scroll for Chat
  useEffect(() => {
    if (messages.length === 0 || activeTab !== "DM") return;
    const lastMsg = messages[messages.length - 1];
    const isFirstLoad = lastMessageIdRef.current === null;
    const shouldForce = forceScrollBottomRef.current;

    if (lastMsg.id !== lastMessageIdRef.current || shouldForce) {
      if (scrollContainerRef.current && (isNearBottomRef.current || isFirstLoad || shouldForce)) {
        // Open / conversation switch: instant jump. Live new messages: smooth.
        scrollToBottom(shouldForce || isFirstLoad ? "auto" : "smooth");
        forceScrollBottomRef.current = false;
      }
      lastMessageIdRef.current = lastMsg.id;
    }
  }, [messages, activeTab]);

  // Reset scroll tracker when switching conversations
  useEffect(() => {
    lastMessageIdRef.current = null;
    isNearBottomRef.current = true;
    prevFirstMessageIdRef.current = null;
    forceScrollBottomRef.current = true;
  }, [activeCid]);

  // Handle Outside Click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setIsOpen(false);
  };

  // Scroll Handler for Pagination & Sticky Scroll Tracking
  const handleScroll = async (e: React.UIEvent<HTMLDivElement>) => {
    if (activeTab === "FRIENDS") return;

    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;

    // Track if we are near bottom (within 100px)
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isNear = distanceFromBottom < 100;
    isNearBottomRef.current = isNear;

    // Show/Hide scroll button
    setShowScrollButton(distanceFromBottom > 300);

    if (scrollTop === 0 && hasMore && !loading) {
      await loadMoreMessages();
      // Scroll restoration is now handled by useLayoutEffect
    }
  };

  const handleFriendListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    friendScrollPos.current = e.currentTarget.scrollTop;
  };

  // Send Message Logic with Type Safety
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !activeCid) return;

    const activeConv = conversations.find((c) => c.cid === activeCid);

    // Fallback to "chat" (DM) if conversation not found in list.
    // This happens when starting a new DM from friends list that isn't active yet.
    const type = activeConv?.type === "groupchat" ? "groupchat" : "chat";

    const messageToSend = inputValue;
    setInputValue(""); // Clear immediately for better UX

    const success = await sendMessage(messageToSend, type);
    if (success) {
      isNearBottomRef.current = true;
      forceScrollBottomRef.current = true;
      // Force immediate message fetch to show the sent message
      await fetchMessages(true);
      scrollToBottom("smooth");
    } else {
      // Restore message on failure
      setInputValue(messageToSend);
      console.error("Failed to send message");
    }
  };

  // Filter Logic already defined below, but we need to ensure handleSend is before use

  // ... (rest of render)

  // ...

  // In render:
  // <form onSubmit={handleSend} ...>

  const conversationLabel = (conv: (typeof conversations)[number]) => {
    const raw = (conv.game_name || "").trim();
    if (raw && raw !== "AGENT" && raw !== "AJAN") return raw.split("#")[0];
    const friend = friends.find((f) => conv.cid.toLowerCase().includes(f.puuid.toLowerCase()));
    if (friend?.game_name) return friend.game_name;
    return t("chat.dm");
  };

  // Chat tab: friend DMs only (in-game / party rooms stay out of this list).
  const filteredConversations = useMemo(() => {
    if (activeTab !== "DM") return [];
    return conversations.filter((c) => !isLiveConversation(c));
  }, [conversations, activeTab]);

  const filteredFriends = useMemo(() => {
    if (!friendSearch) return friends;
    const lower = friendSearch.toLowerCase();
    return friends.filter((f) => f.game_name.toLowerCase().includes(lower) || f.game_tag.toLowerCase().includes(lower));
  }, [friends, friendSearch]);

  // Online first, then alphabetical inside each group.
  const friendGroups = useMemo(() => {
    const byName = (a: Friend, b: Friend) => a.game_name.localeCompare(b.game_name, undefined, { sensitivity: "base" });
    return [
      { key: "online", label: t("chat.online"), items: filteredFriends.filter((f) => f.activePlatform).sort(byName) },
      { key: "offline", label: t("chat.offline"), items: filteredFriends.filter((f) => !f.activePlatform).sort(byName) },
    ].filter((g) => g.items.length > 0);
  }, [filteredFriends, t]);

  const lastSeen = (ts: number | null): string => {
    if (!ts) return "";
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    if (mins < 1) return t("lastMatch.justNow");
    if (mins < 60) return t("lastMatch.minutesAgo", { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t("lastMatch.hoursAgo", { n: hours });
    return t("lastMatch.daysAgo", { n: Math.floor(hours / 24) });
  };

  const filteredOutgoing = useMemo(() => {
    if (!friendSearch) return outgoingRequests;
    const lower = friendSearch.toLowerCase();
    return outgoingRequests.filter(
      (r) => r.game_name.toLowerCase().includes(lower) || r.game_tag.toLowerCase().includes(lower),
    );
  }, [outgoingRequests, friendSearch]);

  const handleCancelRequest = async (e: React.MouseEvent, puuid: string) => {
    e.stopPropagation();
    await cancelOutgoingRequest(puuid);
  };

  const openFriendProfile = (e: React.MouseEvent, friend: Friend) => {
    e.stopPropagation();
    const name = friend.game_tag
      ? `${friend.game_name}#${friend.game_tag}`
      : friend.game_name;
    void openPlayer({
      puuid: friend.puuid,
      name,
      agent: "",
      locked: false,
      party: "",
      is_me: false,
      rank_tier: 0,
      rank_rr: 0,
      level: 0,
    }, "friends");
    setIsOpen(false);
  };

  const handleFriendClick = async (puuid: string) => {
    await startDm(puuid);
    setActiveTab("DM");
    setFriendSearch("");
  };

  // Handle Tab Switch with Smart Selection
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);

    // Auto-select logic based on tab
    if (tab === "DM") {
      const preferred =
        conversations.find((c) => !isLiveConversation(c)) ||
        null;
      setActiveCid(preferred ? preferred.cid : null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/50 backdrop-blur-md animate-fade-in flex justify-end" onClick={handleBackdropClick}>
      <div className={clsx("w-[450px] h-full bg-dark/95 border-l border-white/10 shadow-[0_0_40px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden transform transition-transform duration-300 ease-out", isOpen ? "translate-x-0" : "translate-x-full")} onClick={(e) => e.stopPropagation()}>
        {/* HEADER */}
        <div data-tauri-drag-region className="h-14 border-b border-white/5 bg-linear-to-r from-white/5 to-transparent flex items-center justify-between px-6 shrink-0 relative overflow-hidden cursor-move">
          {/* Decorative glint */}
          <div className="absolute top-0 left-0 w-1 h-full bg-accent-red shadow-[0_0_10px_#ff4655]" />
          <h2 className="text-lg font-bold text-white font-display tracking-widest uppercase pointer-events-none">{t("chat.title")}</h2>

          <div className="flex items-center gap-1">
            {/* Minimize Button */}
            {/* Minimize Button */}
            <button onClick={hideWindow} className="text-dim hover:text-white transition-colors p-2 hover:bg-white/5 rounded-lg group cursor-pointer" title={t("chat.hide")}>
              <Minus className="w-4 h-4" />
            </button>
            {/* Close Button */}
            <button onClick={() => setIsOpen(false)} className="text-dim hover:text-accent-red transition-colors p-2 hover:bg-accent-red/10 rounded-lg group cursor-pointer" title={t("chat.close")}>
              <ChevronDown className="w-4 h-4 group-hover:translate-y-0.5 transition-transform duration-300" />
            </button>
          </div>
        </div>

        {/* TABS */}
        <div className="flex px-2 pt-2 gap-1 border-b border-white/5 bg-black/20 shrink-0">
          {(["DM", "FRIENDS"] as Tab[]).map((tab) => (
            <button key={tab} onClick={() => handleTabChange(tab)} className={clsx("flex-1 py-3 text-[10px] font-bold tracking-widest transition-all relative uppercase hover:bg-white/5 rounded-t-sm flex items-center justify-center", activeTab === tab ? "text-white bg-white/5" : "text-dim")}>
              {t(`tabs.${tab.toLowerCase()}`)}
              {tab === "FRIENDS" && outgoingRequests.length > 0 && (
                <span className="ml-1.5 min-w-[16px] h-4 px-1 rounded-sm bg-accent-red/80 text-white text-[9px] leading-4 font-bold">
                  {outgoingRequests.length}
                </span>
              )}
              {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-red shadow-[0_0_10px_#ff4655]" />}
            </button>
          ))}
        </div>

        {/* MAIN CONTENT AREA */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          <div className="scan-lines absolute inset-0 pointer-events-none opacity-10" />

          {activeTab === "FRIENDS" ? (
            <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
              {/* Search Bar */}
              <div className="relative shrink-0 group">
                <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-secondary group-focus-within:text-accent-red transition-colors">
                  <Search className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={friendSearch}
                  onChange={(e) => setFriendSearch(e.target.value)}
                  placeholder={t("chat.search_placeholder")}
                  className="w-full bg-black/30 border border-white/[0.08] rounded-md py-2 pl-9 pr-3 text-xs font-medium text-white placeholder:text-secondary/60 focus:outline-none focus:border-accent-red/50 transition-colors"
                />
              </div>

              {/* Friend List */}
              <div ref={friendListRef} onScroll={handleFriendListScroll} className="flex-1 overflow-y-auto space-y-1 pr-1 scrollbar-thin scrollbar-thumb-white/10">
                {filteredOutgoing.length > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between px-1 mb-2">
                      <span className="section-title text-secondary">
                        {t("chat.outgoing_requests")}
                      </span>
                      <span className="text-[9px] font-mono text-dim/70">{filteredOutgoing.length}</span>
                    </div>
                    <div className="space-y-1">
                      {filteredOutgoing.map((req) => {
                        const busy = cancellingPuuid === req.puuid;
                        return (
                          <div
                            key={req.puuid}
                            className="w-full h-12 flex items-center gap-3 px-2 rounded-md"
                          >
                            <FriendAvatar name={req.game_name} online={false} />
                            <div className="flex flex-col items-start gap-0.5 overflow-hidden flex-1 min-w-0">
                              <div className="flex items-baseline gap-1.5 w-full">
                                <span className="text-[13px] font-semibold text-white truncate max-w-[160px]">
                                  {req.game_name}
                                </span>
                                <span className="text-[10px] text-dim font-mono">#{req.game_tag}</span>
                              </div>
                              <span className="text-[9px] uppercase tracking-wider font-medium text-accent-gold">
                                {t("chat.pending")}
                              </span>
                            </div>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(e) => handleCancelRequest(e, req.puuid)}
                              className="shrink-0 px-2.5 h-7 rounded-md border border-accent-red/40 bg-accent-red/10 text-[10px] font-semibold text-accent-red hover:text-white hover:bg-accent-red/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              {t("chat.cancel_request")}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    {filteredFriends.length > 0 && <div className="mt-3 mb-1 h-px bg-white/5" />}
                  </div>
                )}
                {friendGroups.map((group) => (
                  <div key={group.key} className="mb-2">
                    <div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
                      <span className="section-title text-secondary">{group.label}</span>
                      <span className="text-[10px] font-semibold text-dim">{group.items.length}</span>
                    </div>
                    {group.items.map((friend) => {
                      const online = !!friend.activePlatform;
                      const seen = online ? "" : lastSeen(friend.last_online_ts);
                      return (
                        <div
                          key={friend.puuid}
                          role="button"
                          tabIndex={0}
                          title={t("chat.sendMessage")}
                          onClick={() => void handleFriendClick(friend.puuid)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void handleFriendClick(friend.puuid);
                            }
                          }}
                          className="w-full h-12 flex items-center gap-3 px-2 rounded-md hover:bg-white/[0.05] transition-colors group cursor-pointer"
                        >
                          <FriendAvatar name={friend.game_name} online={online} />

                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-1 min-w-0">
                              <span className={clsx("text-[13px] font-semibold truncate", online ? "text-white" : "text-primary/70")}>{friend.game_name}</span>
                              <span className="text-[10px] text-dim shrink-0">#{friend.game_tag}</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] min-w-0">
                              <span className={clsx("shrink-0", online ? "text-success" : "text-secondary/70")}>
                                {online ? t("chat.online") : seen || t("chat.offline")}
                              </span>
                              {friend.note && <span className="text-secondary/60 truncate">· {friend.note}</span>}
                            </div>
                          </div>

                          <div className="flex items-center gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                            <span className="icon-btn" aria-hidden>
                              <MessageSquare className="w-3.5 h-3.5" />
                            </span>
                            <button
                              type="button"
                              title={t("chat.viewProfile")}
                              onClick={(e) => openFriendProfile(e, friend)}
                              className="icon-btn hover:text-accent-cyan!"
                            >
                              <IdCard className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {filteredFriends.length === 0 && filteredOutgoing.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 opacity-80 animate-fade-in px-8">
                    <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4 border border-white/10 shadow-[0_0_20px_rgba(255,255,255,0.05)]">
                      <Users className="w-8 h-8 text-dim" strokeWidth={1.5} />
                    </div>

                    <h3 className="text-sm font-bold text-white tracking-widest uppercase mb-2">{t("chat.no_agents")}</h3>

                    {!isConnected() ? (
                      <div className="bg-accent-red/10 border border-accent-red/20 rounded-lg p-3 w-full text-center">
                        <p className="text-[10px] text-accent-red font-medium leading-relaxed">{t("chat.gameRequired")}</p>
                      </div>
                    ) : (
                      <p className="text-[10px] text-dim text-center leading-relaxed max-w-[200px]">{t("chat.search_friends_hint")}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* CASE: CHAT VIEW (DM) */
            <>
              {/* Conversation Horizontal Scroll (Hidden in Friends Tab or if no comms?)
                   Actually, user said "Active Comms text appears constantly".
                   It appears when filteredConversations is empty.
                   It should NOT appear in Friends tab because this blocks friends list? Wait.
                   No, Friends Tab has its own block "CASE: FRIENDS TAB".
                   This block is for "CASE: CHAT VIEW".
                   So if we are in CHAT VIEW, and have no filteredConversations, it shows "No Active Comms".
                   That seems correct. But if user sees it "constantly" maybe they have no convs?
              */}
              {/* Conversation Horizontal Scroll (Hidden if empty) */}
              {filteredConversations.length > 0 && (
                <div className="relative shrink-0 border-b border-white/5 bg-black/20">
                  <div
                    className="dm-rail flex items-center gap-1 px-3 py-1.5 overflow-x-auto"
                    onWheel={(e) => {
                      const el = e.currentTarget;
                      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                        el.scrollLeft += e.deltaY;
                      }
                    }}
                  >
                    {filteredConversations.map((conv) => {
                      const name = conversationLabel(conv);
                      const on = activeCid === conv.cid;
                      return (
                        <button
                          key={conv.cid}
                          type="button"
                          onClick={() => setActiveCid(conv.cid)}
                          title={name}
                          className={clsx(
                            "h-7 max-w-[8.5rem] shrink-0 px-2.5 rounded-sm text-[11px] font-semibold tracking-normal whitespace-nowrap truncate border transition-all",
                            on
                              ? "bg-accent-red/20 border-accent-red/70 text-white"
                              : "bg-white/5 border-transparent text-white/70 hover:text-white hover:bg-white/10",
                          )}
                        >
                          {name}
                          {conv.unread_count > 0 && (
                            <span className="ml-1.5 align-middle inline-block min-w-4 px-1 rounded-sm bg-accent-red text-white text-[9px] leading-4 font-bold">
                              {conv.unread_count > 99 ? "99+" : conv.unread_count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-linear-to-r from-black/50 to-transparent" />
                  <div className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-linear-to-l from-black/60 to-transparent" />
                </div>
              )}

              {/* Messages Body */}
              <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-accent-red/20 scrollbar-track-transparent min-h-0">
                {/* Loading Spinner */}
                {loading && hasMore && (
                  <div className="flex justify-center py-2 animate-pulse">
                    <div className="text-[10px] tracking-[0.2em] text-accent-red font-display">{t("chat.decrypting")}</div>
                  </div>
                )}

                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center opacity-20">
                    <MessagesSquare className="w-16 h-16 mb-4 text-white" strokeWidth={1} />
                    <span className="font-display tracking-[0.2em] text-xs">{t("chat.no_messages")}</span>
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isMe = msg.puuid === myPuuid;
                    const time = new Date(Number(msg.time)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

                    // Name Resolution
                    // If msg.game_name is missing, try to find it
                    let displayName = msg.game_name;
                    if (!displayName || displayName === "AGENT" || displayName === "AJAN") {
                      if (isMe) {
                        // Try to find my name from allies
                        const me = gameState.allies.find((a) => a.puuid === myPuuid);
                        if (me) displayName = me.name;
                      } else {
                        // Try friends
                        const friend = friends.find((f) => f.puuid === msg.puuid);
                        if (friend) displayName = friend.game_name;
                        else {
                          // Try conversations
                          const conv = conversations.find((c) => c.cid === activeCid);
                          // If this is a DM, the conv name is the other person's name
                          if (conv && conv.type !== "groupchat") displayName = conv.game_name || displayName;
                        }
                      }
                    }

                    const themeColor = !isMe ? getStringColor(displayName || "agent") : { border: "border-accent-red/60", bg: "bg-accent-red/15", text: "text-accent-red" };

                    return (
                      <div id={`msg-${msg.id}`} key={msg.id} className={clsx("flex flex-col gap-1 w-full max-w-[85%] group mb-2", isMe ? "ml-auto items-end" : "items-start")}>
                        {/* Meta Line */}
                        <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest px-1">
                          <span className={clsx("uppercase", themeColor.text)}>{displayName || t("chat.agent_fallback")}</span>
                          <span className="text-dim/60 font-mono tracking-normal">{time}</span>
                        </div>

                        {/* Message Bubble */}
                        <div
                          className={clsx(
                            "relative px-4 py-2.5 text-sm shadow-xl transition-all wrap-break-word",
                            "backdrop-blur-sm border-y border-white/5",
                            isMe ? "bg-linear-to-l from-accent-red/20 to-accent-red/5 border-r-2 border-accent-red text-white" : clsx("bg-linear-to-r from-white/5 to-transparent border-l-2", themeColor.bg, themeColor.border, "text-white"),
                          )}
                        >
                          <p className="leading-relaxed font-medium tracking-wide drop-shadow-sm select-text cursor-text">{msg.body}</p>

                          {/* Corner Accent */}
                          <div className={clsx("absolute top-0 w-1.5 h-1.5", isMe ? "right-0 bg-accent-red" : clsx("left-0", themeColor.text.replace("text-", "bg-")))} style={{ clipPath: isMe ? "polygon(0 0, 100% 0, 100% 100%)" : "polygon(0 0, 100% 0, 0 100%)" }} />
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Scroll To Bottom Button */}
              {showScrollButton && (
                <button
                  onClick={() => {
                    forceScrollBottomRef.current = true;
                    scrollToBottom("smooth");
                  }}
                  className="absolute bottom-24 right-6 z-20 w-8 h-8 rounded-full bg-accent-red text-white shadow-lg flex items-center justify-center animate-bounce-in hover:bg-accent-red/90 transition-all active:scale-95"
                  title={t("chat.scroll_down")}
                >
                  <ArrowDown className="w-5 h-5" />
                </button>
              )}

              {/* Input Area - Tactical Design */}
              <form onSubmit={handleSend} className="p-4 bg-black/40 backdrop-blur-xl border-t border-white/10 shrink-0 flex gap-3 items-stretch h-21 relative overflow-hidden">
                {/* Subtle top glow */}
                <div className="absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-accent-red/30 to-transparent" />

                {/* Input Field */}
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={t("chat.placeholder")}
                  disabled={!activeCid}
                  className="flex-1 bg-white/5 border border-white/10 rounded-sm px-5 py-3 text-sm text-white placeholder-dim/30 hover:bg-white/10 hover:border-white/20 focus:border-accent-red/50 focus:bg-white/10 focus:outline-none transition-all disabled:opacity-30 disabled:cursor-not-allowed font-bold"
                />

                {/* Send Button (Tactical Geometric) */}
                <button
                  type="submit"
                  disabled={!inputValue.trim()}
                  className={clsx("w-13 rounded-sm flex items-center justify-center transition-all border", inputValue.trim() ? "bg-accent-red/20 border-accent-red/50 text-accent-red shadow-[0_0_15px_rgba(255,70,85,0.2)] hover:bg-accent-red hover:text-white" : "bg-white/5 border-white/10 text-dim")}
                >
                  <SendHorizontal className="w-5 h-5" />
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
