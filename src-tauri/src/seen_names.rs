//! Compact Riot-ID memory: `puuid → name`, plus how many finished matches
//! included that player.
//!
//! Fed from completed last-match recaps and live name-service hits. When Riot
//! hides an identity the roster can still show the last seen name.
//!
//! On disk (v2) each player is a short array, not an object, so a larger cap
//! stays smaller than the old map. Zero counts omit the last field. Players
//! you have actually met are evicted last.

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_VERSION: u32 = 2;
/// Unique players kept. A few years of matches fit. Counted players outlive
/// name-only rows when the cap is hit.
const MAX_ENTRIES: usize = 80_000;

static STORE: OnceCell<Mutex<Inner>> = OnceCell::new();

#[derive(Debug, Clone)]
struct Row {
    n: String,
    t: u32,
    c: u32,
}

#[derive(Debug, Deserialize)]
struct LegacyRow {
    n: String,
    #[serde(default)]
    t: u32,
    #[serde(default)]
    c: u32,
}

struct Inner {
    path: PathBuf,
    names: HashMap<String, Row>,
}

struct Loaded {
    names: HashMap<String, Row>,
    version: u32,
}

pub fn init(data_dir: &Path) {
    let path = data_dir.join("seen_names.json");
    let loaded = load(&path);
    tracing::info!(
        "[SeenNames] loaded {} identit{}",
        loaded.names.len(),
        if loaded.names.len() == 1 { "y" } else { "ies" }
    );
    if loaded.version != FILE_VERSION && !loaded.names.is_empty() {
        save(&path, &loaded.names);
    }
    let _ = STORE.set(Mutex::new(Inner {
        path,
        names: loaded.names,
    }));
}

fn puuid_key(puuid: &str) -> String {
    puuid.trim().to_ascii_lowercase()
}

/// Store real Riot IDs. A new `Name#Tag` replaces the saved one.
/// Agent fallbacks and empty names are ignored. Disk is written only when a
/// name string changes, so a 1s poll of the same ids does not rewrite the file.
pub fn remember<'a, I>(pairs: I)
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    write_names(pairs, true);
}

/// Insert a Riot ID only when this puuid is not stored yet.
/// A different name already on file is left alone. A count-only row with a
/// blank name is filled.
pub fn remember_if_absent<'a, I>(pairs: I)
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    write_names(pairs, false);
}

fn write_names<'a, I>(pairs: I, replace: bool)
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let Some(cell) = STORE.get() else { return };
    let mut inner = cell.lock();
    let now = now_secs();
    if apply_names(&mut inner.names, pairs, replace, now) {
        evict_if_needed(&mut inner.names, MAX_ENTRIES);
        save(&inner.path, &inner.names);
    }
}

/// One finished match. Each puuid is counted once. Self is the caller's job
/// to leave out. A player with no stored name still gets a count.
pub fn note_encounters<'a, I>(puuids: I)
where
    I: IntoIterator<Item = &'a str>,
{
    let Some(cell) = STORE.get() else { return };
    let mut inner = cell.lock();
    let now = now_secs();
    if bump_encounters(&mut inner.names, puuids, now) {
        evict_if_needed(&mut inner.names, MAX_ENTRIES);
        save(&inner.path, &inner.names);
    }
}

pub fn encounter_count(puuid: &str) -> u32 {
    let Some(cell) = STORE.get() else { return 0 };
    let inner = cell.lock();
    let key = puuid_key(puuid);
    inner.names.get(&key).map(|r| r.c).unwrap_or(0)
}

fn apply_names<'a, I>(names: &mut HashMap<String, Row>, pairs: I, replace: bool, now: u32) -> bool
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut changed = false;
    for (puuid, name) in pairs {
        let key = puuid_key(puuid);
        if key.is_empty() {
            continue;
        }
        let Some(clean) = sanitize_riot_id(name) else {
            continue;
        };
        match names.get_mut(&key) {
            Some(row) if row.n == clean => {}
            Some(row) if !replace && !row.n.is_empty() => {}
            Some(row) => {
                row.n = clean;
                row.t = now;
                changed = true;
            }
            None => {
                names.insert(
                    key,
                    Row {
                        n: clean,
                        t: now,
                        c: 0,
                    },
                );
                changed = true;
            }
        }
    }
    changed
}

