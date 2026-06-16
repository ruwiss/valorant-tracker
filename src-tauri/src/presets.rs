//! Settings preset storage. Presets hold a full Valorant settings blob (the raw
//! cloud `Ares.PlayerSettings` JSON) so they can be re-applied to any account.
//!
//! Stored as a single JSON file in the app data dir, written atomically
//! (tmp + rename). The full settings blob (~60KB/preset) lives here in the
//! backend; the frontend only ever sees lightweight `PresetMeta`.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CURRENT_FORMAT_VERSION: u32 = 1;

/// A saved settings preset, including the full raw settings blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsPreset {
    pub id: String,
    pub name: String,
    pub created_at: i64, // unix seconds
    #[serde(default)]
    pub source_puuid: String,
    #[serde(default)]
    pub auto_backup: bool,
    #[serde(default = "default_format_version")]
    pub format_version: u32,
    /// Raw `Ares.PlayerSettings` JSON (decompressed). Round-trips losslessly.
    pub data: serde_json::Value,
}

fn default_format_version() -> u32 {
    CURRENT_FORMAT_VERSION
}

/// Lightweight metadata sent to the frontend (no heavy `data`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetMeta {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub source_puuid: String,
    pub auto_backup: bool,
    /// MouseSensitivity, surfaced for the list preview. None if absent.
    pub sensitivity: Option<f64>,
}

impl SettingsPreset {
    fn meta(&self) -> PresetMeta {
        PresetMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            created_at: self.created_at,
            source_puuid: self.source_puuid.clone(),
            auto_backup: self.auto_backup,
            sensitivity: extract_sensitivity(&self.data),
        }
    }
}

/// Pull MouseSensitivity out of a raw settings blob for the list preview.
fn extract_sensitivity(data: &serde_json::Value) -> Option<f64> {
    data.get("floatSettings")?.as_array()?.iter().find_map(|s| {
        let name = s.get("settingEnum")?.as_str()?;
        if name.ends_with("::MouseSensitivity") {
            s.get("value")?.as_f64()
        } else {
            None
        }
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PresetFile {
    #[serde(default)]
    presets: Vec<SettingsPreset>,
}

/// Disk-backed preset store. Cheap to clone the Arc; all ops lock internally.
pub struct PresetStore {
    path: PathBuf,
    inner: Mutex<PresetFile>,
}

impl PresetStore {
    /// Load from disk (or start empty). A corrupt file is moved aside to `.bak`.
    pub fn load(path: PathBuf) -> Self {
        let inner = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<PresetFile>(&raw) {
                Ok(f) => f,
                Err(e) => {
                    tracing::error!("[Presets] Corrupt presets file ({}), backing up", e);
                    let _ = std::fs::rename(&path, path.with_extension("json.bak"));
                    PresetFile::default()
                }
            },
            Err(_) => PresetFile::default(),
        };
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    fn persist(&self, file: &PresetFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
        }
        let json =
            serde_json::to_string_pretty(file).map_err(|e| format!("serialize failed: {}", e))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write failed: {}", e))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("rename failed: {}", e))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<PresetMeta> {
        let mut metas: Vec<PresetMeta> = self.inner.lock().presets.iter().map(|p| p.meta()).collect();
        // Newest first.
        metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        metas
    }

    pub fn get(&self, id: &str) -> Option<SettingsPreset> {
        self.inner.lock().presets.iter().find(|p| p.id == id).cloned()
    }

    /// Add a preset and persist. Returns its metadata.
    pub fn add(&self, preset: SettingsPreset) -> Result<PresetMeta, String> {
        let meta = preset.meta();
        let mut guard = self.inner.lock();
        guard.presets.push(preset);
        self.persist(&guard)?;
        Ok(meta)
    }

    /// Rename a preset and persist. Returns the updated metadata.
    pub fn rename(&self, id: &str, name: &str) -> Result<PresetMeta, String> {
        let mut guard = self.inner.lock();
        let preset = guard
            .presets
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| "Preset not found".to_string())?;
        preset.name = name.to_string();
        let meta = preset.meta();
        self.persist(&guard)?;
        Ok(meta)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut guard = self.inner.lock();
        let before = guard.presets.len();
        guard.presets.retain(|p| p.id != id);
        if guard.presets.len() == before {
            return Err("Preset not found".to_string());
        }
        self.persist(&guard)
    }

    /// Keep only the newest `keep` auto-backup presets, deleting older ones.
    pub fn prune_auto_backups(&self, keep: usize) -> Result<(), String> {
        let mut guard = self.inner.lock();
        let mut backups: Vec<(usize, i64)> = guard
            .presets
            .iter()
            .enumerate()
            .filter(|(_, p)| p.auto_backup)
            .map(|(i, p)| (i, p.created_at))
            .collect();
        if backups.len() <= keep {
            return Ok(());
        }
        // Sort by created_at desc; drop everything past `keep`.
        backups.sort_by(|a, b| b.1.cmp(&a.1));
        let drop_ids: std::collections::HashSet<String> = backups
            .into_iter()
            .skip(keep)
            .map(|(i, _)| guard.presets[i].id.clone())
            .collect();
        guard.presets.retain(|p| !drop_ids.contains(&p.id));
        self.persist(&guard)
    }
}

/// Build a new preset with a fresh id and current timestamp.
pub fn new_preset(
    name: String,
    source_puuid: String,
    auto_backup: bool,
    data: serde_json::Value,
) -> SettingsPreset {
    SettingsPreset {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        created_at: now_unix(),
        source_puuid,
        auto_backup,
        format_version: CURRENT_FORMAT_VERSION,
        data,
    }
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Default presets file path inside the app data dir.
pub fn presets_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("presets.json")
}
