//! Native process detection and termination for the Valorant/Riot stack.
//!
//! Replaces the old `tasklist`/`netstat` string-parsing, which was fragile
//! across machines: it depended on the `tasklist` binary being on PATH, on the
//! console code page, and on Windows display language (localized column headers
//! and the "LISTENING" word). Those differences made "is the game running?"
//! answer differently on different PCs — the root of the preset-apply
//! inconsistency between users.
//!
//! Here we go straight to the Win32 Toolhelp snapshot API, which is
//! language-independent and needs no child process, so detection and kill
//! behave identically on every Windows install.

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };

    /// Walk the process snapshot, calling `f(pid, exe_name)` for each entry.
    /// `exe_name` is the bare image name (e.g. `VALORANT-Win64-Shipping.exe`).
    fn for_each_process(mut f: impl FnMut(u32, &str)) {
        unsafe {
            let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                Ok(h) => h,
                Err(e) => {
                    tracing::warn!("[Process] snapshot failed: {}", e);
                    return;
                }
            };

            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };

            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    // szExeFile is a fixed-size [u16; 260] NUL-terminated string.
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = std::ffi::OsString::from_wide(&entry.szExeFile[..len])
                        .to_string_lossy()
                        .into_owned();
                    f(entry.th32ProcessID, &name);

                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }

            let _ = CloseHandle(snapshot);
        }
    }

    /// True if any running process matches `exe_name` (case-insensitive).
    pub fn is_running(exe_name: &str) -> bool {
        let mut found = false;
        for_each_process(|_, name| {
            if name.eq_ignore_ascii_case(exe_name) {
                found = true;
            }
        });
        found
    }

    /// Terminate every process whose image name satisfies `pred`. Returns how
    /// many were asked to terminate. Missing processes are not an error — the
    /// goal state is "not running".
    fn kill_where(pred: impl Fn(&str) -> bool) -> u32 {
        let mut pids: Vec<u32> = Vec::new();
        for_each_process(|pid, name| {
            if pred(name) {
                pids.push(pid);
            }
        });

        let mut killed = 0;
        for pid in pids {
            unsafe {
                match OpenProcess(PROCESS_TERMINATE, false, pid) {
                    Ok(handle) => {
                        if TerminateProcess(handle, 1).is_ok() {
                            killed += 1;
                        } else {
                            tracing::warn!("[Process] TerminateProcess failed for pid {}", pid);
                        }
                        let _ = CloseHandle(handle);
                    }
                    Err(e) => {
                        // Already gone, or access denied (e.g. elevated process).
                        tracing::warn!("[Process] OpenProcess failed for pid {}: {}", pid, e);
                    }
                }
            }
        }
        killed
    }

    /// Terminate every process whose image name matches `exe_name` exactly
    /// (case-insensitive).
    pub fn kill_by_name(exe_name: &str) -> u32 {
        kill_where(|name| name.eq_ignore_ascii_case(exe_name))
    }

    /// Terminate every process whose image name starts with `prefix`
    /// (case-insensitive). Used to sweep the whole Riot Client family
    /// (`RiotClientServices`, `RiotClientUx`, `RiotClientUxRender`, ...).
    pub fn kill_by_prefix(prefix: &str) -> u32 {
        let prefix_lc = prefix.to_ascii_lowercase();
        kill_where(|name| name.to_ascii_lowercase().starts_with(&prefix_lc))
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn is_running(_exe_name: &str) -> bool {
        false
    }
    pub fn kill_by_name(_exe_name: &str) -> u32 {
        0
    }
    pub fn kill_by_prefix(_prefix: &str) -> u32 {
        0
    }
}

/// The Valorant game process. While this is running the game owns the in-memory
/// settings and will overwrite the cloud on exit, so presets must not be applied.
pub const GAME_EXE: &str = "VALORANT-Win64-Shipping.exe";

/// The Riot Client service process. Holds the local auth/lockfile we need for
/// cloud writes; killing it drops our tokens (so an armed preset re-applies on
/// relaunch). NOTE: the client is actually a *family* of processes — the visible
/// window is `RiotClientUx.exe` / `RiotClientUxRender.exe`, separate from this
/// service. Killing only the service leaves those windows on screen, which is
/// why "Riot didn't close" — we sweep the whole family by prefix instead.
pub const RIOT_CLIENT_PREFIX: &str = "RiotClient";

// NOTE: We deliberately do NOT touch Vanguard (`vgc.exe` service, `vgk.sys`
// kernel driver, or even the `vgtray.exe` tray icon). Vanguard is anti-cheat:
// killing any of its pieces can be flagged as tampering, after which it refuses
// to let VALORANT launch until the user reboots. Closing the Riot Client is all
// the preset flow needs — Vanguard keeps running harmlessly in the background.

/// True if the VALORANT game process is running.
pub fn is_game_running() -> bool {
    imp::is_running(GAME_EXE)
}

/// True if the Riot Client service process is running.
#[allow(dead_code)] // Part of the process API; not all callers wired up yet.
pub fn is_riot_client_running() -> bool {
    imp::is_running("RiotClientServices.exe")
}

/// Kill the game process only (leaving the client running). Returns the number
/// of processes terminated.
#[allow(dead_code)] // Part of the process API; not all callers wired up yet.
pub fn kill_game() -> u32 {
    imp::kill_by_name(GAME_EXE)
}

/// Kill the Riot stack for a clean relaunch: the game first (so the client
/// doesn't immediately relaunch it), then the entire Riot Client process family
/// (service + UX windows + helpers, by prefix). Vanguard is intentionally left
/// alone — see the note above. Returns the number of processes terminated.
pub fn kill_riot_stack() -> u32 {
    let mut total = imp::kill_by_name(GAME_EXE);
    total += imp::kill_by_prefix(RIOT_CLIENT_PREFIX);
    total
}
