export interface ConnectionStatus {
  connected: boolean;
  region: string;
  message: string;
}

/**
 * Payload emitted by the backend `connection_changed` event (and returned by
 * the `get_connection_status` command). The backend supervisor owns the
 * connection lifecycle and pushes these to the frontend.
 */
export interface ConnectionEvent {
  status: "connected" | "connecting" | "waiting_for_game" | "paused";
  region: string;
}

export interface PlayerData {
  puuid: string;
  name: string;
  agent: string;
  locked: boolean;
  party: string;
  is_me: boolean;
  rank_tier: number;
  rank_rr: number;
  level: number;
  previous_encounter?: number; // 1 = Last game, 2 = Two games ago
  previous_encounter_agent?: string;
  previous_encounter_was_enemy?: boolean;
}

export interface GameState {
  state: "idle" | "pregame" | "ingame" | "disconnected";
  match_id: string | null;
  map_name: string | null;
  mode_name: string | null;
  side: string | null;
  allies: PlayerData[];
  enemies: PlayerData[];
}

export interface ChatMessage {
  body: string;
  cid: string;
  game_name: string;
  game_tag: string;
  id: string;
  mid: string;
  puuid: string;
  read: boolean;
  time: string;
  type: string;
}

export interface Conversation {
  cid: string;
  direct_messages: boolean;
  global_read: boolean;
  message_history: boolean;
  muted: boolean;
  muted_restriction: boolean;
  type: string;
  unread_count: number;
  game_name?: string; // Enhanced with player name
}

export interface PaginatedMessages {
  messages: ChatMessage[];
  total: number;
  page: number;
  page_size: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface Friend {
  activePlatform: string | null;
  displayGroup: string;
  game_name: string;
  game_tag: string;
  group: string;
  last_online_ts: number | null;
  name: string;
  note: string;
  pid: string;
  puuid: string;
  region: string;
}

// ===== Player Settings (Ares.PlayerSettings) =====
// Read from local Riot Client preferences via the `get_player_settings` command.

export interface ActionMapping {
  alt: boolean;
  bindIndex: number;
  characterName: string;
  cmd: boolean;
  ctrl: boolean;
  key: string;
  name: string;
  shift: boolean;
}

export interface BoolSetting {
  settingEnum: string;
  value: boolean;
}

export interface FloatSetting {
  settingEnum: string;
  value: number;
}

export interface IntSetting {
  settingEnum: string;
  value: number;
}

export interface StringSetting {
  settingEnum: string;
  value: string;
}

export interface PlayerSettingsData {
  actionMappings: ActionMapping[];
  boolSettings: BoolSetting[];
  floatSettings: FloatSetting[];
  intSettings: IntSetting[];
  stringSettings: StringSetting[];
  roamingSetttingsVersion: number;
  // Optional round-trip fields (present in cloud payload).
  axisMappings?: unknown[];
  settingsProfiles?: unknown[];
  settingsProfileData?: unknown;
}

export interface PlayerSettingsResponse {
  data: PlayerSettingsData;
  modified: number;
  settings_type: string;
}

// Lightweight preset metadata returned by the backend (no heavy settings blob).
export interface PresetMeta {
  id: string;
  name: string;
  created_at: number; // unix seconds
  source_puuid: string;
  auto_backup: boolean;
  sensitivity: number | null;
}

// ===== Crosshair (SavedCrosshairProfileData) =====
export interface CrosshairColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface CrosshairLines {
  lineThickness: number;
  lineLength: number;
  lineLengthVertical: number;
  lineOffset: number;
  opacity: number;
  bShowLines: boolean;
  bAllowVertScaling: boolean;
}

// One weapon layer (primary / aDS / focusMode).
export interface CrosshairLayer {
  color: CrosshairColor;
  colorCustom: CrosshairColor;
  bUseCustomColor: boolean;
  bHasOutline: boolean;
  outlineThickness: number;
  outlineColor: CrosshairColor;
  outlineOpacity: number;
  centerDotSize: number;
  centerDotOpacity: number;
  bDisplayCenterDot: boolean;
  innerLines: CrosshairLines;
  outerLines: CrosshairLines;
}

export interface CrosshairProfile {
  profileName: string;
  primary: CrosshairLayer;
  aDS?: CrosshairLayer;
  bUseAdvancedOptions?: boolean;
}

export interface CrosshairProfileData {
  currentProfile: number;
  profiles: CrosshairProfile[];
}
