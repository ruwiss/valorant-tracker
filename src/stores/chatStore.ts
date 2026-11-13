import { create } from "zustand";
import { invokeCommand } from "../utils/ipc";
import type { ChatMessage, Conversation, PaginatedMessages, Friend, FriendRequest } from "../lib/types";
import { usePanelStore } from "./panelStore";
import { useI18n } from "../lib/i18n";

export type Tab = "DM" | "FRIENDS";

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
  /** Conversation `messages` belongs to; the composer stays locked until it matches `activeCid`. */
  messagesCid: string | null;
  /** Unsent text per conversation, so a draft never follows you into another chat. */
  drafts: Record<string, string>;
  /** A friend → DM lookup is in flight. */
  dmPending: boolean;
  friends: Friend[];
  outgoingRequests: FriendRequest[];
  cancellingPuuid: string | null;
  loading: boolean;
  isOpen: boolean;
  /** null = not probed yet; false = Riot chat unreachable; true = friends API ok. */
  chatLinkOk: boolean | null;
  /** New DMs noticed while the chat panel is closed, during menus. */
  alertCount: number;

  // Pagination
  page: number;
  hasMore: boolean;

  setIsOpen: (isOpen: boolean) => void;
  addAlert: (delta: number) => void;
  setActiveCid: (cid: string | null) => void;
  setActiveTab: (tab: Tab) => void;
  setDraft: (cid: string, text: string) => void;

  fetchConversations: () => Promise<void>;
  fetchMessages: (reload?: boolean) => Promise<void>;
  fetchFriends: () => Promise<void>;
  fetchOutgoingRequests: () => Promise<void>;
  sendFriendRequest: (gameName: string, gameTag: string, puuid?: string) => Promise<boolean>;
  cancelOutgoingRequest: (puuid: string) => Promise<boolean>;

  loadMoreMessages: () => Promise<void>;
  /** `cid` is the conversation the user was looking at when they hit send. */
  sendMessage: (cid: string, message: string, type: string) => Promise<boolean>;
  /** Resolves true only when this call actually became the active conversation. */
  startDm: (friendPuuid: string) => Promise<boolean>;
}

const PAGE_SIZE = 50;

/** Bumped on every conversation switch so a slow `get_dm_cid` can't override a newer click. */
let dmGen = 0;

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


