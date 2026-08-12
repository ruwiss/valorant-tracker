use crate::api::types::*;
use crate::api::ValorantAPI;
use crate::constants::{AGENTS, MAP_NAMES};
use crate::state::AppState;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy)]
pub enum LastMatchReason {
    Connected,
    MatchEnd,
}

/// Fetch last completed match (cache unless `force`) and emit `last_match_updated`.
pub fn spawn_refresh(app: AppHandle, reason: LastMatchReason) {
    tauri::async_runtime::spawn(async move {
        let attempts: &[u64] = match reason {
            // History is usually ready immediately after a connect.
            LastMatchReason::Connected => &[0, 4_000],
            // Match-details often lags 10–40s after the client returns to MENUS.
            LastMatchReason::MatchEnd => &[2_000, 6_000, 12_000, 20_000, 35_000, 55_000],
        };

        let newest_only = matches!(reason, LastMatchReason::MatchEnd);

        for (i, delay_ms) in attempts.iter().enumerate() {
            if *delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
            }

            let state = app.state::<AppState>();
            match fetch_and_store(&state, true, newest_only).await {
                Ok(Some(m)) => {
                    tracing::info!(
                        "[LastMatch] Loaded {} on {:?} (attempt {})",
                        m.match_id,
                        reason_label(reason),
                        i + 1
                    );
                    let _ = app.emit("last_match_updated", &m);
                    return;
                }
                Ok(None) => {
                    tracing::debug!(
                        "[LastMatch] No completed match yet ({:?} attempt {})",
                        reason_label(reason),
                        i + 1
                    );
                }
                Err(e) => {
                    tracing::debug!(
                        "[LastMatch] Fetch failed ({:?} attempt {}): {}",
                        reason_label(reason),
                        i + 1,
                        e
                    );
                }
            }
        }
    });
}

fn reason_label(reason: LastMatchReason) -> &'static str {
    match reason {
        LastMatchReason::Connected => "connect",
        LastMatchReason::MatchEnd => "match_end",
    }
}

#[tauri::command]
pub async fn get_last_match(
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
) -> Result<Option<LastMatch>, String> {
    let force = force.unwrap_or(false);
    fetch_and_store(&state, force, false).await
}

async fn fetch_and_store(
    state: &AppState,
    force: bool,
    newest_only: bool,
) -> Result<Option<LastMatch>, String> {
    if !force {
        if let Some(cached) = state.last_match.read().clone() {
            return Ok(Some(cached));
        }
    }

    if !*state.api.connected.read() {
        return Ok(state.last_match.read().clone());
    }

    let fetched = fetch_last_match_from_api(&state.api, newest_only).await?;
    if fetched.is_some() {
        *state.last_match.write() = fetched.clone();
    }
    Ok(fetched)
}

async fn fetch_last_match_from_api(
    api: &ValorantAPI,
    newest_only: bool,
) -> Result<Option<LastMatch>, String> {
    let puuid = api.puuid.read().clone();
    if puuid.is_empty() {
        return Err("No puuid".into());
    }

    let history = api.get_match_history(&puuid, 5).await;
    if history.is_empty() {
        return Ok(None);
    }

    let ids: Vec<String> = if newest_only {
        history.into_iter().take(1).collect()
    } else {
        history
    };

    for match_id in ids {
        if let Some(details) = api.get_match_details(&match_id).await {
            if let Some(mut parsed) = build_last_match(&puuid, details) {
                let mut name_ids: Vec<String> = parsed
                    .allies
                    .iter()
                    .chain(parsed.enemies.iter())
                    .map(|p| p.puuid.clone())
                    .collect();
                if !name_ids.iter().any(|id| id == &parsed.me.puuid) {
                    name_ids.push(parsed.me.puuid.clone());
                }
                let names = api.get_player_names(&name_ids).await;
                apply_resolved_names(&mut parsed, &names);
                return Ok(Some(parsed));
            }
        }
    }

    Ok(None)
}