fn bump_encounters<'a, I>(names: &mut HashMap<String, Row>, puuids: I, now: u32) -> bool
where
    I: IntoIterator<Item = &'a str>,
{
    let mut changed = false;
    let mut seen = HashSet::new();
    for puuid in puuids {
        let key = puuid_key(puuid);
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        match names.get_mut(&key) {
            Some(row) => {
                row.c = row.c.saturating_add(1);
                row.t = now;
            }
            None => {
                names.insert(
                    key,
                    Row {
                        n: String::new(),
                        t: now,
                        c: 1,
                    },
                );
            }
        }
        changed = true;
    }
    changed
}

pub fn lookup(puuid: &str) -> Option<String> {
    let inner = STORE.get()?.lock();
    let key = puuid_key(puuid);
    inner
        .names
        .get(&key)
        .filter(|r| !r.n.is_empty())
        .map(|r| r.n.clone())
}

pub fn is_riot_id(name: &str) -> bool {
    sanitize_riot_id(name).is_some()
}

/// Live roster: visible name-service result wins; otherwise a recalled Riot ID
/// (`from_history = true`); otherwise the capitalized agent name.
pub fn resolve_hidden(puuid: &str, live_name: &str, agent: &str) -> (String, bool) {
    let live = live_name.trim();
    if !live.is_empty() {
        return (live.to_string(), false);
    }
    if let Some(seen) = lookup(puuid) {
        return (seen, true);
    }
    let agent = agent.trim();
    if agent.is_empty() {
        return (String::new(), false);
    }
    (capitalize_first(agent), false)
}

fn sanitize_riot_id(name: &str) -> Option<String> {
    let name = name.trim();
    let (game, tag) = name.rsplit_once('#')?;
    let game = game.trim();
    let tag = tag.trim();
    if game.is_empty() || tag.is_empty() {
        return None;
    }
    if game.len() > 32 || !(2..=8).contains(&tag.len()) {
        return None;
    }
    Some(format!("{game}#{tag}"))
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first
            .to_uppercase()
            .chain(chars.flat_map(|c| c.to_lowercase()))
            .collect(),
    }
}

fn now_secs() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as u32)
        .unwrap_or(0)
}

/// Drop name-only rows first (oldest), then the lowest counts.
fn evict_if_needed(names: &mut HashMap<String, Row>, max: usize) {
    if names.len() <= max {
        return;
    }
    let mut rows: Vec<(String, u32, u32)> = names
        .iter()
        .map(|(k, v)| (k.clone(), v.c, v.t))
        .collect();
    rows.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)).then(a.0.cmp(&b.0)));
    let drop_n = names.len() - max;
    for (k, _, _) in rows.into_iter().take(drop_n) {
        names.remove(&k);
    }
}

fn load(path: &Path) -> Loaded {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Loaded {
            names: HashMap::new(),
            version: FILE_VERSION,
        };
    };
    decode(&raw).unwrap_or(Loaded {
        names: HashMap::new(),
        version: 0,
    })
}

fn decode(raw: &str) -> Option<Loaded> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let version = value.get("v").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let n = value.get("n")?;
    let names = if let Some(map) = n.as_object() {
        decode_v1(map)
    } else if let Some(rows) = n.as_array() {
        decode_v2(rows)
    } else {
        HashMap::new()
    };
    Some(Loaded { names, version })
}

fn decode_v1(map: &serde_json::Map<String, Value>) -> HashMap<String, Row> {
    let mut names = HashMap::new();
    for (puuid, value) in map {
        let key = puuid_key(puuid);
        if key.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_value::<LegacyRow>(value.clone()) else {
            continue;
        };
        insert_row(
            &mut names,
            key,
            Row {
                n: row.n,
                t: row.t,
                c: row.c,
            },
        );
    }
    names
}

fn decode_v2(rows: &[Value]) -> HashMap<String, Row> {
    let mut names = HashMap::new();
    for row in rows {
        let Some(arr) = row.as_array() else { continue };
        if arr.len() < 3 {
            continue;
        }
        let Some(puuid) = arr[0].as_str() else { continue };
        let key = puuid_key(puuid);
        if key.is_empty() {
            continue;
        }
        let n = arr[1].as_str().unwrap_or("").to_string();
        let t = arr[2].as_u64().unwrap_or(0) as u32;
        let c = arr.get(3).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        insert_row(&mut names, key, Row { n, t, c });
    }
    names
}

