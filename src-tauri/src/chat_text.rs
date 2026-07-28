//! Outgoing chat text transforms shared by the Riot chat API path and the
//! in-game keyboard expander.
//!
//! Shortcuts:
//! - whole message `sa` → `Selamun Aleyküm`
//! - whole message `as` → `Aleyküm Selam`
//! - symbol emoticons (`<3`, `:)` , `->`, …) → Unicode text chars (not emoji)
//! - `!t <lang> <text>` → Google Translate (auto source → lang)

use once_cell::sync::Lazy;
use std::time::Duration;

/// Shared blocking HTTP client for translate (hook thread + API path).
static HTTP: Lazy<reqwest::blocking::Client> = Lazy::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) ValorantTracker/1.0")
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
});

/// ASCII → Unicode text symbols. Longer keys first so `</3` wins over `<3`,
/// `:-)` over `:)`, etc. Prefer text symbols over emoji (Valorant-friendly).
const SYMBOL_REPLACEMENTS: &[(&str, &str)] = &[
    // Hearts
    ("</3", "\u{2661}"), // ♡ broken/empty heart
    ("<3", "\u{2665}"),  // ♥
    // Faces (text dingbats, not color emoji)
    (":-)", "\u{263A}"), // ☺
    (":)", "\u{263A}"),  // ☺
    (":-(", "\u{2639}"), // ☹
    (":(", "\u{2639}"),  // ☹
    (":-D", "\u{263B}"), // ☻
    (":D", "\u{263B}"),  // ☻
    (";-)", "\u{263A}"), // ☺ (wink ≈ smile; BMP-only for game inject)
    (";)", "\u{263A}"),  // ☺
    // :P left as-is — no good BMP "tongue" glyph that renders everywhere
    // Stars / sparkle
    (":star:", "\u{2605}"), // ★
    ("***", "\u{2605}"),    // ★
    // Arrows
    ("<=>", "\u{2194}"), // ↔
    ("=>", "\u{21D2}"),  // ⇒
    ("->", "\u{2192}"),  // →
    ("<-", "\u{2190}"),  // ←
    // Comparison / math
    ("+/-", "\u{00B1}"), // ±
    ("!=", "\u{2260}"),  // ≠
    ("~=", "\u{2248}"),  // ≈
    ("<=", "\u{2264}"),  // ≤
    (">=", "\u{2265}"),  // ≥
    // Typography
    ("...", "\u{2026}"), // …
    // Legal / marks (case handled separately for (c)/(r)/(tm))
    // Music / misc
    (":note:", "\u{266A}"), // ♪
    (":check:", "\u{2713}"), // ✓
    (":x:", "\u{2717}"),     // ✗
    (":warn:", "\u{26A0}"),  // ⚠
    // Skull (text)
    (":skull:", "\u{2620}"), // ☠
    // Peace / target-ish
    (":peace:", "\u{262E}"), // ☮
];

/// Apply symbol/emoticon replacements. Case-sensitive for faces (`:D` vs `:d`);
/// legal marks are case-insensitive.
fn apply_symbol_shortcuts(input: &str) -> String {
    let mut out = input.to_string();

    for (from, to) in SYMBOL_REPLACEMENTS {
        if out.contains(from) {
            out = out.replace(from, to);
        }
    }

    // Case-insensitive legal / trademark marks
    out = replace_ci(&out, "(tm)", "\u{2122}"); // ™
    out = replace_ci(&out, "(c)", "\u{00A9}");  // ©
    out = replace_ci(&out, "(r)", "\u{00AE}");  // ®

    out
}

fn replace_ci(haystack: &str, needle: &str, replacement: &str) -> String {
    let lower_h = haystack.to_lowercase();
    let lower_n = needle.to_lowercase();
    if !lower_h.contains(&lower_n) {
        return haystack.to_string();
    }
    let mut result = String::with_capacity(haystack.len());
    let h_bytes = haystack.as_bytes();
    let n_len = needle.len();
    let mut i = 0;
    let lower_bytes = lower_h.as_bytes();
    let n_bytes = lower_n.as_bytes();
    while i < h_bytes.len() {
        if i + n_len <= lower_bytes.len() && &lower_bytes[i..i + n_len] == n_bytes {
            // Align to char boundary in original (needle is pure ASCII).
            result.push_str(replacement);
            i += n_len;
        } else {
            // Copy one UTF-8 char
            let ch = haystack[i..].chars().next().unwrap();
            result.push(ch);
            i += ch.len_utf8();
        }
    }
    result
}

