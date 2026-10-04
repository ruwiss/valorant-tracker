// Recent competitive form, computed from the local Riot session.

export interface RecentForm {
  status: "ok" | "empty" | "rate_limited" | "error" | string;
  retry_after_secs: number;
  from_cache: boolean;
  matches: number;
  wins: number;
  losses: number;
  kd: string;
  win_rate: string;
  acs: string;
  hs_pct: string;
  adr: string;
  kills: number;
  deaths: number;
  assists: number;
  account_level: number;
  top_agent: string;
  top_agent_matches: number;
  current_tier: number;
  current_rr: number;
  act_wins: number;
  act_games: number;
  peak_tier: number;
}
