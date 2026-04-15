use crate::api::types::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::RwLock;
use rquest_util::Emulation;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ApiError {
    #[error("Valorant not running")]
    NotRunning,
    #[error("Request failed: {0}")]
    RequestFailed(String),
    #[error("Parse error: {0}")]
    ParseError(String),
}

/// Lockfile data structure
#[derive(Clone, Debug)]
struct LockfileData {
    port: String,
    password: String,
    hash: String, // Simple hash of port:password for change detection
}

pub struct ValorantAPI {
    client: reqwest::Client,    // Standard client for Local Riot API (supports invalid certs)
    tracker_client: rquest::Client, // Impersonation client for Tracker.gg
    pub puuid: RwLock<String>,
    pub region: RwLock<String>,
    pub shard: RwLock<String>,
    local_port: RwLock<String>,
    local_auth: RwLock<String>,
    remote_headers: RwLock<HashMap<String, String>>,
    pub connected: RwLock<bool>,
    pub needs_reinit: RwLock<bool>, // Signal that tokens need refresh
    last_init_time: RwLock<std::time::Instant>,
    pub consecutive_network_errors: RwLock<u32>, // Track network errors for smarter disconnection
    lockfile_hash: RwLock<String>, // Track lockfile content hash to detect changes
    last_lockfile_check: RwLock<std::time::Instant>, // Rate limit lockfile checks
    last_recovery_check: RwLock<std::time::Instant>, // Rate limit recovery checks
}

impl ValorantAPI {
    pub fn new() -> Self {
        // 1. Standard client for Local API
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();

        // 2. Impersonation client for Tracker.gg (Chrome 120 - Safe fallback for v4)
        let tracker_client = rquest::Client::builder()
            .emulation(Emulation::Chrome120) // v4 supports this range reliably
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap();

        Self {
            client,
            tracker_client,
            puuid: RwLock::new(String::new()),
            region: RwLock::new(String::new()),
            shard: RwLock::new(String::new()),
            local_port: RwLock::new(String::new()),
            local_auth: RwLock::new(String::new()),
            remote_headers: RwLock::new(HashMap::new()),
            connected: RwLock::new(false),
            needs_reinit: RwLock::new(false),
            last_init_time: RwLock::new(std::time::Instant::now()),
            consecutive_network_errors: RwLock::new(0),
            lockfile_hash: RwLock::new(String::new()),
            last_lockfile_check: RwLock::new(std::time::Instant::now()),
            last_recovery_check: RwLock::new(std::time::Instant::now()),
        }
    }

    /// Read lockfile and return parsed data
    fn read_lockfile() -> Result<LockfileData, ApiError> {
        let lockfile_path = format!(
            "{}\\Riot Games\\Riot Client\\Config\\lockfile",
            std::env::var("LOCALAPPDATA").unwrap_or_default()
        );

        let lockfile_content = std::fs::read_to_string(&lockfile_path)
            .map_err(|_| ApiError::NotRunning)?;

        let parts: Vec<&str> = lockfile_content.split(':').collect();
        if parts.len() < 4 {
            return Err(ApiError::ParseError("Invalid lockfile".into()));
        }

        let port = parts[2].to_string();
        let password = parts[3].to_string();
        let hash = format!("{}:{}", port, password); // Simple hash for comparison

        Ok(LockfileData { port, password, hash })
    }

    /// Check if lockfile has changed since last read (rate limited to once per second)
    pub fn check_lockfile_changed(&self) -> bool {
        let now = std::time::Instant::now();
        let last_check = *self.last_lockfile_check.read();

        // Rate limit to once per second
        if now.duration_since(last_check) < std::time::Duration::from_secs(1) {
            return false;
        }

        *self.last_lockfile_check.write() = now;

        if let Ok(lockfile) = Self::read_lockfile() {
            let current_hash = self.lockfile_hash.read().clone();
            if !current_hash.is_empty() && lockfile.hash != current_hash {
                tracing::debug!("[LockfileMonitor] Lockfile changed! Old hash: {}, New hash: {}",
                    current_hash, lockfile.hash);
                return true;
            }
        }
        false
    }

    /// Detect actual RiotClientServices port by checking which port the process is listening on
    /// This is a fallback when lockfile might be stale
    fn detect_riot_client_port() -> Option<String> {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // First, find RiotClientServices PID
        // Use /NH to hide headers and /FO CSV for easier parsing
        let tasklist = Command::new("tasklist")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/FI", "IMAGENAME eq RiotClientServices.exe", "/FO", "CSV", "/NH"])
            .output()
            .ok()?;

        let tasklist_output = String::from_utf8_lossy(&tasklist.stdout);

        // Parse PID from tasklist output (format: "RiotClientServices.exe","PID",...)
        let pid: Option<String> = tasklist_output
            .lines()
            .next()
            .and_then(|line| {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 2 {
                    Some(parts[1].trim_matches('"').to_string())
                } else {
                    None
                }
            });

        let pid = pid?;
        tracing::debug!("[PortDetect] Found RiotClientServices PID: {}", pid);

        // Now find the port this PID is listening on (127.0.0.1)
        let netstat = Command::new("netstat")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-ano"])
            .output()
            .ok()?;

        let netstat_output = String::from_utf8_lossy(&netstat.stdout);

        // Look for LISTENING ports on 127.0.0.1 with matching PID
        for line in netstat_output.lines() {
            // Check for PID and Local Address 127.0.0.1
            // We check for "0.0.0.0:0" as Foreign Address to identify LISTENING sockets
            // This is safer than checking for word "LISTENING" which varies by system language
            if line.contains(&pid) && line.contains("127.0.0.1:") && (line.contains("LISTENING") || line.contains("0.0.0.0:0")) {
                 // Parse port from line like: "  TCP    127.0.0.1:64011        0.0.0.0:0              LISTENING       2424"
                 let parts: Vec<&str> = line.split_whitespace().collect();
                 // Column 1: Proto, Column 2: Local Address
                 if parts.len() >= 2 {
                     if let Some(port) = parts[1].split(':').last() {
                        tracing::debug!("[PortDetect] Found listening port: {}", port);
                        return Some(port.to_string());
                     }
                 }
            }
        }

        tracing::debug!("[PortDetect] Could not find listening port for PID {}", pid);
        None
    }