fn build_last_match(my_puuid: &str, details: MatchDetailsResponse) -> Option<LastMatch> {
    let info = details.match_info?;
    if info.is_completed == Some(false) {
        return None;
    }

    let match_id = info.match_id.filter(|s| !s.is_empty())?;
    let raw_players = details.players.unwrap_or_default();
    if raw_players.is_empty() {
        return None;
    }

    let map_name = map_display_name(info.map_id.as_deref().unwrap_or(""));
    let queue_id = info.queue_id.unwrap_or_default();
    let completion_state = info.completion_state.unwrap_or_default();
    let teams = details.teams.unwrap_or_default();

    let me_raw = raw_players.iter().find(|p| p.subject == my_puuid)?;
    let my_team = me_raw.team_id.clone().unwrap_or_default();
    let is_ffa = !is_standard_team(&my_team);

    let party_labels = assign_party_labels(&raw_players);

    let mut built: Vec<LastMatchPlayer> = raw_players
        .into_iter()
        .filter(|p| !p.is_observer.unwrap_or(false))
        .map(|p| to_last_match_player(p, my_puuid, &party_labels))
        .collect();

    if built.is_empty() {
        return None;
    }

    built.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.kills.cmp(&a.kills))
            .then_with(|| a.deaths.cmp(&b.deaths))
    });

    let me = built.iter().find(|p| p.is_me).cloned()?;

    let (allies, enemies): (Vec<LastMatchPlayer>, Vec<LastMatchPlayer>) = if is_ffa {
        let allies = vec![me.clone()];
        let enemies = built.into_iter().filter(|p| !p.is_me).collect();
        (allies, enemies)
    } else {
        let mut allies = Vec::new();
        let mut enemies = Vec::new();
        for p in built {
            if p.team_id.eq_ignore_ascii_case(&my_team) {
                allies.push(p);
            } else {
                enemies.push(p);
            }
        }
        (allies, enemies)
    };

    let (ally_score, enemy_score, won, rounds_played) =
        resolve_score(&teams, &my_team, is_ffa, &me, &enemies);

    let placement = if is_ffa {
        let better = enemies.iter().filter(|p| {
            p.kills > me.kills || (p.kills == me.kills && p.score > me.score)
        }).count();
        Some((better + 1) as i32)
    } else {
        None
    };

    Some(LastMatch {
        match_id,
        map_name,
        queue_id,
        game_start_millis: info.game_start_millis.unwrap_or(0),
        game_length_millis: info.game_length_millis,
        ally_score,
        enemy_score,
        won,
        completion_state,
        is_ranked: info.is_ranked.unwrap_or(false),
        is_ffa,
        rounds_played,
        placement,
        me,
        allies,
        enemies,
    })
}

fn resolve_score(
    teams: &[MatchTeam],
    my_team: &str,
    is_ffa: bool,
    me: &LastMatchPlayer,
    enemies: &[LastMatchPlayer],
) -> (i32, i32, Option<bool>, i32) {
    if is_ffa {
        let best_other = enemies.iter().map(|p| p.kills).max().unwrap_or(0);
        let won = teams
            .iter()
            .find(|t| t.team_id.as_deref() == Some(my_team))
            .and_then(|t| t.won)
            .or_else(|| Some(me.kills >= best_other && me.kills > 0));
        return (me.kills, best_other, won, 0);
    }

    let my_row = teams.iter().find(|t| {
        t.team_id
            .as_deref()
            .is_some_and(|id| id.eq_ignore_ascii_case(my_team))
    });
    let their_row = teams.iter().find(|t| {
        t.team_id
            .as_deref()
            .is_some_and(|id| !id.eq_ignore_ascii_case(my_team))
    });

    let ally_score = my_row
        .and_then(|t| t.rounds_won.or(t.num_points))
        .unwrap_or(0);
    let enemy_score = their_row
        .and_then(|t| t.rounds_won.or(t.num_points))
        .unwrap_or(0);
    let rounds_played = my_row
        .and_then(|t| t.rounds_played)
        .unwrap_or(ally_score + enemy_score);

    let won = match (my_row.and_then(|t| t.won), their_row.and_then(|t| t.won)) {
        (Some(true), _) => Some(true),
        (_, Some(true)) => Some(false),
        (Some(false), Some(false)) => None,
        _ if ally_score > enemy_score => Some(true),
        _ if ally_score < enemy_score => Some(false),
        _ => None,
    };

    (ally_score, enemy_score, won, rounds_played)
}

