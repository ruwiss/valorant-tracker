use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::Once;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Global logger guard - must be kept alive for the duration of the app
static LOGGER_GUARD: RwLock<Option<WorkerGuard>> = RwLock::new(None);

/// Initialize the logging system
/// - Writes to `app.log` in the app's log directory
/// - Clears the log file on each app start
/// - Also outputs to stderr for development
pub fn init_logger(log_dir: PathBuf) {
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        // Ensure log directory exists
        std::fs::create_dir_all(&log_dir).ok();

        // Clear old log file
        let log_file = log_dir.join("app.log");
        if log_file.exists() {
            std::fs::remove_file(&log_file).ok();
        }

        // Create file appender
        let file_appender = tracing_appender::rolling::never(&log_dir, "app.log");
        let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

        // Store guard to keep logger alive
        *LOGGER_GUARD.write() = Some(guard);

        // Build subscriber with both file and stderr output
        let fmt_layer = fmt::layer()
            .with_target(true)
            .with_thread_ids(false)
            .with_file(false)
            .with_line_number(false)
            .with_ansi(false)
            .with_writer(non_blocking);

        let stderr_layer = fmt::layer()
            .with_target(true)
            .with_ansi(true)
            .with_writer(std::io::stderr);

        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,valorant_tracker_lib=debug"));

        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .with(stderr_layer)
            .init();

        tracing::info!("=== Valorant Tracker Started ===");
        tracing::info!("Log file: {}", log_file.display());
    });
}

/// Helper macro to log only once per unique call site
#[macro_export]
macro_rules! log_once {
    ($level:ident, $($arg:tt)*) => {{
        static LOGGED: std::sync::Once = std::sync::Once::new();
        LOGGED.call_once(|| {
            tracing::$level!($($arg)*);
        });
    }};
}
