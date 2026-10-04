use crate::api::types::{MatchDetailsResponse, MmrResponse};
use serde::Serialize;

pub struct FormMatch {
    pub won: Option<bool>,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub score: i32,
    pub rounds: i32,
    pub headshots: i32,
    pub bodyshots: i32,
    pub legshots: i32,
    pub damage: i32,
    pub agent: String,
    pub account_level: i32,
}

pub struct RecentForm {
    pub matches: u32,
    pub wins: u32,
    pub losses: u32,
    pub kd: String,
    pub win_rate: String,
    pub acs: String,
    pub hs_pct: String,
    pub adr: String,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub account_level: i32,
    pub top_agent: String,
    pub top_agent_matches: u32,
}

fn blank() -> String {
    "—".into()
}

fn ratio_2(num: i32, den: i32) -> String {
    if den <= 0 {
        if num <= 0 {
            return blank();
        }
        return format!("{:.2}", num as f64);
    }
    format!("{:.2}", num as f64 / den as f64)
}

fn pct(num: i32, den: i32) -> String {
    if den <= 0 {
        return blank();
    }
    format!("{}%", ((num as f64 / den as f64) * 100.0).round() as i32)
}

fn rounded_div(num: i32, den: i32) -> String {
    if den <= 0 {
        return blank();
    }
    format!("{}", ((num as f64 / den as f64).round() as i32))
}

