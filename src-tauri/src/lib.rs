mod api;
#[cfg(windows)]
mod chat_expander;
mod chat_rules;
mod chat_text;
mod commands;
mod translate;
mod constants;
mod discord;
mod logger;
mod presets;
mod process;
mod single_instance;
mod state;
mod usage;
mod last_match;
mod party;

use single_instance::{SingleInstanceGuard, SingleInstanceResult};
use state::AppState;
use std::sync::Arc;
use tauri::Manager;

/// Turn off WebView2 browser chrome shortcuts (Ctrl+F find, Ctrl+P print, …).
#[cfg(windows)]
fn disable_browser_accelerator_keys(webview: &tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let controller = webview.controller();
    unsafe {
        let Ok(core) = controller.CoreWebView2() else {
            tracing::warn!("[WebView] CoreWebView2 unavailable; Ctrl+F still enabled");
            return;
        };
        let Ok(settings) = core.Settings() else {
            tracing::warn!("[WebView] Settings unavailable; Ctrl+F still enabled");
            return;
        };
        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            tracing::warn!("[WebView] Settings3 unavailable; Ctrl+F still enabled");
            return;
        };
        if let Err(e) = settings3.SetAreBrowserAcceleratorKeysEnabled(false) {
            tracing::warn!("[WebView] Failed to disable accelerator keys: {e}");
        } else {
            tracing::info!("[WebView] Browser accelerator keys disabled (Ctrl+F / Ctrl+P / …)");
        }
    }
}

/// Result of attempting to run the application
pub enum RunResult {
    /// Application ran normally and exited
    Completed,
    /// Another instance is already running
    AlreadyRunning,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> RunResult {
    // Try to acquire single-instance lock before doing anything else
    let guard = match single_instance::try_acquire_single_instance() {
        SingleInstanceResult::Primary(guard) => guard,
        SingleInstanceResult::Secondary => {
            // Another instance is already running, we've signaled it to show overlay
            // Exit silently
            return RunResult::AlreadyRunning;
        }
        SingleInstanceResult::Error(e) => {
            eprintln!("Single instance check failed: {}", e);
            // Continue anyway - better to run than to fail completely
            // Create a dummy guard (won't hold mutex)
            SingleInstanceGuard::dummy()
        }
    };

    // Get the shutdown flag before we start (guard is Send-safe now)
    let shutdown_flag = guard.shutdown_flag();

    // Keep guard alive for the duration of the app
    let _guard = Arc::new(guard);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_constants,
            commands::initialize,
            commands::get_game_state,
            commands::set_auto_lock,
            commands::get_auto_lock,
            commands::set_auto_lock_delay,
            commands::get_auto_lock_delay,
            commands::set_map_preferences,
            commands::pause_watching,
            commands::resume_watching,
            commands::reconnect,
            commands::set_discord_rpc,
            commands::get_discord_rpc,
            commands::set_chat_shortcuts,
            commands::get_chat_shortcuts,
            commands::get_chat_shortcut_rules,
            commands::save_chat_shortcut_rules,
            commands::reset_chat_shortcut_rules,
            commands::get_connection_status,
            commands::get_player_loadout,
            commands::get_chat_messages,
            commands::get_active_conversations,
            commands::send_message,
            commands::get_paginated_chat_messages,
            commands::get_friends,
            commands::get_outgoing_friend_requests,
            commands::send_friend_request,
            commands::cancel_friend_request,
            commands::get_dm_cid,
            commands::get_cached_image,
            commands::get_tracker_stats,
            commands::get_peak_rank,
            commands::get_frequent_teammates,
            commands::get_storefront,
            commands::get_wallet,
            commands::get_player_settings,
            commands::capture_player_settings,
            commands::list_presets,
            commands::delete_preset,
            commands::apply_preset,
            commands::rename_preset,
            commands::duplicate_preset,
            commands::arm_preset,
            commands::close_riot_and_arm_preset,
            commands::disarm_preset,
            commands::get_armed_preset,
            commands::get_game_running,
            commands::get_preset_crosshairs,
            // License commands
            commands::get_machine_id,
            commands::get_license_request_data,
            commands::get_activation_code,
            commands::check_license,
            commands::import_license,
            commands::get_license_info,
            commands::reset_license,
            commands::minimize_window,
            commands::close_window,
            commands::set_always_on_top,
            commands::focus_window,
            commands::open_log_file,
            commands::log_frontend_message,
            commands::translate_text,
            commands::get_install_count,
            last_match::get_last_match,
        ])
        .setup(move |app| {
            // Initialize logger first
            let log_dir = app.path().app_log_dir().expect("Failed to get log dir");
            logger::init_logger(log_dir);

            // Initialize the settings-preset store from the app data dir.
            if let Ok(data_dir) = app.path().app_data_dir() {
                let store = presets::PresetStore::load(presets::presets_path(&data_dir));
                *app.state::<AppState>().presets.write() = Some(Arc::new(store));
                // Editable chat shortcuts (sa/as/symbols + user rules)
                chat_rules::init(chat_rules::rules_path(&data_dir));
            } else {
                tracing::error!("[Presets] Could not resolve app_data_dir; presets disabled");
                // Still seed in-memory defaults so shortcuts work without persistence.
                chat_rules::init(std::env::temp_dir().join("valorant-tracker-chat_shortcuts.json"));
            }

            // One-time unique-install ping (does not block startup).
            {
                let handle = app.handle().clone();
                let client = app.state::<AppState>().http_client.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::usage::report(&handle, &client).await;
                });
            }

            // Start the named pipe server to listen for signals from other instances
            single_instance::start_pipe_server(app.handle().clone(), shutdown_flag.clone());

            // Start the connection supervisor: it owns the whole connection
            // lifecycle (connect, watch, self-reconnect, autolock) and emits
            // `connection_changed` / `game_state_changed` events to the frontend.
            commands::start_supervisor(app.handle().clone());

            // WebView2 treats Ctrl+F / Ctrl+P / F3 as browser chrome. The
            // tauri.conf `browserAcceleratorKeys` field isn't in 2.8/2.9
            // schema, so flip the setting on the live controller instead.
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    disable_browser_accelerator_keys(&webview);
                });
            }

            // In-game chat shortcuts (sa / as / <3) — native game chat box only
            // works via keyboard expansion; the HTTP API never sees those keys.
            #[cfg(windows)]
            chat_expander::start();

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    RunResult::Completed
}
