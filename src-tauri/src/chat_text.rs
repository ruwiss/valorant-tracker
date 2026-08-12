//! Outgoing chat text transforms shared by the Riot chat API path and the
//! in-game keyboard expander.
//!
//! Shortcuts:
//! - whole message `sa` → `Selamun Aleyküm`
//! - whole message `as` → `Aleyküm Selam`
//! - symbol emoticons (`<3`, `:)` , `->`, …) → Unicode text chars (not emoji)
//! - agent tags: `<sage` (ally) / `>jett` (enemy) → `@Name` (no #tag)
//! - `!t <lang> <text>` → Google Translate (auto source → lang)

use crate::api::types::GameState;
use crate::constants::AGENTS;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

pub use crate::translate::{google_translate, google_translate_detailed};

/// Master switch for outgoing chat shortcuts, driven by the Settings toggle.
/// Shared by the in-game keyboard expander and the overlay's own send path so
/// one setting governs both.
static SHORTCUTS_ENABLED: AtomicBool = AtomicBool::new(true);

/// Enable/disable every outgoing shortcut transform.
pub fn set_shortcuts_enabled(on: bool) {
    SHORTCUTS_ENABLED.store(on, Ordering::Relaxed);
    tracing::info!(
        "[ChatText] Shortcuts {}",
        if on { "enabled" } else { "disabled" }
    );
}

/// Whether outgoing shortcut transforms are currently active.
pub fn shortcuts_enabled() -> bool {
    SHORTCUTS_ENABLED.load(Ordering::Relaxed)
}

/// Live roster for agent → player mention resolution.
#[derive(Clone, Default, PartialEq, Eq)]
struct RosterSnapshot {
    /// (agent lowercase, display name without #tag)
    allies: Vec<(String, String)>,
    enemies: Vec<(String, String)>,
}

static ROSTER: Mutex<RosterSnapshot> = Mutex::new(RosterSnapshot {
    allies: Vec::new(),
    enemies: Vec::new(),
});

/// Agent names longest-first so future multi-word aliases stay safe.
static AGENT_NAMES_BY_LEN: Lazy<Vec<&'static str>> = Lazy::new(|| {
    let mut names: Vec<&'static str> = AGENTS.keys().copied().collect();
    names.sort_by(|a, b| b.len().cmp(&a.len()));
    names
});

/// Refresh agent→player map from the latest pregame/ingame snapshot.
pub fn update_roster_from_game(gs: &GameState) {
    let strip = |name: &str| -> String {
        let base = name.split('#').next().unwrap_or(name).trim();
        if base.is_empty() {
            name.trim().to_string()
        } else {
            base.to_string()
        }
    };
    let map_side = |players: &[crate::api::types::PlayerData]| -> Vec<(String, String)> {
        players
            .iter()
            .filter_map(|p| {
                let agent = p.agent.trim().to_lowercase();
                if agent.is_empty() {
                    return None;
                }
                // Normalize kay/o style leftovers if any.
                let agent = agent.replace(['/', ' ', '-'], "");
                let name = strip(&p.name);
                if name.is_empty() {
                    return None;
                }
                Some((agent, name))
            })
            .collect()
    };

    let snap = RosterSnapshot {
        allies: map_side(&gs.allies),
        enemies: map_side(&gs.enemies),
    };
    let mut roster = ROSTER.lock();
    if *roster == snap {
        return;
    }
    tracing::debug!(
        "[ChatText] Roster updated: {} allies, {} enemies",
        snap.allies.len(),
        snap.enemies.len()
    );
    *roster = snap;
}

pub fn clear_roster() {
    *ROSTER.lock() = RosterSnapshot::default();
}

