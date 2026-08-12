//! User-editable chat shortcut rules with persistence.
//!
//! Defaults cover the classic system shortcuts (`sa`/`as`, symbol replacements).
//! Users can delete those, add their own, and choose match mode:
//! - `equals`   — whole trimmed message equals pattern (case-insensitive)
//! - `contains` — replace every occurrence in the message (case-insensitive)
//!
//! Special handlers (`!t …`, `<agent` / `>agent`) stay hard-coded in `chat_text`
//! and are not part of this list.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const FILE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    Equals,
    Contains,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRule {
    pub id: String,
    /// Text to match (e.g. `sa`, `<3`, `gg`).
    pub pattern: String,
    /// Replacement text.
    pub replacement: String,
    pub mode: MatchMode,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Shipped as a system default (still deletable by the user).
    #[serde(default)]
    pub builtin: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RulesFile {
    #[serde(default = "default_file_version")]
    version: u32,
    rules: Vec<ChatRule>,
}

fn default_file_version() -> u32 {
    FILE_VERSION
}

/// Built-in defaults. Order matters for `contains` (longer first for `</3` vs `<3`).
pub fn default_rules() -> Vec<ChatRule> {
    let mut rules = vec![
        ChatRule {
            id: "builtin-sa".into(),
            pattern: "sa".into(),
            replacement: "Selamun Aleyküm".into(),
            mode: MatchMode::Equals,
            enabled: true,
            builtin: true,
        },
        ChatRule {
            id: "builtin-as".into(),
            pattern: "as".into(),
            replacement: "Aleyküm Selam".into(),
            mode: MatchMode::Equals,
            enabled: true,
            builtin: true,
        },
    ];

    // Valorant-safe symbol shortcuts (same set as the old hard-coded list).
    let symbols: &[(&str, &str, &str)] = &[
        ("builtin-sym-broken-heart", "</3", "\u{2661}"),
        ("builtin-sym-heart", "<3", "\u{2665}"),
        ("builtin-sym-arrow-r", "->", "\u{2192}"),
        ("builtin-sym-arrow-l", "<-", "\u{2190}"),
        ("builtin-sym-ellipsis", "...", "\u{2026}"),
        ("builtin-sym-check", ":check:", "\u{2713}"),
        ("builtin-sym-yes", ":yes:", "\u{2713}"),
        ("builtin-sym-wrong", ":wrong:", "\u{2717}"),
        ("builtin-sym-x", ":x:", "\u{2717}"),
        ("builtin-sym-warn", ":warn:", "\u{26A0}"),
        ("builtin-sym-skull", ":skull:", "\u{2620}"),
        ("builtin-sym-kurukafa", ":kurukafa:", "\u{2620}"),
    ];

    for (id, pat, rep) in symbols {
        rules.push(ChatRule {
            id: (*id).into(),
            pattern: (*pat).into(),
            replacement: (*rep).into(),
            mode: MatchMode::Contains,
            enabled: true,
            builtin: true,
        });
    }

    rules
}

struct RulesState {
    path: Option<PathBuf>,
    rules: Vec<ChatRule>,
}

static STATE: Mutex<RulesState> = Mutex::new(RulesState {
    path: None,
    rules: Vec::new(),
});

/// Path used for persistence under the app data dir.
pub fn rules_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("chat_shortcuts.json")
}

/// Load rules from disk (or defaults) and remember the path for later saves.
pub fn init(path: PathBuf) {
    let rules = load_from_disk(&path).unwrap_or_else(|| {
        tracing::info!("[ChatRules] No saved file — using defaults");
        default_rules()
    });
    tracing::info!("[ChatRules] Loaded {} rule(s) from {}", rules.len(), path.display());
    let mut st = STATE.lock();
    st.path = Some(path);
    st.rules = rules;
}

fn load_from_disk(path: &Path) -> Option<Vec<ChatRule>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let file: RulesFile = serde_json::from_str(&raw).ok()?;
    if file.rules.is_empty() {
        return None;
    }
    // Basic sanitize
    let rules: Vec<ChatRule> = file
        .rules
        .into_iter()
        .filter_map(|mut r| {
            r.pattern = r.pattern.trim().to_string();
            if r.pattern.is_empty() {
                return None;
            }
            if r.id.trim().is_empty() {
                r.id = Uuid::new_v4().to_string();
            }
            // Cap lengths to keep inject/chat sane
            if r.pattern.chars().count() > 64 {
                r.pattern = r.pattern.chars().take(64).collect();
            }
            if r.replacement.chars().count() > 280 {
                r.replacement = r.replacement.chars().take(280).collect();
            }
            Some(r)
        })
        .collect();
    if rules.is_empty() {
        None
    } else {
        Some(rules)
    }
}

