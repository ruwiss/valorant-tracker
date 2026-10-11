import { useEffect, useRef } from "react";
import { useGameStore } from "../stores/gameStore";
import { useChatStore } from "../stores/chatStore";
import { diffUnread, type UnreadBaseline } from "../lib/messageAlert";
import { playMessageSound } from "../lib/messageSound";

const POLL_MS = 2000;

export function useIncomingMessageAlert() {
  const status = useGameStore((s) => s.status);
  const phase = useGameStore((s) => s.gameState.state);
  const isOpen = useChatStore((s) => s.isOpen);
  const baselineRef = useRef<UnreadBaseline | null>(null);

  const watching =
    (status === "CONNECTED" || status === "PAUSED") &&
    phase !== "pregame" &&
    phase !== "ingame" &&
    !isOpen;

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
