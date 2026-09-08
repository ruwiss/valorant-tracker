//! Outgoing chat text transforms shared by the Riot chat API path and the
//! in-game keyboard expander.
//!
//! Shortcuts:
//! - whole message `sa` → `Selamun Aleyküm`
//! - whole message `as` → `Aleyküm Selam`
//! - symbol emoticons (`<3`, `:)` , `->`, …) → Unicode text chars (not emoji)
//! - agent tags: `<sage` (ally) / `>jett` (enemy) → `@Name` (no #tag)

use crate::api::types::GameState;
use crate::constants::AGENTS;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

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
            let rest: String = chars[i + 1..].iter().collect();
            let rest_lower = rest.to_lowercase();
            if let Some((agent, matched_len_chars)) = match_agent_prefix(&rest_lower) {
                let side = if c == '<' {
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

/// If `rest_lower` starts with a known agent (word boundary, plus `kay/o`),
/// return `(agent, consumed char count)`.
fn match_agent_prefix(rest_lower: &str) -> Option<(&'static str, usize)> {
    for agent in AGENT_NAMES_BY_LEN.iter() {
        if rest_lower.starts_with(agent) {
            let after = agent.len();
            let boundary = rest_lower
                .as_bytes()
                .get(after)
                .map(|b| !b.is_ascii_alphanumeric())
                .unwrap_or(true);
            if boundary {
                return Some((*agent, agent.chars().count()));
            }
        }
    }

    // `kay/o` typed with slash / hyphen still resolves `kayo`.
    let token: String = rest_lower
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '/' || *ch == '-')
        .collect();
    if token.is_empty() {
        return None;
    }
    let compact = token.replace(['/', '-'], "");
    for agent in AGENT_NAMES_BY_LEN.iter() {
        if compact == *agent {
            return Some((*agent, token.chars().count()));
        }
    }
    None
}

/// Cheap hook-safe check: `<sage` / `>jett` style tags. Must be a real agent
/// name — a lone letter after `>` (`>D` from a TR-Q `:D`) is not a mention.
fn looks_like_agent_mention(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i + 1 < chars.len() {
        if chars[i] == '<' || chars[i] == '>' {
            let rest_lower: String = chars[i + 1..].iter().collect::<String>().to_lowercase();
            if match_agent_prefix(&rest_lower).is_some() {
                return true;
            }
        }
        i += 1;
    }
    false
}


/// Apply all outgoing shortcuts.
///
/// Order:
/// 1. User/system **equals** rules (`chat_rules`, e.g. sa → Selamun Aleyküm)
/// 2. Agent mentions (`<sage` / `>jett`)
/// 3. Contains rules (symbols + user "contains" phrases)
pub fn transform_outgoing_chat(message: &str) -> String {
    if !shortcuts_enabled() {
        return message.to_string();
    }

    let trimmed = message.trim();
    if trimmed.is_empty() {
        return message.to_string();
    }

    let mut out = crate::chat_rules::apply_equals_rules(trimmed);
    // Agent tags (`<sage` / `>jett`) — before symbol/contains so `<3` still works.
    out = apply_agent_mentions(&out);
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
    if crate::chat_rules::needs_rule_expansion(t) {
        return true;
    }
    looks_like_agent_mention(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heart_in_turkish_sentence() {
        let out = transform_outgoing_chat("günaydın <3 hoşça kal");
        assert_eq!(out, "günaydın \u{2665} hoşça kal");
    }

    #[test]
    fn heart_preserves_dotted_and_dotless_i() {
        assert_eq!(
            transform_outgoing_chat("İyi akşamlar <3 nasılsın"),
            "İyi akşamlar \u{2665} nasılsın"
        );
    }

    #[test]
    fn colon_d_emoticon_is_not_a_shortcut() {
        assert!(!needs_chat_expansion(":D"));
        assert!(!needs_chat_expansion("lol :D"));
        assert_eq!(transform_outgoing_chat(":D"), ":D");
        assert_eq!(transform_outgoing_chat("lol :D"), "lol :D");
    }

    #[test]
    fn mangled_trq_greater_d_is_not_an_agent_tag() {
        // TR-Q Shift+period is `:`; US fallback mapped it to `>`, so `:D`
        // landed in the hook buffer as `>D` and was treated as `>jett`.
        assert!(!needs_chat_expansion(">D"));
        assert!(!needs_chat_expansion("gg >D"));
        assert!(!looks_like_agent_mention(">D"));
        assert!(!looks_like_agent_mention(":)"));
        assert!(!looks_like_agent_mention(">:("));
        assert_eq!(transform_outgoing_chat(">D"), ">D");
    }

    #[test]
    fn real_agent_tags_still_count_as_expansion() {
        assert!(looks_like_agent_mention(">jett"));
        assert!(looks_like_agent_mention("<sage"));
        assert!(looks_like_agent_mention("focus >killjoy please"));
        assert!(looks_like_agent_mention(">kay/o"));
        assert!(needs_chat_expansion(">jett"));
        assert!(!looks_like_agent_mention(">j"));
        assert!(!looks_like_agent_mention("<3"));
    }

    #[test]
    fn bang_t_is_no_longer_a_shortcut() {
        assert!(!needs_chat_expansion("!t en merhaba"));
        assert_eq!(transform_outgoing_chat("!t en merhaba"), "!t en merhaba");
    }
}