fn persist_locked(st: &RulesState) -> Result<(), String> {
    let Some(path) = st.path.as_ref() else {
        return Err("Chat rules path not initialized".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = RulesFile {
        version: FILE_VERSION,
        rules: st.rules.clone(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    // Atomic-ish write: tmp + rename
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Snapshot of current rules (for UI / transform).
pub fn get_rules() -> Vec<ChatRule> {
    let st = STATE.lock();
    if st.rules.is_empty() && st.path.is_none() {
        // Init never called (non-setup path) — still return defaults in-memory.
        return default_rules();
    }
    if st.rules.is_empty() {
        return default_rules();
    }
    st.rules.clone()
}

/// Replace all rules and persist.
pub fn set_rules(rules: Vec<ChatRule>) -> Result<Vec<ChatRule>, String> {
    let sanitized = sanitize_rules(rules)?;
    let mut st = STATE.lock();
    if st.rules.is_empty() && st.path.is_none() {
        // Allow in-memory use without path (tests / early call)
        st.rules = sanitized.clone();
        return Ok(sanitized);
    }
    st.rules = sanitized.clone();
    persist_locked(&st)?;
    tracing::info!("[ChatRules] Saved {} rule(s)", st.rules.len());
    Ok(sanitized)
}

/// Restore factory defaults and persist.
pub fn reset_to_defaults() -> Result<Vec<ChatRule>, String> {
    set_rules(default_rules())
}

fn sanitize_rules(rules: Vec<ChatRule>) -> Result<Vec<ChatRule>, String> {
    if rules.len() > 200 {
        return Err("Too many rules (max 200)".into());
    }
    let mut out = Vec::with_capacity(rules.len());
    for mut r in rules {
        r.pattern = r.pattern.trim().to_string();
        r.replacement = r.replacement.to_string(); // keep internal spaces
        if r.pattern.is_empty() {
            return Err("Pattern cannot be empty".into());
        }
        if r.pattern.chars().count() > 64 {
            return Err("Pattern too long (max 64)".into());
        }
        if r.replacement.chars().count() > 280 {
            return Err("Replacement too long (max 280)".into());
        }
        if r.id.trim().is_empty() {
            r.id = Uuid::new_v4().to_string();
        }
        out.push(r);
    }
    Ok(out)
}

/// Apply enabled **equals** rules: first match replaces the whole trimmed message.
pub fn apply_equals_rules(message: &str) -> String {
    let rules = get_rules();
    let trimmed = message.trim();
    let lower_full = trimmed.to_lowercase();

    for r in rules.iter().filter(|r| r.enabled && r.mode == MatchMode::Equals) {
        let pat = r.pattern.trim();
        if pat.is_empty() {
            continue;
        }
        if lower_full == pat.to_lowercase() {
            return r.replacement.clone();
        }
    }
    message.to_string()
}

/// Apply enabled **contains** rules (longest pattern first so `</3` wins over `<3`).
pub fn apply_contains_rules(message: &str) -> String {
    let rules = get_rules();
    let mut contains: Vec<ChatRule> = rules
        .into_iter()
        .filter(|r| r.enabled && r.mode == MatchMode::Contains)
        .collect();
    if contains.is_empty() {
        return message.to_string();
    }
    contains.sort_by(|a, b| {
        b.pattern
            .chars()
            .count()
            .cmp(&a.pattern.chars().count())
            .then_with(|| a.pattern.cmp(&b.pattern))
    });

    let mut out = message.to_string();
    for r in contains {
        let pat = r.pattern.as_str();
        if pat.is_empty() {
            continue;
        }
        out = replace_ci(&out, pat, &r.replacement);
    }
    out
}

/// Whether any enabled rule would change `raw` (for keyboard expander intercept).
/// Iterates the live table in place so the keyboard hook does not clone rules.
pub fn needs_rule_expansion(raw: &str) -> bool {
    let t = raw.trim();
    if t.is_empty() {
        return false;
    }
    let lower = t.to_lowercase();
    let st = STATE.lock();
    let rules: &[ChatRule] = if st.rules.is_empty() {
        // Init not called — rare. Fall back without holding the lock long.
        drop(st);
        return needs_rule_expansion_on(&default_rules(), &lower);
    } else {
        &st.rules
    };
    needs_rule_expansion_on(rules, &lower)
}

fn needs_rule_expansion_on(rules: &[ChatRule], lower: &str) -> bool {
    for r in rules.iter().filter(|r| r.enabled) {
        let pat = r.pattern.trim();
        if pat.is_empty() {
            continue;
        }
        match r.mode {
            MatchMode::Equals => {
                if lower.eq_ignore_ascii_case(pat) || lower == pat.to_lowercase() {
                    return true;
                }
            }
            MatchMode::Contains => {
                if contains_ci_lower(lower, pat) {
                    return true;
                }
            }
        }
    }
    false
}

fn contains_ci_lower(hay_lower: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let n = needle.to_lowercase();
    hay_lower.contains(&n)
}

/// Case-insensitive substring replace (all non-overlapping matches, left-to-right).
fn replace_ci(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let hay_lower = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    if !hay_lower.contains(&needle_lower) {
        return haystack.to_string();
    }

    // Work in char indices via byte offsets on the lowercased mirror (ASCII-heavy
    // patterns; for Unicode, lowercasing can change length — fall back carefully).
    // We locate on the lowercased string and map slices on the original by
    // walking both in lockstep with char boundaries when lengths match.
    if haystack.len() == hay_lower.len() && needle.len() == needle_lower.len() {
        let mut out = String::with_capacity(haystack.len());
        let mut i = 0;
        while i < hay_lower.len() {
            if hay_lower[i..].starts_with(&needle_lower) {
                out.push_str(replacement);
                i += needle_lower.len();
            } else {
                let ch = haystack[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
        return out;
    }

    // Unicode-safe fallback: scan by chars.
    let hay_chars: Vec<char> = haystack.chars().collect();
    let needle_chars: Vec<char> = needle_lower.chars().collect();
    let nlen = needle_chars.len();
    if nlen == 0 {
        return haystack.to_string();
    }
    let mut out = String::new();
    let mut i = 0;
    while i < hay_chars.len() {
        if i + nlen <= hay_chars.len() {
            let window: String = hay_chars[i..i + nlen].iter().collect::<String>().to_lowercase();
            if window.chars().eq(needle_chars.iter().copied()) {
                out.push_str(replacement);
                i += nlen;
                continue;
            }
        }
        out.push(hay_chars[i]);
        i += 1;
    }
    out
}
