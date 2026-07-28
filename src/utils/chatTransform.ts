/**
 * Docs mirror of backend `chat_text.rs` shortcuts.
 * Real expansion runs in Rust (API send + in-game keyboard expander).
 *
 * Greetings: sa / as
 * Translate: !t <lang> <text>
 * Agents: <sage (ally) / >jett (enemy) → @Name (no #tag)
 * Symbols: <3 </3 -> <- ... :check: :warn: :skull: / :kurukafa:
 */

const SYMBOLS: [string, string][] = [
  ["</3", "\u2661"],
  ["<3", "\u2665"],
  ["->", "\u2192"],
  ["<-", "\u2190"],
  ["...", "\u2026"],
  [":check:", "\u2713"],
  [":warn:", "\u26A0"],
  [":skull:", "\u2620"],
  [":kurukafa:", "\u2620"],
];

/** Frontend helper for previews/tests only — production path is Rust. */
export function transformOutgoingChat(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  let out = trimmed;
  const lower = out.toLocaleLowerCase("tr-TR");
  if (lower === "sa") out = "Selamun Aleyküm";
  else if (lower === "as") out = "Aleyküm Selam";

  for (const [from, to] of SYMBOLS) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}
