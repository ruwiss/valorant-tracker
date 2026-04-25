export interface ConnectionStatus {
  connected: boolean;
  region: string;
  message: string;
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
