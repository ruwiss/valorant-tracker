//! Single-instance mechanism using Windows named mutex and named pipe for IPC.
//!
//! When the application starts:
//! 1. Try to acquire a named mutex
//! 2. If mutex already exists (another instance is running):
//!    - Send a message via named pipe to the existing instance
//!    - Exit silently
//! 3. If mutex acquired (first instance):
//!    - Start a named pipe server to listen for messages from other instances
//!    - When a message is received, emit an event to show the overlay

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info, warn};

const MUTEX_NAME: &str = "ValorantTrackerSingleInstanceMutex_v1";
const PIPE_NAME: &str = r"\\.\pipe\ValorantTrackerPipe_v1";

/// Guard that manages the single-instance mutex.
pub struct SingleInstanceGuard {
    shutdown_flag: Arc<AtomicBool>,
    #[cfg(windows)]
    mutex_handle_raw: usize, // Store as raw usize to be Send-safe
}

// SAFETY: We're storing the HANDLE as a raw usize and only accessing it from the main thread
// The handle will be released when the guard is dropped
unsafe impl Send for SingleInstanceGuard {}
unsafe impl Sync for SingleInstanceGuard {}

impl SingleInstanceGuard {
    /// Create a new guard with the given shutdown flag and mutex handle
    #[cfg(windows)]
    pub fn new(shutdown_flag: Arc<AtomicBool>, mutex_handle_raw: usize) -> Self {
        Self {
            shutdown_flag,
            mutex_handle_raw,
        }
    }

    #[cfg(not(windows))]
    pub fn new(shutdown_flag: Arc<AtomicBool>) -> Self {
        Self { shutdown_flag }
    }

    /// Create a dummy guard that doesn't hold any mutex
    /// Used when single-instance check fails but we want to continue anyway
    pub fn dummy() -> Self {
        #[cfg(windows)]
        {
            Self {
                shutdown_flag: Arc::new(AtomicBool::new(false)),
                mutex_handle_raw: 0,
            }
        }
        #[cfg(not(windows))]
        {
            Self {
                shutdown_flag: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    /// Get a clone of the shutdown flag
    pub fn shutdown_flag(&self) -> Arc<AtomicBool> {
        self.shutdown_flag.clone()
    }
}

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::Threading::ReleaseMutex;

        self.shutdown_flag.store(true, Ordering::SeqCst);

        if self.mutex_handle_raw != 0 {
            unsafe {
                let handle = HANDLE(self.mutex_handle_raw as *mut std::ffi::c_void);
                let _ = ReleaseMutex(handle);
                let _ = CloseHandle(handle);
            }
            info!("Single instance mutex released and closed");
        }
    }
}

#[cfg(not(windows))]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        self.shutdown_flag.store(true, Ordering::SeqCst);
        info!("Single instance guard dropped");
    }
}

/// Result of trying to acquire single instance lock
pub enum SingleInstanceResult {
    /// This is the first/primary instance
    Primary(SingleInstanceGuard),
    /// Another instance is already running, signal was sent
    Secondary,
    /// Failed to determine instance status
    Error(String),
}

#[cfg(windows)]
fn encode_wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
pub fn try_acquire_single_instance() -> SingleInstanceResult {
    use std::ptr;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    let mutex_name_wide = encode_wide(MUTEX_NAME);

    unsafe {
        // Try to create the mutex
        let handle = CreateMutexW(
            Some(ptr::null()),
            true, // Initial owner
            PCWSTR::from_raw(mutex_name_wide.as_ptr()),
        );

        match handle {
            Ok(h) => {
                let last_error = GetLastError();

                if last_error == ERROR_ALREADY_EXISTS {
                    // Another instance already has the mutex
                    info!("Another instance is already running, signaling it to show overlay");
                    let _ = CloseHandle(h);

                    // Signal the existing instance
                    if let Err(e) = signal_existing_instance() {
                        warn!("Failed to signal existing instance: {}", e);
                    }

                    SingleInstanceResult::Secondary
                } else {
                    // We are the first instance
                    info!("Acquired single instance mutex, this is the primary instance");

                    // Store handle as raw usize for Send-safety
                    let handle_raw = h.0 as usize;
                    let shutdown_flag = Arc::new(AtomicBool::new(false));

                    SingleInstanceResult::Primary(SingleInstanceGuard::new(
                        shutdown_flag,
                        handle_raw,
                    ))
                }
            }
            Err(e) => {
                error!("Failed to create mutex: {}", e);
                SingleInstanceResult::Error(format!("Failed to create mutex: {}", e))
            }
        }
    }
}