fn insert_row(names: &mut HashMap<String, Row>, key: String, row: Row) {
    match names.get(&key) {
        Some(existing) if existing.t >= row.t => {}
        _ => {
            names.insert(key, row);
        }
    }
}

fn save(path: &Path, names: &HashMap<String, Row>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = encode(names);
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn encode(names: &HashMap<String, Row>) -> String {
    let mut keys: Vec<&String> = names.keys().collect();
    keys.sort();
    let rows: Vec<Value> = keys
        .into_iter()
        .filter_map(|k| {
            let row = names.get(k)?;
            if row.n.is_empty() && row.c == 0 {
                return None;
            }
            if row.c == 0 {
                Some(json!([k, row.n, row.t]))
            } else {
                Some(json!([k, row.n, row.t, row.c]))
            }
        })
        .collect();
    json!({ "v": FILE_VERSION, "n": rows }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_keeps_one_lowercase_key_and_ignores_empty() {
        let dir = std::env::temp_dir().join(format!(
            "seen-names-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        init(&dir);

        remember([("ABC-DEF", "Old#Tag")]);
        remember([("abc-def", "New#Tag")]);
        assert_eq!(lookup("AbC-DeF").as_deref(), Some("New#Tag"));

        remember([("abc-def", "")]);
        remember([("abc-def", "hidden")]);
        assert_eq!(lookup("abc-def").as_deref(), Some("New#Tag"));

        remember_if_absent([("abc-def", "Older#Name"), ("zzz-1", "Fresh#One")]);
        assert_eq!(lookup("abc-def").as_deref(), Some("New#Tag"));
        assert_eq!(lookup("ZZZ-1").as_deref(), Some("Fresh#One"));

        note_encounters(["abc-def", "ABC-DEF", "no-name-yet"]);
        note_encounters(["no-name-yet"]);
        assert_eq!(encounter_count("abc-def"), 1);
        assert_eq!(encounter_count("no-name-yet"), 2);
        assert_eq!(lookup("no-name-yet"), None);

        remember_if_absent([("no-name-yet", "Later#Name")]);
        assert_eq!(lookup("no-name-yet").as_deref(), Some("Later#Name"));
        assert_eq!(encounter_count("no-name-yet"), 2);
        remember([("abc-def", "Renamed#Tag")]);
        assert_eq!(encounter_count("abc-def"), 1);

        let raw = std::fs::read_to_string(dir.join("seen_names.json")).unwrap();
        assert!(!raw.contains("ABC-DEF"));
        assert!(raw.contains("abc-def"));
        assert!(raw.contains("Renamed#Tag"));
        assert!(!raw.contains("Old#Tag"));
        assert!(raw.contains("\"v\":2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v1_object_loads_and_zero_count_stays_short() {
        let raw = r#"{"v":1,"n":{"AbC":{"n":"Ada#TR1","t":10},"blank":{"n":"","t":4,"c":2}}}"#;
        let loaded = decode(raw).unwrap();
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.names.get("abc").map(|r| r.n.as_str()), Some("Ada#TR1"));
        assert_eq!(loaded.names.get("abc").map(|r| r.c), Some(0));
        assert_eq!(loaded.names.get("blank").map(|r| r.c), Some(2));

        let encoded = encode(&loaded.names);
        assert!(encoded.contains("[\"abc\",\"Ada#TR1\",10]"));
        assert!(!encoded.contains("\"c\""));
        assert!(encoded.contains("[\"blank\",\"\",4,2]"));
    }

    #[test]
    fn eviction_drops_name_only_before_counted() {
        let mut names = HashMap::new();
        names.insert(
            "old".into(),
            Row {
                n: "Old#A".into(),
                t: 1,
                c: 0,
            },
        );
        names.insert(
            "new".into(),
            Row {
                n: "New#B".into(),
                t: 50,
                c: 0,
            },
        );
        names.insert(
            "met".into(),
            Row {
                n: "Met#C".into(),
                t: 1,
                c: 4,
            },
        );
        evict_if_needed(&mut names, 2);
        assert!(!names.contains_key("old"));
        assert!(names.contains_key("new"));
        assert_eq!(names.get("met").map(|r| r.c), Some(4));

        evict_if_needed(&mut names, 1);
        assert_eq!(names.len(), 1);
        assert!(names.contains_key("met"));
    }
}
