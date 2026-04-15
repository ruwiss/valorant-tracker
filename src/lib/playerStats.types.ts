// Type definitions for tracker.gg Valorant API response

export interface TrackerApiResponse {
  data: TrackerProfile;
}

export interface TrackerProfile {
  platformInfo: PlatformInfo;
  userInfo: UserInfo;
  metadata: ProfileMetadata;
  segments: Segment[];
}

export interface PlatformInfo {
  platformSlug: string;
  platformUserId: string;
  platformUserHandle: string;
  platformUserIdentifier: string;
  avatarUrl: string | null;
  additionalParameters: unknown;
}

export interface UserInfo {
  userId: string | null;
  isPremium: boolean;
  isVerified: boolean;
  isInfluencer: boolean;
  isPartner: boolean;
  countryCode: string | null;
  customAvatarUrl: string | null;
  customHeroUrl: string | null;
  isSuspicious: boolean | null;
}

export interface ProfileMetadata {
  activeShard: string;
  schema: string;
  privacy: "public" | "private";
  defaultPlatform: string;
  defaultPlaylist: string | null;
  defaultSeason: string | null;
  accountLevel: number;
  seasons: Season[];
  playlists: Playlist[];
}

export interface Season {
  id: string;
  name: string;
  shortName: string;
  episodeName: string;
  actName: string;
}

export interface Playlist {
  id: string;
  name: string;
  platform: string;
}

export interface Segment {
  type: "season" | "agent";
  attributes: {
    seasonId?: string;
    playlist?: string;
    key?: string;
  };
  metadata: SegmentMetadata;
  expiryDate: string;
  stats: Record<string, StatValue>;
}

export interface SegmentMetadata {
  name: string;
  shortName?: string;
  playlistName?: string;
  imageUrl?: string;
  heroUrl?: string;
  role?: string;
  color?: string;
}

export interface StatValue {
  displayName: string;
  displayCategory: string;
  category: string;
  metadata: Record<string, unknown>;
  value: number;
  displayValue: string;
  displayType: string;
  description?: string;
}

// Simplified display model for UI
export interface PlayerStatsDisplay {
  // Profile info
  playerName: string;
  avatarUrl: string | null;
  accountLevel: number;
  currentSeason: string;
  privacy: "public" | "private";

  // Core stats (from latest season)
  kd: string;
  winRate: string;
  headshotPct: string;
  acs: string;

  // Additional stats
  matchesPlayed: number;
  kills: number;
  deaths: number;
  assists: number;
  playtimeSeconds: number;

  // Advanced Stats
  adr: string; // Damage Per Round
  kast: string; // KAST %
  firstBloods: number;
  clutches: number; // Total clutches
  clutchWinRate: string; // Clutch %

  // New Stats
  aces: number;
  econRating: string;
  damageDelta: string; // Damage Delta Per Round

  // Top agent (from agent segments)
  topAgent: {
    name: string;
    imageUrl: string;
    matches: number;
  } | null;
}