#[cfg(not(windows))]
pub fn try_acquire_single_instance() -> SingleInstanceResult {
    // On non-Windows platforms, just allow running (no single-instance enforcement)
    SingleInstanceResult::Primary(SingleInstanceGuard::dummy())
}

#[cfg(windows)]
fn signal_existing_instance() -> Result<(), String> {
    // Try to connect to the named pipe
    let mut attempts = 0;
    const MAX_ATTEMPTS: u32 = 3;

    while attempts < MAX_ATTEMPTS {
        match std::fs::OpenOptions::new().write(true).open(PIPE_NAME) {
            Ok(mut pipe) => {
                // Send a simple message to show overlay
                let message = b"SHOW_OVERLAY";
                if let Err(e) = pipe.write_all(message) {
                    warn!("Failed to write to pipe: {}", e);
                    attempts += 1;
                    thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
                info!("Successfully signaled existing instance to show overlay");
                return Ok(());
            }
            Err(e) => {
                debug!(
                    "Failed to connect to pipe (attempt {}): {}",
                    attempts + 1,
                    e
                );
                attempts += 1;
                thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }

    Err(format!(
        "Failed to connect to existing instance after {} attempts",
        MAX_ATTEMPTS
    ))
}

#[cfg(not(windows))]
fn signal_existing_instance() -> Result<(), String> {
    Ok(())
}

/// Start the named pipe server to listen for signals from other instances
#[cfg(windows)]
pub fn start_pipe_server(app_handle: AppHandle, shutdown_flag: Arc<AtomicBool>) {
    use std::ptr;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{ReadFile, PIPE_ACCESS_INBOUND};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let pipe_name_wide = encode_wide(PIPE_NAME);

    thread::spawn(move || {
        info!("Starting named pipe server for single-instance IPC");

        while !shutdown_flag.load(Ordering::SeqCst) {
            // Create the named pipe
            let pipe_handle = unsafe {
                CreateNamedPipeW(
                    PCWSTR::from_raw(pipe_name_wide.as_ptr()),
                    PIPE_ACCESS_INBOUND,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    PIPE_UNLIMITED_INSTANCES,
                    512, // Out buffer size
                    512, // In buffer size
                    0,   // Default timeout
                    Some(ptr::null()),
                )
            };

            if pipe_handle == INVALID_HANDLE_VALUE {
                error!("Failed to create named pipe");
                thread::sleep(std::time::Duration::from_secs(1));
                continue;
            }

            debug!("Named pipe created, waiting for client connection...");

            // Wait for a client to connect
            let _connected = unsafe { ConnectNamedPipe(pipe_handle, Some(ptr::null_mut())) };

            if shutdown_flag.load(Ordering::SeqCst) {
                unsafe {
                    let _ = CloseHandle(pipe_handle);
                }
                break;
            }

            // Read the message
            let mut buffer = [0u8; 512];
            let mut bytes_read: u32 = 0;

            let read_success = unsafe {
                ReadFile(
                    pipe_handle,
                    Some(&mut buffer),
                    Some(&mut bytes_read),
                    Some(ptr::null_mut()),
                )
            };

            if read_success.is_ok() && bytes_read > 0 {
                let message = String::from_utf8_lossy(&buffer[..bytes_read as usize]);
                info!("Received IPC message: {}", message);

                if message.trim() == "SHOW_OVERLAY" {
                    // Emit event to frontend to show the overlay
                    if let Err(e) = app_handle.emit("show-overlay", ()) {
                        error!("Failed to emit show-overlay event: {}", e);
                    } else {
                        info!("Emitted show-overlay event to frontend");
                    }
                }
            }

            // Disconnect and close the pipe
            unsafe {
                let _ = DisconnectNamedPipe(pipe_handle);
                let _ = CloseHandle(pipe_handle);
            }
        }

        info!("Named pipe server stopped");
    });
}

#[cfg(not(windows))]
pub fn start_pipe_server(_app_handle: AppHandle, _shutdown_flag: Arc<AtomicBool>) {
    // No-op on non-Windows platforms
}
