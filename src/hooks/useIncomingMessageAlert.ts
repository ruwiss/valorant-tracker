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

      const previous = baselineRef.current;
      const { baseline, delta } = diffUnread(previous, after);
      baselineRef.current = baseline;
      if (delta <= 0) return;
      if (useChatStore.getState().isOpen) return;
      useChatStore.getState().addAlert(delta);

      // Rust already played this unread while the overlay was hidden (the page
      // timers were frozen). Claiming it here keeps F2 from playing it again.
      const counts: Record<string, number> = {};
      for (const cid of Object.keys(baseline)) {
        if (baseline[cid] > (previous?.[cid] ?? 0)) counts[cid] = baseline[cid];
      }
      let play = true;
      try {
        play =
          (await invokeCommand<boolean>("take_message_sound", { counts }, {
            suppressErrorToast: true,
          })) !== false;
      } catch {
        play = true;
      }
      if (cancelled || !play || useChatStore.getState().isOpen) return;
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