fn has_symbol_shortcut(s: &str) -> bool {
    for (from, _) in SYMBOL_REPLACEMENTS {
        if s.contains(from) {
            return true;
        }
    }
    let lower = s.to_lowercase();
    lower.contains("(tm)") || lower.contains("(c)") || lower.contains("(r)")
}

/// `!t <lang> <message>` — lang is any Google-supported code (`en`, `tr`, `de`,
/// `zh-CN`, `pt-BR`, …). Message must be non-empty.
pub fn parse_translate_command(raw: &str) -> Option<(&str, &str)> {
    let t = raw.trim();
    // Case-insensitive "!t" prefix.
    let rest = if t.len() >= 2 && t.as_bytes()[..2].eq_ignore_ascii_case(b"!t") {
        &t[2..]
    } else {
        return None;
    };
    let rest = rest.trim_start();
    if rest.is_empty() {
        return None;
    }
    // Language token: letters + optional regional suffix (zh-CN, pt-BR).
    let mut parts = rest.splitn(2, char::is_whitespace);
    let lang = parts.next()?.trim();
    let text = parts.next()?.trim();
    if lang.is_empty() || text.is_empty() {
        return None;
    }
    if !is_plausible_lang_code(lang) {
        return None;
    }
    Some((lang, text))
}

fn is_plausible_lang_code(lang: &str) -> bool {
    let b = lang.as_bytes();
    if b.len() < 2 || b.len() > 12 {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_alphabetic() || *c == b'-')
        && b[0].is_ascii_alphabetic()
}

/// Translate `text` into `target_lang` (source auto-detected). Returns None on failure.
pub fn google_translate(text: &str, target_lang: &str) -> Option<String> {
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={}&dt=t&q={}",
        urlencoding::encode(target_lang),
        urlencoding::encode(text)
    );

    let resp = HTTP.get(&url).send().ok()?;
    if !resp.status().is_success() {
        tracing::warn!(
            "[ChatText] Translate HTTP {} for tl={}",
            resp.status(),
            target_lang
        );
        return None;
    }

    let body: serde_json::Value = resp.json().ok()?;
    let segments = body.get(0)?.as_array()?;
    let mut out = String::new();
    for seg in segments {
        if let Some(piece) = seg.get(0).and_then(|v| v.as_str()) {
            out.push_str(piece);
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Apply all outgoing shortcuts. Safe to call from any thread (uses blocking HTTP
/// only when `!t` is present).
pub fn transform_outgoing_chat(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return message.to_string();
    }

    // 1) Translate command — may hit the network.
    let mut out = if let Some((lang, text)) = parse_translate_command(trimmed) {
        match google_translate(text, lang) {
            Some(translated) => {
                tracing::info!(
                    "[ChatText] !t {} {:?} → {:?}",
                    lang,
                    text,
                    translated
                );
                translated
            }
            None => {
                tracing::warn!("[ChatText] Translate failed; sending original text");
                text.to_string()
            }
        }
    } else {
        let lower = trimmed.to_lowercase();
        if lower == "sa" {
            "Selamun Aleyküm".to_string()
        } else if lower == "as" {
            "Aleyküm Selam".to_string()
        } else {
            trimmed.to_string()
        }
    };

    // 2) Symbol / emoticon shortcuts anywhere in the final text.
    out = apply_symbol_shortcuts(&out);
    out
}

/// True if sending `raw` should be intercepted and rewritten before it hits chat.
pub fn needs_chat_expansion(raw: &str) -> bool {
    let t = raw.trim();
    if t.is_empty() {
        return false;
    }
    if parse_translate_command(t).is_some() {
        return true;
    }
    let lower = t.to_lowercase();
    if lower == "sa" || lower == "as" {
        return true;
    }
    has_symbol_shortcut(t)
}
