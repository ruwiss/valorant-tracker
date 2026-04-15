mod api;
mod commands;
mod constants;
mod logger;
mod single_instance;
mod state;

use single_instance::{SingleInstanceGuard, SingleInstanceResult};
use state::AppState;
use std::sync::Arc;
use tauri::Manager;

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
            commands::initialize,
            commands::get_game_state,
            commands::set_auto_lock,
            commands::get_auto_lock,
            commands::set_map_preferences,
            commands::get_player_loadout,
            commands::get_chat_messages,
            commands::get_active_conversations,
            commands::send_message,
            commands::get_paginated_chat_messages,
            commands::get_friends,
            commands::get_dm_cid,
            commands::get_cached_image,
            commands::get_tracker_stats,
            commands::get_peak_rank,
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
        ])
        .setup(move |app| {
            // Initialize logger first
            let log_dir = app.path().app_log_dir().expect("Failed to get log dir");
            logger::init_logger(log_dir);

            // Start the named pipe server to listen for signals from other instances
            single_instance::start_pipe_server(app.handle().clone(), shutdown_flag.clone());

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
