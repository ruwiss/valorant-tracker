import type { Conversation } from "./types";

/** cid → last seen Riot unread_count. Null means no successful poll yet. */
export type UnreadBaseline = Record<string, number>;

function isAlertable(conv: Conversation): boolean {
  if (!conv.cid || conv.muted) return false;
  const cid = conv.cid.toLowerCase();
  return !cid.includes("ares-coregame") && !cid.includes("ares-pregame") && !cid.includes("ares-parties");
}

/**
 * First successful snapshot is silent. Later polls sum unread increases per cid.
 * Drops and decreases update the baseline without a negative delta.
 */
export function diffUnread(
  previous: UnreadBaseline | null,
  conversations: Conversation[],
): { baseline: UnreadBaseline; delta: number } {
  const baseline: UnreadBaseline = {};
  for (const conv of conversations) {
    if (!isAlertable(conv)) continue;
    baseline[conv.cid] = conv.unread_count;
  }
  if (previous === null) {
    return { baseline, delta: 0 };
  }

  let delta = 0;
  for (const [cid, count] of Object.entries(baseline)) {
    delta += Math.max(0, count - (previous[cid] ?? 0));
  }
  return { baseline, delta };
}
