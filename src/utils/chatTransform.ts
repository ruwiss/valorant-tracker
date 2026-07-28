/**
 * Docs mirror of backend `chat_text.rs` shortcuts.
 * Real expansion runs in Rust (API send + in-game keyboard expander).
 *
 * Greetings: sa / as
 * Translate: !t <lang> <text>
 * Symbols: see list below
 */

const SYMBOLS: [string, string][] = [
  ["</3", "\u2661"],
  ["<3", "\u2665"],
  [":-)", "\u263A"],
  [":)", "\u263A"],
  [":-(", "\u2639"],
  [":(", "\u2639"],
  [":-D", "\u263B"],
  [":D", "\u263B"],
  [";)", "\u263A"],
  [":star:", "\u2605"],
  ["***", "\u2605"],
  ["<=>", "\u2194"],
  ["=>", "\u21D2"],
  ["->", "\u2192"],
  ["<-", "\u2190"],
  ["+/-", "\u00B1"],
  ["!=", "\u2260"],
  ["~=", "\u2248"],
  ["<=", "\u2264"],
  [">=", "\u2265"],
  ["...", "\u2026"],
  [":note:", "\u266A"],
  [":check:", "\u2713"],
  [":x:", "\u2717"],
  [":warn:", "\u26A0"],
  [":skull:", "\u2620"],
  [":peace:", "\u262E"],
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
  out = out.replace(/\(tm\)/gi, "\u2122").replace(/\(c\)/gi, "\u00A9").replace(/\(r\)/gi, "\u00AE");
  return out;
}
