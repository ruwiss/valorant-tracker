//! Unique-install counter: one remote increment per machine.
//!
//! Identity lives in `install.json` under the app data dir. The first
//! successful ping hits Abacus (`/hit`); later launches only read (`/get`).
//! Failures leave `counted` false so the next launch retries.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Mutex;

const HIT_URL: &str = "https://abacus.jasoncameron.dev/hit/com-omerg-valorant-tracker/installs";
const GET_URL: &str = "https://abacus.jasoncameron.dev/get/com-omerg-valorant-tracker/installs";

static REPORT_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstallRecord {
    id: String,
    #[serde(default)]
    counted: bool,
    last_count: Option<u64>,
}

impl Default for InstallRecord {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            counted: false,
            last_count: None,
        }
    }
}

#[derive(Deserialize)]
struct CounterResponse {
    value: u64,
}

fn record_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("install.json"))
}

fn load(path: &PathBuf) -> InstallRecord {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => InstallRecord::default(),
    }
}

fn save(path: &PathBuf, rec: &InstallRecord) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(json) = serde_json::to_string_pretty(rec) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

async fn fetch_count(client: &reqwest::Client, increment: bool) -> Option<u64> {
    let url = if increment { HIT_URL } else { GET_URL };

    let resp = client
        .get(url)
        .header("User-Agent", "valorant-tracker")
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    resp.json::<CounterResponse>().await.ok().map(|c| c.value)
}

/// Load or create the local install id, increment remotely at most once,
/// and return the latest known total (cached if the network call fails).
pub async fn report(app: &tauri::AppHandle, client: &reqwest::Client) -> Option<u64> {
    let _guard = REPORT_LOCK.lock().await;
    let path = record_path(app)?;
    let mut rec = load(&path);
    if rec.id.is_empty() {
        rec.id = uuid::Uuid::new_v4().to_string();
    }
    // Persist before the network call so a crash mid-ping retries with
    // the same record (counted stays false until /hit succeeds).
    save(&path, &rec);

    let increment = !rec.counted;
    match fetch_count(client, increment).await {
        Some(value) => {
            if increment {
                rec.counted = true;
                tracing::info!("[Usage] first-run increment, total={}", value);
            }
            rec.last_count = Some(value);
            save(&path, &rec);
            Some(value)
        }
        None => {
            tracing::warn!("[Usage] counter fetch failed; using cached {:?}", rec.last_count);
            rec.last_count
        }
    }
}