export const useChatStore = create<ChatStore>((set, get) => ({
  activeCid: null,
  // No default open DM → land on friends; switch to DM when a conversation is opened.
  activeTab: "FRIENDS",
  conversations: [],
  messages: [],
  messagesCid: null,
  drafts: {},
  dmPending: false,
  friends: [],
  outgoingRequests: [],
  cancellingPuuid: null,
  loading: false,
  isOpen: false,
  chatLinkOk: null,
  alertCount: 0,
  page: 0,
  hasMore: false,

  setActiveTab: (tab) => set({ activeTab: tab }),

  setDraft: (cid, text) =>
    set((state) => {
      const drafts = { ...state.drafts };
      if (text) drafts[cid] = text;
      else delete drafts[cid];
      return { drafts };
    }),

  setIsOpen: (isOpen) => {
    if (isOpen) usePanelStore.getState().dismissForChat();
    set(isOpen ? {
      isOpen, alertCount: 0,
      ...(!get().activeCid ? { activeTab: "FRIENDS" as Tab } : {}),
    } : { isOpen });
    void usePanelStore.getState().syncWindowToState();
  },

  addAlert: (delta) => {
    if (delta <= 0 || get().isOpen) return;
    set((state) => ({ alertCount: state.alertCount + delta }));
  },

  setActiveCid: (cid) => {
    // Any DM lookup still in flight belongs to an older click — invalidate it.
    dmGen += 1;
    set({
      activeCid: cid,
      dmPending: false,
      loading: false,
      page: 0,
      messages: [],
      messagesCid: null,
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
            set({ friends, chatLinkOk: true });
        }
    } catch (e) {
        // Expected while host is down / tokens still spinning up — keep quiet.
        console.debug("Failed to fetch friends", e);
        set({ friends: [], outgoingRequests: [], chatLinkOk: false });
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
    const cid = get().activeCid;
    if (!cid) return;

    try {
      // Always fetch latest on poll/reload
      const result = await invokeCommand<PaginatedMessages>("get_paginated_chat_messages", {
        cid,
        page: 0,
        pageSize: PAGE_SIZE
      }, { suppressErrorToast: true });

      if (!result) return;
      // User switched conversation while this request was in flight — these
      // messages belong to the old chat and must not leak into the new one.
      if (get().activeCid !== cid) return;

      if (reload || get().messagesCid !== cid) {
        set({
          messages: result.messages,
          messagesCid: cid,
          hasMore: result.has_next,
          page: 0
        });
        return;
      }

      // Merge logic (Polling): read the list *after* the await so we never merge into a stale snapshot.
      const current = get().messages;
      const existingIds = new Set(current.map(m => m.id));
      const uniqueNew = result.messages.filter(m => !existingIds.has(m.id));

      if (uniqueNew.length > 0) {
        const combined = [...current, ...uniqueNew];
        combined.sort((a, b) => Number(a.time) - Number(b.time));
        set({ messages: combined, hasMore: result.has_next || get().hasMore });
      }
    } catch (e) {
      console.error("Failed to fetch messages", e);
    }
  },

  loadMoreMessages: async () => {
      const { activeCid: cid, page, hasMore, loading } = get();
      if (!cid || !hasMore || loading) return;

      set({ loading: true });
      try {
          const nextPage = page + 1;
          const result = await invokeCommand<PaginatedMessages>("get_paginated_chat_messages", {
            cid,
            page: nextPage,
            pageSize: PAGE_SIZE
          }); // Let error toast show for manual load more action

          // Conversation changed mid-flight: setActiveCid already reset `loading`.
          if (get().activeCid !== cid) return;

          if (!result) {
              set({ loading: false });
              return;
          }

          // Prepend older messages
          const messages = get().messages;
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
              // Nothing new: we have everything, stop paginating to avoid loops / scroll jumping.
              set({
                  hasMore: false,
                  loading: false
              });
          }

      } catch (e) {
          console.error("Failed to load more messages", e);
          if (get().activeCid === cid) set({ loading: false });
      }
  },

  sendMessage: async (cid, message, type) => {
    // Hard guard: only send to the conversation that is open right now, and only
    // once its history has loaded — i.e. the one the user is actually looking at.
    const state = get();
    if (!cid || state.activeCid !== cid || state.messagesCid !== cid) return false;

    try {
      const success = await invokeCommand<boolean>("send_message", {
        cid,
        message,
        messageType: type
      }, {
          errorMessage: "Mesaj gönderilemedi"
      });

      if (success) {
        // Wait a bit for the message to be processed by the server
        await new Promise(resolve => setTimeout(resolve, 300));
        // Reload the thread we sent to (no-op if the user already moved on).
        if (get().activeCid === cid) await get().fetchMessages(true);
      }

      return success || false;
    } catch (e) {
      console.error("Failed to send message", e);
      return false;
    }
  },

  startDm: async (friendPuuid: string) => {
      const gen = ++dmGen;
      set({ dmPending: true });
      try {
          const cid = await invokeCommand<string>("get_dm_cid", { friendPuuid }, {
              errorMessage: "DM başlatılamadı. Arkadaş bulunamadı veya çevrimdışı."
          });
          // A newer click (or a manual conversation switch) won; drop this result.
          if (gen !== dmGen) return false;
          set({ dmPending: false });
          if (!cid) return false;
          get().setActiveCid(cid);
          get().fetchConversations();
          return true;
      } catch (e) {
          console.error("Failed to start DM", e);
          if (gen === dmGen) set({ dmPending: false });
          return false;
      }
  },

}));
