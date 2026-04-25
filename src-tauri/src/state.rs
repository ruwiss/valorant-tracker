use crate::api::types::PlayerSkinData;
use crate::api::ValorantAPI;
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

pub struct AppState {
    pub api: Arc<ValorantAPI>,
    pub http_client: reqwest::Client,
    pub auto_lock_agent: Arc<RwLock<Option<String>>>,
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
    // Track if background autolock worker is running
    pub autolock_worker_started: RwLock<bool>,
    // Debounce: consecutive idle responses needed before transitioning from pregame/ingame to idle
    pub consecutive_idle_count: RwLock<u32>,
    // Last known game state for debounce logic
    pub last_known_state: RwLock<String>,
    pub map_agent_preferences: Arc<RwLock<HashMap<String, String>>>,

    // --- RECENT ENCOUNTER TRACKING ---
    // Stores PUUID -> agent name from previous matches (max 2)
    pub match_history: RwLock<VecDeque<HashMap<String, String>>>,
    // Current match tracking to know when to push to history
    pub current_match_id: RwLock<Option<String>>,
    pub current_match_players: RwLock<HashMap<String, String>>,
    pub current_match_seen_ingame: RwLock<bool>,
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
            cached_parties: RwLock::new(HashMap::new()),
            cached_parties_match_id: RwLock::new(None),
            in_game_session: RwLock::new(false),
            fetched_history_players: RwLock::new(HashSet::new()),
            cached_loadouts: RwLock::new(HashMap::new()),
            loadouts_match_id: RwLock::new(None),
            autolock_worker_started: RwLock::new(false),
            consecutive_idle_count: RwLock::new(0),
            last_known_state: RwLock::new("idle".to_string()),
            map_agent_preferences: Arc::new(RwLock::new(HashMap::new())),

            match_history: RwLock::new(VecDeque::with_capacity(2)),
            current_match_id: RwLock::new(None),
            current_match_players: RwLock::new(HashMap::new()),
            current_match_seen_ingame: RwLock::new(false),
        }
    }
}
