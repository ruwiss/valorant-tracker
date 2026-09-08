import { create } from "zustand";
import { invokeCommand } from "../utils/ipc";
import { ChatMessage, Conversation, PaginatedMessages, Friend, FriendRequest, LiveChatMessage, LiveChatSnapshot, LiveChatChannel } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { useSettingsStore } from "./settingsStore";

export type Tab = "LIVE" | "DM" | "FRIENDS";

export function isLiveConversation(conv: Conversation): boolean {
  if (!conv.cid) return false;
  const cid = conv.cid.toLowerCase();
  return cid.includes("ares-coregame") || cid.includes("ares-pregame") || cid.includes("ares-parties");
}

interface ChatStore {
  activeCid: string | null;
  activeTab: Tab;
  conversations: Conversation[];
  messages: ChatMessage[];
  friends: Friend[];
  outgoingRequests: FriendRequest[];
  cancellingPuuid: string | null;
  loading: boolean;
  isOpen: boolean;

  // Live in-game / party feed
  liveMessages: LiveChatMessage[];
  liveHasGame: boolean;
  liveHasParty: boolean;
  liveSendChannel: LiveChatChannel;
  liveUnread: number;

  // Pagination
  page: number;
  hasMore: boolean;

  setIsOpen: (isOpen: boolean) => void;
  setActiveCid: (cid: string | null) => void;
  setActiveTab: (tab: Tab) => void;
  setLiveSendChannel: (channel: LiveChatChannel) => void;
  fetchLiveMessages: () => Promise<void>;
  sendLiveMessage: (message: string, channel: LiveChatChannel) => Promise<boolean>;

  fetchConversations: () => Promise<void>;
  fetchMessages: (reload?: boolean) => Promise<void>;
  fetchFriends: () => Promise<void>;
  fetchOutgoingRequests: () => Promise<void>;
  sendFriendRequest: (gameName: string, gameTag: string, puuid?: string) => Promise<boolean>;
  cancelOutgoingRequest: (puuid: string) => Promise<boolean>;

  loadMoreMessages: () => Promise<void>;
  sendMessage: (message: string, type: string) => Promise<boolean>;
  startDm: (friendPuuid: string) => Promise<void>;
}

const PAGE_SIZE = 50;

/** Bumped on every outgoing-request fetch/cancel so stale in-flight polls are dropped. */
let outgoingFetchGen = 0;
/** PUUID → expiry. Riot's GET can still list a request for a few seconds after DELETE. */
const cancelledOutgoing = new Map<string, number>();
const CANCEL_TOMBSTONE_MS = 30_000;

function pruneCancelledTombstones() {
  const now = Date.now();
  for (const [id, exp] of cancelledOutgoing) {
    if (exp <= now) cancelledOutgoing.delete(id);
  }
}

function applyOutgoingRequests(
  set: (partial: { outgoingRequests: FriendRequest[] }) => void,
  requests: FriendRequest[],
) {
  pruneCancelledTombstones();
  for (const [id] of cancelledOutgoing) {
    if (!requests.some((r) => r.puuid === id)) {
      cancelledOutgoing.delete(id);
    }
  }
  set({
    outgoingRequests: requests.filter((r) => !cancelledOutgoing.has(r.puuid)),
  });
}


function classifyLiveMessage(cid: string, _type: string): LiveChatChannel {
  const id = cid.toLowerCase();
  if (id.includes("ares-parties")) return "party";
  if (id.includes("-all@")) return "all";
  if (id.includes("ares-coregame") || id.includes("ares-pregame")) return "team";
  return "party";
}

async function fallbackLiveFromConversations(conversations: Conversation[]): Promise<{
  messages: LiveChatMessage[];
  hasGame: boolean;
  hasParty: boolean;
}> {
  const live = conversations.filter(isLiveConversation);
  const hasGame = live.some((c) => {
    const id = c.cid.toLowerCase();
    return id.includes("coregame") || id.includes("pregame");
  });
  const hasParty = live.some((c) => {
    const id = c.cid.toLowerCase();
    return !id.includes("coregame") && !id.includes("pregame");
  });
  if (live.length === 0) return { messages: [], hasGame, hasParty };

  const pages = await Promise.all(
    live.map((conv) =>
      invokeCommand<PaginatedMessages>(
        "get_paginated_chat_messages",
        { cid: conv.cid, page: 0, pageSize: 80 },
        { suppressErrorToast: true },
      ).catch(() => null),
    ),
  );

  const seen = new Set<string>();
  const messages: LiveChatMessage[] = [];
  for (const page of pages) {
    if (!page?.messages) continue;
    for (const msg of page.messages) {
      if (!msg.body?.trim() || seen.has(msg.id)) continue;
      const channel = classifyLiveMessage(msg.cid, msg.type);
      if (channel === "party" && msg.type === "chat") continue;
      seen.add(msg.id);
      messages.push({
        body: msg.body,
        cid: msg.cid,
        game_name: msg.game_name,
        game_tag: msg.game_tag,
        id: msg.id,
        mid: msg.mid,
        puuid: msg.puuid,
        time: msg.time,
        type: msg.type,
        channel,
      });
    }
  }
  messages.sort((a, b) => Number(a.time) - Number(b.time));
  return { messages, hasGame, hasParty };
}