/// `<sage` / `>jett` (case-insensitive agent) → `@DisplayName` when that agent
/// is on ally / enemy team in the current match.
fn apply_agent_mentions(input: &str) -> String {
    let roster = ROSTER.lock().clone();
    if roster.allies.is_empty() && roster.enemies.is_empty() {
        return input.to_string();
    }

    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if c == '<' || c == '>' {
            let ally = c == '<';
            // Remaining text after the marker, lowercased for agent match.
            let rest: String = chars[i + 1..].iter().collect();
            let rest_lower = rest.to_lowercase();
            // Normalize so `<kay/o` still matches `kayo` if user types slash.
            // We match against the raw rest_lower first; also try without / - space.
            let mut matched_agent: Option<&str> = None;
            let mut matched_len_chars = 0usize;

            for agent in AGENT_NAMES_BY_LEN.iter() {
                // Direct prefix match on lowercased rest (usual: sage, killjoy).
                if rest_lower.starts_with(agent) {
                    let after = agent.len();
                    let boundary = rest_lower
                        .as_bytes()
                        .get(after)
                        .map(|b| !b.is_ascii_alphanumeric())
                        .unwrap_or(true);
                    if boundary {
                        matched_agent = Some(*agent);
                        matched_len_chars = agent.chars().count();
                        break;
                    }
                }
            }

            // Special: kay/o typed with slash → still resolve kayo.
            if matched_agent.is_none() {
                let compact: String = rest_lower
                    .chars()
                    .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '/' || *ch == '-')
                    .collect::<String>()
                    .replace(['/', '-'], "");
                for agent in AGENT_NAMES_BY_LEN.iter() {
                    if compact == *agent
                        || compact.starts_with(agent) && compact.len() == agent.len()
                    {
                        // Consume original typed token length (with slashes).
                        let token: String = rest
                            .chars()
                            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '/' || *ch == '-')
                            .collect();
                        if token.replace(['/', '-'], "").eq_ignore_ascii_case(agent) {
                            matched_agent = Some(*agent);
                            matched_len_chars = token.chars().count();
                            break;
                        }
                    }
                }
            }

            if let Some(agent) = matched_agent {
                let side = if ally {
                    &roster.allies
                } else {
                    &roster.enemies
                };
                if let Some((_, name)) = side.iter().find(|(a, _)| a == agent) {
                    out.push('@');
                    out.push_str(name);
                    i += 1 + matched_len_chars;
                    continue;
                }
            }
        }

        out.push(c);
        i += 1;
    }

    out
}

/// Cheap hook-safe check: `<sage` / `>jett` style tags. Does not resolve the
/// roster — false positives just intercept a send and paste the same text.
fn looks_like_agent_mention(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if (bytes[i] == b'<' || bytes[i] == b'>') && bytes[i + 1].is_ascii_alphabetic() {
            return true;
        }
        i += 1;
    }
    false
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
    b.iter().all(|c| c.is_ascii_alphabetic() || *c == b'-') && b[0].is_ascii_alphabetic()
}

/// Apply all outgoing shortcuts. Safe to call from any thread (uses blocking HTTP
/// only when `!t` is present).
///
/// Order:
/// 1. `!t <lang> …` translate (always available)
/// 2. User/system **equals** + **contains** rules (`chat_rules`)
/// 3. Agent mentions (`<sage` / `>jett`)
/// 4. Contains rules again only if agent mentions changed text? — no:
///    Agent mentions run after equals, then contains so symbols still apply
///    to the remaining text. Equals already replaced the whole message.
pub fn transform_outgoing_chat(message: &str) -> String {
    if !shortcuts_enabled() {
        return message.to_string();
    }

    let trimmed = message.trim();
    if trimmed.is_empty() {
        return message.to_string();
    }

    // 1) Translate command — may hit the network.
    let mut out = if let Some((lang, text)) = parse_translate_command(trimmed) {
        match google_translate(text, lang) {
            Some(translated) => {
                tracing::info!("[ChatText] !t {} {:?} → {:?}", lang, text, translated);
                translated
            }
            None => {
                tracing::warn!("[ChatText] Translate failed; sending original text");
                text.to_string()
            }
        }
    } else {
        // 2) Equals rules (whole message, e.g. sa → Selamun Aleyküm).
        crate::chat_rules::apply_equals_rules(trimmed)
    };

    // 3) Agent tags (`<sage` / `>jett`) — before symbol/contains so `<3` still works.
    out = apply_agent_mentions(&out);

    // 4) Contains rules (symbols + user "contains" phrases).
    out = crate::chat_rules::apply_contains_rules(&out);

    out
}

/// True if sending `raw` should be intercepted and rewritten before it hits chat.
pub fn needs_chat_expansion(raw: &str) -> bool {
    if !shortcuts_enabled() {
        return false;
    }

    let t = raw.trim();
    if t.is_empty() {
        return false;
    }
    if parse_translate_command(t).is_some() {
        return true;
    }
    if crate::chat_rules::needs_rule_expansion(t) {
        return true;
    }
    looks_like_agent_mention(t)
}