fn apply_resolved_names(m: &mut LastMatch, names: &HashMap<String, String>) {
    let apply = |p: &mut LastMatchPlayer| {
        if let Some(n) = names.get(&p.puuid) {
            if !n.is_empty() {
                p.name = n.clone();
            }
        }
    };
    apply(&mut m.me);
    for p in &mut m.allies {
        apply(p);
    }
    for p in &mut m.enemies {
        apply(p);
    }
}

fn to_last_match_player(
    p: MatchPlayer,
    my_puuid: &str,
    party_labels: &HashMap<String, String>,
) -> LastMatchPlayer {
    let agent = p
        .character_id
        .as_deref()
        .map(get_agent_name)
        .unwrap_or_default();
    let game_name = p.game_name.unwrap_or_default();
    let tag = p.tag_line.unwrap_or_default();
    let name = if game_name.is_empty() {
        capitalize_first(&agent)
    } else if tag.is_empty() {
        game_name
    } else {
        format!("{}#{}", game_name, tag)
    };

    let stats = p.stats.unwrap_or_default();
    let kills = stats.kills.unwrap_or(0);
    let deaths = stats.deaths.unwrap_or(0);
    let assists = stats.assists.unwrap_or(0);
    let score = stats.score.unwrap_or(0);
    let rounds = stats.rounds_played.unwrap_or(0).max(0);
    let acs = if rounds > 0 { score / rounds } else { score };

    LastMatchPlayer {
        puuid: p.subject.clone(),
        name,
        agent,
        team_id: p.team_id.unwrap_or_default(),
        party: party_labels
            .get(&p.subject)
            .cloned()
            .unwrap_or_else(|| "Solo".into()),
        is_me: p.subject == my_puuid,
        rank_tier: p.competitive_tier.unwrap_or(0),
        level: p.account_level.unwrap_or(0),
        player_card_id: p.player_card.filter(|s| !s.is_empty()),
        kills,
        deaths,
        assists,
        score,
        acs,
    }
}

fn assign_party_labels(players: &[MatchPlayer]) -> HashMap<String, String> {
    let mut labels = HashMap::new();
    let mut party_num: HashMap<String, u32> = HashMap::new();
    let mut next = 1u32;

    for p in players {
        if p.party_id.is_empty() {
            labels.insert(p.subject.clone(), "Solo".into());
            continue;
        }
        let num = *party_num.entry(p.party_id.clone()).or_insert_with(|| {
            let n = next;
            next += 1;
            n
        });
        labels.insert(p.subject.clone(), format!("Grup-{}", num));
    }

    let mut sizes: HashMap<String, u32> = HashMap::new();
    for tag in labels.values() {
        *sizes.entry(tag.clone()).or_insert(0) += 1;
    }
    for tag in labels.values_mut() {
        if tag.starts_with("Grup-") && sizes.get(tag).copied().unwrap_or(0) == 1 {
            *tag = "Solo".into();
        }
    }
    labels
}

fn is_standard_team(id: &str) -> bool {
    id.eq_ignore_ascii_case("Blue") || id.eq_ignore_ascii_case("Red")
}

fn map_display_name(map_id: &str) -> String {
    if let Some(name) = MAP_NAMES.get(map_id) {
        return (*name).to_string();
    }
    if map_id.is_empty() {
        return "Unknown".into();
    }
    map_id
        .rsplit('/')
        .next()
        .unwrap_or("Unknown")
        .replace('_', " ")
}

fn get_agent_name(agent_id: &str) -> String {
    for (name, id) in AGENTS.iter() {
        if id.eq_ignore_ascii_case(agent_id) {
            return name.to_string();
        }
    }
    String::new()
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first
            .to_uppercase()
            .chain(chars.flat_map(|c| c.to_lowercase()))
            .collect(),
    }
}
