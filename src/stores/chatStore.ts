import { create } from "zustand";
import { invokeCommand } from "../utils/ipc";
import { ChatMessage, Conversation, PaginatedMessages, Friend } from "../lib/types";

export type Tab = "DM" | "FRIENDS";

interface ChatStore {
  activeCid: string | null;
  activeTab: Tab;
  conversations: Conversation[];
  messages: ChatMessage[];
  friends: Friend[];
  loading: boolean;
  isOpen: boolean;

  // Pagination
  page: number;
  hasMore: boolean;

  setIsOpen: (isOpen: boolean) => void;
  setActiveCid: (cid: string | null) => void;
  setActiveTab: (tab: Tab) => void;

  fetchConversations: () => Promise<void>;
  fetchMessages: (reload?: boolean) => Promise<void>;
  fetchFriends: () => Promise<void>;

  loadMoreMessages: () => Promise<void>;
  sendMessage: (message: string, type: string) => Promise<boolean>;
  startDm: (friendPuuid: string) => Promise<void>;
}

const PAGE_SIZE = 50;

export const useChatStore = create<ChatStore>((set, get) => ({
  activeCid: null,
  activeTab: "DM",
  conversations: [],
  messages: [],
  friends: [],
  loading: false,
  isOpen: false,
  page: 0,
  hasMore: false,

  setActiveTab: (tab) => set({ activeTab: tab }),

  setIsOpen: (isOpen) => set({ isOpen }),

  setActiveCid: (cid) => {
    set({ activeCid: cid, page: 0, messages: [], hasMore: true });
    get().fetchMessages(true);
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
  }
}));