pub fn aggregate_recent_form(matches: &[FormMatch]) -> RecentForm {
    if matches.is_empty() {
        return RecentForm {
            matches: 0,
            wins: 0,
            losses: 0,
            kd: blank(),
            win_rate: blank(),
            acs: blank(),
            hs_pct: blank(),
            adr: blank(),
            kills: 0,
            deaths: 0,
            assists: 0,
            account_level: 0,
            top_agent: String::new(),
            top_agent_matches: 0,
        };
    }

    let mut kills = 0i32;
    let mut deaths = 0i32;
    let mut assists = 0i32;
    let mut score = 0i32;
    let mut rounds = 0i32;
    let mut headshots = 0i32;
    let mut shots = 0i32;
    let mut damage = 0i32;
    let mut wins = 0u32;
    let mut losses = 0u32;
    let mut account_level = 0i32;
    let mut agents: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

    for m in matches {
        kills += m.kills.max(0);
        deaths += m.deaths.max(0);
        assists += m.assists.max(0);
        score += m.score.max(0);
        rounds += m.rounds.max(0);
        headshots += m.headshots.max(0);
        shots += m.headshots.max(0) + m.bodyshots.max(0) + m.legshots.max(0);
        damage += m.damage.max(0);
        match m.won {
            Some(true) => wins += 1,
            Some(false) => losses += 1,
            None => {}
        }
        if m.account_level > account_level {
            account_level = m.account_level;
        }
        if !m.agent.is_empty() {
            *agents.entry(m.agent.clone()).or_insert(0) += 1;
        }
    }

    let (top_agent, top_agent_matches) = agents
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
        .unwrap_or_default();

    let decided = (wins + losses) as i32;
    RecentForm {
        matches: matches.len() as u32,
        wins,
        losses,
        kd: ratio_2(kills, deaths),
        win_rate: pct(wins as i32, decided),
        acs: rounded_div(score, rounds),
        hs_pct: pct(headshots, shots),
        adr: if damage <= 0 && shots <= 0 {
            blank()
        } else {
            rounded_div(damage, rounds)
        },
        kills,
        deaths,
        assists,
        account_level,
        top_agent,
        top_agent_matches,
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RecentFormResponse {
    pub status: String,
    pub retry_after_secs: u32,
    pub from_cache: bool,
    pub matches: u32,
    pub wins: u32,
    pub losses: u32,
    pub kd: String,
    pub win_rate: String,
    pub acs: String,
    pub hs_pct: String,
    pub adr: String,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub account_level: i32,
    pub top_agent: String,
    pub top_agent_matches: u32,
    pub current_tier: u32,
    pub current_rr: u32,
    pub act_wins: u32,
    pub act_games: u32,
    pub peak_tier: u32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RankSnapshot {
    pub current_tier: u32,
    pub current_rr: u32,
    pub act_wins: u32,
    pub act_games: u32,
    pub peak_tier: u32,
}

/// Cache hit always wins. A live scan is blocked while another burst is in
/// flight or the cooldown has not elapsed.
#[derive(Debug, PartialEq, Eq)]
pub enum ScanDecision {
    ServeCache,
    Wait { retry_after_secs: u32 },
    Fetch,
}

pub fn decide_scan(
    has_cache: bool,
    busy: bool,
    elapsed_secs: Option<u64>,
    cooldown_secs: u64,
) -> ScanDecision {
    if has_cache {
        return ScanDecision::ServeCache;
    }
    if busy {
        return ScanDecision::Wait {
            retry_after_secs: cooldown_secs.max(1) as u32,
        };
    }
    if let Some(elapsed) = elapsed_secs {
        if elapsed < cooldown_secs {
            return ScanDecision::Wait {
                retry_after_secs: (cooldown_secs - elapsed) as u32,
            };
        }
    }
    ScanDecision::Fetch
}

fn agent_name(character_id: &str) -> String {
    for (name, uuid) in crate::constants::AGENTS.iter() {
        if uuid.eq_ignore_ascii_case(character_id) {
            return (*name).to_string();
        }
    }
    String::new()
}

fn adjusted_peak_tier(season_id: &str, tier: u32) -> u32 {
    if tier > 20 && crate::constants::BEFORE_ASCENDANT_SEASONS.contains(&season_id) {
        tier + 3
    } else {
        tier
    }
}

/// One player's contribution from a competitive match. Other queues are skipped
/// so a deathmatch cannot dilute K/D and ACS.
pub fn form_match_from_details(details: &MatchDetailsResponse, puuid: &str) -> Option<FormMatch> {
    let queue = details
        .match_info
        .as_ref()
        .and_then(|info| info.queue_id.as_deref())
        .unwrap_or("");
    if !queue.is_empty() && !queue.eq_ignore_ascii_case("competitive") {
        return None;
    }

    let players = details.players.as_ref()?;
    let player = players.iter().find(|p| p.subject == puuid)?;
    if player.is_observer == Some(true) {
        return None;
    }

    let stats = player.stats.clone().unwrap_or_default();
    let mut headshots = 0i32;
    let mut bodyshots = 0i32;
    let mut legshots = 0i32;
    let mut damage = 0i32;
    if let Some(rounds) = player.round_damage.as_ref() {
        for shot in rounds {
            headshots += shot.headshots.unwrap_or(0).max(0);
            bodyshots += shot.bodyshots.unwrap_or(0).max(0);
            legshots += shot.legshots.unwrap_or(0).max(0);
            damage += shot.damage.unwrap_or(0).max(0);
        }
    }

    let team_id = player.team_id.as_deref().unwrap_or("");
    let won = details.teams.as_ref().and_then(|teams| {
        teams.iter().find_map(|team| {
            if team.team_id.as_deref() == Some(team_id) && !team_id.is_empty() {
                team.won
            } else {
                None
            }
        })
    });

    Some(FormMatch {
        won,
        kills: stats.kills.unwrap_or(0),
        deaths: stats.deaths.unwrap_or(0),
        assists: stats.assists.unwrap_or(0),
        score: stats.score.unwrap_or(0),
        rounds: stats.rounds_played.unwrap_or(0),
        headshots,
        bodyshots,
        legshots,
        damage,
        agent: player
            .character_id
            .as_deref()
            .map(agent_name)
            .unwrap_or_default(),
        account_level: player.account_level.unwrap_or(0),
    })
}

pub fn rank_snapshot_from_mmr(data: &MmrResponse) -> RankSnapshot {
    let mut snap = RankSnapshot::default();

    if let Some(update) = data.latest_competitive_update.as_ref() {
        let tier = update.tier_after_update.unwrap_or(0);
        if tier > 0 {
            snap.current_tier = tier;
            snap.current_rr = update.ranked_rating_after_update.unwrap_or(0);
        }
    }

    let seasons = data
        .queue_skills
        .as_ref()
        .and_then(|q| q.competitive.as_ref())
        .and_then(|c| c.seasonal_info_by_season_id.as_ref());

    if let Some(seasons) = seasons {
        if snap.current_tier == 0 {
            let mut best: Option<(u32, u32, u32)> = None;
            for season in seasons.values() {
                let tier = season.effective_tier();
                if tier == 0 {
                    continue;
                }
                let games = season.number_of_games.unwrap_or(0);
                let rr = season.ranked_rating.unwrap_or(0);
                let replace = match best {
                    None => true,
                    Some((best_games, best_tier, _)) => {
                        games > best_games || (games == best_games && tier > best_tier)
                    }
                };
                if replace {
                    best = Some((games, tier, rr));
                }
            }
            if let Some((_, tier, rr)) = best {
                snap.current_tier = tier;
                snap.current_rr = rr;
            }
        }

        let act_id = data
            .latest_competitive_update
            .as_ref()
            .and_then(|u| u.season_id.as_deref());
        if let Some(id) = act_id {
            if let Some(season) = seasons.get(id) {
                snap.act_wins = season.number_of_wins.unwrap_or(0);
                snap.act_games = season.number_of_games.unwrap_or(0);
            }
        }
        if snap.act_games == 0 {
            let mut best: Option<(u32, u32, u32)> = None;
            for season in seasons.values() {
                let games = season.number_of_games.unwrap_or(0);
                let wins = season.number_of_wins.unwrap_or(0);
                if games == 0 {
                    continue;
                }
                if best.map(|(g, _, _)| games > g).unwrap_or(true) {
                    best = Some((games, wins, 0));
                }
            }
            if let Some((games, wins, _)) = best {
                snap.act_games = games;
                snap.act_wins = wins;
            }
        }

        for (season_id, season) in seasons {
            if let Some(wins_by_tier) = season.wins_by_tier.as_ref() {
                for tier_str in wins_by_tier.keys() {
                    if let Ok(tier) = tier_str.parse::<u32>() {
                        let adjusted = adjusted_peak_tier(season_id, tier);
                        if adjusted > snap.peak_tier {
                            snap.peak_tier = adjusted;
                        }
                    }
                }
            }
            let tier = season.effective_tier();
            if tier > 0 {
                let adjusted = adjusted_peak_tier(season_id, tier);
                if adjusted > snap.peak_tier {
                    snap.peak_tier = adjusted;
                }
            }
        }
    }

    if snap.current_tier == 0 {
        if let Some(competitive) = data
            .queue_skills
            .as_ref()
            .and_then(|q| q.competitive.as_ref())
        {
            let tier = competitive.competitive_tier.unwrap_or(0);
            if tier > 0 {
                snap.current_tier = tier;
                snap.current_rr = competitive.ranked_rating.unwrap_or(0);
            }
        }
    }

    snap
}

pub fn response_from_parts(form: RecentForm, rank: RankSnapshot) -> RecentFormResponse {
    RecentFormResponse {
        status: if form.matches == 0 {
            "empty".into()
        } else {
            "ok".into()
        },
        retry_after_secs: 0,
        from_cache: false,
        matches: form.matches,
        wins: form.wins,
        losses: form.losses,
        kd: form.kd,
        win_rate: form.win_rate,
        acs: form.acs,
        hs_pct: form.hs_pct,
        adr: form.adr,
        kills: form.kills,
        deaths: form.deaths,
        assists: form.assists,
        account_level: form.account_level,
        top_agent: form.top_agent,
        top_agent_matches: form.top_agent_matches,
        current_tier: rank.current_tier,
        current_rr: rank.current_rr,
        act_wins: rank.act_wins,
        act_games: rank.act_games,
        peak_tier: rank.peak_tier,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<FormMatch> {
        vec![
            FormMatch {
                won: Some(true),
                kills: 20,
                deaths: 10,
                assists: 5,
                score: 4000,
                rounds: 20,
                headshots: 10,
                bodyshots: 30,
                legshots: 10,
                damage: 3000,
                agent: "jett".into(),
                account_level: 40,
            },
            FormMatch {
                won: Some(false),
                kills: 10,
                deaths: 15,
                assists: 2,
                score: 2000,
                rounds: 20,
                headshots: 5,
                bodyshots: 15,
                legshots: 5,
                damage: 2000,
                agent: "jett".into(),
                account_level: 41,
            },
            FormMatch {
                won: None,
                kills: 8,
                deaths: 8,
                assists: 1,
                score: 1500,
                rounds: 15,
                headshots: 0,
                bodyshots: 0,
                legshots: 0,
                damage: 0,
                agent: "sage".into(),
                account_level: 41,
            },
        ]
    }

    #[test]
    fn aggregate_uses_totals_not_a_mean_of_ratios() {
        // 7500 score / 55 rounds = 136, not the mean of per-match ACS (133).
        // 38 kills / 33 deaths = 1.15. Undecided match is not a loss: 1-1 = 50%.
        // 15 headshots / 75 shots = 20%. 5000 damage / 55 rounds = 91.
        let form = aggregate_recent_form(&sample());
        assert_eq!(form.matches, 3);
        assert_eq!(form.wins, 1);
        assert_eq!(form.losses, 1);
        assert_eq!(form.kd, "1.15");
        assert_eq!(form.win_rate, "50%");
        assert_eq!(form.acs, "136");
        assert_eq!(form.hs_pct, "20%");
        assert_eq!(form.adr, "91");
        assert_eq!(form.kills, 38);
        assert_eq!(form.deaths, 33);
        assert_eq!(form.assists, 8);
        assert_eq!(form.top_agent, "jett");
        assert_eq!(form.top_agent_matches, 2);
        assert_eq!(form.account_level, 41);
    }

    #[test]
    fn zero_deaths_does_not_divide_by_zero() {
        let form = aggregate_recent_form(&[FormMatch {
            won: Some(true),
            kills: 5,
            deaths: 0,
            assists: 1,
            score: 300,
            rounds: 4,
            headshots: 0,
            bodyshots: 0,
            legshots: 0,
            damage: 0,
            agent: "reyna".into(),
            account_level: 12,
        }]);
        assert_eq!(form.kd, "5.00");
        assert_eq!(form.hs_pct, "—");
        assert_eq!(form.adr, "—");
        assert_eq!(form.win_rate, "100%");
    }

    #[test]
    fn empty_window_is_blank_not_zero() {
        let form = aggregate_recent_form(&[]);
        assert_eq!(form.matches, 0);
        assert_eq!(form.kd, "—");
        assert_eq!(form.win_rate, "—");
        assert_eq!(form.acs, "—");
        assert_eq!(form.top_agent, "");
    }

    #[test]
    fn same_player_is_served_from_cache_even_during_cooldown() {
        assert_eq!(
            decide_scan(true, true, Some(1), 20),
            ScanDecision::ServeCache
        );
    }

    #[test]
    fn another_player_must_wait_out_the_cooldown() {
        assert_eq!(
            decide_scan(false, false, Some(5), 20),
            ScanDecision::Wait {
                retry_after_secs: 15
            }
        );
    }

    #[test]
    fn a_busy_scan_blocks_a_second_click() {
        assert_eq!(
            decide_scan(false, true, None, 20),
            ScanDecision::Wait {
                retry_after_secs: 20
            }
        );
    }

    #[test]
    fn competitive_details_keep_shots_and_skip_other_queues() {
        let raw = r#"{
            "matchInfo": { "queueID": "competitive" },
            "players": [{
                "subject": "p1",
                "teamId": "Blue",
                "characterId": "add6443a-41bd-e414-f6ad-e58d267f4e95",
                "accountLevel": 50,
                "stats": { "score": 240, "roundsPlayed": 20, "kills": 18, "deaths": 12, "assists": 4 },
                "roundDamage": [
                    { "damage": 140, "headshots": 1, "bodyshots": 3, "legshots": 0 },
                    { "damage": 60, "headshots": 0, "bodyshots": 2, "legshots": 1 }
                ]
            }],
            "teams": [{ "teamId": "Blue", "won": true }]
        }"#;
        let details: crate::api::types::MatchDetailsResponse = serde_json::from_str(raw).unwrap();
        let form = form_match_from_details(&details, "p1").unwrap();
        assert_eq!(form.kills, 18);
        assert_eq!(form.headshots, 1);
        assert_eq!(form.bodyshots, 5);
        assert_eq!(form.legshots, 1);
        assert_eq!(form.damage, 200);
        assert_eq!(form.agent, "jett");
        assert_eq!(form.won, Some(true));
        assert_eq!(form.account_level, 50);

        let dm = raw.replace("competitive", "deathmatch");
        let details: crate::api::types::MatchDetailsResponse = serde_json::from_str(&dm).unwrap();
        assert!(form_match_from_details(&details, "p1").is_none());
    }
}