    /// Try to recover connection by detecting actual Riot Client port
    /// Returns true if successfully updated credentials with new port
    pub fn try_recover_connection(&self) -> bool {
        // Rate limit recovery attempts (e.g., once every 3 seconds)
        let now = std::time::Instant::now();
        let last_check = *self.last_recovery_check.read();
        if now.duration_since(last_check) < std::time::Duration::from_secs(3) {
            return false;
        }
        *self.last_recovery_check.write() = now;

        tracing::debug!("[Recovery] Attempting to detect actual Riot Client port...");

        if let Some(detected_port) = Self::detect_riot_client_port() {
            let current_port = self.local_port.read().clone();

            if detected_port != current_port {
                tracing::debug!("[Recovery] Port mismatch! Current: {}, Detected: {}", current_port, detected_port);
                tracing::debug!("[Recovery] Will re-read lockfile to get new credentials...");

                // Re-read lockfile which should have the updated port
                if let Ok(lockfile) = Self::read_lockfile() {
                    if lockfile.port == detected_port {
                        tracing::debug!("[Recovery] Lockfile has correct port, updating credentials...");
                        let auth = STANDARD.encode(format!("riot:{}", lockfile.password));
                        *self.local_port.write() = lockfile.port.clone();
                        *self.local_auth.write() = format!("Basic {}", auth);
                        *self.lockfile_hash.write() = lockfile.hash;
                        *self.needs_reinit.write() = true;
                        return true;
                    } else {
                        // Lockfile is stale. We CANNOT force update because we don't know the new password.
                        // The password in the lockfile belongs to the OLD port.
                        tracing::warn!("[Recovery] Lockfile port ({}) matches old port, waiting for lockfile update...", lockfile.port);
                    }
                }
            } else {
                tracing::debug!("[Recovery] Port is correct ({}), issue might be temporary", current_port);
            }
        }

        false
    }


    /// Check if tokens might be stale (older than 45 minutes)
    fn should_refresh_tokens(&self) -> bool {
        let last_init = *self.last_init_time.read();
        last_init.elapsed() > std::time::Duration::from_secs(45 * 60)
    }

