//! Compact Riot-ID memory: `puuid → "Name#Tag"`.
//!
//! Fed from completed last-match recaps (and any live name-service hit that
//! already returned a real id). When Riot hides an identity the roster can
//! still show the last seen name, flagged as recalled from history.

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 2500;

static STORE: OnceCell<Mutex<Inner>> = OnceCell::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Row {
    n: String,
    #[serde(default)]
    t: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FileDto {
    #[serde(default)]
    v: u32,
    #[serde(default)]
    n: HashMap<String, Row>,
}

struct Inner {
    path: PathBuf,
    names: HashMap<String, Row>,
}

pub fn init(data_dir: &Path) {
    let path = data_dir.join("seen_names.json");
    let names = load(&path);
    tracing::info!(
        "[SeenNames] loaded {} identit{}",
        names.len(),
        if names.len() == 1 { "y" } else { "ies" }
    );
    let _ = STORE.set(Mutex::new(Inner { path, names }));
}

/// Store real Riot IDs. Agent fallbacks and empty names are ignored.
/// Unchanged entries skip the disk write.
pub fn remember<'a, I>(pairs: I)
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let Some(cell) = STORE.get() else { return };
    let mut inner = cell.lock();
    let now = now_secs();
    let mut changed = false;
    for (puuid, name) in pairs {
        if puuid.is_empty() {
            continue;
        }
        let Some(clean) = sanitize_riot_id(name) else {
            continue;
        };
        match inner.names.get(puuid) {
            Some(row) if row.n == clean => {}
            _ => {
                inner.names.insert(puuid.to_string(), Row { n: clean, t: now });
                changed = true;
            }
        }
    }
    if !changed {
        return;
    }
    evict_if_needed(&mut inner.names);
    save(&inner.path, &inner.names);
}

pub fn lookup(puuid: &str) -> Option<String> {
    let inner = STORE.get()?.lock();
    inner.names.get(puuid).map(|r| r.n.clone())
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

fn evict_if_needed(names: &mut HashMap<String, Row>) {
    if names.len() <= MAX_ENTRIES {
        return;
    }
    let mut rows: Vec<(String, u32)> = names.iter().map(|(k, v)| (k.clone(), v.t)).collect();
    rows.sort_by_key(|(_, t)| *t);
    let drop_n = names.len() - MAX_ENTRIES;
    for (k, _) in rows.into_iter().take(drop_n) {
        names.remove(&k);
    }
}

fn load(path: &Path) -> HashMap<String, Row> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str::<FileDto>(&raw)
        .ok()
        .map(|dto| dto.n)
        .unwrap_or_default()
}

fn save(path: &Path, names: &HashMap<String, Row>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let dto = FileDto {
        v: FILE_VERSION,
        n: names.clone(),
    };
    let Ok(json) = serde_json::to_string(&dto) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}
