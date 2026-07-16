use crate::api::types::PlayerSkinData;
use crate::api::ValorantAPI;
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

#[derive(Clone)]
pub struct EncounterPlayer {
    pub agent: String,
    pub was_enemy: bool,
}

pub struct AppState {
    pub api: Arc<ValorantAPI>,
    pub http_client: reqwest::Client,
    pub auto_lock_agent: Arc<RwLock<Option<String>>>,
    pub auto_lock_delay_ms: Arc<RwLock<u64>>,
    // Cache for party detection - persists across pregame->ingame transition
    pub cached_parties: RwLock<HashMap<String, String>>,
    // Track which match the party cache belongs to
    pub cached_parties_match_id: RwLock<Option<String>>,
    // Track if we're in an active game session (pregame or ingame)
    pub in_game_session: RwLock<bool>,
    // Cache for players whose match history has been fetched this game session
    pub fetched_history_players: RwLock<HashSet<String>>,
    // Cache for player loadouts - puuid -> skins
    pub cached_loadouts: RwLock<HashMap<String, PlayerSkinData>>,
    pub loadouts_match_id: RwLock<Option<String>>,
    // Track if the background connection supervisor (connect + watch + reconnect + autolock) is running
    pub supervisor_started: RwLock<bool>,
    // User paused match watching - supervisor stops polling/autolock while true
    pub is_paused: RwLock<bool>,
    // Debounce: consecutive idle responses needed before transitioning from pregame/ingame to idle
    pub consecutive_idle_count: RwLock<u32>,
    // Last known game state string for debounce logic ("idle" | "pregame" | "ingame")
    pub last_known_state: RwLock<String>,
    // Last full GameState snapshot (used during idle debounce so UI/Discord keep
    // map+score instead of a blank "ingame" / 0-0 payload).
    pub last_full_game_state: RwLock<Option<crate::api::types::GameState>>,
    pub map_agent_preferences: Arc<RwLock<HashMap<String, String>>>,

    // --- RECENT ENCOUNTER TRACKING ---
    // Stores PUUID -> agent/team info from previous matches (max 2)
    pub match_history: RwLock<VecDeque<HashMap<String, EncounterPlayer>>>,
    // Current match tracking to know when to push to history
    pub current_match_id: RwLock<Option<String>>,
    pub current_match_players: RwLock<HashMap<String, EncounterPlayer>>,
    pub current_match_seen_ingame: RwLock<bool>,

    // Settings presets store. Lazy-initialized in setup() once app_data_dir is known.
    pub presets: RwLock<Option<Arc<crate::presets::PresetStore>>>,
    // A preset "armed" to auto-apply on the next fresh connection (next game
    // launch / account login). Holds (preset_id, backup_label).
    pub armed_preset: RwLock<Option<crate::state::ArmedPreset>>,

    // Discord Rich Presence integration (mirrors map/score into Discord profile).
    pub discord: Arc<crate::discord::DiscordPresence>,
}

#[derive(Clone)]
pub struct ArmedPreset {
    pub id: String,
    pub backup_label: String,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            api: Arc::new(ValorantAPI::new()),
            http_client: reqwest::Client::builder()
                .pool_idle_timeout(std::time::Duration::from_secs(60))
                .pool_max_idle_per_host(50)
                .build()
                .unwrap_or_default(),
            auto_lock_agent: Arc::new(RwLock::new(None)),
            auto_lock_delay_ms: Arc::new(RwLock::new(6000)),
            cached_parties: RwLock::new(HashMap::new()),
            cached_parties_match_id: RwLock::new(None),
            in_game_session: RwLock::new(false),
            fetched_history_players: RwLock::new(HashSet::new()),
            cached_loadouts: RwLock::new(HashMap::new()),
            loadouts_match_id: RwLock::new(None),
            supervisor_started: RwLock::new(false),
            is_paused: RwLock::new(false),
            consecutive_idle_count: RwLock::new(0),
            last_known_state: RwLock::new("idle".to_string()),
            last_full_game_state: RwLock::new(None),
            map_agent_preferences: Arc::new(RwLock::new(HashMap::new())),

            match_history: RwLock::new(VecDeque::with_capacity(2)),
            current_match_id: RwLock::new(None),
            current_match_players: RwLock::new(HashMap::new()),
            current_match_seen_ingame: RwLock::new(false),

            presets: RwLock::new(None),
            armed_preset: RwLock::new(None),
            discord: Arc::new(crate::discord::DiscordPresence::new()),
        }
    }
}
