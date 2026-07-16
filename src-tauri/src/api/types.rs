use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntitlementsResponse {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    pub token: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    #[serde(rename = "launchConfiguration")]
    pub launch_configuration: Option<LaunchConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchConfig {
    pub arguments: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionResponse {
    pub data: Option<VersionData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionData {
    #[serde(rename = "riotClientVersion")]
    pub riot_client_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PregamePlayer {
    #[serde(rename = "MatchID")]
    pub match_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PregameMatch {
    #[serde(rename = "MapID")]
    pub map_id: String,
    #[serde(rename = "QueueID")]
    pub queue_id: String,
    pub ally_team: Option<PregameTeam>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PregameTeam {
    #[serde(rename = "TeamID")]
    pub team_id: String,
    pub players: Vec<PregamePlayerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PregamePlayerInfo {
    pub subject: String,
    #[serde(rename = "CharacterID")]
    pub character_id: String,
    pub character_selection_state: String,
    pub competitive_tier: i32,
    pub player_identity: Option<PlayerIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PlayerIdentity {
    #[serde(default)]
    pub account_level: i32,
    /// Equipped player card UUID (used for banner art via valorant-api media).
    /// Riot sends `PlayerCardID` (all-caps ID); accept a few aliases just in case.
    #[serde(
        default,
        rename = "PlayerCardID",
        alias = "PlayerCardId",
        alias = "playerCardId"
    )]
    pub player_card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CoregamePlayer {
    #[serde(rename = "MatchID")]
    pub match_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CoregameMatch {
    #[serde(rename = "MapID")]
    pub map_id: String,
    pub players: Vec<CoregamePlayerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CoregamePlayerInfo {
    pub subject: String,
    #[serde(rename = "CharacterID")]
    pub character_id: String,
    #[serde(rename = "TeamID")]
    pub team_id: String,
    pub player_identity: Option<PlayerIdentity>,
    pub seasonal_badge_info: Option<SeasonalBadgeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SeasonalBadgeInfo {
    pub rank: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PlayerNameInfo {
    pub subject: String,
    pub game_name: String,
    pub tag_line: String,
}

// Frontend types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub region: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GameState {
    pub state: String, // "idle" | "pregame" | "ingame"
    pub match_id: Option<String>,
    pub map_name: Option<String>,
    pub mode_name: Option<String>,
    pub side: Option<String>,
    pub allies: Vec<PlayerData>,
    pub enemies: Vec<PlayerData>,
    // Round score while ingame (from our own Riot presence). None in pregame/idle.
    pub ally_score: Option<i32>,
    pub enemy_score: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerData {
    pub puuid: String,
    pub name: String,
    pub agent: String,
    pub locked: bool,
    pub party: String,
    pub is_me: bool,
    pub rank_tier: i32,
    pub rank_rr: i32,
    pub level: i32,
    pub previous_encounter: Option<u32>, // 1 = Last game, 2 = Two games ago
    pub previous_encounter_agent: Option<String>,
    pub previous_encounter_was_enemy: Option<bool>,
    /// Equipped player card UUID for soft banner background in the roster.
    #[serde(default)]
    pub player_card_id: Option<String>,
}

// Presence types for party detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresencesResponse {
    pub presences: Vec<Presence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Presence {
    pub puuid: String,
    pub private: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePrivate {
    pub party_id: Option<String>,
    // Live match info exposed by the Riot client in our own presence. Used to
    // surface the round score (the GLZ match endpoints do not include it).
    pub session_loop_state: Option<String>, // "MENUS" | "PREGAME" | "INGAME"
    pub party_owner_match_score_ally_team: Option<i32>,
    pub party_owner_match_score_enemy_team: Option<i32>,
}

/// Parsed view of *our* Riot presence (session phase + live score).
#[derive(Debug, Clone, Default)]
pub struct MyPresence {
    /// "MENUS" | "PREGAME" | "INGAME" (as reported by the client).
    pub session_loop_state: Option<String>,
    pub ally_score: Option<i32>,
    pub enemy_score: Option<i32>,
}

impl MyPresence {
    pub fn is_menus(&self) -> bool {
        self.session_loop_state
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("MENUS"))
    }
}

// Party types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PartyPlayerResponse {
    #[serde(rename = "CurrentPartyID")]
    pub current_party_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PartyResponse {
    pub members: Vec<PartyMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PartyMember {
    pub subject: Option<String>,
}

// MMR types
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MmrResponse {
    pub queue_skills: Option<QueueSkills>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueSkills {
    pub competitive: Option<CompetitiveSkill>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CompetitiveSkill {
    pub competitive_tier: Option<u32>,
    pub ranked_rating: Option<u32>,
    #[serde(rename = "SeasonalInfoBySeasonID")]
    pub seasonal_info_by_season_id: Option<std::collections::HashMap<String, SeasonalInfo>>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SeasonalInfo {
    #[serde(rename = "SeasonID")]
    pub season_id: Option<String>,
    pub competitive_tier: Option<u32>,
    pub ranked_rating: Option<u32>,
    pub number_of_wins: Option<u32>,
    pub number_of_wins_with_placements: Option<u32>,
    pub number_of_games: Option<u32>,
    pub leaderboard_rank: Option<u32>,
    #[serde(rename = "WinsByTier")]
    pub wins_by_tier: Option<std::collections::HashMap<String, u32>>,
}

// Match History types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MatchHistoryResponse {
    pub subject: Option<String>,
    pub history: Option<Vec<MatchHistoryEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MatchHistoryEntry {
    #[serde(rename = "MatchID")]
    pub match_id: String,
    pub game_start_time: Option<u64>,
    #[serde(rename = "QueueID")]
    pub queue_id: Option<String>,
}

// Match Details types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchDetailsResponse {
    pub match_info: Option<MatchInfo>,
    pub players: Option<Vec<MatchPlayer>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchInfo {
    pub match_id: Option<String>,
    #[serde(rename = "queueID")]
    pub queue_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchPlayer {
    pub subject: String,
    pub party_id: String,
    pub team_id: Option<String>,
}

// Loadout types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct LoadoutsResponse {
    pub loadouts: Vec<PlayerLoadout>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PlayerLoadout {
    #[serde(rename = "CharacterID")]
    pub character_id: String,
    pub loadout: LoadoutData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct LoadoutData {
    pub subject: String,
    pub items: std::collections::HashMap<String, LoadoutItem>,
}

// Pregame loadout types (different structure)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PregameLoadoutsResponse {
    pub loadouts: Vec<PregameLoadoutData>,
    pub loadouts_valid: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PregameLoadoutData {
    pub subject: String,
    pub items: std::collections::HashMap<String, LoadoutItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct LoadoutItem {
    #[serde(rename = "ID")]
    pub id: String,
    #[serde(rename = "TypeID")]
    pub type_id: String,
    pub sockets: Option<std::collections::HashMap<String, SocketItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SocketItem {
    #[serde(rename = "ID")]
    pub id: String,
    pub item: SocketItemData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SocketItemData {
    #[serde(rename = "ID")]
    pub id: String,
    #[serde(rename = "TypeID")]
    pub type_id: String,
}

// Frontend loadout response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSkinData {
    pub puuid: String,
    pub skins: Vec<WeaponSkin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeaponSkin {
    pub weapon_id: String,
    pub skin_id: String,
    pub chroma_id: Option<String>,
    pub buddy_id: Option<String>,
}

// Chat Related Structs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryResponse {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub body: String,
    pub cid: String,
    pub game_name: String,
    pub game_tag: String,
    pub id: String,
    pub mid: String,
    pub puuid: String,
    pub read: bool,
    pub time: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationsResponse {
    pub conversations: Vec<Conversation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub cid: String,
    pub direct_messages: bool,
    pub global_read: bool,
    pub message_history: bool,
    pub muted: bool,
    pub muted_restriction: bool,
    #[serde(rename = "type")]
    pub conversation_type: String,
    pub unread_count: i32,
    pub game_name: Option<String>, // Enhanced with player name if DM
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendChatRequest {
    pub cid: String,
    pub message: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendChatResponse {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginatedMessages {
    pub messages: Vec<ChatMessage>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub has_next: bool,
    pub has_prev: bool,
}

// Friend & Chat Participants Structs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendsResponse {
    pub friends: Vec<Friend>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Friend {
    #[serde(rename = "activePlatform")]
    pub active_platform: Option<String>,
    #[serde(rename = "displayGroup")]
    pub display_group: String,
    pub game_name: String,
    pub game_tag: String,
    pub group: String,
    pub last_online_ts: Option<i64>,
    pub name: String,
    pub note: String,
    pub pid: String,
    pub puuid: String,
    pub region: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatParticipantsResponse {
    pub participants: Vec<ChatParticipant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatParticipant {
    pub cid: String,
    pub game_name: String,
    pub game_tag: String,
    pub muted: bool,
    pub name: String,
    pub pid: String,
    pub puuid: String,
    pub region: String,
}

// ===== Player Settings (Ares.PlayerSettings) =====
// Local endpoint: GET /player-preferences/v1/data-json/Ares.PlayerSettings
// Auth: Basic (lockfile) - same as chat endpoints.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSettingsResponse {
    pub data: PlayerSettingsData,
    #[serde(default)]
    pub modified: i64,
    #[serde(rename = "type", default)]
    pub settings_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSettingsData {
    #[serde(rename = "actionMappings", default)]
    pub action_mappings: Vec<ActionMapping>,
    #[serde(rename = "boolSettings", default)]
    pub bool_settings: Vec<BoolSetting>,
    #[serde(rename = "floatSettings", default)]
    pub float_settings: Vec<FloatSetting>,
    #[serde(rename = "intSettings", default)]
    pub int_settings: Vec<IntSetting>,
    #[serde(rename = "stringSettings", default)]
    pub string_settings: Vec<StringSetting>,
    #[serde(rename = "roamingSetttingsVersion", default)]
    pub roaming_settings_version: i64,
}

/// Shape of WindowsClient/BackupKeybinds.json (keybinds are stored locally,
/// separate from the cloud roaming settings).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindsFile {
    #[serde(rename = "actionMappings", default)]
    pub action_mappings: Vec<ActionMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionMapping {
    #[serde(default)]
    pub alt: bool,
    #[serde(rename = "bindIndex", default)]
    pub bind_index: i64,
    #[serde(rename = "characterName", default)]
    pub character_name: String,
    #[serde(default)]
    pub cmd: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub shift: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoolSetting {
    #[serde(rename = "settingEnum")]
    pub setting_enum: String,
    pub value: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FloatSetting {
    #[serde(rename = "settingEnum")]
    pub setting_enum: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntSetting {
    #[serde(rename = "settingEnum")]
    pub setting_enum: String,
    pub value: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StringSetting {
    #[serde(rename = "settingEnum")]
    pub setting_enum: String,
    pub value: String,
}

// ---- Storefront / Shop ----
// Currency UUIDs
pub const VP_CURRENCY_ID: &str = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
pub const RADIANITE_CURRENCY_ID: &str = "e59aa87c-4cbf-517a-5983-6e81511be9b7";
pub const KINGDOM_CURRENCY_ID: &str = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";

// Riot raw storefront response (only the fields we need)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct StorefrontResponse {
    pub skins_panel_layout: SkinsPanelLayout,
    pub bonus_store: Option<BonusStore>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SkinsPanelLayout {
    pub single_item_store_offers: Vec<StoreOffer>,
    #[serde(rename = "SingleItemOffersRemainingDurationInSeconds")]
    pub single_item_offers_remaining_duration_in_seconds: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct StoreOffer {
    #[serde(rename = "OfferID")]
    pub offer_id: String,
    pub cost: std::collections::HashMap<String, i64>,
    pub rewards: Vec<OfferReward>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct OfferReward {
    #[serde(rename = "ItemTypeID")]
    #[allow(dead_code)]
    pub item_type_id: String,
    #[serde(rename = "ItemID")]
    pub item_id: String,
    #[allow(dead_code)]
    pub quantity: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct BonusStore {
    pub bonus_store_offers: Vec<BonusOffer>,
    #[serde(rename = "BonusStoreRemainingDurationInSeconds")]
    pub bonus_store_remaining_duration_in_seconds: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct BonusOffer {
    #[serde(rename = "BonusOfferID")]
    pub bonus_offer_id: String,
    pub offer: StoreOffer,
    pub discount_percent: i64,
    pub discount_costs: std::collections::HashMap<String, i64>,
    pub is_seen: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct WalletResponse {
    pub balances: std::collections::HashMap<String, i64>,
}

// Frontend return structs (snake_case)
#[derive(Debug, Clone, Serialize)]
pub struct ShopOffer {
    pub offer_id: String,
    pub skin_level_id: String,
    pub vp_cost: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NightMarketOffer {
    pub offer_id: String,
    pub skin_level_id: String,
    pub vp_cost: i64,
    pub discounted_cost: i64,
    pub discount_percent: i64,
    pub is_seen: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorefrontData {
    pub daily_offers: Vec<ShopOffer>,
    pub daily_remaining_seconds: i64,
    pub night_market: Option<Vec<NightMarketOffer>>,
    pub night_market_remaining_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WalletData {
    pub vp: i64,
    pub radianite: i64,
    pub kingdom: i64,
}
