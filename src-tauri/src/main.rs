// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    match valorant_tracker_lib::run() {
        valorant_tracker_lib::RunResult::Completed => {}
        valorant_tracker_lib::RunResult::AlreadyRunning => {
            // Another instance is already running, exit silently
            // The existing instance has been signaled to show its overlay
        }
    }
}
