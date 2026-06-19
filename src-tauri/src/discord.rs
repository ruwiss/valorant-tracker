//! Discord Rich Presence integration.
//!
//! Mirrors the live game state (map, round score, agent-select, lobby) into the
//! user's Discord profile via Discord's local IPC socket. The supervisor calls
//! [`DiscordPresence::update`] whenever the connection or game state changes.
//!
//! Asset images (map thumbnails, a default logo) must be uploaded to the Discord
//! application's "Rich Presence Assets" tab; the asset *keys* referenced here
//! (e.g. the lowercased map name, or `logo`) must match those uploads.

use crate::api::types::GameState;
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use parking_lot::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Discord application id. Replace with the real id from the Discord Developer
/// Portal before shipping. Until then the integration silently no-ops (an empty
/// / invalid id simply fails to connect).
pub const DISCORD_APP_ID: &str = "1517323235509928077";

/// Default large-image asset key (upload an image with this key to the app).
const DEFAULT_LARGE_IMAGE: &str = "logo";
const DEFAULT_LARGE_TEXT: &str = "VALORANT";

/// Thread-safe wrapper around the Discord IPC client. Held in `AppState`.
pub struct DiscordPresence {
    inner: Mutex<DiscordState>,
}

struct DiscordState {
    client: Option<DiscordIpcClient>,
    /// Whether the user has the feature enabled (persisted by the frontend).
    enabled: bool,
    /// Dedup: the last activity signature we pushed, to avoid spamming IPC.
    last_signature: String,
    /// When we last successfully pushed (unix secs). Drives the heartbeat that
    /// re-pushes an unchanged activity so a silently-dropped IPC socket (which
    /// happens when the game goes fullscreen) self-heals instead of vanishing.
    last_push_secs: i64,
    /// Match start timestamp (unix secs) for the elapsed-time display.
    match_start: Option<i64>,
    /// The match_id the current `match_start` belongs to.
    timed_match_id: Option<String>,
}

/// Re-push the activity at least this often even if nothing changed, so a
/// dead-but-not-reported IPC connection gets noticed and re-established.
const HEARTBEAT_SECS: i64 = 15;