    pub async fn initialize(&self) -> Result<ConnectionStatus, ApiError> {
        // Use the new read_lockfile helper
        let lockfile = Self::read_lockfile()?;

        let port = lockfile.port.clone();
        let password = lockfile.password.clone();
        let auth = STANDARD.encode(format!("riot:{}", password));

        *self.local_port.write() = port.clone();
        *self.local_auth.write() = format!("Basic {}", auth);
        *self.lockfile_hash.write() = lockfile.hash.clone(); // Save hash for change detection

        tracing::debug!("[Initialize] Attempting connection to Riot Client on port {}", port);

        // Get entitlements with retry logic
        let ent_url = format!("https://127.0.0.1:{}/entitlements/v1/token", port);

        let mut last_error = String::new();
        let mut ent_response_opt: Option<EntitlementsResponse> = None;

        for attempt in 1..=3 {
            tracing::debug!("[Initialize] Entitlements request attempt {}/3 to {}...", attempt, ent_url);

            match self.client
                .get(&ent_url)
                .header("Authorization", format!("Basic {}", auth))
                .send()
                .await
            {
                Ok(resp) => {
                    let status = resp.status();
                    if !status.is_success() {
                        last_error = format!("HTTP {}", status);
                        tracing::debug!("[Initialize] Request failed with status: {}", last_error);
                        if attempt < 3 {
                            tracing::debug!("[Initialize] Retrying in 4000ms...");
                            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                            continue;
                        }
                    } else {
                        match resp.json::<EntitlementsResponse>().await {
                            Ok(ent) => {
                                tracing::info!("[Initialize] Got entitlements successfully");
                                ent_response_opt = Some(ent);
                                break;
                            }
                            Err(e) => {
                                last_error = format!("JSON parse error: {}", e);
                                tracing::debug!("[Initialize] Parse error: {}", last_error);
                            }
                        }
                    }
                }
                Err(e) => {
                    last_error = e.to_string();
                    tracing::debug!("[Initialize] Connection error (attempt {}): {}", attempt, last_error);

                    // Print the error source chain for debugging
                    use std::error::Error;
                    let mut source = e.source();
                    while let Some(s) = source {
                        tracing::debug!("[Initialize]   Caused by: {}", s);
                        source = s.source();
                    }

                    // Check specific error types
                    if e.is_connect() {
                        tracing::warn!("[Initialize]   -> Connection failed (check firewall/antivirus)");
                    }
                    if e.is_timeout() {
                        tracing::warn!("[Initialize]   -> Timeout occurred");
                    }

                    if attempt < 3 {
                        tracing::debug!("[Initialize] Retrying in 4000ms...");
                        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    }
                }
            }
        }


        // Check if we succeeded in the loop above
        if ent_response_opt.is_none() {
            // All retries failed - try to detect actual port from process
            tracing::debug!("[Initialize] All connection attempts failed, trying port recovery...");
            if let Some(detected_port) = Self::detect_riot_client_port() {
                if detected_port != port {
                    tracing::debug!("[Initialize] Port mismatch detected! Lockfile: {}, Actual: {}", port, detected_port);
                    tracing::debug!("[Initialize] Re-reading lockfile and retrying...");

                    // Re-read lockfile to get updated credentials
                    if let Ok(new_lockfile) = Self::read_lockfile() {
                        if new_lockfile.port == detected_port {
                            let new_auth = STANDARD.encode(format!("riot:{}", new_lockfile.password));
                            *self.local_port.write() = new_lockfile.port.clone();
                            *self.local_auth.write() = format!("Basic {}", new_auth);
                            *self.lockfile_hash.write() = new_lockfile.hash;

                            // One more attempt with correct port
                            let new_url = format!("https://127.0.0.1:{}/entitlements/v1/token", detected_port);
                            tracing::debug!("[Initialize] Retrying with detected port: {}", new_url);

                            if let Ok(resp) = self.client
                                .get(&new_url)
                                .header("Authorization", format!("Basic {}", new_auth))
                                .send()
                                .await
                            {
                                if resp.status().is_success() {
                                    if let Ok(ent) = resp.json::<EntitlementsResponse>().await {
                                        tracing::info!("[Initialize] Port recovery successful!");
                                        ent_response_opt = Some(ent);
                                    }
                                }
                            }
                        }
                    }
                } else {
                     tracing::debug!("[Initialize] Port matches detected port ({}), no recovery needed", detected_port);
                }
            }
        }

        let ent_response = ent_response_opt.ok_or_else(|| {
            tracing::error!("[Initialize] All attempts failed. Last error: {}", last_error);
            ApiError::RequestFailed(last_error)
        })?;

        *self.puuid.write() = ent_response.subject.clone();

        // Get client version
        let version = self.get_client_version().await;

        // Set remote headers
        {
            let mut headers = self.remote_headers.write();
            headers.insert("Authorization".into(), format!("Bearer {}", ent_response.access_token));
            headers.insert("X-Riot-Entitlements-JWT".into(), ent_response.token);
            headers.insert("X-Riot-ClientPlatform".into(), "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9".into());
            headers.insert("X-Riot-ClientVersion".into(), version);
            headers.insert("Content-Type".into(), "application/json".into());
        }

        // Get region from sessions
        let sessions_url = format!("https://127.0.0.1:{}/product-session/v1/external-sessions", port);
        if let Ok(resp) = self.client
            .get(&sessions_url)
            .header("Authorization", format!("Basic {}", auth))
            .send()
            .await
        {
            if let Ok(sessions) = resp.json::<HashMap<String, SessionData>>().await {
                for (_, session) in sessions {
                    if let Some(config) = session.launch_configuration {
                        if let Some(args) = config.arguments {
                            for arg in args {
                                if arg.contains("-ares-deployment=") {
                                    let region = arg.split('=').nth(1).unwrap_or("tr").to_string();
                                    *self.region.write() = region.clone();
                                }
                                if arg.contains("-config-endpoint=") {
                                    if let Some(endpoint) = arg.split('=').nth(1) {
                                        let parts: Vec<&str> = endpoint.split('.').collect();
                                        if parts.len() > 1 {
                                            *self.shard.write() = parts[1].to_string();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Default region/shard
        if self.region.read().is_empty() {
            *self.region.write() = "tr".to_string();
        }
        if self.shard.read().is_empty() {
            *self.shard.write() = self.get_shard(&self.region.read());
        }

        *self.connected.write() = true;
        *self.needs_reinit.write() = false;
        *self.consecutive_network_errors.write() = 0;
        *self.last_init_time.write() = std::time::Instant::now();

        Ok(ConnectionStatus {
            connected: true,
            region: self.region.read().to_uppercase(),
            message: "Connected".into(),
        })
    }

    fn get_shard(&self, region: &str) -> String {
        match region.to_lowercase().as_str() {
            "eu" | "tr" => "eu",
            "na" | "latam" | "br" => "na",
            "ap" => "ap",
            "kr" => "kr",
            _ => "eu",
        }.to_string()
    }

    async fn get_client_version(&self) -> String {
        if let Ok(resp) = self.client
            .get("https://valorant-api.com/v1/version")
            .send()
            .await
        {
            if let Ok(data) = resp.json::<VersionResponse>().await {
                if let Some(d) = data.data {
                    if let Some(v) = d.riot_client_version {
                        return v;
                    }
                }
            }
        }
        "release-09.10-shipping-18-2775386".to_string()
    }

    fn glz_url(&self, endpoint: &str) -> String {
        let region = self.region.read();
        let shard = self.shard.read();
        let glz_region = if region.to_lowercase() == "tr" { "eu" } else { &region };
        format!("https://glz-{}-1.{}.a.pvp.net{}", glz_region, shard, endpoint)
    }

    fn pd_url(&self, endpoint: &str) -> String {
        let shard = self.shard.read();
        format!("https://pd.{}.a.pvp.net{}", shard, endpoint)
    }

    async fn get_remote<T: serde::de::DeserializeOwned>(&self, url: &str) -> Option<T> {
        // Check if tokens might be stale
        if self.should_refresh_tokens() {
            *self.needs_reinit.write() = true;
            // Don't immediately disconnect - let caller handle reinit
        }

        let headers: HashMap<String, String> = self.remote_headers.read().clone();

        // Retry mechanism - try up to 2 times
        for attempt in 1..=2 {
            let mut req = self.client.get(url);
            for (k, v) in headers.iter() {
                req = req.header(k, v);
            }

            match req.send().await {
                Ok(resp) => {
                    // Check for auth errors that indicate connection is stale
                    if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
                        tracing::debug!("[get_remote] Auth error ({}), triggering reinit", resp.status());
                        *self.needs_reinit.write() = true;
                        return None;
                    }
                    // Success - reset error counter
                    *self.consecutive_network_errors.write() = 0;
                    return resp.json().await.ok();
                }
                Err(e) => {
                    tracing::debug!("[get_remote] Request error (attempt {}): {}", attempt, e);

                    if attempt < 2 {
                        // Wait a bit before retry
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        continue;
                    }

                    // After all retries failed, check if lockfile changed
                    // This is critical for detecting mid-game Riot Client restarts
                    if self.check_lockfile_changed() {
                        tracing::debug!("[get_remote] Lockfile changed during game! Triggering full reinit...");
                        *self.needs_reinit.write() = true;
                        *self.connected.write() = false;
                        return None;
                    }

                    // If lockfile hasn't changed, try to detect actual port from process
                    // This handles cases where lockfile is stale
                    if self.try_recover_connection() {
                        tracing::debug!("[get_remote] Port recovery successful, triggering reinit...");
                        *self.connected.write() = false;
                        return None;
                    }

                    // Increment error counter
                    let mut errors = self.consecutive_network_errors.write();
                    *errors += 1;
                    // Only trigger reinit after 3+ consecutive network errors
                    if *errors >= 3 {
                        tracing::debug!("[get_remote] Multiple network errors ({}), triggering reinit", *errors);
                        *self.needs_reinit.write() = true;
                    }
                    return None;
                }
            }
        }
        None
    }

    #[allow(dead_code)]
    async fn post_remote(&self, url: &str) -> Option<serde_json::Value> {
        // Check if tokens might be stale
        if self.should_refresh_tokens() {
            *self.needs_reinit.write() = true;
        }

        let headers: HashMap<String, String> = self.remote_headers.read().clone();

        // Retry mechanism - try up to 2 times
        for attempt in 1..=2 {
            let mut req = self.client.post(url);
            for (k, v) in headers.iter() {
                req = req.header(k, v);
            }

            match req.json(&serde_json::json!({})).send().await {
                Ok(resp) => {
                    if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
                        tracing::debug!("[post_remote] Auth error ({}), triggering reinit", resp.status());
                        *self.needs_reinit.write() = true;
                        return None;
                    }
                    *self.consecutive_network_errors.write() = 0;
                    return resp.json().await.ok();
                }
                Err(e) => {
                    tracing::debug!("[post_remote] Request error (attempt {}): {}", attempt, e);

                    if attempt < 2 {
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        continue;
                    }

                    // Check if lockfile changed (Riot Client might have restarted)
                    if self.check_lockfile_changed() {
                        tracing::debug!("[post_remote] Lockfile changed! Triggering full reinit...");
                        *self.needs_reinit.write() = true;
                        *self.connected.write() = false;
                        return None;
                    }

                    let mut errors = self.consecutive_network_errors.write();
                    *errors += 1;
                    if *errors >= 3 {
                        tracing::debug!("[post_remote] Multiple network errors ({}), triggering reinit", *errors);
                        *self.needs_reinit.write() = true;
                    }
                    return None;
                }
            }
        }
        None
    }

    /// Fire-and-forget POST - Errors do NOT affect connection state
    /// Used for agent select/lock where errors are non-critical
    async fn post_remote_silent(&self, url: &str) -> Option<serde_json::Value> {
        let headers: HashMap<String, String> = self.remote_headers.read().clone();
        let mut req = self.client.post(url);
        for (k, v) in headers.iter() {
            req = req.header(k, v);
        }
        match req.json(&serde_json::json!({})).send().await {
            Ok(resp) => resp.json().await.ok(),
            Err(e) => {
                tracing::error!("[post_remote_silent] Error (ignored): {}", e);
                None
            }
        }
    }

    pub async fn get_pregame_match_id(&self) -> Option<String> {
        let puuid = self.puuid.read().clone();
        let url = self.glz_url(&format!("/pregame/v1/players/{}", puuid));
        let data: PregamePlayer = self.get_remote(&url).await?;
        data.match_id
    }

    pub async fn get_pregame_match(&self, match_id: &str) -> Option<PregameMatch> {
        let url = self.glz_url(&format!("/pregame/v1/matches/{}", match_id));
        self.get_remote(&url).await
    }

    pub async fn get_coregame_match_id(&self) -> Option<String> {
        let puuid = self.puuid.read().clone();
        let url = self.glz_url(&format!("/core-game/v1/players/{}", puuid));
        let data: CoregamePlayer = self.get_remote(&url).await?;
        data.match_id
    }

    pub async fn get_coregame_match(&self, match_id: &str) -> Option<CoregameMatch> {
        let url = self.glz_url(&format!("/core-game/v1/matches/{}", match_id));
        self.get_remote(&url).await
    }

    pub async fn get_player_names(&self, puuids: &[String]) -> HashMap<String, String> {
        let url = self.pd_url("/name-service/v2/players");
        let headers: HashMap<String, String> = self.remote_headers.read().clone();
        let mut req = self.client.put(&url);
        for (k, v) in headers.iter() {
            req = req.header(k, v);
        }

        let mut names = HashMap::new();
        if let Ok(resp) = req.json(&puuids).send().await {
            if let Ok(data) = resp.json::<Vec<PlayerNameInfo>>().await {
                for p in data {
                    // Handle hidden/anonymous players - Riot returns empty game_name for privacy
                    // Return empty string for hidden players, caller will use agent name instead
                    let name = if p.game_name.is_empty() {
                        // Player has hidden their name - return empty, will be replaced with agent name
                        String::new()
                    } else if p.tag_line.is_empty() {
                        p.game_name
                    } else {
                        format!("{}#{}", p.game_name, p.tag_line)
                    };
                    names.insert(p.subject, name);
                }
            }
        }
        names
    }

    pub async fn select_agent(&self, match_id: &str, agent_id: &str) {
        let url = self.glz_url(&format!("/pregame/v1/matches/{}/select/{}", match_id, agent_id));
        let _ = self.post_remote_silent(&url).await;
    }

    pub async fn lock_agent(&self, match_id: &str, agent_id: &str) {
        let url = self.glz_url(&format!("/pregame/v1/matches/{}/lock/{}", match_id, agent_id));
        let _ = self.post_remote_silent(&url).await;
    }

    /// Get presences from local chat API - returns puuid -> party_id map
    pub async fn get_presences(&self) -> HashMap<String, String> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();
        let url = format!("https://127.0.0.1:{}/chat/v4/presences", port);

        let mut party_map = HashMap::new();

        match self.client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(resp) => {
                // Check for auth errors
                if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
                    tracing::debug!("[get_presences] Auth error ({}), checking lockfile...", resp.status());
                    // Check if lockfile changed (port/password might have changed)
                    if self.check_lockfile_changed() {
                        tracing::debug!("[get_presences] Lockfile changed, triggering reinit");
                    }
                    *self.needs_reinit.write() = true;
                    return party_map;
                }

                if let Ok(data) = resp.json::<PresencesResponse>().await {
                    for p in data.presences {
                        if let Some(private_b64) = p.private {
                            if let Ok(decoded) = STANDARD.decode(&private_b64) {
                                if let Ok(json_str) = String::from_utf8(decoded) {
                                    if let Ok(private_data) = serde_json::from_str::<PresencePrivate>(&json_str) {
                                        if let Some(party_id) = private_data.party_id {
                                            if !party_id.is_empty() {
                                                party_map.insert(p.puuid, party_id);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                // Local API unreachable - check if lockfile changed (Riot Client might have restarted)
                tracing::debug!("[get_presences] Connection error: {}", e);

                // Check if lockfile changed - this is the KEY check for the mid-game issue
                if self.check_lockfile_changed() {
                    tracing::debug!("[get_presences] Lockfile changed! Port may have changed, triggering full reinit...");
                    *self.needs_reinit.write() = true;
                    *self.connected.write() = false;
                    return party_map;
                }

                // Increment error counter
                let mut errors = self.consecutive_network_errors.write();
                *errors += 1;
                if *errors >= 3 {
                    tracing::debug!("[get_presences] 3+ consecutive errors, triggering reinit");
                    *self.needs_reinit.write() = true;
                }
            }
        }
        party_map
    }

    /// Get my party info - returns (party_id, member_puuids)
    pub async fn get_my_party(&self) -> (Option<String>, Vec<String>) {
        let puuid = self.puuid.read().clone();
        let url = self.glz_url(&format!("/parties/v1/players/{}", puuid));

        if let Some(data) = self.get_remote::<PartyPlayerResponse>(&url).await {
            if let Some(party_id) = data.current_party_id {
                let party_url = self.glz_url(&format!("/parties/v1/parties/{}", party_id));
                if let Some(party_data) = self.get_remote::<PartyResponse>(&party_url).await {
                    let members: Vec<String> = party_data.members
                        .iter()
                        .filter_map(|m| m.subject.clone())
                        .collect();
                    return (Some(party_id), members);
                }
                return (Some(party_id), vec![puuid]);
            }
        }
        (None, vec![])
    }

    /// Detect parties for a list of players (legacy - kept for compatibility)
    #[allow(dead_code)]
    pub async fn detect_parties(&self, puuids: &[String]) -> HashMap<String, String> {
        let mut party_map: HashMap<String, String> = HashMap::new();
        let mut party_counter: HashMap<String, u32> = HashMap::new();
        let mut next_party_num: u32 = 1;
        let mut found_via_presence: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Get my party info
        let (my_party_id, my_party_members) = self.get_my_party().await;

        // Get presences for friends
        let presences = self.get_presences().await;

        for puuid in puuids {
            // Check if in my party
            if let Some(ref my_pid) = my_party_id {
                if my_party_members.contains(puuid) {
                    if !party_counter.contains_key(my_pid) {
                        party_counter.insert(my_pid.clone(), next_party_num);
                        next_party_num += 1;
                    }
                    party_map.insert(puuid.clone(), format!("Grup-{}", party_counter[my_pid]));
                    found_via_presence.insert(puuid.clone());
                    continue;
                }
            }

            // Check presences (friends)
            if let Some(friend_party_id) = presences.get(puuid) {
                if !party_counter.contains_key(friend_party_id) {
                    party_counter.insert(friend_party_id.clone(), next_party_num);
                    next_party_num += 1;
                }
                party_map.insert(puuid.clone(), format!("Grup-{}", party_counter[friend_party_id]));
                found_via_presence.insert(puuid.clone());
            }
        }

        // For players not found via presence, try match history method
        let unknown_puuids: Vec<String> = puuids
            .iter()
            .filter(|p| !found_via_presence.contains(*p))
            .cloned()
            .collect();

        if !unknown_puuids.is_empty() {
            // Try to get party info from match history
            let history_parties = self.detect_parties_via_history(&unknown_puuids).await;

            for (puuid, party_tag) in history_parties {
                if !party_map.contains_key(&puuid) {
                    // Renumber the groups to continue from where we left off
                    if party_tag.starts_with("Grup-") {
                        let new_tag = format!("Grup-{}", next_party_num);
                        // Check if this is a new group we haven't seen
                        let existing_count = party_map.values().filter(|v| *v == &party_tag).count();
                        if existing_count == 0 {
                            party_map.insert(puuid, new_tag);
                            next_party_num += 1;
                        } else {
                            party_map.insert(puuid, party_tag);
                        }
                    } else {
                        party_map.insert(puuid, party_tag);
                    }
                }
            }
        }

        // Mark remaining as Solo
        for puuid in puuids {
            if !party_map.contains_key(puuid) {
                party_map.insert(puuid.clone(), "Solo".into());
            }
        }

        // Filter single-person groups
        let mut party_sizes: HashMap<String, u32> = HashMap::new();
        for tag in party_map.values() {
            *party_sizes.entry(tag.clone()).or_insert(0) += 1;
        }

        for (_puuid, tag) in party_map.iter_mut() {
            if party_sizes.get(tag).copied().unwrap_or(0) == 1 {
                *tag = "Solo".into();
            }
        }

        party_map
    }

    /// Get player MMR/rank
    #[allow(dead_code)]
    pub async fn get_player_mmr(&self, puuid: &str) -> (u32, u32) {
        let url = self.pd_url(&format!("/mmr/v1/players/{}", puuid));
        if let Some(data) = self.get_remote::<MmrResponse>(&url).await {
            if let Some(queue_skills) = data.queue_skills {
                if let Some(competitive) = queue_skills.competitive {
                    return (competitive.competitive_tier.unwrap_or(0), competitive.ranked_rating.unwrap_or(0));
                }
            }
        }
        (0, 0)
    }

    /// Get player peak rank across all competitive seasons
    /// Returns (peak_tier, peak_rank_name, peak_rank_color, season_id)
    pub async fn get_player_peak_rank(&self, puuid: &str) -> Option<(u32, String, String, String)> {
        use crate::constants::{BEFORE_ASCENDANT_SEASONS, RANK_NAMES};
        
        let url = self.pd_url(&format!("/mmr/v1/players/{}", puuid));
        let data: MmrResponse = self.get_remote(&url).await?;
        
        let queue_skills = data.queue_skills?;
        let competitive = queue_skills.competitive?;
        let seasons = competitive.seasonal_info_by_season_id?;
        
        let mut max_tier: u32 = 0;
        let mut max_tier_season = String::new();
        
        for (season_id, season_info) in seasons {
            // Check WinsByTier - keys are tier numbers as strings
            if let Some(wins_by_tier) = season_info.wins_by_tier {
                for (tier_str, _wins) in wins_by_tier {
                    if let Ok(mut tier) = tier_str.parse::<u32>() {
                        // Apply Ascendant offset for old seasons
                        // Before Ascendant, Immortal was tier 21-23, Radiant was 24
                        // After Ascendant, Ascendant is 21-23, Immortal is 24-26, Radiant is 27
                        if BEFORE_ASCENDANT_SEASONS.contains(&season_id.as_str()) && tier > 20 {
                            tier += 3; // Shift old Immortal/Radiant to new tier numbers
                        }
                        
                        if tier > max_tier {
                            max_tier = tier;
                            max_tier_season = season_id.clone();
                        }
                    }
                }
            }
            
            // Also check CompetitiveTier directly
            if let Some(tier) = season_info.competitive_tier {
                let mut adjusted_tier = tier;
                if BEFORE_ASCENDANT_SEASONS.contains(&season_id.as_str()) && tier > 20 {
                    adjusted_tier += 3;
                }
                if adjusted_tier > max_tier {
                    max_tier = adjusted_tier;
                    max_tier_season = season_id.clone();
                }
            }
        }
        
        if max_tier == 0 {
            return None;
        }
        
        let (rank_name, rank_color) = RANK_NAMES.get(&max_tier)
            .map(|(n, c)| (n.to_string(), c.to_string()))
            .unwrap_or_else(|| ("Unknown".to_string(), "#768079".to_string()));
        
        Some((max_tier, rank_name, rank_color, max_tier_season))
    }

    /// Get match history for a player (last N matches)
    pub async fn get_match_history(&self, puuid: &str, count: u32) -> Vec<String> {
        let url = self.pd_url(&format!(
            "/match-history/v1/history/{}?startIndex=0&endIndex={}",
            puuid, count
        ));

        if let Some(data) = self.get_remote::<MatchHistoryResponse>(&url).await {
            if let Some(history) = data.history {
                return history.into_iter().map(|h| h.match_id).collect();
            }
        }
        vec![]
    }

    /// Get match details (contains partyId for all players)
    pub async fn get_match_details(&self, match_id: &str) -> Option<MatchDetailsResponse> {
        let url = self.pd_url(&format!("/match-details/v1/matches/{}", match_id));
        self.get_remote(&url).await
    }

    /// Detect parties using match history - checks last match for party groupings
    #[allow(dead_code)]
    pub async fn detect_parties_via_history(&self, puuids: &[String]) -> HashMap<String, String> {
        let mut party_map: HashMap<String, String> = HashMap::new();
        let mut party_counter: HashMap<String, u32> = HashMap::new();
        let mut next_party_num: u32 = 1;

        // We need to find a common recent match to get party info
        // Strategy: Get last 2 matches of first player for better coverage

        if puuids.is_empty() {
            return party_map;
        }

        // Get last 2 matches of first player
        let first_puuid = &puuids[0];
        let match_ids = self.get_match_history(first_puuid, 2).await;

        // Collect party info from both matches
        let mut all_match_parties: HashMap<String, String> = HashMap::new();

        for match_id in &match_ids {
            if let Some(details) = self.get_match_details(match_id).await {
                if let Some(players) = details.players {
                    for p in players {
                        // Only add if not already found (prefer more recent match)
                        if !all_match_parties.contains_key(&p.subject) {
                            all_match_parties.insert(p.subject.clone(), p.party_id.clone());
                        }
                    }
                }
            }
        }

        // Map party IDs to group numbers for target puuids
        for puuid in puuids {
            if let Some(party_id) = all_match_parties.get(puuid) {
                if !party_id.is_empty() {
                    if !party_counter.contains_key(party_id) {
                        party_counter.insert(party_id.clone(), next_party_num);
                        next_party_num += 1;
                    }
                    party_map.insert(puuid.clone(), format!("Grup-{}", party_counter[party_id]));
                } else {
                    party_map.insert(puuid.clone(), "Solo".into());
                }
            }
        }

        // For any puuids not found in the matches, mark as solo
        for puuid in puuids {
            if !party_map.contains_key(puuid) {
                party_map.insert(puuid.clone(), "Solo".into());
            }
        }

        // Filter single-person groups (they're actually solo)
        let mut party_sizes: HashMap<String, u32> = HashMap::new();
        for tag in party_map.values() {
            *party_sizes.entry(tag.clone()).or_insert(0) += 1;
        }

        for (_puuid, tag) in party_map.iter_mut() {
            if tag.starts_with("Grup-") && party_sizes.get(tag).copied().unwrap_or(0) == 1 {
                *tag = "Solo".into();
            }
        }

        party_map
    }

    /// Get current game loadouts for all players
    pub async fn get_coregame_loadouts(&self, match_id: &str) -> Option<LoadoutsResponse> {
        let url = self.glz_url(&format!("/core-game/v1/matches/{}/loadouts", match_id));
        self.get_remote(&url).await
    }

    /// Get pregame loadouts for all players
    pub async fn get_pregame_loadouts(&self, match_id: &str) -> Option<PregameLoadoutsResponse> {
        let url = self.glz_url(&format!("/pregame/v1/matches/{}/loadouts", match_id));
        self.get_remote(&url).await
    }

    /// Detect parties with player-level caching
    /// Only fetches match history for players in `players_to_fetch` (once per game session)
    /// `existing_cache` preserves party assignments from previous calls for consistency
    pub async fn detect_parties_with_cache(
        &self,
        all_puuids: &[String],
        players_to_fetch: &[String],
        existing_cache: &HashMap<String, String>,
    ) -> HashMap<String, String> {
        let mut party_map: HashMap<String, String> = HashMap::new();
        let mut party_id_to_num: HashMap<String, u32> = HashMap::new();

        // Start numbering from existing cache to maintain consistency
        let mut next_party_num: u32 = 1;
        for tag in existing_cache.values() {
            if tag.starts_with("Grup-") {
                if let Ok(num) = tag.trim_start_matches("Grup-").parse::<u32>() {
                    if num >= next_party_num {
                        next_party_num = num + 1;
                    }
                }
            }
        }

        // Step 1: Preserve existing cache entries
        for (puuid, party) in existing_cache {
            party_map.insert(puuid.clone(), party.clone());
        }

        // Step 2: Get my party and presences for new players
        let (my_party_id, my_party_members) = self.get_my_party().await;
        let presences = self.get_presences().await;

        let mut found_via_presence: std::collections::HashSet<String> = std::collections::HashSet::new();

        for puuid in all_puuids {
            // Skip if already in cache
            if party_map.contains_key(puuid) {
                continue;
            }

            // Check my party
            if let Some(ref my_pid) = my_party_id {
                if my_party_members.contains(puuid) {
                    if !party_id_to_num.contains_key(my_pid) {
                        party_id_to_num.insert(my_pid.clone(), next_party_num);
                        next_party_num += 1;
                    }
                    party_map.insert(puuid.clone(), format!("Grup-{}", party_id_to_num[my_pid]));
                    found_via_presence.insert(puuid.clone());
                    continue;
                }
            }

            // Check presences (friends)
            if let Some(friend_party_id) = presences.get(puuid) {
                if !party_id_to_num.contains_key(friend_party_id) {
                    party_id_to_num.insert(friend_party_id.clone(), next_party_num);
                    next_party_num += 1;
                }
                party_map.insert(puuid.clone(), format!("Grup-{}", party_id_to_num[friend_party_id]));
                found_via_presence.insert(puuid.clone());
            }
        }

        // Step 3: For players not found via presence AND in players_to_fetch, use match history
        let need_history: Vec<String> = players_to_fetch
            .iter()
            .filter(|p| !found_via_presence.contains(*p) && !party_map.contains_key(*p))
            .cloned()
            .collect();

        if !need_history.is_empty() {
            // Pick first player that needs history to fetch last 2 matches
            if let Some(first_puuid) = need_history.first() {
                let match_ids = self.get_match_history(first_puuid, 2).await;

                // Collect party info from matches
                let mut match_parties: HashMap<String, String> = HashMap::new();

                for match_id in &match_ids {
                    if let Some(details) = self.get_match_details(match_id).await {
                        if let Some(players) = details.players {
                            for p in players {
                                if !match_parties.contains_key(&p.subject) {
                                    match_parties.insert(p.subject.clone(), p.party_id.clone());
                                }
                            }
                        }
                    }
                }

                // Apply party info to ALL players needing it (not just need_history)
                // This catches teammates who might be in the same match
                for puuid in all_puuids {
                    if party_map.contains_key(puuid) {
                        continue;
                    }

                    if let Some(party_id) = match_parties.get(puuid) {
                        if !party_id.is_empty() {
                            if !party_id_to_num.contains_key(party_id) {
                                party_id_to_num.insert(party_id.clone(), next_party_num);
                                next_party_num += 1;
                            }
                            party_map.insert(puuid.clone(), format!("Grup-{}", party_id_to_num[party_id]));
                        }
                    }
                }
            }
        }

        // Step 4: Mark remaining as Solo
        for puuid in all_puuids {
            if !party_map.contains_key(puuid) {
                party_map.insert(puuid.clone(), "Solo".into());
            }
        }

        // Step 5: Filter single-person groups (but preserve existing cache assignments)
        let mut party_sizes: HashMap<String, u32> = HashMap::new();
        for tag in party_map.values() {
            *party_sizes.entry(tag.clone()).or_insert(0) += 1;
        }

        for (puuid, tag) in party_map.iter_mut() {
            // Don't modify entries that were in existing cache
            if existing_cache.contains_key(puuid) {
                continue;
            }
            if tag.starts_with("Grup-") && party_sizes.get(tag).copied().unwrap_or(0) == 1 {
                *tag = "Solo".into();
            }
        }

        party_map
    }
}

impl ValorantAPI {
    // Chat API Methods

    /// Get all active conversations
    pub async fn get_conversations(&self) -> Option<ConversationsResponse> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();
        let url = format!("https://127.0.0.1:{}/chat/v6/conversations", port);

        match self.client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(resp) => resp.json().await.ok(),
            Err(_) => None,
        }
    }

    /// Get chat history for all or specific conversation
    pub async fn get_chat_history(&self, cid: Option<&str>) -> Option<ChatHistoryResponse> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();

        let url = if let Some(conversation_id) = cid {
            format!("https://127.0.0.1:{}/chat/v6/messages?cid={}", port, conversation_id)
        } else {
            format!("https://127.0.0.1:{}/chat/v6/messages", port)
        };

        match self.client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    tracing::debug!("[get_chat_history] HTTP {}: {}", status,
                        resp.text().await.unwrap_or_default());
                    return None;
                }

                match resp.json().await {
                    Ok(history) => {
                        if cid.is_some() {
                            tracing::info!("[get_chat_history] CID {} returned messages", cid.unwrap());
                        }
                        Some(history)
                    }
                    Err(e) => {
                        tracing::debug!("[get_chat_history] Parse error: {}", e);
                        None
                    }
                }
            }
            Err(e) => {
                tracing::debug!("[get_chat_history] Request error: {}", e);
                None
            }
        }
    }

    /// Get local game chat conversation info
    #[allow(dead_code)]
    pub async fn get_game_chat(&self) -> Option<ConversationsResponse> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();
        let url = format!("https://127.0.0.1:{}/chat/v6/conversations/ares-coregame", port);

        match self.client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(resp) => resp.json().await.ok(),
            Err(_) => None,
        }
    }

    /// Get local party chat conversation info
    #[allow(dead_code)]
    pub async fn get_party_chat(&self) -> Option<ConversationsResponse> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();
        let url = format!("https://127.0.0.1:{}/chat/v6/conversations/ares-parties", port);

        match self.client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(resp) => resp.json().await.ok(),
            Err(_) => None,
        }
    }

    /// Send a chat message
    pub async fn send_chat_message(
        &self,
        cid: &str,
        message: &str,
        message_type: &str, // "chat", "groupchat", or "system"
    ) -> Option<SendChatResponse> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();
        let url = format!("https://127.0.0.1:{}/chat/v6/messages", port);

        let body = SendChatRequest {
            cid: cid.to_string(),
            message: message.to_string(),
            message_type: message_type.to_string(),
        };

        match self.client
            .post(&url)
            .header("Authorization", &auth)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    resp.json().await.ok()
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    }

    /// Send message to current game chat
    #[allow(dead_code)]
    pub async fn send_game_message(&self, message: &str) -> bool {
        if let Some(conv) = self.get_game_chat().await {
            if let Some(first_conv) = conv.conversations.first() {
                return self.send_chat_message(
                    &first_conv.cid,
                    message,
                    "groupchat"
                ).await.is_some();
            }
        }
        false
    }

    /// Send message to party chat
    #[allow(dead_code)]
    pub async fn send_party_message(&self, message: &str) -> bool {
        if let Some(conv) = self.get_party_chat().await {
            if let Some(first_conv) = conv.conversations.first() {
                return self.send_chat_message(
                    &first_conv.cid,
                    message,
                    "groupchat"
                ).await.is_some();
            }
        }
        false
    }
    /// Get friends list
    pub async fn get_friends(&self) -> Option<FriendsResponse> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();
        let url = format!("https://127.0.0.1:{}/chat/v4/friends", port);

        match self.client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(resp) => resp.json().await.ok(),
            Err(_) => None,
        }
    }

    /// Generate conversation ID for DM with a friend
    #[allow(dead_code)]
    pub fn generate_dm_cid(&self, friend_puuid: &str) -> String {
        let my_puuid = self.puuid.read().clone();
        let region = self.region.read().clone();

        // Sort PUUIDs alphabetically
        let (first, second) = if my_puuid < friend_puuid.to_string() {
            (my_puuid, friend_puuid.to_string())
        } else {
            (friend_puuid.to_string(), my_puuid)
        };

        format!("{}@{}.pvp.net-{}@{}.pvp.net", first, region, second, region)
    }

    /// Get chat participants
    pub async fn get_chat_participants(&self, cid: Option<&str>) -> Option<ChatParticipantsResponse> {
        let port = self.local_port.read().clone();
        let auth = self.local_auth.read().clone();

        let url = if let Some(conversation_id) = cid {
            format!("https://127.0.0.1:{}/chat/v5/participants?cid={}", port, conversation_id)
        } else {
            format!("https://127.0.0.1:{}/chat/v5/participants", port)
        };

        match self.client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(resp) => resp.json().await.ok(),
            Err(_) => None,
        }
    }

    /// Generate all possible CID formats (prioritizing double format for DMs)
    #[allow(dead_code)]
    fn generate_all_cid_formats(&self, friend_puuid: &str) -> Vec<String> {
        let region = self.region.read().clone();
        let shard = self.shard.read().clone();

        // Helper to generate double format (REQUIRED for DM sends)
        let make_double = |r: &str| {
            let my_puuid = self.puuid.read().clone();
            let (first, second) = if my_puuid < friend_puuid.to_string() {
                (my_puuid.clone(), friend_puuid.to_string())
            } else {
                (friend_puuid.to_string(), my_puuid.clone())
            };
            format!("{}@{}.pvp.net-{}@{}.pvp.net", first, r, second, r)
        };

        // Priority regions to try first
        let priority_regions = vec![
            region.clone(),
            shard.clone(),
            "eu".to_string(),
            "na".to_string(),
        ];

        // All potentially valid chat regions/shards
        let mut all_regions = vec![
            "eu1".to_string(), "eu2".to_string(), "eu3".to_string(),
            "na1".to_string(),
            "ap1".to_string(), "ap2".to_string(), "ap".to_string(),
            "kr1".to_string(), "kr".to_string(),
            "br1".to_string(), "br".to_string(),
            "la1".to_string(), "la2".to_string(), "latam".to_string(),
            "tr1".to_string(), "tr".to_string(),
            "ru1".to_string(), "ru".to_string(),
        ];

        // Combine and dedup
        let mut regions_to_try = priority_regions;
        regions_to_try.append(&mut all_regions);
        regions_to_try.sort();
        regions_to_try.dedup();

        let mut formats = Vec::new();

        // CRITICAL: Double Formats ONLY for sending DMs
        // Single format is only for reading history, NOT for sending
        for r in &regions_to_try {
            formats.push(make_double(r));
        }

        formats
    }

    /// Find actual conversation ID for a friend from existing messages
    pub async fn find_dm_cid(&self, friend_puuid: &str) -> Option<String> {
        // Check all messages and find by PUUID
        if let Some(history) = self.get_chat_history(None).await {
            for msg in history.messages {
                // If we find a message with/to the friend in a 'chat'
                if msg.puuid == friend_puuid && msg.message_type == "chat" {
                    tracing::debug!("[find_dm_cid] Found CID from message: {}", msg.cid);
                    return Some(msg.cid);
                }
            }
        }
        None
    }

    /// Find or recover DM CID (tries finding, then probing generated formats)
    /// ALWAYS returns double format CID required for sending messages
    #[allow(dead_code)]
    pub async fn find_or_recover_dm_cid(&self, friend_puuid: &str) -> String {
        tracing::debug!("[find_or_recover_dm_cid] Searching for friend: {}", friend_puuid);

        // 1. Try to find existing from messages (will return double format)
        if let Some(cid) = self.find_dm_cid(friend_puuid).await {
            tracing::info!("[find_or_recover_dm_cid] Found existing CID: {}", cid);
            return cid;
        }

        // 2. Generate double format CID (required for sending)
        let formats = self.generate_all_cid_formats(friend_puuid);
        tracing::debug!("[find_or_recover_dm_cid] Generated {} double-format CIDs to try", formats.len());

        // 3. Try the most likely format first (current region)
        let primary_cid = &formats[0];
        tracing::debug!("[find_or_recover_dm_cid] Using primary double-format CID: {}", primary_cid);

        // We don't need to probe - just use the double format
        // The API will create the conversation on first send
        primary_cid.clone()
    }

    /// Initialize a DM conversation by sending an empty/test message to establish message_history
    /// This ensures the conversation is ready to receive messages
    #[allow(dead_code)]
    pub async fn initialize_dm_conversation(&self, cid: &str) -> bool {
        tracing::debug!("[initialize_dm_conversation] Initializing conversation: {}", cid);

        // Try to get existing history first
        if let Some(history) = self.get_chat_history(Some(cid)).await {
            if !history.messages.is_empty() {
                tracing::info!("[initialize_dm_conversation] Conversation already has messages");
                return true;
            }
        }

        // Check if conversation exists and has message_history enabled
        if let Some(convs) = self.get_conversations().await {
            if let Some(conv) = convs.conversations.iter().find(|c| c.cid == cid) {
                if conv.message_history {
                    tracing::info!("[initialize_dm_conversation] Conversation exists with message_history=true");
                    return true;
                }
            }
        }

        tracing::debug!("[initialize_dm_conversation] ⚠ Conversation needs initialization, will send first message");
        // The conversation will be initialized when the first real message is sent
        true
    }

    /// Send DM to a friend by PUUID (Safely found CID with retry logic)
    #[allow(dead_code)]
    pub async fn send_dm(&self, friend_puuid: &str, message: &str) -> bool {
        tracing::debug!("[send_dm] Sending message to friend: {}", friend_puuid);

        // Use the recovery logic to find the best CID
        let cid = self.find_or_recover_dm_cid(friend_puuid).await;
        tracing::debug!("[send_dm] Using CID: {}", cid);

        // Initialize conversation if needed
        self.initialize_dm_conversation(&cid).await;

        // Try sending using the 'best' CID
        if self.send_chat_message(&cid, message, "chat").await.is_some() {
            tracing::info!("[send_dm] Message sent successfully");
            return true;
        }

        tracing::debug!("[send_dm] ⚠ First attempt failed, trying all formats...");

        // Fallback: If that failed, try ALL formats blindly
        let formats = self.generate_all_cid_formats(friend_puuid);
        for (i, fmt_cid) in formats.iter().enumerate() {
            if fmt_cid == &cid { continue; } // Skip already tried

            tracing::debug!("[send_dm] Retry {}/{}: {}", i+1, formats.len(), fmt_cid);

            if self.send_chat_message(fmt_cid, message, "chat").await.is_some() {
                tracing::info!("[send_dm] Message sent with alternate format");
                return true;
            }
        }

        tracing::error!("[send_dm] All attempts failed");
        false
    }

    /// Get helper for single friend by PUUID
    #[allow(dead_code)]
    pub async fn get_friend_by_puuid(&self, puuid: &str) -> Option<Friend> {
        if let Some(friends) = self.get_friends().await {
            return friends.friends.into_iter().find(|f| f.puuid == puuid);
        }
        None
    }

    /// Check if conversation has message history
    #[allow(dead_code)]
    pub fn has_message_history(&self, conversation: &Conversation) -> bool {
        conversation.message_history
    }

    /// Get conversations with message history only
    #[allow(dead_code)]
    pub async fn get_conversations_with_history(&self) -> Vec<Conversation> {
        if let Some(convs) = self.get_conversations().await {
            return convs.conversations
                .into_iter()
                .filter(|c| c.message_history)
                .collect();
        }
        vec![]
    }

    /// Enhanced DM list - only shows conversations with history
    #[allow(dead_code)]
    pub async fn get_dm_list_with_history(&self) -> Vec<(String, Friend, i32, bool)> {
        let mut dm_list = Vec::new();

        if let Some(convs) = self.get_conversations().await {
            for conv in convs.conversations {
                // Only DMs
                if conv.conversation_type != "chat" || !conv.direct_messages {
                    continue;
                }

                // Get participants
                if let Some(participants) = self.get_chat_participants(Some(&conv.cid)).await {
                    for p in participants.participants {
                        if p.puuid == *self.puuid.read() {
                            continue;
                        }

                        if let Some(friend) = self.get_friend_by_puuid(&p.puuid).await {
                            dm_list.push((
                                conv.cid.clone(),
                                friend,
                                conv.unread_count,
                                conv.message_history, // History flag
                            ));
                        }
                    }
                }
            }
        }

        dm_list
    }

    /// Get DM history with checking for message_history flag
    #[allow(dead_code)]
    pub async fn get_dm_history_checked(&self, friend_puuid: &str) -> Result<ChatHistoryResponse, String> {
        // Find conversation
        let cid = self.find_dm_cid(friend_puuid).await
            .ok_or("Conversation bulunamadı")?;

        // Check if conversation has history
        if let Some(convs) = self.get_conversations().await {
            let conv = convs.conversations.iter()
                .find(|c| c.cid == cid)
                .ok_or("Conversation detayları alınamadı")?;

            if !conv.message_history {
                return Err("Bu conversation için mesaj geçmişi devre dışı (message_history=false)".to_string());
            }
        }

        // Get history
        self.get_chat_history(Some(&cid)).await
            .ok_or("Mesaj geçmişi alınamadı".to_string())
    }

    /// Debug: Show all conversations with history status
    #[allow(dead_code)]
    pub async fn debug_message_history(&self) {
        tracing::debug!("=== MESSAGE HISTORY STATUS ===");

        if let Some(convs) = self.get_conversations().await {
            for conv in convs.conversations {
                tracing::debug!(
                    "CID: {} | Type: {} | DM: {} | History: {} | Unread: {}",
                    conv.cid,
                    conv.conversation_type,
                    conv.direct_messages,
                    if conv.message_history { "✓" } else { "✗" },
                    conv.unread_count
                );
            }
        }
    }

    /// Fetch player stats from tracker.gg
    pub async fn get_tracker_stats(&self, player_name: &str) -> Result<serde_json::Value, ApiError> {
        let encoded_name = urlencoding::encode(player_name);
        let url = format!(
            "https://api.tracker.gg/api/v2/valorant/standard/profile/riot/{}",
            encoded_name
        );

        tracing::debug!("[Tracker] Fetching stats for {}...", player_name);

        // Use impersonated client - no need for manual headers
        // The client automatically handles User-Agent and TLS fingerprinting
        // Use impersonation client for tracker.gg
        let response = self.tracker_client
            .get(&url)
            .send()
            .await
            .map_err(|e| ApiError::RequestFailed(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            tracing::error!("[Tracker] request failed with status {}", status);

            if status == 429 {
                let retry_after = response.headers()
                    .get("retry-after")
                    .and_then(|h| h.to_str().ok())
                    .unwrap_or("60"); // Default to 60s if missing
                return Err(ApiError::RequestFailed(format!("HTTP 429:{}", retry_after)));
            }

            return Err(ApiError::RequestFailed(format!("HTTP {}", status)));
        }

        let json = response.json::<serde_json::Value>()
            .await
            .map_err(|e| ApiError::ParseError(e.to_string()))?;

        tracing::info!("[Tracker] Successfully fetched stats");
        Ok(json)
    }
}
