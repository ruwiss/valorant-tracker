use crate::api::types::*;
use crate::constants::{AGENTS, MAP_NAMES, QUEUE_NAMES};
use crate::state::AppState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri::State;

#[tauri::command]
pub async fn initialize(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    tracing::info!("[Command] initialize() called - attempting to connect to Valorant");

    let result = state.api.initialize().await.map_err(|e| {
        tracing::error!("[Command] initialize() failed: {}", e);
        e.to_string()
    });

    if let Ok(ref status) = result {
        tracing::info!(
            "[Command] initialize() success: connected={}, region={}",
            status.connected,
            status.region
        );
    }

    // Start autolock worker if not already running
    let mut started = state.autolock_worker_started.write();
    if !*started {
        *started = true;
        let api = state.api.clone();
        let auto_lock_agent = state.auto_lock_agent.clone();
        let map_agent_preferences = state.map_agent_preferences.clone();

        tokio::spawn(async move {
            tracing::info!("[Worker] Background autolock worker started");
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                // Check connection first
                if !*api.connected.read() {
                    continue;
                }

                // Check pregame
                if let Some(match_id) = api.get_pregame_match_id().await {
                    if let Some(match_data) = api.get_pregame_match(&match_id).await {
                        // Determine map name
                        let map_name = MAP_NAMES
                            .get(match_data.map_id.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| "Unknown".into());

                        // Determine target agent
                        // Priority: Map Preference > Global Auto Lock
                        // BUT: If global auto_lock is disabled (None), skip map preferences too
                        // This ensures the master toggle controls ALL autolock functionality
                        let global_agent = auto_lock_agent.read().clone();
                        let target_agent = if global_agent.is_some() {
                            // Global enabled - check map preference first, then fall back to global
                            let map_prefs = map_agent_preferences.read();
                            map_prefs.get(&map_name).cloned().or(global_agent)
                        } else {
                            // Global disabled - no autolock at all (respects master toggle)
                            None
                        };

                        if let Some(agent_name) = target_agent {
                            if let Some(agent_id) = AGENTS.get(agent_name.to_lowercase().as_str()) {
                                // Check if already locked to avoid spamming
                                let my_puuid = api.puuid.read().clone();
                                let is_locked = match_data
                                    .ally_team
                                    .as_ref()
                                    .and_then(|team| {
                                        team.players
                                            .iter()
                                            .find(|p| p.subject == my_puuid)
                                            .map(|p| p.character_selection_state == "locked")
                                    })
                                    .unwrap_or(false);

                                if !is_locked {
                                    tracing::info!(
                                        "[Worker] Attempting autolock for {} on match {} (Map: {})",
                                        agent_name,
                                        match_id,
                                        map_name
                                    );
                                    api.select_agent(&match_id, agent_id).await;
                                    // 3 SECOND DELAY BEFORE LOCKING (Requested by user)
                                    tokio::time::sleep(tokio::time::Duration::from_millis(3000))
                                        .await;
                                    api.lock_agent(&match_id, agent_id).await;
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    result
}

#[tauri::command]
pub async fn get_game_state(state: State<'_, AppState>) -> Result<GameState, String> {
    let api = &state.api;

    if !*api.connected.read() {
        return Ok(GameState {
            state: "disconnected".into(),
            match_id: None,
            map_name: None,
            mode_name: None,
            side: None,
            allies: vec![],
            enemies: vec![],
        });
    }

    // Static flags to prevent repeated logging (reset on successful connection)
    static LOCKFILE_WARNED: AtomicBool = AtomicBool::new(false);
    static REINIT_WARNED: AtomicBool = AtomicBool::new(false);

    // PROACTIVE LOCKFILE CHECK: Detect if Riot Client restarted
    // This catches issues BEFORE API calls timeout
    if api.check_lockfile_changed() {
        // Log only once per detection
        if !LOCKFILE_WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!("[get_game_state] Lockfile changed! Riot Client may have restarted. Triggering reinit...");
        }
        *api.needs_reinit.write() = true;
        return Ok(GameState {
            state: "disconnected".into(),
            match_id: None,
            map_name: None,
            mode_name: None,
            side: None,
            allies: vec![],
            enemies: vec![],
        });
    }

    // If tokens need refresh, trigger reconnection instead of returning stale data
    if *api.needs_reinit.read() {
        // Log only once per reinit cycle
        if !REINIT_WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!("[get_game_state] Tokens need refresh, signaling disconnected");
        }
        return Ok(GameState {
            state: "disconnected".into(),
            match_id: None,
            map_name: None,
            mode_name: None,
            side: None,
            allies: vec![],
            enemies: vec![],
        });
    }

    // Reset warning flags when connected successfully (reached this point = no issues)
    LOCKFILE_WARNED.store(false, Ordering::Relaxed);
    REINIT_WARNED.store(false, Ordering::Relaxed);

    // --- RECENT ENCOUNTER TRACKING LOGIC ---
    let coregame_match_id = api.get_coregame_match_id().await;
    let pregame_match_id = if coregame_match_id.is_none() {
        api.get_pregame_match_id().await
    } else {
        None
    };
    let current_is_ingame = coregame_match_id.is_some();
    let current_id = coregame_match_id
        .or(pregame_match_id)
        .unwrap_or_else(|| "idle".to_string());

    {
        let mut last_id_guard = state.current_match_id.write();
        if let Some(ref last_id) = *last_id_guard {
            if last_id != &current_id && current_id != "idle" {
                let was_real_match = *state.current_match_seen_ingame.read();

                if was_real_match {
                    // Match changed after reaching coregame. Push previous match players to history.
                    let players = state.current_match_players.read().clone();
                    if !players.is_empty() {
                        let mut history = state.match_history.write();
                        history.push_front(players);
                        if history.len() > 2 {
                            history.pop_back();
                        }
                        tracing::info!(
                            "[Encounter] Pushed match {} to history. History size: {}",
                            last_id,
                            history.len()
                        );
                    }
                } else {
                    tracing::debug!(
                        "[Encounter] Ignored pregame-only match id change from {} to {}",
                        last_id,
                        current_id
                    );
                }

                state.current_match_players.write().clear();
                *last_id_guard = Some(current_id.clone());
                *state.current_match_seen_ingame.write() = current_is_ingame;
            }
        } else if current_id != "idle" {
            *last_id_guard = Some(current_id.clone());
            *state.current_match_seen_ingame.write() = current_is_ingame;
        } else if current_is_ingame {
            *state.current_match_seen_ingame.write() = true;
        }

        if current_is_ingame {
            *state.current_match_seen_ingame.write() = true;
        }
    }

    let get_encounter_data = |puuid: &str| -> (Option<u32>, Option<String>) {
        let history = state.match_history.read();
        for (i, players) in history.iter().enumerate() {
            if let Some(agent) = players.get(puuid) {
                return (Some((i + 1) as u32), Some(agent.clone()));
            }
        }
        (None, None)
    };
    // ---------------------------------------

    // Check pregame
    if let Some(match_id) = api.get_pregame_match_id().await {
        if let Some(match_data) = api.get_pregame_match(&match_id).await {
            let map_name = MAP_NAMES
                .get(match_data.map_id.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "Unknown".into());
            let mode_name = QUEUE_NAMES
                .get(match_data.queue_id.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| match_data.queue_id.clone());

            let mut allies = vec![];
            let my_puuid = api.puuid.read().clone();

            if let Some(team) = match_data.ally_team {
                let side = if team.team_id == "Red" {
                    "SALDIRAN"
                } else {
                    "SAVUNAN"
                };
                let puuids: Vec<String> = team.players.iter().map(|p| p.subject.clone()).collect();

                let names = api.get_player_names(&puuids).await;

                // Get parties with caching - only fetch once per match
                let parties = get_cached_parties(&state, &match_id, &puuids, api).await;

                // Check if I'm already locked
                let my_player = team.players.iter().find(|p| p.subject == my_puuid);
                let im_locked = my_player
                    .map(|p| p.character_selection_state == "locked")
                    .unwrap_or(false);

                // Auto-lock: keep trying until locked
                if !im_locked {
                    let auto_lock_agent = state.auto_lock_agent.read().clone();
                    if let Some(agent_name) = auto_lock_agent.as_ref() {
                        if let Some(agent_id) = AGENTS.get(agent_name.to_lowercase().as_str()) {
                            api.select_agent(&match_id, agent_id).await;
                            tokio::time::sleep(tokio::time::Duration::from_millis(2200)).await;
                            api.lock_agent(&match_id, agent_id).await;
                        }
                    }
                }

                for p in team.players {
                    let agent_name = get_agent_name(&p.character_id);
                    if p.subject != my_puuid && !agent_name.is_empty() {
                        state
                            .current_match_players
                            .write()
                            .insert(p.subject.clone(), agent_name.clone());
                    }

                    let (previous_encounter, previous_encounter_agent) =
                        get_encounter_data(&p.subject);
                    let level = p.player_identity.map(|i| i.account_level).unwrap_or(0);
                    let party = parties
                        .get(&p.subject)
                        .cloned()
                        .unwrap_or_else(|| "Solo".into());

                    // Use agent name (capitalized) for hidden players
                    let player_name = names.get(&p.subject).cloned().unwrap_or_default();
                    let display_name = if player_name.is_empty() {
                        capitalize_first(&agent_name)
                    } else {
                        player_name
                    };

                    allies.push(PlayerData {
                        puuid: p.subject.clone(),
                        name: display_name,
                        agent: agent_name,
                        locked: p.character_selection_state == "locked",
                        party,
                        is_me: p.subject == my_puuid,
                        rank_tier: p.competitive_tier,
                        rank_rr: 0,
                        level,
                        previous_encounter,
                        previous_encounter_agent,
                    });
                }

                // Reset idle counter and update last known state on successful pregame
                *state.consecutive_idle_count.write() = 0;
                *state.last_known_state.write() = "pregame".to_string();

                return Ok(GameState {
                    state: "pregame".into(),
                    match_id: Some(match_id),
                    map_name: Some(map_name),
                    mode_name: Some(mode_name),
                    side: Some(side.into()),
                    allies,
                    enemies: vec![],
                });
            }
        }
    }

    // Check coregame
    if let Some(match_id) = api.get_coregame_match_id().await {
        if let Some(match_data) = api.get_coregame_match(&match_id).await {
            let map_name = MAP_NAMES
                .get(match_data.map_id.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "Unknown".into());

            let my_puuid = api.puuid.read().clone();
            let puuids: Vec<String> = match_data
                .players
                .iter()
                .map(|p| p.subject.clone())
                .collect();

            let names = api.get_player_names(&puuids).await;

            // Get parties with caching
            let parties = get_cached_parties(&state, &match_id, &puuids, api).await;

            let my_team = match_data
                .players
                .iter()
                .find(|p| p.subject == my_puuid)
                .map(|p| p.team_id.clone())
                .unwrap_or_default();

            let mut allies = vec![];
            let mut enemies = vec![];

            for p in match_data.players {
                let agent_name = get_agent_name(&p.character_id);
                if p.subject != my_puuid && !agent_name.is_empty() {
                    state
                        .current_match_players
                        .write()
                        .insert(p.subject.clone(), agent_name.clone());
                }

                let (previous_encounter, previous_encounter_agent) = get_encounter_data(&p.subject);
                let level = p.player_identity.map(|i| i.account_level).unwrap_or(0);
                let rank = p.seasonal_badge_info.and_then(|s| s.rank).unwrap_or(0);
                let party = parties
                    .get(&p.subject)
                    .cloned()
                    .unwrap_or_else(|| "Solo".into());

                // Use agent name (capitalized) for hidden players
                let player_name = names.get(&p.subject).cloned().unwrap_or_default();
                let display_name = if player_name.is_empty() {
                    capitalize_first(&agent_name)
                } else {
                    player_name
                };

                let player = PlayerData {
                    puuid: p.subject.clone(),
                    name: display_name,
                    agent: agent_name,
                    locked: true,
                    party,
                    is_me: p.subject == my_puuid,
                    rank_tier: rank,
                    rank_rr: 0,
                    level,
                    previous_encounter,
                    previous_encounter_agent,
                };

                if p.team_id == my_team {
                    allies.push(player);
                } else {
                    enemies.push(player);
                }
            }

            // Reset idle counter and update last known state on successful ingame
            *state.consecutive_idle_count.write() = 0;
            *state.last_known_state.write() = "ingame".to_string();

            return Ok(GameState {
                state: "ingame".into(),
                match_id: Some(match_id),
                map_name: Some(map_name),
                mode_name: None,
                side: None,
                allies,
                enemies,
            });
        }
    }

    // If we were in a game session and now getting no match data,
    // check if this is a real transition or just an API failure
    let was_in_game = *state.in_game_session.read();
    let last_state = state.last_known_state.read().clone();

    // Check for signs of API issues that might cause false "idle" state
    let network_errors = *api.consecutive_network_errors.read();
    if was_in_game && network_errors > 0 {
        // We were in a game but getting network errors - don't trust this "idle" state
        tracing::warn!("[get_game_state] In-game session with {} network errors, returning disconnected instead of idle", network_errors);
        return Ok(GameState {
            state: "disconnected".into(),
            match_id: None,
            map_name: None,
            mode_name: None,
            side: None,
            allies: vec![],
            enemies: vec![],
        });
    }

    // DEBOUNCE: If we were in pregame/ingame, require 3 consecutive idle responses
    // before actually transitioning to idle. This prevents false idle transitions
    // when API temporarily fails to return match data.
    const IDLE_DEBOUNCE_THRESHOLD: u32 = 3;

    if last_state == "pregame" || last_state == "ingame" {
        let mut idle_count = state.consecutive_idle_count.write();
        *idle_count += 1;

        if *idle_count < IDLE_DEBOUNCE_THRESHOLD {
            tracing::debug!(
                "[get_game_state] Idle debounce: {} (was {}), waiting for {} more confirmations",
                *idle_count,
                last_state,
                IDLE_DEBOUNCE_THRESHOLD - *idle_count
            );
            // Return the last known state to maintain UI stability
            return Ok(GameState {
                state: last_state.clone(),
                match_id: None,
                map_name: None,
                mode_name: None,
                side: None,
                allies: vec![],
                enemies: vec![],
            });
        }

        // Threshold reached - this is a real transition
        tracing::info!(
            "[get_game_state] Idle confirmed after {} checks, transitioning {} -> idle",
            *idle_count,
            last_state
        );
        *idle_count = 0;
    }

    // Clear party cache when idle (no match) - only if we were in a game session
    if was_in_game {
        // Returning to lobby - clear all caches for next game
        state.cached_parties.write().clear();
        state.fetched_history_players.write().clear();
        *state.cached_parties_match_id.write() = None;
        *state.in_game_session.write() = false;
    }

    // Update last known state to idle
    *state.last_known_state.write() = "idle".to_string();

    Ok(GameState {
        state: "idle".into(),
        match_id: None,
        map_name: None,
        mode_name: None,
        side: None,
        allies: vec![],
        enemies: vec![],
    })
}

/// Get parties with caching - persists across pregame->ingame transition
/// Only clears when returning to idle state (lobby) OR when match_id changes
async fn get_cached_parties(
    state: &State<'_, AppState>,
    match_id: &str,
    puuids: &[String],
    api: &crate::api::ValorantAPI,
) -> HashMap<String, String> {
    // Mark that we're in a game session
    *state.in_game_session.write() = true;

    // Check if match changed - if so, clear all caches for fresh party detection
    {
        let cached_match_id = state.cached_parties_match_id.read().clone();
        if cached_match_id.as_deref() != Some(match_id) {
            // Match changed! Clear all party-related caches
            if cached_match_id.is_some() {
                tracing::info!(
                    "[get_cached_parties] Match changed from {:?} to {}, clearing party cache",
                    cached_match_id,
                    match_id
                );
            }
            state.cached_parties.write().clear();
            state.fetched_history_players.write().clear();
            *state.cached_parties_match_id.write() = Some(match_id.to_string());
        }
    }

    // Get existing cached parties
    let cached = state.cached_parties.read().clone();

    // Check if all players are already cached
    let all_cached = puuids.iter().all(|p| cached.contains_key(p));
    if all_cached {
        return cached;
    }

    // Determine which players need history fetch (not fetched before this game session)
    let players_needing_fetch: Vec<String> = {
        let fetched = state.fetched_history_players.read();
        puuids
            .iter()
            .filter(|p| !fetched.contains(*p))
            .cloned()
            .collect()
    };

    // If no new players to fetch, return existing cache + mark missing as Solo
    if players_needing_fetch.is_empty() {
        let mut result = cached;
        for puuid in puuids {
            if !result.contains_key(puuid) {
                result.insert(puuid.clone(), "Solo".into());
            }
        }
        return result;
    }

    // Fetch parties - pass ALL puuids but only fetch history for new players
    // This ensures consistent party numbering across the entire lobby
    let new_parties = api
        .detect_parties_with_cache(puuids, &players_needing_fetch, &cached)
        .await;

    // Mark these players as fetched
    {
        let mut fetched = state.fetched_history_players.write();
        for p in &players_needing_fetch {
            fetched.insert(p.clone());
        }
    }

    // Update party cache with merged result
    *state.cached_parties.write() = new_parties.clone();

    new_parties
}

#[tauri::command]
pub fn set_auto_lock(state: State<'_, AppState>, agent: Option<String>) {
    *state.auto_lock_agent.write() = agent;
}

#[tauri::command]
pub fn get_auto_lock(state: State<'_, AppState>) -> Option<String> {
    state.auto_lock_agent.read().clone()
}

#[tauri::command]
pub fn set_map_preferences(state: State<'_, AppState>, preferences: HashMap<String, String>) {
    *state.map_agent_preferences.write() = preferences;
}

fn get_agent_name(agent_id: &str) -> String {
    for (name, id) in AGENTS.iter() {
        if id.eq_ignore_ascii_case(agent_id) {
            return name.to_string();
        }
    }
    String::new()
}

/// Capitalize first letter, lowercase the rest (e.g., "jett" -> "Jett", "REYNA" -> "Reyna")
fn capitalize_first(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first
            .to_uppercase()
            .chain(chars.flat_map(|c| c.to_lowercase()))
            .collect(),
    }
}

#[tauri::command]
pub async fn get_player_loadout(
    state: State<'_, AppState>,
    puuid: String,
) -> Result<Option<crate::api::types::PlayerSkinData>, String> {
    let api = &state.api;

    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    // Try to get match id - first check coregame, then pregame
    let (match_id, is_pregame) = if let Some(id) = api.get_coregame_match_id().await {
        (id, false)
    } else if let Some(id) = api.get_pregame_match_id().await {
        (id, true)
    } else {
        return Err("Not in game".into());
    };

    // Check cache first (only if NOT pregame - in pregame we want fresh data for skin changes)
    if !is_pregame {
        let cached = state.cached_loadouts.read();
        if let Some(loadout) = cached.get(&puuid) {
            return Ok(Some(loadout.clone()));
        }
    }

    // Check if match changed - clear cache
    {
        let cached_match = state.loadouts_match_id.read();
        if cached_match.as_ref() != Some(&match_id) {
            drop(cached_match);
            state.cached_loadouts.write().clear();
            *state.loadouts_match_id.write() = Some(match_id.clone());
        }
    }

    // Fetch loadouts based on game state
    if is_pregame {
        // Pregame loadouts
        if let Some(loadouts_response) = api.get_pregame_loadouts(&match_id).await {
            let mut cache = state.cached_loadouts.write();

            for loadout_data in loadouts_response.loadouts {
                let player_puuid = loadout_data.subject.clone();
                let mut skins = Vec::new();

                for (weapon_id, item) in loadout_data.items {
                    let mut chroma_id = None;
                    let mut buddy_id = None;

                    if let Some(sockets) = &item.sockets {
                        for (_socket_id, socket_item) in sockets {
                            // Chroma/Skin Variant
                            if socket_item.item.type_id == "3ad1b2b2-acdb-4524-852f-954a76ddae0a" {
                                chroma_id = Some(socket_item.item.id.clone());
                            }
                            // Gun Buddy
                            if socket_item.item.type_id == "dd3bf334-87f3-40bd-b043-682a57a8dc3a" {
                                buddy_id = Some(socket_item.item.id.clone());
                            }
                        }
                    }

                    skins.push(crate::api::types::WeaponSkin {
                        weapon_id,
                        skin_id: item.id,
                        chroma_id,
                        buddy_id,
                    });
                }

                cache.insert(
                    player_puuid.clone(),
                    crate::api::types::PlayerSkinData {
                        puuid: player_puuid,
                        skins,
                    },
                );
            }

            return Ok(cache.get(&puuid).cloned());
        }
    } else {
        // Coregame loadouts
        if let Some(loadouts_response) = api.get_coregame_loadouts(&match_id).await {
            let mut cache = state.cached_loadouts.write();

            for player_loadout in loadouts_response.loadouts {
                let player_puuid = player_loadout.loadout.subject.clone();
                let mut skins = Vec::new();

                for (weapon_id, item) in player_loadout.loadout.items {
                    let mut chroma_id = None;
                    let mut buddy_id = None;

                    if let Some(sockets) = &item.sockets {
                        for (_socket_id, socket_item) in sockets {
                            // Chroma/Skin Variant
                            if socket_item.item.type_id == "3ad1b2b2-acdb-4524-852f-954a76ddae0a" {
                                chroma_id = Some(socket_item.item.id.clone());
                            }
                            // Gun Buddy
                            if socket_item.item.type_id == "dd3bf334-87f3-40bd-b043-682a57a8dc3a" {
                                buddy_id = Some(socket_item.item.id.clone());
                            }
                        }
                    }

                    skins.push(crate::api::types::WeaponSkin {
                        weapon_id,
                        skin_id: item.id,
                        chroma_id,
                        buddy_id,
                    });
                }

                cache.insert(
                    player_puuid.clone(),
                    crate::api::types::PlayerSkinData {
                        puuid: player_puuid,
                        skins,
                    },
                );
            }

            return Ok(cache.get(&puuid).cloned());
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn get_chat_messages(
    state: State<'_, AppState>,
    cid: Option<String>,
) -> Result<Vec<ChatMessage>, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    tracing::debug!("[get_chat_messages] Request with CID: {:?}", cid);

    if let Some(history) = api.get_chat_history(cid.as_deref()).await {
        tracing::debug!(
            "[get_chat_messages] Returning {} messages",
            history.messages.len()
        );
        Ok(history.messages)
    } else {
        tracing::debug!("[get_chat_messages] No history returned");
        Ok(vec![])
    }
}

#[tauri::command]
pub async fn get_active_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<Conversation>, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    if let Some(mut convs) = api.get_conversations().await {
        // Enhance DM conversations with player names
        let mut puuids = Vec::new();
        for conv in &convs.conversations {
            if conv.conversation_type == "chat" && !conv.cid.contains('@') {
                // Try to guess PUUID from CID if it IS a PUUID (DM conversations usually are)
                // But wait, the CID for DMs is usually "puuid@ares-parties.glz" or just a UUID
                // Let's safe check if the CID looks like a UUID
                if conv.cid.len() == 36 {
                    puuids.push(conv.cid.clone());
                }
            }
        }

        if !puuids.is_empty() {
            let names = api.get_player_names(&puuids).await;
            for conv in &mut convs.conversations {
                if conv.conversation_type == "chat" && conv.cid.len() == 36 {
                    if let Some(name) = names.get(&conv.cid) {
                        conv.game_name = Some(name.clone());
                    }
                }
            }
        }

        Ok(convs.conversations)
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    cid: String,
    message: String,
    message_type: String,
) -> Result<bool, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    tracing::debug!("[send_message] CID: {}, Type: {}", cid, message_type);

    // Direct send - CID should be correct (PID for DMs or actual CID for groups)
    if api
        .send_chat_message(&cid, &message, &message_type)
        .await
        .is_some()
    {
        tracing::info!("[send_message] Message sent successfully");
        return Ok(true);
    }

    tracing::error!("[send_message] Send failed");
    Ok(false)
}

#[tauri::command]
pub async fn get_paginated_chat_messages(
    state: State<'_, AppState>,
    cid: Option<String>,
    page: usize,
    page_size: usize,
) -> Result<PaginatedMessages, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    if let Some(history) = api.get_chat_history(cid.as_deref()).await {
        let total = history.messages.len();
        // Sort by time descending (newest first) for pagination slicing
        // But we want to return them in chronological order for chat view
        let mut all_msgs = history.messages;
        all_msgs.sort_by(|a, b| b.time.cmp(&a.time)); // Sort Newest -> Oldest

        let start = page * page_size;
        let end = (start + page_size).min(total);

        if start >= total {
            return Ok(PaginatedMessages {
                messages: vec![],
                total,
                page,
                page_size,
                has_next: false,
                has_prev: page > 0,
            });
        }

        let mut messages: Vec<ChatMessage> =
            all_msgs.into_iter().skip(start).take(page_size).collect();

        // Re-sort to Oldest -> Newest for display
        messages.sort_by(|a, b| a.time.cmp(&b.time));

        Ok(PaginatedMessages {
            messages,
            total,
            page,
            page_size,
            has_next: end < total,
            has_prev: page > 0,
        })
    } else {
        Ok(PaginatedMessages {
            messages: vec![],
            total: 0,
            page,
            page_size,
            has_next: false,
            has_prev: false,
        })
    }
}

#[tauri::command]
pub async fn get_friends(state: State<'_, AppState>) -> Result<Vec<Friend>, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    if let Some(friends) = api.get_friends().await {
        Ok(friends.friends)
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
pub async fn get_dm_cid(
    state: State<'_, AppState>,
    friend_puuid: String,
) -> Result<String, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    tracing::debug!("[get_dm_cid] Finding CID for friend: {}", friend_puuid);

    // 1. Try to find existing conversation CID from messages
    if let Some(cid) = api.find_dm_cid(&friend_puuid).await {
        tracing::debug!("[get_dm_cid] Found existing CID from messages: {}", cid);
        return Ok(cid);
    }

    // 2. Try to find from active conversations
    if let Some(convs) = api.get_conversations().await {
        for conv in convs.conversations {
            if conv.conversation_type == "chat" && conv.direct_messages {
                // Check participants
                if let Some(participants) = api.get_chat_participants(Some(&conv.cid)).await {
                    for p in participants.participants {
                        if p.puuid == friend_puuid {
                            tracing::debug!(
                                "[get_dm_cid] Found CID from conversations: {}",
                                conv.cid
                            );
                            return Ok(conv.cid);
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback: Get friend's PID and use it as CID
    if let Some(friends) = api.get_friends().await {
        for friend in friends.friends {
            if friend.puuid == friend_puuid {
                tracing::debug!("[get_dm_cid] Using friend PID as CID: {}", friend.pid);
                return Ok(friend.pid);
            }
        }
    }

    Err("Friend not found".into())
}

/// Get a cached image from disk or download it if not cached
/// Returns base64 data URL for direct use in img src
/// If check_only is true, only checks cache without downloading
#[tauri::command]
pub async fn get_cached_image(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    check_only: Option<bool>,
) -> Result<Option<String>, String> {
    // Only allow valorant-api.com URLs for security
    if !url.starts_with("https://media.valorant-api.com/") {
        return Err("Invalid image URL".into());
    }

    let check_only = check_only.unwrap_or(false);

    // Create a filename from URL hash
    let hash = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        format!("{:x}", hasher.finish())
    };

    // Get cache directory
    let cache_dir: PathBuf = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("images");

    // Ensure cache directory exists
    if !cache_dir.exists() {
        if check_only {
            return Ok(None);
        }
        std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    }

    let cache_path = cache_dir.join(format!("{}.png", hash));

    // Check if cached
    if cache_path.exists() {
        // Read from cache
        let data = std::fs::read(&cache_path).map_err(|e| e.to_string())?;
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
        return Ok(Some(format!("data:image/png;base64,{}", base64)));
    }

    // If check_only, don't download
    if check_only {
        return Ok(None);
    }

    // Download and cache using SHARED client (Pooling enabled)
    match state.http_client.get(&url).send().await {
        Ok(response) => {
            if !response.status().is_success() {
                return Ok(None);
            }
            match response.bytes().await {
                Ok(bytes) => {
                    // Save to cache (ignore errors - caching is optional)
                    let _ = std::fs::write(&cache_path, &bytes);

                    let base64 =
                        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
                    Ok(Some(format!("data:image/png;base64,{}", base64)))
                }
                Err(_) => Ok(None),
            }
        }
        Err(_) => Ok(None),
    }
}
#[tauri::command]
pub async fn get_tracker_stats(
    state: State<'_, AppState>,
    player_name: String,
) -> Result<serde_json::Value, String> {
    tracing::info!("[Command] get_tracker_stats() for player: {}", player_name);
    state
        .api
        .get_tracker_stats(&player_name)
        .await
        .map_err(|e| {
            tracing::error!("[Command] get_tracker_stats() failed: {}", e);
            e.to_string()
        })
}

/// Peak rank response type
#[derive(serde::Serialize)]
pub struct PeakRankResponse {
    pub tier: u32,
    pub rank_name: String,
    pub rank_color: String,
    pub season_id: String,
}

/// Get player's peak rank across all competitive seasons
#[tauri::command]
pub async fn get_peak_rank(
    state: State<'_, AppState>,
    puuid: String,
) -> Result<Option<PeakRankResponse>, String> {
    let api = &state.api;

    tracing::info!("[Command] get_peak_rank called for puuid: {}", puuid);

    if !*api.connected.read() {
        tracing::warn!("[Command] get_peak_rank: Not connected");
        return Err("Not connected".into());
    }

    match api.get_player_peak_rank(&puuid).await {
        Some((tier, rank_name, rank_color, season_id)) => {
            tracing::info!("[Command] get_peak_rank success: {} ({})", rank_name, tier);
            Ok(Some(PeakRankResponse {
                tier,
                rank_name,
                rank_color,
                season_id,
            }))
        }
        None => {
            tracing::info!("[Command] get_peak_rank: No peak rank found");
            Ok(None)
        }
    }
}

// ==================== License Commands (DEACTIVATED - APP IS FREE) ====================

#[derive(serde::Serialize)]
pub struct MachineIdResponse {
    pub machine_id: String,
    pub components: HashMap<String, String>,
}

#[derive(serde::Serialize)]
pub struct LicenseRequestData {
    pub machine_id: String,
    pub hashes: HashMap<String, String>,
}

#[derive(serde::Serialize)]
#[serde(tag = "status")]
pub enum LicenseStatus {
    Valid {
        license_id: String,
        expires_at: Option<i64>,
        score: u8,
    },
    #[allow(dead_code)]
    Invalid { reason: String },
    #[allow(dead_code)]
    NotFound,
    #[allow(dead_code)]
    Expired { expired_at: i64 },
}

#[derive(serde::Serialize)]
pub struct LicenseValidation {
    pub is_valid: bool,
    pub score: u8,
    pub threshold: u8,
    pub matched_components: Vec<String>,
    pub mismatched_components: Vec<String>,
    pub expires_at: Option<i64>,
    pub license_id: String,
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LicenseData {
    pub hardware_hashes: HashMap<String, String>,
    pub weights: HashMap<String, u8>,
    pub threshold: u8,
    pub expires_at: Option<i64>,
    pub issued_at: i64,
    pub license_id: String,
}

/// Get the Machine ID for this computer
#[tauri::command]
pub fn get_machine_id(_state: State<'_, AppState>) -> Result<MachineIdResponse, String> {
    Ok(MachineIdResponse {
        machine_id: "FREE-VERSION".into(),
        components: HashMap::new(),
    })
}

/// Get full license request data (machine_id + hashes) for keygen - copy & paste into keygen
#[tauri::command]
pub fn get_license_request_data(_state: State<'_, AppState>) -> Result<LicenseRequestData, String> {
    Ok(LicenseRequestData {
        machine_id: "FREE-VERSION".into(),
        hashes: HashMap::new(),
    })
}

/// Get encrypted activation code (single string)
#[tauri::command]
pub fn get_activation_code(_state: State<'_, AppState>) -> Result<String, String> {
    Ok("FREE-VERSION".into())
}

/// Check the current license status
#[tauri::command]
pub fn check_license(_state: State<'_, AppState>) -> LicenseStatus {
    LicenseStatus::Valid {
        license_id: "FREE-VERSION".into(),
        expires_at: None,
        score: 100,
    }
}

/// Import a license file from the given path
#[tauri::command]
pub fn import_license(
    _state: State<'_, AppState>,
    _path: String,
) -> Result<LicenseValidation, String> {
    Ok(LicenseValidation {
        is_valid: true,
        score: 100,
        threshold: 0,
        matched_components: vec![],
        mismatched_components: vec![],
        expires_at: None,
        license_id: "FREE-VERSION".into(),
        error: None,
    })
}

/// Get license info (if valid)
#[tauri::command]
pub fn get_license_info(_state: State<'_, AppState>) -> Option<LicenseData> {
    Some(LicenseData {
        hardware_hashes: HashMap::new(),
        weights: HashMap::new(),
        threshold: 0,
        expires_at: None,
        issued_at: 0,
        license_id: "Lifetime License".into(),
    })
}

/// Reset/Delete the current license
#[tauri::command]
pub fn reset_license(_state: State<'_, AppState>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_always_on_top(window: tauri::Window, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn focus_window(window: tauri::Window) -> Result<(), String> {
    window.set_focus().map_err(|e| e.to_string())
}

/// Open the log file in the default text editor
#[tauri::command]
pub fn log_frontend_message(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!("[Frontend] {}", message),
        "warn" => tracing::warn!("[Frontend] {}", message),
        "info" => tracing::info!("[Frontend] {}", message),
        "debug" => tracing::debug!("[Frontend] {}", message),
        _ => tracing::info!("[Frontend] [{}] {}", level, message),
    }
}

#[tauri::command]
pub fn open_log_file(app: tauri::AppHandle) -> Result<(), String> {
    let log_path = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?
        .join("app.log");

    tracing::info!("[Command] open_log_file() - path: {:?}", log_path);

    if !log_path.exists() {
        tracing::warn!("[Command] Log file not found at {:?}", log_path);
        return Err("Log file not found".into());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("notepad")
            .arg(&log_path)
            .spawn()
            .map_err(|e| {
                tracing::error!("[Command] Failed to open notepad: {}", e);
                e.to_string()
            })?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&log_path)
            .spawn()
            .map_err(|e| {
                tracing::error!("[Command] Failed to open xdg-open: {}", e);
                e.to_string()
            })?;
    }

    Ok(())
}