impl DiscordPresence {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(DiscordState {
                client: None,
                enabled: false,
                last_signature: String::new(),
                last_push_secs: 0,
                match_start: None,
                timed_match_id: None,
            }),
        }
    }

    /// Enable/disable the integration. Disabling clears any shown activity and
    /// drops the connection.
    pub fn set_enabled(&self, enabled: bool) {
        let mut st = self.inner.lock();
        if st.enabled == enabled {
            return;
        }
        st.enabled = enabled;
        if !enabled {
            if let Some(client) = st.client.as_mut() {
                let _ = client.clear_activity();
                let _ = client.close();
            }
            st.client = None;
            st.last_signature.clear();
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.lock().enabled
    }

    /// Ensure we have a live IPC connection. Returns false if Discord is not
    /// running / the app id is unset.
    fn ensure_connected(st: &mut DiscordState) -> bool {
        if DISCORD_APP_ID.is_empty() {
            return false;
        }
        if st.client.is_some() {
            return true;
        }
        let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
        match client.connect() {
            Ok(_) => {
                st.client = Some(client);
                true
            }
            Err(_) => false,
        }
    }

    /// Push the current state to Discord. `conn_status` is the supervisor's
    /// connection status string ("connected" | "connecting" | "waiting_for_game"
    /// | "paused"). No-op when disabled.
    pub fn update(&self, gs: &GameState, conn_status: &str) {
        let mut st = self.inner.lock();
        if !st.enabled {
            return;
        }

        // Build details/state/image for the current state.
        let (details, state_line, image_key, keep_timer) = render(gs, conn_status);

        // Maintain the match elapsed-timer: (re)start it when a new match begins,
        // clear it outside of a match.
        if keep_timer {
            let new_id = gs.match_id.clone();
            if st.timed_match_id != new_id || st.match_start.is_none() {
                st.match_start = Some(now_secs());
                st.timed_match_id = new_id;
            }
        } else {
            st.match_start = None;
            st.timed_match_id = None;
        }

        // Dedup identical payloads (timer changes are continuous so we exclude it
        // from the signature - Discord keeps counting from the start timestamp).
        // BUT still re-push every HEARTBEAT_SECS even when unchanged: the IPC
        // socket can die silently when the game grabs the screen, and without a
        // periodic re-push the presence would just vanish until the next state
        // change. The heartbeat makes it self-heal.
        let now = now_secs();
        let signature = format!("{details}|{state_line}|{image_key}");
        let unchanged = signature == st.last_signature;
        if unchanged && now - st.last_push_secs < HEARTBEAT_SECS {
            return;
        }

        let match_start = st.match_start;

        // Try to push; if the socket is dead, reconnect once and retry in the
        // same tick so a drop costs zero visible downtime.
        let mut pushed = false;
        for attempt in 0..2 {
            if !Self::ensure_connected(&mut st) {
                break; // Discord not running / app id unset.
            }
            let res = {
                let client = st.client.as_mut().unwrap();
                client.set_activity(Self::build_activity(&details, &state_line, &image_key, match_start))
            };
            match res {
                Ok(_) => {
                    pushed = true;
                    break;
                }
                Err(_) => {
                    // Socket likely dropped - close and let the next loop
                    // iteration reconnect from scratch.
                    if let Some(client) = st.client.as_mut() {
                        let _ = client.close();
                    }
                    st.client = None;
                    if attempt == 1 {
                        // Both tries failed; reconnect on a later tick.
                        st.last_signature.clear();
                    }
                }
            }
        }

        if pushed {
            st.last_signature = signature;
            st.last_push_secs = now;
        }
    }

    /// Build the activity payload. Discord rejects empty state/details
    /// (must be >= 2 chars), so those are only attached when non-empty.
    fn build_activity<'a>(
        details: &'a str,
        state_line: &'a str,
        image_key: &'a str,
        match_start: Option<i64>,
    ) -> activity::Activity<'a> {
        // Hover text is always "VALORANT" (the map name already shows in
        // `details`); the small logo brands the presence.
        let assets = activity::Assets::new()
            .large_image(image_key)
            .large_text(DEFAULT_LARGE_TEXT)
            .small_image(DEFAULT_LARGE_IMAGE)
            .small_text(DEFAULT_LARGE_TEXT);

        let mut act = activity::Activity::new().assets(assets);
        if !details.is_empty() {
            act = act.details(details);
        }
        if !state_line.is_empty() {
            act = act.state(state_line);
        }
        if let Some(start) = match_start {
            act = act.timestamps(activity::Timestamps::new().start(start));
        }
        act
    }
}

impl Default for DiscordPresence {
    fn default() -> Self {
        Self::new()
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Map a GameState + connection status to Discord activity fields.
/// Returns (details, state, large_image_key, large_image_text, keep_match_timer).
fn render(gs: &GameState, conn_status: &str) -> (String, String, String, bool) {
    // Connection problems take precedence over a stale game state.
    if conn_status == "paused" {
        return ("İzleme duraklatıldı".into(), String::new(), DEFAULT_LARGE_IMAGE.into(), false);
    }
    if conn_status == "waiting_for_game" || conn_status == "connecting" {
        return ("Oyun bekleniyor".into(), String::new(), DEFAULT_LARGE_IMAGE.into(), false);
    }

    match gs.state.as_str() {
        "ingame" => {
            let map = gs.map_name.clone().unwrap_or_else(|| "Bilinmeyen".into());
            let details = match (gs.ally_score, gs.enemy_score) {
                (Some(a), Some(e)) => format!("{map}  {a} - {e}"),
                _ => map.clone(),
            };
            (details, "Maçta".into(), map_image_key(&map), true)
        }
        "pregame" => {
            let map = gs.map_name.clone().unwrap_or_else(|| "Bilinmeyen".into());
            let image = map_image_key(&map);
            ("Ajan seçimi".into(), map, image, false)
        }
        _ => ("Menüde".into(), String::new(), DEFAULT_LARGE_IMAGE.into(), false),
    }
}

/// Discord asset key for a map: lowercase, no spaces (e.g. "Ascent" -> "ascent").
/// Falls back to the default logo asset for unknown maps so the image never
/// renders broken.
fn map_image_key(map_name: &str) -> String {
    let key = map_name.to_lowercase().replace(' ', "");
    if key.is_empty() || key == "bilinmeyen" {
        DEFAULT_LARGE_IMAGE.to_string()
    } else {
        key
    }
}
