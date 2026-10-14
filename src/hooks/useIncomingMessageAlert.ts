import { useEffect, useRef } from "react";
import { useGameStore } from "../stores/gameStore";
import { useChatStore } from "../stores/chatStore";
import { diffUnread, type UnreadBaseline } from "../lib/messageAlert";
import { playMessageSound } from "../lib/messageSound";
import { useI18n } from "../lib/i18n";
import { invokeCommand } from "../utils/ipc";

const POLL_MS = 2000;

export function useIncomingMessageAlert() {
  const status = useGameStore((s) => s.status);
  const phase = useGameStore((s) => s.gameState.state);
  const isOpen = useChatStore((s) => s.isOpen);
  const locale = useI18n((s) => s.locale);
  const baselineRef = useRef<UnreadBaseline | null>(null);

  const watching =
    (status === "CONNECTED" ||
      status === "RIOT_CONNECTED" ||
      status === "PAUSED") &&
    phase !== "pregame" &&
    phase !== "ingame" &&
    !isOpen;

  useEffect(() => {
    void invokeCommand(
      "set_message_alerts",
      { enabled: watching, locale },
      { suppressErrorToast: true },
    ).catch(() => {});
  }, [watching, locale]);

  useEffect(() => {
    if (!watching) {
      baselineRef.current = null;
      return;
    }

    let cancelled = false;
    baselineRef.current = null;

    const tick = async () => {
      const before = useChatStore.getState().conversations;
      await useChatStore.getState().fetchConversations();
      if (cancelled) return;
      if (useChatStore.getState().isOpen) return;

      const after = useChatStore.getState().conversations;
      // A failed fetch leaves the same array. Don't burn the silent baseline on it.
      if (after === before) return;

      const { baseline, delta } = diffUnread(baselineRef.current, after);
      baselineRef.current = baseline;
      if (delta <= 0) return;
      if (useChatStore.getState().isOpen) return;
      useChatStore.getState().addAlert(delta);

      // The Riot socket plays the clip as soon as the message arrives. This poll
      // is the fallback when that socket misses it. If the socket is up, wait
      // a beat so a fetch that already includes the new unread doesn't double
      // the sound.
      let live = false;
      try {
        live =
          (await invokeCommand<boolean>("message_alerts_live", undefined, {
            suppressErrorToast: true,
          })) === true;
      } catch {
        live = false;
      }
      if (cancelled || useChatStore.getState().isOpen) return;
      if (live) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        if (cancelled || useChatStore.getState().isOpen) return;
      }
      let handled = false;
      try {
        handled =
          (await invokeCommand<boolean>("message_sound_handled", undefined, {
            suppressErrorToast: true,
          })) === true;
      } catch {
        handled = false;
      }
      if (cancelled || handled || useChatStore.getState().isOpen) return;
      playMessageSound();
    };

    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      baselineRef.current = null;
    };
  }, [watching]);
}
