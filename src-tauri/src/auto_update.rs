//! Silent background updates.
//!
//! Flow (no clicks, no installer UI):
//!   1. On launch and every few hours, check the updater endpoint. A newer
//!      release is downloaded in the background, signature-verified by the
//!      updater plugin, and parked on disk with a `pending.json` marker.
//!   2. When the app exits normally, the parked NSIS installer is started in
//!      silent mode (`/S /UPDATE`, no `/R`) so the next launch is the new
//!      version and the app does not pop back open after the user closed it.
//!   3. If the app was killed before it could install (shutdown, crash), the
//!      next launch installs before any window is created and the installer
//!      relaunches the app (`/R`).
//!
//! We run the installer ourselves instead of `Update::install`: the plugin
//! always passes `/R` and needs a fresh network `check()` to get an `Update`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Re-check interval for sessions that stay open (tray) for days.
const RECHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
/// First check waits a little so startup work (connect, assets) goes first.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);

const MARKER_FILE: &str = "pending.json";

/// Set once an installer has been launched so exit paths don't start a second one.
static INSTALLER_LAUNCHED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct PendingUpdate {
    version: String,
    file: String,
}

/// `%LOCALAPPDATA%\<identifier>\updates` — same root Tauri uses for
/// `app_local_data_dir`, resolved without an `App` so the pre-launch check
/// can run before any window exists.
///
/// Dev builds share the identifier with the installed release, so they get
/// no directory: `pnpm tauri dev` never downloads or installs a release.
fn updates_dir(identifier: &str) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join(identifier).join("updates"))
}

fn read_marker(dir: &Path) -> Option<PendingUpdate> {
    let raw = std::fs::read_to_string(dir.join(MARKER_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn is_newer(candidate: &str, current: &semver::Version) -> bool {
    semver::Version::parse(candidate.trim_start_matches('v'))
        .map(|v| v > *current)
        .unwrap_or(false)
}

/// The parked installer, if it is for a version newer than the running one.
fn ready_installer(dir: &Path, current: &semver::Version) -> Option<(PendingUpdate, PathBuf)> {
    let marker = read_marker(dir)?;
    if !is_newer(&marker.version, current) {
        return None;
    }
    let path = dir.join(&marker.file);
    path.is_file().then_some((marker, path))
}

/// Start the NSIS installer detached from this process.
fn spawn_installer(path: &Path, relaunch: bool) -> bool {
    if INSTALLER_LAUNCHED.swap(true, Ordering::SeqCst) {
        return true;
    }
    let mut args = vec!["/S", "/UPDATE"];
    if relaunch {
        args.push("/R");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        // Breakaway keeps the installer alive if a launcher put us in a
        // kill-on-close job; it is refused when the job forbids it.
        let spawned = std::process::Command::new(path)
            .args(&args)
            .creation_flags(base | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .or_else(|_| {
                std::process::Command::new(path)
                    .args(&args)
                    .creation_flags(base)
                    .spawn()
            });
        match spawned {
            Ok(_) => true,
            Err(e) => {
                tracing::error!("[Updater] Failed to start installer: {e}");
                INSTALLER_LAUNCHED.store(false, Ordering::SeqCst);
                false
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (path, args);
        INSTALLER_LAUNCHED.store(false, Ordering::SeqCst);
        false
    }
}

/// Called before the Tauri app is built. Installs an update the previous
/// session downloaded but never got to apply. Returns true when the caller
/// should exit right away (the installer relaunches the new version).
pub fn install_pending_before_launch(identifier: &str, current: &semver::Version) -> bool {
    let Some(dir) = updates_dir(identifier) else {
        return false;
    };
    match ready_installer(&dir, current) {
        Some((_, path)) => {
            // Drop the marker first: if this install fails we get one attempt
            // per launch, not a relaunch loop. The background check re-downloads.
            let _ = std::fs::remove_file(dir.join(MARKER_FILE));
            spawn_installer(&path, true)
        }
        None => {
            // Already applied, stale, or half-written — clear leftovers.
            let _ = std::fs::remove_dir_all(&dir);
            false
        }
    }
}

/// Exit hook: install the parked update silently, leaving the app closed.
pub fn install_on_exit(app: &AppHandle) {
    let current = &app.package_info().version;
    let Some(dir) = updates_dir(&app.config().identifier) else {
        return;
    };
    if let Some((marker, path)) = ready_installer(&dir, current) {
        tracing::info!("[Updater] Installing {} on exit", marker.version);
        spawn_installer(&path, false);
    }
}

/// Version of a downloaded update waiting to be installed, if any.
pub fn ready_version(app: &AppHandle) -> Option<String> {
    let dir = updates_dir(&app.config().identifier)?;
    ready_installer(&dir, &app.package_info().version).map(|(m, _)| m.version)
}

/// Install now and relaunch (optional "restart to update" button).
pub fn restart_and_install(app: &AppHandle) -> Result<(), String> {
    let dir = updates_dir(&app.config().identifier).ok_or("No updates directory")?;
    let (_, path) = ready_installer(&dir, &app.package_info().version)
        .ok_or("No downloaded update")?;
    if !spawn_installer(&path, true) {
        return Err("Failed to start installer".into());
    }
    app.exit(0);
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// One check + background download. Returns the version now ready, if any.
async fn check_and_download(app: &AppHandle) -> Result<Option<String>, String> {
    let dir = updates_dir(&app.config().identifier).ok_or("No updates directory")?;
    let current = app.package_info().version.clone();

    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Ok(None);
    };

    if let Some((marker, _)) = ready_installer(&dir, &current) {
        if marker.version == update.version {
            return Ok(Some(marker.version));
        }
    }

    tracing::info!("[Updater] Downloading {} in background", update.version);
    // `download` verifies the minisign signature before returning the bytes.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // Replace any older parked installer.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = format!("update-{}-setup.exe", update.version);
    write_atomic(&dir.join(&file), &bytes).map_err(|e| e.to_string())?;
    let marker = serde_json::to_vec(&PendingUpdate {
        version: update.version.clone(),
        file,
    })
    .map_err(|e| e.to_string())?;
    // Marker last: it only exists once the installer is fully on disk.
    write_atomic(&dir.join(MARKER_FILE), &marker).map_err(|e| e.to_string())?;

    tracing::info!("[Updater] {} ready; installs on next restart", update.version);
    Ok(Some(update.version))
}

/// Background loop: check on launch, then periodically.
pub fn start(app: AppHandle) {
    if updates_dir(&app.config().identifier).is_none() {
        tracing::info!("[Updater] Auto-update disabled (dev build)");
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            match check_and_download(&app).await {
                Ok(Some(version)) => {
                    let _ = app.emit("update_ready", &version);
                }
                Ok(None) => tracing::debug!("[Updater] Up to date"),
                Err(e) => tracing::warn!("[Updater] Update check failed: {e}"),
            }
            tokio::time::sleep(RECHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn newer_version_comparison() {
        let cur = semver::Version::parse("1.9.4").unwrap();
        assert!(is_newer("1.9.5", &cur));
        assert!(is_newer("v1.10.0", &cur));
        assert!(!is_newer("1.9.4", &cur));
        assert!(!is_newer("1.9.3", &cur));
        assert!(!is_newer("garbage", &cur));
    }
}
