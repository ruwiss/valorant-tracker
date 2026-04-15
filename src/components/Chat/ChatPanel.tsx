import { useEffect, useRef, useState, useMemo, useLayoutEffect } from "react";
import { useChatStore, Tab } from "../../stores/chatStore";
import { useGameStore } from "../../stores/gameStore";
import { useSettingsStore } from "../../stores/settingsStore"; // Import Settings Store
import { useI18n } from "../../lib/i18n";
import clsx from "clsx";

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
    fetchConversations,
    fetchMessages,
    fetchFriends,
    loadMoreMessages,
    sendMessage,
    startDm,
    hasMore,
    loading,
  } = useChatStore();
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

  // Initial & Polling Logic
  useEffect(() => {
    if (!isOpen || !isConnected()) return;

    // Initial fetch whenever we open or reconnect or BECOME VISIBLE
    if (isWindowVisible) {
      fetchConversations();
      fetchMessages(true);
      fetchFriends();
    }

    // Only set interval if visible
    if (!isWindowVisible) return;

    const interval = setInterval(() => {
      fetchConversations();
      // Only poll messages if we are in DM tab
      if (activeTab === "DM") {
        fetchMessages();
      }
      fetchFriends();
    }, 2000);

    return () => clearInterval(interval);
  }, [isOpen, isConnected, activeCid, isWindowVisible, activeTab]);

  const scrollAnimRef = useRef<number | null>(null);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      if (scrollAnimRef.current !== null) {
        cancelAnimationFrame(scrollAnimRef.current);
      }
    };
  }, []);

  // Scroll restoration for chat
  useLayoutEffect(() => {
    if (activeTab === "FRIENDS" && friendListRef.current) {
      friendListRef.current.scrollTop = friendScrollPos.current;
    }
  }, [activeTab]);

  // Smart Scroll for Chat
  useEffect(() => {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];

    // Only scroll if we are near bottom OR if it's a completely new chat (id changed and last was null)
    // or if we just sent a message (we can track that via store or simple expectation)
    // For now, simple logic: if near bottom, stay at bottom.

    // Also if this is the FIRST load of a chat (lastMessageIdRef.current is null), we should scroll.
    const isFirstLoad = lastMessageIdRef.current === null;

    if (lastMsg.id !== lastMessageIdRef.current) {
      if (scrollContainerRef.current && (isNearBottomRef.current || isFirstLoad)) {
        if (isFirstLoad) {
          // Custom slow scroll for first load (2s duration)
          const container = scrollContainerRef.current;
          const start = container.scrollTop;
          const target = container.scrollHeight - container.clientHeight;
          const distance = target - start;
          const duration = 2000;
          const startTime = performance.now();

          const animate = (time: number) => {
            const elapsed = time - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const ease = 1 - Math.pow(1 - progress, 4); // Quartic ease-out

            container.scrollTop = start + distance * ease;

            if (progress < 1) {
              scrollAnimRef.current = requestAnimationFrame(animate);
            } else {
              scrollAnimRef.current = null;
            }
          };

          if (distance > 0) {
            if (scrollAnimRef.current !== null) cancelAnimationFrame(scrollAnimRef.current);
            scrollAnimRef.current = requestAnimationFrame(animate);
          }
        } else {
          // Safe scroll using the container directly to prevent parent layout shifts
          scrollContainerRef.current.scrollTo({
            top: scrollContainerRef.current.scrollHeight,
            behavior: "smooth",
          });
        }
      }
      lastMessageIdRef.current = lastMsg.id;
    }
  }, [messages]);

  // Reset scroll tracker
  useEffect(() => {
    lastMessageIdRef.current = null;
    isNearBottomRef.current = true;
    prevFirstMessageIdRef.current = null;
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
      // Force immediate message fetch to show the sent message
      await fetchMessages(true);
      setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({
            top: scrollContainerRef.current.scrollHeight,
            behavior: "smooth",
          });
        }
      }, 100);
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

  // Filter Logic
  const filteredConversations = useMemo(() => {
    if (activeTab === "DM") return conversations.filter((c) => c.type !== "groupchat");
    return []; // Friends tab doesn't use this
  }, [conversations, activeTab]);

  const filteredFriends = useMemo(() => {
    if (!friendSearch) return friends;
    const lower = friendSearch.toLowerCase();
    return friends.filter((f) => f.game_name.toLowerCase().includes(lower) || f.game_tag.toLowerCase().includes(lower));
  }, [friends, friendSearch]);

  const handleFriendClick = async (puuid: string) => {
    await startDm(puuid);
    setActiveTab("DM"); // Switch to DM tab to see the chat
    setFriendSearch("");
  };

  // Handle Tab Switch with Smart Selection
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);

    // Auto-select logic based on tab
    if (tab === "DM") {
      // Auto select first DM
      const firstDm = conversations.find((c) => c.type !== "groupchat");
      setActiveCid(firstDm ? firstDm.cid : null);
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
            <button onClick={hideWindow} className="text-dim hover:text-white transition-colors p-2 hover:bg-white/5 rounded-lg group cursor-pointer" title="Minimize & Hide">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
            {/* Close Button */}
            <button onClick={() => setIsOpen(false)} className="text-dim hover:text-accent-red transition-colors p-2 hover:bg-accent-red/10 rounded-lg group cursor-pointer" title={t("chat.close")}>
              <svg className="w-4 h-4 group-hover:translate-y-0.5 transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* TABS */}
        <div className="flex px-2 pt-2 gap-1 border-b border-white/5 bg-black/20 shrink-0">
          {(["DM", "FRIENDS"] as Tab[]).map((tab) => (
            <button key={tab} onClick={() => handleTabChange(tab)} className={clsx("flex-1 py-3 text-[10px] font-bold tracking-widest transition-all relative uppercase hover:bg-white/5 rounded-t-sm flex items-center justify-center", activeTab === tab ? "text-white bg-white/5" : "text-dim")}>
              {t(`tabs.${tab.toLowerCase()}`)}
              {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-red shadow-[0_0_10px_#ff4655]" />}
            </button>
          ))}
        </div>

        {/* MAIN CONTENT AREA */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          <div className="scan-lines absolute inset-0 pointer-events-none opacity-10" />

          {/* CASE: FRIENDS TAB */}
          {activeTab === "FRIENDS" ? (
            <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
              {/* Search Bar */}
              <div className="relative shrink-0 group">
                <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-dim group-focus-within:text-accent-red transition-colors">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <input
                  type="text"
                  value={friendSearch}
                  onChange={(e) => setFriendSearch(e.target.value)}
                  placeholder={t("chat.search_placeholder")}
                  className="w-full bg-black/40 border border-white/10 rounded-sm py-2.5 pl-10 pr-4 text-xs font-bold text-white placeholder-dim/50 focus:outline-none focus:border-accent-red/50 transition-all uppercase tracking-wider"
                />
              </div>

              {/* Friend List */}
              <div ref={friendListRef} onScroll={handleFriendListScroll} className="flex-1 overflow-y-auto space-y-1 pr-1 scrollbar-thin scrollbar-thumb-white/10">
                {filteredFriends.map((friend) => (
                  <button key={friend.puuid} onClick={() => handleFriendClick(friend.puuid)} className="w-full h-14 flex items-center gap-3 px-3 rounded-sm border border-transparent hover:border-white/10 hover:bg-white/5 transition-all group relative overflow-hidden">
                    {/* Status Line */}
                    <div className={clsx("w-1 h-full absolute left-0 top-0 transition-colors", !friend.activePlatform ? "bg-dim/20" : "bg-accent-cyan shadow-[0_0_8px_cyan]")} />

                    {/* Avatar Placeholder */}
                    <div className="w-8 h-8 rounded-sm bg-white/10 flex items-center justify-center text-[10px] font-bold text-dim group-hover:text-white transition-colors relative z-10 shrink-0">{friend.game_name.charAt(0)}</div>

                    {/* Info */}
                    <div className="flex flex-col items-start gap-0.5 relative z-10 overflow-hidden">
                      <div className="flex items-baseline gap-1.5 w-full">
                        <span className="text-sm font-bold text-white truncate max-w-[180px] group-hover:text-accent-red transition-colors">{friend.game_name}</span>
                        <span className="text-[10px] text-dim font-mono">#{friend.game_tag}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider font-medium">
                        <span className={clsx(!friend.activePlatform ? "text-dim" : "text-accent-cyan")}>{!friend.activePlatform ? "OFFLINE" : "ONLINE"}</span>
                        {friend.note && <span className="text-dim/50 truncate">• {friend.note}</span>}
                      </div>
                    </div>

                    {/* Action Icon (Refined Fade Animation) */}
                    <div className="ml-auto opacity-0 group-hover:opacity-100 transition-all duration-300">
                      <div className="p-2 bg-accent-red text-white rounded-sm shadow-lg hover:scale-105 active:scale-95 transition-transform">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      </div>
                    </div>
                  </button>
                ))}
                {filteredFriends.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 opacity-80 animate-fade-in px-8">
                    <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4 border border-white/10 shadow-[0_0_20px_rgba(255,255,255,0.05)]">
                      <svg className="w-8 h-8 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                        />
                      </svg>
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
                <div className="h-14 shrink-0 flex items-center gap-2 px-4 overflow-x-auto border-b border-white/5 bg-black/10 scrollbar-none">
                  {filteredConversations.map((conv) => (
                    <button
                      key={conv.cid}
                      onClick={() => setActiveCid(conv.cid)}
                      className={clsx(
                        "px-3 py-1.5 rounded-sm flex items-center gap-2 border transition-all text-[11px] font-bold uppercase tracking-wider whitespace-nowrap",
                        activeCid === conv.cid ? "bg-accent-red/20 border-accent-red text-white shadow-[0_0_10px_rgba(255,70,85,0.2)]" : "bg-white/5 border-transparent text-dim hover:bg-white/10 hover:text-white",
                      )}
                    >
                      <div className={clsx("w-1.5 h-1.5 rounded-full", conv.type === "groupchat" ? "bg-accent-cyan" : "bg-accent-gold")} />
                      {conv.type === "groupchat" ? t("chat.team") : conv.game_name || t("chat.dm")}
                      {conv.unread_count > 0 && <span className="ml-1 bg-accent-red text-white text-[9px] px-1 rounded-sm">{conv.unread_count}</span>}
                    </button>
                  ))}
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
                    <svg className="w-16 h-16 mb-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
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
                    scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" });
                    isNearBottomRef.current = true;
                    setShowScrollButton(false);
                  }}
                  className="absolute bottom-24 right-6 z-20 w-8 h-8 rounded-full bg-accent-red text-white shadow-lg flex items-center justify-center animate-bounce-in hover:bg-accent-red/90 transition-all active:scale-95"
                  title={t("chat.scroll_down")}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
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
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