export const useChatStore = create<ChatStore>((set, get) => ({
  activeCid: null,
  // No default open DM → land on friends; switch to DM when a conversation is opened.
  activeTab: "LIVE",
  conversations: [],
  messages: [],
  friends: [],
  outgoingRequests: [],
  cancellingPuuid: null,
  loading: false,
  isOpen: false,
  liveMessages: [],
  liveHasGame: false,
  liveHasParty: false,
  liveSendChannel: "team",
  liveUnread: 0,
  page: 0,
  hasMore: false,

  setActiveTab: (tab) => set({ activeTab: tab, ...(tab === "LIVE" ? { liveUnread: 0 } : {}) }),

  setLiveSendChannel: (channel) => set({ liveSendChannel: channel }),

  setIsOpen: (isOpen) => {
    // Opening the panel with no active conversation → live match/party chat.
    if (isOpen && !get().activeCid) {
      set({ isOpen: true, activeTab: "LIVE", liveUnread: 0 });
      return;
    }
    set({ isOpen });
  },

  setActiveCid: (cid) => {
    set({
      activeCid: cid,
      page: 0,
      messages: [],
      hasMore: true,
      // Opening a conversation always lands on the DM tab.
      ...(cid ? { activeTab: "DM" as Tab } : {}),
    });
    if (cid) get().fetchMessages(true);
  },

  fetchConversations: async () => {
    try {
      // Suppress error toast for polling
      const convs = await invokeCommand<Conversation[]>("get_active_conversations", undefined, { suppressErrorToast: true });
      if (convs) {
          set({ conversations: convs });

          // Select first if none selected
          const { activeCid } = get();
          if (!activeCid && convs.length > 0) {
            // Only auto select if we are totally empty?
            // Actually typical behavior is to NOT select anything until user clicks,
            // unless we want to resume last. For now, let's keep it safe.
            // get().setActiveCid(convs[0].cid);
          }
      }
    } catch (e) {
      console.error("Failed to fetch conversations", e);
    }
  },

  fetchFriends: async () => {
    try {
        // Suppress error toast for polling
        const friends = await invokeCommand<Friend[]>("get_friends", undefined, { suppressErrorToast: true });
        // Sort friends: Online first, then by name
        // activePlatform check: 'riot' means playing? usually null means offline or away from game
        // We'll trust the order given or sort simply
        if (friends) {
            friends.sort((a, b) => {
                // Determine online status roughly
                const aOnline = !a.activePlatform ? 0 : 1;
                const bOnline = !b.activePlatform ? 0 : 1;

                if (aOnline !== bOnline) return bOnline - aOnline;
                return a.game_name.localeCompare(b.game_name);
            });
            set({ friends });
        }
    } catch (e) {
        console.error("Failed to fetch friends", e);
    }
  },

  fetchOutgoingRequests: async () => {
    const gen = ++outgoingFetchGen;
    try {
      const requests = await invokeCommand<FriendRequest[]>(
        "get_outgoing_friend_requests",
        undefined,
        { suppressErrorToast: true },
      );
      if (gen !== outgoingFetchGen) return;
      if (requests) applyOutgoingRequests(set, requests);
    } catch (e) {
      console.error("Failed to fetch outgoing friend requests", e);
    }
  },

  sendFriendRequest: async (gameName, gameTag, puuid) => {
    const t = useI18n.getState().t;
    const name = gameName.trim();
    const tag = gameTag.trim();
    if (!name || !tag) return false;

    try {
      const success = await invokeCommand<boolean>(
        "send_friend_request",
        { gameName: name, gameTag: tag },
        {
          errorMessage: t("lastMatch.friendFailed"),
          successMessage: t("lastMatch.friendSent"),
        },
      );
      if (success) {
        if (puuid) {
          set((state) => {
            if (state.outgoingRequests.some((r) => r.puuid === puuid)) return state;
            return {
              outgoingRequests: [
                ...state.outgoingRequests,
                {
                  game_name: name,
                  game_tag: tag,
                  name,
                  note: "",
                  pid: "",
                  puuid,
                  region: "",
                  subscription: "pending_out",
                },
              ],
            };
          });
        }
        void get().fetchOutgoingRequests();
        return true;
      }
      return false;
    } catch (e) {
      console.error("Failed to send friend request", e);
      return false;
    }
  },

  cancelOutgoingRequest: async (puuid) => {
    const { cancellingPuuid } = get();
    if (!puuid || cancellingPuuid === puuid) return false;

    const t = useI18n.getState().t;
    outgoingFetchGen += 1;
    set({ cancellingPuuid: puuid });
    try {
      const success = await invokeCommand<boolean>(
        "cancel_friend_request",
        { puuid },
        {
          errorMessage: t("chat.cancel_request_failed"),
          successMessage: t("chat.cancel_request_success"),
        },
      );
      if (success) {
        cancelledOutgoing.set(puuid, Date.now() + CANCEL_TOMBSTONE_MS);
        outgoingFetchGen += 1;
        set((state) => ({
          outgoingRequests: state.outgoingRequests.filter((r) => r.puuid !== puuid),
          cancellingPuuid: null,
        }));
        return true;
      }
      set({ cancellingPuuid: null });
      return false;
    } catch (e) {
      console.error("Failed to cancel friend request", e);
      set({ cancellingPuuid: null });
      return false;
    }
  },

  fetchMessages: async (reload = false) => {
    const { activeCid, messages } = get();
    if (!activeCid) return;

    try {
      // Always fetch latest on poll/reload
      const result = await invokeCommand<PaginatedMessages>("get_paginated_chat_messages", {
        cid: activeCid,
        page: 0,
        pageSize: PAGE_SIZE
      }, { suppressErrorToast: true });

      if (!result) return;

      if (reload) {
        // Complete reset
        set({
           messages: result.messages,
           hasMore: result.has_next,
           page: 0
        });
      } else {
        // Merge logic (Polling)
        // Combine new latest messages with existing messages
        // Deduplicate by ID
        const existingIds = new Set(messages.map(m => m.id));

        // Actually Set.has is O(1).
        const uniqueNew = result.messages.filter(m => !existingIds.has(m.id));

        if (uniqueNew.length > 0) {
            // We have new messages!
            // Append them to the list (since result.messages is Oldest->Newest, and 'messages' is Oldest->Newest)
            // But wait, if we fetched Page 0, these are the *latest* messages.
            // If we have messages 1..100. Page 0 might have 90..110?
            // We should merge everything and resort to be safe.

            const combined = [...messages, ...uniqueNew];
            // Dedupe again just in case (though uniqueNew filtered already)
            // Sort by time
            combined.sort((a, b) => Number(a.time) - Number(b.time));

            set({ messages: combined, hasMore: result.has_next || get().hasMore });
        }
      }
    } catch (e) {
      console.error("Failed to fetch messages", e);
    }
  },

  loadMoreMessages: async () => {
      const { activeCid, page, messages, hasMore, loading } = get();
      if (!activeCid || !hasMore || loading) return;

      set({ loading: true });
      try {
          const nextPage = page + 1;
          const result = await invokeCommand<PaginatedMessages>("get_paginated_chat_messages", {
            cid: activeCid,
            page: nextPage,
            pageSize: PAGE_SIZE
          }); // Let error toast show for manual load more action

          if (!result) {
              set({ loading: false });
              return;
          }

          // Prepend older messages
          // Dedupe just in case
          const existingIds = new Set(messages.map(m => m.id));
          const uniqueOld = result.messages.filter(m => !existingIds.has(m.id));

          if (uniqueOld.length > 0) {
              const combined = [...uniqueOld, ...messages];
              combined.sort((a, b) => Number(a.time) - Number(b.time));

               set({
                  messages: combined,
                  page: nextPage,
                  hasMore: result.has_next,
                  loading: false
              });
          } else {
              // No new unique messages found, so we probably have everything or are overlapping heavily.
              // Stop further pagination to prevent infinite loops / scroll jumping.
              set({
                  hasMore: false,
                  loading: false
              });
          }

      } catch (e) {
          console.error("Failed to load more messages", e);
          set({ loading: false });
      }
  },

  sendMessage: async (message, type) => {
    const { activeCid } = get();
    if (!activeCid) return false;

    // Shortcuts (sa/as/<3) are applied in the Rust send path so they hit
    // in-game Valorant chat (groupchat) the same way as DMs.
    try {
      const success = await invokeCommand<boolean>("send_message", {
        cid: activeCid,
        message,
        messageType: type
      }, {
          errorMessage: "Mesaj gönderilemedi"
      });

      if (success) {
        // Wait a bit for the message to be processed by the server
        await new Promise(resolve => setTimeout(resolve, 300));
        // Reload messages to show the sent message
        await get().fetchMessages(true);
      }

      return success || false;
    } catch (e) {
      console.error("Failed to send message", e);
      return false;
    }
  },

  startDm: async (friendPuuid: string) => {
      try {
          const cid = await invokeCommand<string>("get_dm_cid", { friendPuuid }, {
              errorMessage: "DM başlatılamadı. Arkadaş bulunamadı veya çevrimdışı."
          });
          if (cid) {
              get().setActiveCid(cid);
              get().fetchConversations();
          }
      } catch (e) {
          console.error("Failed to start DM", e);
      }
  },

  fetchLiveMessages: async () => {
    try {
      const snap = await invokeCommand<LiveChatSnapshot>("get_live_chat_messages", undefined, {
        suppressErrorToast: true,
      });
      let messages = snap?.messages ?? [];
      let hasGame = snap?.has_game ?? false;
      let hasParty = snap?.has_party ?? false;

      if (messages.length === 0) {
        const fallback = await fallbackLiveFromConversations(get().conversations);
        if (fallback.messages.length > 0) {
          messages = fallback.messages;
          hasGame = hasGame || fallback.hasGame;
          hasParty = hasParty || fallback.hasParty;
        }
      }

      if (messages.length === 0) {
        const all = await invokeCommand<ChatMessage[]>(
          "get_chat_messages",
          { cid: null },
          { suppressErrorToast: true },
        ).catch(() => null);
        if (all?.length) {
          const seen = new Set<string>();
          for (const msg of all) {
            if (!msg.body?.trim() || seen.has(msg.id)) continue;
            const cid = (msg.cid || "").toLowerCase();
            const liveCid =
              cid.includes("ares-coregame") ||
              cid.includes("ares-pregame") ||
              cid.includes("ares-parties");
            if (!liveCid) continue;
            seen.add(msg.id);
            const channel = classifyLiveMessage(msg.cid, msg.type);
            messages.push({
              body: msg.body,
              cid: msg.cid,
              game_name: msg.game_name,
              game_tag: msg.game_tag,
              id: msg.id,
              mid: msg.mid,
              puuid: msg.puuid,
              time: msg.time,
              type: msg.type,
              channel,
            });
            if (channel === "team" || channel === "all") hasGame = true;
            if (channel === "party") hasParty = true;
          }
          messages.sort((a, b) => Number(a.time) - Number(b.time));
        }
      }

      if (!hasGame && !hasParty && messages.length > 0) {
        hasParty = messages.some((m) => m.channel === "party");
        hasGame = messages.some((m) => m.channel === "team" || m.channel === "all");
        if (!hasGame && !hasParty) hasParty = true;
      }

      const prevIds = new Set(get().liveMessages.map((m) => m.id));
      const fresh = messages.filter((m) => !prevIds.has(m.id));
      const onLive = get().activeTab === "LIVE";
      set({
        liveMessages: messages,
        liveHasGame: hasGame || messages.some((m) => m.channel === "team" || m.channel === "all"),
        liveHasParty: hasParty || messages.some((m) => m.channel === "party"),
        liveUnread: onLive ? 0 : get().liveUnread + fresh.length,
      });
    } catch (e) {
      console.error("Failed to fetch live chat", e);
    }
  },

  sendLiveMessage: async (message, channel) => {
    const settings = useSettingsStore.getState();
    const translateTo = settings.chatTranslateOnSend ? settings.chatOutgoingLang : null;
    const t = useI18n.getState().t;
    try {
      const success = await invokeCommand<boolean>(
        "send_live_chat",
        { message, channel, translateTo },
        { errorMessage: t("chat.sendFailed") },
      );
      if (success) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await get().fetchLiveMessages();
        return true;
      }
    } catch (e) {
      console.error("Failed to send live chat", e);
    }

    const conv = get().conversations.find((c) => {
      if (!isLiveConversation(c)) return false;
      const cid = c.cid.toLowerCase();
      if (channel === "all") return cid.includes("-all@") || cid.includes("ares-coregame");
      if (channel === "party") return cid.includes("ares-parties");
      return cid.includes("ares-coregame") || cid.includes("ares-pregame") || cid.includes("ares-parties");
    });
    if (!conv) return false;
    const type = channel === "all" ? "chat" : "groupchat";
    try {
      const success = await invokeCommand<boolean>(
        "send_message",
        { cid: conv.cid, message, messageType: type },
        { errorMessage: t("chat.sendFailed") },
      );
      if (success) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await get().fetchLiveMessages();
      }
      return success || false;
    } catch (e) {
      console.error("Failed to send live chat fallback", e);
      return false;
    }
  },
}));
