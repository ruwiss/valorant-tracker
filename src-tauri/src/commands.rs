use crate::api::types::*;
use crate::api::{MatchProbe, RemoteResult};
use crate::constants::{AGENTS, MAP_NAMES, QUEUE_NAMES};
use crate::state::{AppState, EncounterPlayer};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

#[derive(serde::Serialize, Clone)]
pub struct ConnectionEvent {
    pub status: String, // "connected" | "connecting" | "waiting_for_game" | "paused"
    pub region: String,
}

/// Emit a `connection_changed` event only when it differs from the last one.
fn emit_connection(app: &tauri::AppHandle, last_json: &mut String, status: &str, region: &str) {
    let ev = ConnectionEvent {
        status: status.to_string(),
        region: region.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&ev) {
        if json != *last_json {
            let _ = app.emit("connection_changed", &ev);
            *last_json = json;
        }
    }
}

/// Force a connection attempt now. Kept for compatibility / manual use; the
/// supervisor below owns the ongoing connection lifecycle.
#[tauri::command]
pub async fn initialize(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    tracing::info!("[Command] initialize() called - forcing a connection attempt");
    state.api.initialize().await.map_err(|e| {
        tracing::error!("[Command] initialize() failed: {}", e);
        e.to_string()
    })
}

#[derive(serde::Serialize, Clone)]
pub struct PresetAppliedEvent {
    pub ok: bool,
    pub preset_id: String,
    pub error: Option<String>,
}

/// If a preset is armed, apply it to the just-connected account, then disarm.
/// Emits `preset_auto_applied` to the frontend with the result. Runs from the
/// supervisor right after a fresh connection is established.
async fn try_apply_armed_preset(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();

    // Take the armed preset (clear it so we don't retry on every tick).
    let armed = { state.armed_preset.write().take() };
    let Some(armed) = armed else {
        return;
    };

    let Some(store) = state.presets.read().clone() else {
        return;
    };
    let Some(preset) = store.get(&armed.id) else {
        tracing::warn!("[ArmedPreset] preset {} no longer exists", armed.id);
        return;
    };

    tracing::info!("[ArmedPreset] Applying armed preset to fresh connection");
    let api = state.api.clone();
    let result = run_apply(&api, &store, &preset, &armed.backup_label).await;

    let ev = match &result {
        Ok(_) => {
            tracing::info!("[ArmedPreset] Applied successfully");
            PresetAppliedEvent {
                ok: true,
                preset_id: armed.id.clone(),
                error: None,
            }
        }
        Err(e) => {
            tracing::error!("[ArmedPreset] Apply failed: {}", e);
            PresetAppliedEvent {
                ok: false,
                preset_id: armed.id.clone(),
                error: Some(e.clone()),
            }
        }
    };
    let _ = app.emit("preset_auto_applied", &ev);
}

/// Single background supervisor that OWNS the connection lifecycle:
/// connect -> watch game state -> self-reconnect on token/lockfile changes ->
/// drive autolock. Emits `connection_changed` and `game_state_changed` events.
/// Started once from lib.rs `setup()`.
pub fn start_supervisor(app: tauri::AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut started = state.supervisor_started.write();
        if *started {
            return;
        }
        *started = true;
    }

    let api = app.state::<AppState>().api.clone();
    let auto_lock_agent = app.state::<AppState>().auto_lock_agent.clone();
    let auto_lock_delay_ms = app.state::<AppState>().auto_lock_delay_ms.clone();
    let map_agent_preferences = app.state::<AppState>().map_agent_preferences.clone();
    let discord = app.state::<AppState>().discord.clone();

    tauri::async_runtime::spawn(async move {
        tracing::info!("[Supervisor] Started (connect + watch + reconnect + autolock)");
        let mut last_emitted_state_json = String::new();
        let mut last_conn_json = String::new();
        let mut last_phase = String::new();
        let autolock_in_progress = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut backoff_ms: u64 = 1000;
        const MAX_BACKOFF_MS: u64 = 10_000;
        // Count consecutive failed (re)connect attempts. While below the
        // threshold we keep emitting "connecting" instead of "waiting_for_game"
        // so a brief token/lockfile hiccup mid-match does NOT wipe the live
        // pregame/ingame panel (the frontend resets gameState on WAITING_FOR_GAME).
        let mut consecutive_connect_failures: u32 = 0;
        const WAITING_AFTER_FAILURES: u32 = 3;

        // Adaptive poll interval. Live match is 1s — enough for autolock/score
        // and match-end without hammering GLZ/presence every half-second.
        // Menus / pause / waiting can sleep longer.
        const POLL_LIVE_MS: u64 = 1000; // pregame + ingame
        const POLL_IDLE_MS: u64 = 2000; // menus / idle
        const POLL_PAUSED_MS: u64 = 2000; // user paused watching
        const POLL_WAITING_MS: u64 = 1500; // connecting / waiting for game
        let mut poll_interval_ms: u64 = POLL_WAITING_MS;
        // Manual reconnect (or a mid-poll disconnect) should re-init on the next
        // iteration without waiting out the current idle/live interval.
        let mut skip_sleep = false;

        loop {
            if !skip_sleep {
                tokio::time::sleep(tokio::time::Duration::from_millis(poll_interval_ms)).await;
            }
            skip_sleep = false;

            // 0. Respect user pause - stop watching but keep the task alive.
            if *app.state::<AppState>().is_paused.read() {
                poll_interval_ms = POLL_PAUSED_MS;
                emit_connection(&app, &mut last_conn_json, "paused", "");
                discord.update(&GameState::default(), "paused");
                continue;
            }

            // 1. Ensure the connection. The backend now OWNS reconnection: if we
            // are disconnected or our tokens went stale, re-initialize here with
            // backoff instead of waiting for the frontend to ask.
            let connected = *api.connected.read();
            let needs_reinit = *api.needs_reinit.read();
            if !connected || needs_reinit {
                poll_interval_ms = POLL_WAITING_MS;
                emit_connection(&app, &mut last_conn_json, "connecting", "");

                // Game process gone (quit to desktop / range exit + close): drop the
                // live cache immediately so we don't keep a phantom LIVE panel.
                if !crate::process::is_game_running() {
                    {
                        let state = app.state::<AppState>();
                        drop_range_or_dead_cache(&state);
                    }
                    let idle = GameState {
                        state: "idle".into(),
                        ..Default::default()
                    };
                    if let Ok(json) = serde_json::to_string(&idle) {
                        if json != last_emitted_state_json {
                            let _ = app.emit("game_state_changed", &idle);
                            last_emitted_state_json = json;
                        }
                    }
                    discord.update(&idle, "waiting_for_game");
                    emit_connection(&app, &mut last_conn_json, "waiting_for_game", "");
                    poll_interval_ms = POLL_WAITING_MS;
                    consecutive_connect_failures = WAITING_AFTER_FAILURES;
                    tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 3 / 2).min(MAX_BACKOFF_MS);
                    continue;
                }

                // Mid-match token blip: keep feeding the last live snapshot so the
                // UI never falls through to the waiting screen while we reconnect.
                let was_live = {
                    let last = app.state::<AppState>().last_known_state.read().clone();
                    last == "pregame" || last == "ingame"
                };
                if was_live {
                    if let Some(cached) =
                        app.state::<AppState>().last_full_game_state.read().clone()
                    {
                        if let Ok(json) = serde_json::to_string(&cached) {
                            if json != last_emitted_state_json {
                                let _ = app.emit("game_state_changed", &cached);
                                last_emitted_state_json = json;
                            }
                        }
                        discord.update(&cached, "connecting");
                    }
                }

                match api.initialize().await {
                    Ok(status) => {
                        backoff_ms = 1000;
                        consecutive_connect_failures = 0;
                        tracing::info!("[Supervisor] Connected (region={})", status.region);
                        emit_connection(&app, &mut last_conn_json, "connected", &status.region);

                        // Reset idle and menus debounce counters upon a successful reconnection/token refresh.
                        // This prevents any transient API delays immediately following reconnection from
                        // triggering a premature transition to "idle" (which would clear or disrupt states).
                        {
                            let state = app.state::<AppState>();
                            *state.consecutive_idle_count.write() = 0;
                            *state.consecutive_menus_count.write() = 0;
                        }

                        // Force the next poll to re-emit the current game state even
                        // if it is unchanged. The frontend may have reset its panel to
                        // "waiting" while we were reconnecting; without this the
                        // identical-JSON guard below would suppress the re-emit and the
                        // UI would stay stuck on the waiting screen until a manual
                        // refresh.
                        last_emitted_state_json.clear();
                        // Next tick should be responsive so we pick up pregame ASAP.
                        poll_interval_ms = POLL_LIVE_MS;

                        // Fresh token just arrived. If a preset is armed, apply it
                        // now — before the game reads its settings (~46s window).
                        try_apply_armed_preset(&app).await;

                        // Idle recap: last completed match (map + score).
                        crate::last_match::spawn_refresh(
                            app.clone(),
                            crate::last_match::LastMatchReason::Connected,
                        );
                    }
                    Err(e) => {
                        consecutive_connect_failures += 1;
                        tracing::debug!(
                            "[Supervisor] Connect failed (#{}): {} (retry in {}ms)",
                            consecutive_connect_failures,
                            e,
                            backoff_ms
                        );
                        // Never advertise "waiting_for_game" while we still believe a
                        // match is live — that status is what drives the waiting
                        // screen. Keep "connecting" so the UI holds the live panel
                        // and we keep retrying until tokens recover or the match ends.
                        if consecutive_connect_failures >= WAITING_AFTER_FAILURES && !was_live {
                            emit_connection(&app, &mut last_conn_json, "waiting_for_game", "");
                            discord.update(&GameState::default(), "waiting_for_game");
                        } else {
                            emit_connection(&app, &mut last_conn_json, "connecting", "");
                        }
                        tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                        backoff_ms = (backoff_ms * 3 / 2).min(MAX_BACKOFF_MS);
                        continue;
                    }
                }
            }

            // 2. Poll the current game state and push it to the frontend.
            if let Ok(current_state) = get_game_state_internal(&app.state::<AppState>()).await {
                // Emit game state only when it changed - including "disconnected"
                // so the UI resets away from a stale pregame/ingame panel.
                if let Ok(current_json) = serde_json::to_string(&current_state) {
                    if current_json != last_emitted_state_json {
                        tracing::debug!("[Supervisor] Game state changed, emitting to frontend.");
                        let _ = app.emit("game_state_changed", &current_state);
                        last_emitted_state_json = current_json;
                    }
                }

                // Live match just ended → refresh last-match recap (details lag).
                let phase = current_state.state.as_str();
                if (last_phase == "pregame" || last_phase == "ingame") && phase == "idle" {
                    crate::last_match::spawn_refresh(
                        app.clone(),
                        crate::last_match::LastMatchReason::MatchEnd,
                    );
                }
                last_phase = phase.to_string();

                // Pace the next tick from the phase we just observed.
                poll_interval_ms = match current_state.state.as_str() {
                    "pregame" | "ingame" => POLL_LIVE_MS,
                    "disconnected" => POLL_WAITING_MS,
                    _ => POLL_IDLE_MS, // idle / menus
                };

                // A disconnect detected mid-poll: reconnect on the next tick.
                // Note: when a live snapshot is cached, get_game_state_internal
                // returns that snapshot instead of empty "disconnected", so we
                // only hit this on a true cold disconnect with no cache.
                if current_state.state == "disconnected" {
                    *api.needs_reinit.write() = true;
                    skip_sleep = true;
                    continue;
                }

                // A manual reconnect (or lockfile/token refresh) was requested
                // during this poll. Do not advertise "connected" — that was
                // overwriting the UI's RECONNECTING state instantly — and skip
                // the next sleep so initialize() runs immediately.
                if *api.needs_reinit.read() {
                    emit_connection(&app, &mut last_conn_json, "connecting", "");
                    skip_sleep = true;
                    continue;
                }

                // Keep the connection status fresh (region may have resolved).
                emit_connection(
                    &app,
                    &mut last_conn_json,
                    "connected",
                    &api.region.read().to_uppercase(),
                );

                // Mirror the live state into Discord Rich Presence (no-op when
                // the feature is disabled or Discord isn't running).
                discord.update(&current_state, "connected");

                // 3. Autolock logic (if in pregame and not already running a sequence)
                if current_state.state == "pregame" && !autolock_in_progress.load(Ordering::Relaxed)
                {
                    if let Some(match_id) = current_state.match_id.clone() {
                        if let Some(map_name) = current_state.map_name.clone() {
                            let global_agent = auto_lock_agent.read().clone();
                            let target_agent = if global_agent.is_some() {
                                let map_prefs = map_agent_preferences.read();
                                map_prefs.get(&map_name).cloned().or(global_agent)
                            } else {
                                None
                            };

                            if let Some(agent_name) = target_agent {
                                let agent_id = if agent_name.len() > 20 {
                                    agent_name.clone()
                                } else {
                                    AGENTS
                                        .get(agent_name.to_lowercase().as_str())
                                        .map(|s| s.to_string())
                                        .unwrap_or_default()
                                };

                                if !agent_id.is_empty() {
                                    let is_locked = current_state
                                        .allies
                                        .iter()
                                        .find(|p| p.is_me)
                                        .map(|p| p.locked)
                                        .unwrap_or(false);

                                    if !is_locked {
                                        let api_clone = api.clone();
                                        let in_progress_clone = autolock_in_progress.clone();

                                        // Spawn a SEPARATE task so we don't block the state emitter
                                        in_progress_clone.store(true, Ordering::Relaxed);
                                        let lock_delay_ms = *auto_lock_delay_ms.read();
                                        tokio::spawn(async move {
                                            tracing::info!(
                                                "[Autolock] Waiting for UI to load (3s)..."
                                            );

                                            // Phase 1: Wait for game client UI to fully render agent grid
                                            tokio::time::sleep(tokio::time::Duration::from_millis(
                                                3000,
                                            ))
                                            .await;
                                            api_clone.select_agent(&match_id, &agent_id).await;
                                            tracing::info!(
                                                "[Autolock] Agent selected (hovering visible)"
                                            );

                                            tracing::info!(
                                                "[Autolock] Waiting before lock ({}ms)...",
                                                lock_delay_ms
                                            );
                                            tokio::time::sleep(tokio::time::Duration::from_millis(
                                                lock_delay_ms,
                                            ))
                                            .await;

                                            // Phase 2: Lock with verification + fast retry.
                                            // A single fire-and-forget lock can be silently
                                            // dropped (stale token, request racing the
                                            // server's select state, lock fired a touch too
                                            // early). Confirm via the pregame match and
                                            // re-attempt until the agent is actually locked,
                                            // the pregame ends, or we hit the safety cap.
                                            let my_puuid = api_clone.puuid.read().clone();
                                            let mut locked = false;
                                            for attempt in 1..=20u32 {
                                                api_clone.lock_agent(&match_id, &agent_id).await;

                                                // Give the server a moment, then verify.
                                                tokio::time::sleep(
                                                    tokio::time::Duration::from_millis(700),
                                                )
                                                .await;

                                                match api_clone.get_pregame_match(&match_id).await {
                                                    Some(m) => {
                                                        let me_locked = m
                                                            .ally_team
                                                            .as_ref()
                                                            .and_then(|t| {
                                                                t.players
                                                                    .iter()
                                                                    .find(|p| p.subject == my_puuid)
                                                            })
                                                            .map(|p| {
                                                                p.character_selection_state
                                                                    == "locked"
                                                            })
                                                            .unwrap_or(false);

                                                        if me_locked {
                                                            locked = true;
                                                            tracing::info!(
                                                                    "[Autolock] Lock confirmed (attempt {})",
                                                                    attempt
                                                                );
                                                            break;
                                                        }

                                                        tracing::warn!(
                                                                "[Autolock] Lock not confirmed (attempt {}), re-hovering and retrying...",
                                                                attempt
                                                            );
                                                        // Re-hover in case the select state
                                                        // was lost, then retry the lock.
                                                        api_clone
                                                            .select_agent(&match_id, &agent_id)
                                                            .await;
                                                        tokio::time::sleep(
                                                            tokio::time::Duration::from_millis(500),
                                                        )
                                                        .await;
                                                    }
                                                    None => {
                                                        // Pregame gone (game started, dodge,
                                                        // or disconnect) - stop retrying.
                                                        tracing::info!(
                                                                "[Autolock] Pregame ended before lock confirmed; stopping retries."
                                                            );
                                                        break;
                                                    }
                                                }
                                            }

                                            if !locked {
                                                tracing::warn!(
                                                        "[Autolock] Could not confirm lock after retries."
                                                    );
                                            }

                                            // Allow next sequence after a small buffer
                                            tokio::time::sleep(tokio::time::Duration::from_millis(
                                                1000,
                                            ))
                                            .await;
                                            in_progress_clone.store(false, Ordering::Relaxed);
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

#[tauri::command]
pub async fn get_game_state(state: State<'_, AppState>) -> Result<GameState, String> {
    get_game_state_internal(&state).await
}

/// Practice range is a coregame session with no 5v5 lobby.
fn is_practice_range_map(map_id: &str) -> bool {
    let id = map_id.to_ascii_lowercase();
    id.contains("range") || id.contains("poveglia")
}

const RANGE_MAP_NAME: &str = "Poligon";

fn is_range_like_state(gs: &GameState) -> bool {
    let map = gs.map_name.as_deref().unwrap_or("");
    let map_l = map.to_ascii_lowercase();
    if map_l.contains("range") || map_l.contains("poveglia") || map_l.contains("poligon") {
        return true;
    }
    // Range often fails MAP_NAMES lookup → "Unknown" + only ourselves.
    map.eq_ignore_ascii_case("Unknown")
        && gs.enemies.is_empty()
        && gs.allies.len() <= 1
}

fn drop_range_or_dead_cache(state: &AppState) {
    // Range is a valid 1-player panel now. Only wipe when Valorant itself is gone.
    if crate::process::is_game_running() {
        return;
    }
    *state.last_full_game_state.write() = None;
    let last = state.last_known_state.read().clone();
    if last == "pregame" || last == "ingame" {
        *state.last_known_state.write() = "idle".into();
    }
}

/// Prefer the last full live snapshot over an empty "disconnected" payload so the
/// UI/Discord keep map/score while the supervisor re-establishes tokens.
fn cached_live_or_disconnected(state: &AppState) -> GameState {
    drop_range_or_dead_cache(state);
    if crate::process::is_game_running() {
        if let Some(cached) = state.last_full_game_state.read().clone() {
            if (cached.state == "pregame" || cached.state == "ingame")
                && !is_range_like_state(&cached)
            {
                return cached;
            }
        }
    }
    GameState {
        state: "disconnected".into(),
        ..Default::default()
    }
}

/// Hold the last pregame/ingame snapshot (or a bare last_known_state) without
/// advancing idle debounce. Used when APIs are flaky mid-match.
fn hold_live_snapshot(state: &AppState, reason: &str) -> GameState {
    tracing::debug!("[get_game_state] Holding live snapshot: {}", reason);
    drop_range_or_dead_cache(state);
    // Do not count this tick as an idle confirmation.
    *state.consecutive_idle_count.write() = 0;
    if crate::process::is_game_running() {
        if let Some(cached) = state.last_full_game_state.read().clone() {
            if (cached.state == "pregame" || cached.state == "ingame")
                && !is_range_like_state(&cached)
            {
                return cached;
            }
        }
    }
    let last = state.last_known_state.read().clone();
    if last == "pregame" || last == "ingame" {
        return GameState {
            state: last,
            ..Default::default()
        };
    }
    GameState {
        state: "idle".into(),
        ..Default::default()
    }
}

pub async fn get_game_state_internal(state: &AppState) -> Result<GameState, String> {
    let api = &state.api;

    if !*api.connected.read() {
        return Ok(cached_live_or_disconnected(state));
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
        return Ok(cached_live_or_disconnected(state));
    }

    // If tokens need refresh, trigger reconnection instead of returning stale data.
    // Still serve the last live snapshot so the panel does not flash "waiting".
    if *api.needs_reinit.read() {
        // Log only once per reinit cycle
        if !REINIT_WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!("[get_game_state] Tokens need refresh, signaling disconnected");
        }
        return Ok(cached_live_or_disconnected(state));
    }

    // Reset warning flags when connected successfully (reached this point = no issues)
    LOCKFILE_WARNED.store(false, Ordering::Relaxed);
    REINIT_WARNED.store(false, Ordering::Relaxed);

    // --- MATCH PROBES (404 vs transient) ---
    // Distinguish clean "not in match" from API failures so a mid-match blip
    // never drops the UI onto "Maç Bekleniyor".
    let coregame_probe = api.probe_coregame_match_id().await;
    // Always probe pregame. A leftover Range coregame id (queueing from the
    // practice range) used to make us skip this call and stay on "waiting"
    // through agent select.
    let pregame_probe = api.probe_pregame_match_id().await;

    // Either probe uncertain? Hold live panel if we were already in a match.
    let last_state_early = state.last_known_state.read().clone();
    let was_live_early = last_state_early == "pregame" || last_state_early == "ingame";
    let probe_uncertain = matches!(coregame_probe, MatchProbe::Uncertain)
        || matches!(pregame_probe, MatchProbe::Uncertain);

    // Own presence: useful as a *positive* live signal during pregame→ingame
    // loading, and as a *positive* MENUS end signal. It is NOT a veto after
    // a real INGAME match — Riot often leaves sessionLoopState=INGAME on the
    // post-game scoreboard long after the match is over.
    let my_presence = api.get_my_presence().await;
    let presence_in_match = my_presence.as_ref().is_some_and(|p| {
        p.session_loop_state
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("INGAME") || s.eq_ignore_ascii_case("PREGAME"))
    });

    if was_live_early && probe_uncertain {
        return Ok(hold_live_snapshot(
            state,
            "match-id probe transient failure while live",
        ));
    }
    // Pregame → map load: match ids vanish for a few seconds while presence
    // already says INGAME. Hold the agent-select snapshot through that gap.
    // After we have already been INGAME, empty match ids mean the match ended.
    if last_state_early == "pregame" && presence_in_match {
        if matches!(coregame_probe, MatchProbe::NotInMatch)
            && matches!(pregame_probe, MatchProbe::NotInMatch)
        {
            return Ok(hold_live_snapshot(
                state,
                "pregame load gap: presence still PREGAME/INGAME but match ids empty",
            ));
        }
    }

    // --- RECENT ENCOUNTER TRACKING LOGIC ---
    let coregame_match_id = match &coregame_probe {
        MatchProbe::InMatch(id) => Some(id.clone()),
        _ => None,
    };
    let pregame_match_id = match &pregame_probe {
        MatchProbe::InMatch(id) => Some(id.clone()),
        _ => None,
    };
    let current_is_ingame = coregame_match_id.is_some();
    let current_id = coregame_match_id
        .clone()
        .or_else(|| pregame_match_id.clone())
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

    let get_encounter_data = |puuid: &str| -> (Option<u32>, Option<String>, Option<bool>) {
        let history = state.match_history.read();
        for (i, players) in history.iter().enumerate() {
            if let Some(player) = players.get(puuid) {
                return (
                    Some((i + 1) as u32),
                    Some(player.agent.clone()),
                    Some(player.was_enemy),
                );
            }
        }
        (None, None, None)
    };
    // ---------------------------------------

    // Check pregame
    if let Some(match_id) = pregame_match_id.clone() {
        match api.get_pregame_match_ex(&match_id).await {
            RemoteResult::Transient => {
                return Ok(hold_live_snapshot(
                    state,
                    "pregame match body transient failure",
                ));
            }
            RemoteResult::NotFound => {
                // Id was residual; fall through to coregame / idle logic.
            }
            RemoteResult::Ok(match_data) => {
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
                    let puuids: Vec<String> =
                        team.players.iter().map(|p| p.subject.clone()).collect();
                    let team_of: HashMap<String, String> = puuids
                        .iter()
                        .map(|p| (p.clone(), team.team_id.clone()))
                        .collect();

                    let names = api.get_player_names(&puuids).await;

                    // Get parties with caching - only fetch once per match
                    let parties =
                        get_cached_parties(&state, &match_id, &puuids, &team_of, api).await;

                    // Note: Auto-lock is handled by the background supervisor to avoid blocking this function

                    for p in team.players {
                        let agent_name = get_agent_name(&p.character_id);
                        if p.subject != my_puuid && !agent_name.is_empty() {
                            state.current_match_players.write().insert(
                                p.subject.clone(),
                                EncounterPlayer {
                                    agent: agent_name.clone(),
                                    was_enemy: false,
                                },
                            );
                        }

                        let (
                            previous_encounter,
                            previous_encounter_agent,
                            previous_encounter_was_enemy,
                        ) = get_encounter_data(&p.subject);
                        let (level, player_card_id) = match p.player_identity {
                            Some(id) => (
                                id.account_level,
                                id.player_card_id.filter(|s| !s.is_empty()),
                            ),
                            None => (0, None),
                        };
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
                            // Pregame still has CompetitiveTier; if Riot zeros it,
                            // enrich_missing_ranks below falls back to MMR.
                            rank_tier: p.competitive_tier,
                            rank_rr: 0,
                            level,
                            previous_encounter,
                            previous_encounter_agent,
                            previous_encounter_was_enemy,
                            player_card_id,
                        });
                    }

                    // Fill zero ranks via cache + MMR (CompetitiveTier can be 0 in
                    // unrated / when Riot blanks match payloads).
                    enrich_missing_ranks(&state, api, &match_id, &mut allies).await;

                    // Reset idle/menus counters and update last known state on successful pregame
                    *state.consecutive_idle_count.write() = 0;
                    *state.consecutive_menus_count.write() = 0;
                    *state.last_known_state.write() = "pregame".to_string();

                    let gs = GameState {
                        state: "pregame".into(),
                        match_id: Some(match_id),
                        map_name: Some(map_name),
                        mode_name: Some(mode_name),
                        side: Some(side.into()),
                        allies,
                        ..Default::default()
                    };
                    *state.last_full_game_state.write() = Some(gs.clone());
                    crate::chat_text::update_roster_from_game(&gs);
                    return Ok(gs);
                }
                // ally_team missing — fall through to hold/idle below
            }
        }
    }

    // Presence MENUS usually means the client left the match loop (residual
    // coregame id + fake 0-0 scores). A *single* MENUS reading is not enough —
    // stale/wrong presence can appear mid-match and would otherwise skip the
    // entire ingame branch permanently. Require consecutive confirmations.
    let mut presence_confirms_menus = false;
    const MENUS_DEBOUNCE_THRESHOLD: u32 = 2; // ~2s at 1s live poll

    // Check coregame (reuse probe result — do not re-fetch player endpoint)
    if let Some(match_id) = coregame_match_id.clone() {
        let presence_is_menus = my_presence.as_ref().is_some_and(|p| p.is_menus());
        if presence_is_menus {
            let mut menus_count = state.consecutive_menus_count.write();
            *menus_count += 1;
            if *menus_count >= MENUS_DEBOUNCE_THRESHOLD {
                presence_confirms_menus = true;
                tracing::info!(
                    "[get_game_state] Presence MENUS confirmed x{} while coregame id {} still present; treating match as ended",
                    *menus_count,
                    match_id
                );
            } else {
                tracing::debug!(
                    "[get_game_state] Presence MENUS debounce {}/{} (coregame id {}) — still treating as in-match",
                    *menus_count,
                    MENUS_DEBOUNCE_THRESHOLD,
                    match_id
                );
            }
        } else if presence_in_match {
            // Only reset on an explicit live loop. A failed presence fetch
            // (None) must not wipe a MENUS streak during post-game.
            *state.consecutive_menus_count.write() = 0;
        }

        if !presence_confirms_menus {
            match api.get_coregame_match_ex(&match_id).await {
                RemoteResult::Transient => {
                    return Ok(hold_live_snapshot(
                        state,
                        "coregame match body transient failure",
                    ));
                }
                RemoteResult::NotFound => {
                    // Residual id; fall through to idle logic.
                }
                RemoteResult::Ok(match_data) => {
                    if match_data.has_ended() {
                        // Residual core-game id after the round is over. Presence
                        // often still says INGAME on the scoreboard — do not
                        // rebuild the roster.
                        tracing::info!(
                            "[get_game_state] Coregame {} ended (state={:?}, post_game={}) — leaving live panel",
                            match_id,
                            match_data.state,
                            match_data
                                .post_game_details
                                .as_ref()
                                .is_some_and(|v| !v.is_null())
                        );
                        presence_confirms_menus = true;
                        *state.consecutive_menus_count.write() = MENUS_DEBOUNCE_THRESHOLD;
                    } else if is_practice_range_map(&match_data.map_id) {
                        let gs =
                            build_range_game_state(&state, api, &match_id, match_data).await;
                        tracing::info!(
                            "[get_game_state] Practice range roster (map={:?}, players={})",
                            gs.map_name,
                            gs.allies.len()
                        );
                        *state.consecutive_idle_count.write() = 0;
                        *state.consecutive_menus_count.write() = 0;
                        *state.last_known_state.write() = "ingame".to_string();
                        *state.current_match_seen_ingame.write() = false;
                        *state.last_full_game_state.write() = Some(gs.clone());
                        crate::chat_text::update_roster_from_game(&gs);
                        return Ok(gs);
                    } else {
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
                    let team_of: HashMap<String, String> = match_data
                        .players
                        .iter()
                        .map(|p| (p.subject.clone(), p.team_id.clone()))
                        .collect();

                    let names = api.get_player_names(&puuids).await;

                    // Get parties with caching
                    let parties =
                        get_cached_parties(&state, &match_id, &puuids, &team_of, api).await;

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
                        let was_enemy = p.team_id != my_team;
                        if p.subject != my_puuid && !agent_name.is_empty() {
                            state.current_match_players.write().insert(
                                p.subject.clone(),
                                EncounterPlayer {
                                    agent: agent_name.clone(),
                                    was_enemy,
                                },
                            );
                        }

                        let (
                            previous_encounter,
                            previous_encounter_agent,
                            previous_encounter_was_enemy,
                        ) = get_encounter_data(&p.subject);
                        let (level, player_card_id) = match p.player_identity {
                            Some(id) => (
                                id.account_level,
                                id.player_card_id.filter(|s| !s.is_empty()),
                            ),
                            None => (0, None),
                        };
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
                            previous_encounter_was_enemy,
                            player_card_id,
                        };

                        if p.team_id == my_team {
                            allies.push(player);
                        } else {
                            enemies.push(player);
                        }
                    }

                    // Coregame only has SeasonalBadgeInfo.Rank (often 0). Carry
                    // pregame CompetitiveTier from cache and fill the rest via MMR.
                    // Enrich both teams in one pass so enemy ranks get the same
                    // cache/MMR treatment as allies (enemies were never in pregame).
                    enrich_missing_ranks_for_roster(
                        &state,
                        api,
                        &match_id,
                        &mut allies,
                        &mut enemies,
                    )
                    .await;

                    // Reset idle/menus counters and update last known state on successful ingame
                    *state.consecutive_idle_count.write() = 0;
                    *state.consecutive_menus_count.write() = 0;
                    *state.last_known_state.write() = "ingame".to_string();

                    // Round score is only available via our own presence, not GLZ.
                    // get_my_presence already blanks scores when not INGAME.
                    let (ally_score, enemy_score) = match &my_presence {
                        Some(p) => (p.ally_score, p.enemy_score),
                        None => (None, None),
                    };

                    let gs = GameState {
                        state: "ingame".into(),
                        match_id: Some(match_id),
                        map_name: Some(map_name),
                        mode_name: None,
                        side: None,
                        allies,
                        enemies,
                        ally_score,
                        enemy_score,
                    };
                    if is_range_like_state(&gs) {
                        *state.current_match_seen_ingame.write() = false;
                        if gs.map_name.as_deref().unwrap_or("").eq_ignore_ascii_case("Unknown")
                        {
                            let mut range_gs = gs;
                            range_gs.map_name = Some(RANGE_MAP_NAME.into());
                            range_gs.mode_name = Some(RANGE_MAP_NAME.into());
                            *state.last_full_game_state.write() = Some(range_gs.clone());
                            crate::chat_text::update_roster_from_game(&range_gs);
                            return Ok(range_gs);
                        }
                    }
                    *state.last_full_game_state.write() = Some(gs.clone());
                    crate::chat_text::update_roster_from_game(&gs);
                    return Ok(gs);
                    }
                }
            }
        }
    }

    // If we were in a game session and now getting no match data,
    // check if this is a real transition or just an API failure
    let was_in_game = *state.in_game_session.read();
    let last_state = state.last_known_state.read().clone();

    // Check for signs of API issues that might cause false "idle" state
    let network_errors = *api.consecutive_network_errors.read();
    if was_live_early && network_errors > 0 {
        // We were in a game but getting network errors - don't trust this "idle" state
        return Ok(hold_live_snapshot(
            state,
            &format!("network errors ({network_errors}) while live"),
        ));
    }
    if was_in_game && network_errors > 0 {
        return Ok(hold_live_snapshot(
            state,
            &format!("in_game_session with network errors ({network_errors})"),
        ));
    }

    // Also confirm MENUS when match ids already cleared (no residual coregame id).
    if !presence_confirms_menus && was_live_early {
        if my_presence.as_ref().is_some_and(|p| p.is_menus())
            && matches!(coregame_probe, MatchProbe::NotInMatch)
            && matches!(pregame_probe, MatchProbe::NotInMatch)
        {
            let mut menus_count = state.consecutive_menus_count.write();
            *menus_count += 1;
            if *menus_count >= MENUS_DEBOUNCE_THRESHOLD {
                presence_confirms_menus = true;
                tracing::info!(
                    "[get_game_state] Presence MENUS + clean NotInMatch confirmed x{} — match ended",
                    *menus_count
                );
            } else {
                tracing::debug!(
                    "[get_game_state] Post-match MENUS debounce {}/{}",
                    *menus_count,
                    MENUS_DEBOUNCE_THRESHOLD
                );
            }
        }
    }

    // After a live INGAME match, clean 404s on both match-id endpoints mean
    // the round is over — even if presence is still INGAME (post-game board).
    let probes_clear = matches!(coregame_probe, MatchProbe::NotInMatch)
        && matches!(pregame_probe, MatchProbe::NotInMatch);
    if !presence_confirms_menus && last_state == "ingame" && probes_clear {
        presence_confirms_menus = true;
        tracing::info!(
            "[get_game_state] Ingame match ids gone (presence={:?}) — match ended",
            my_presence
                .as_ref()
                .and_then(|p| p.session_loop_state.as_deref())
        );
    }

    // Pregame → loading → ingame: match ids vanish for a few seconds while
    // presence already says INGAME. Hold the agent-select snapshot.
    // Do NOT do this after a real INGAME match.
    if last_state == "pregame" && presence_in_match && !presence_confirms_menus {
        return Ok(hold_live_snapshot(
            state,
            "pregame load gap: presence still in match loop at idle gate",
        ));
    }

    // DEBOUNCE: pregame → loading → ingame can leave a multi-second gap with no
    // match id. Hold the last snapshot longer so the UI does not flash waiting.
    // After INGAME the match-over path above already short-circuits.
    // ~15s at 1s live poll for pregame load; ~2s for a leftover ingame.
    const IDLE_DEBOUNCE_PREGAME: u32 = 15;
    const IDLE_DEBOUNCE_INGAME: u32 = 2;

    if last_state == "pregame" || last_state == "ingame" {
        if presence_confirms_menus {
            tracing::info!(
                "[get_game_state] Match end confirmed, transitioning {} -> idle",
                last_state
            );
            *state.consecutive_idle_count.write() = 0;
            *state.consecutive_menus_count.write() = 0;
        } else {
            let threshold = if last_state == "ingame" {
                IDLE_DEBOUNCE_INGAME
            } else {
                IDLE_DEBOUNCE_PREGAME
            };
            let mut idle_count = state.consecutive_idle_count.write();
            *idle_count += 1;

            if *idle_count < threshold {
                tracing::debug!(
                    "[get_game_state] Idle debounce: {} (was {}), waiting for {} more confirmations",
                    *idle_count,
                    last_state,
                    threshold - *idle_count
                );
                // Prefer the last full snapshot so Discord keeps the real map/score
                // instead of a blank "ingame" / fake 0-0 payload.
                if let Some(cached) = state.last_full_game_state.read().clone() {
                    return Ok(cached);
                }
                return Ok(GameState {
                    state: last_state.clone(),
                    ..Default::default()
                });
            }

            // Threshold reached - this is a real transition
            tracing::info!(
                "[get_game_state] Idle confirmed after {} checks, transitioning {} -> idle",
                *idle_count,
                last_state
            );
            *idle_count = 0;
            *state.consecutive_menus_count.write() = 0;
        }
    }

    // Clear party cache when idle (no match) - only if we were in a game session.
    // Note: We no longer clear cached_parties, fetched_history_players, or cached_parties_match_id here.
    // Keeping them preserved ensures that if a connection hiccup or a manual/auto reconnect occurs,
    // we do not lose party color assignments mid-match. The cache is still safely cleared/overwritten
    // in `get_cached_parties` as soon as a new match_id starts.
    if was_in_game {
        *state.in_game_session.write() = false;
    }

    // Update last known state to idle and drop the match snapshot so Discord
    // stops advertising the previous map/score.
    *state.last_known_state.write() = "idle".to_string();
    *state.consecutive_menus_count.write() = 0;
    *state.last_full_game_state.write() = None;
    crate::chat_text::clear_roster();

    Ok(GameState {
        state: "idle".into(),
        ..Default::default()
    })
}

/// Reset rank cache when the match id changes (same lifecycle as party cache).
fn ensure_rank_cache_match(state: &AppState, match_id: &str) {
    let cached_match_id = state.cached_ranks_match_id.read().clone();
    if cached_match_id.as_deref() != Some(match_id) {
        if cached_match_id.is_some() {
            tracing::info!(
                "[rank_cache] Match changed from {:?} to {}, clearing rank cache",
                cached_match_id,
                match_id
            );
        }
        state.cached_ranks.write().clear();
        state.ranks_mmr_fetched.write().clear();
        *state.cached_ranks_match_id.write() = Some(match_id.to_string());
    }
}

fn store_rank_in_cache(state: &AppState, puuid: &str, tier: i32) {
    if tier > 0 {
        state.cached_ranks.write().insert(puuid.to_string(), tier);
    }
}

fn cached_rank(state: &AppState, puuid: &str) -> i32 {
    state.cached_ranks.read().get(puuid).copied().unwrap_or(0)
}

/// Fill missing ranks for both teams in one pass (shared cache + parallel MMR).
async fn enrich_missing_ranks_for_roster(
    state: &AppState,
    api: &crate::api::ValorantAPI,
    match_id: &str,
    allies: &mut [PlayerData],
    enemies: &mut [PlayerData],
) {
    ensure_rank_cache_match(state, match_id);

    // Seed cache from any non-zero ranks already on either team
    for p in allies.iter().chain(enemies.iter()) {
        if p.rank_tier > 0 {
            store_rank_in_cache(state, &p.puuid, p.rank_tier);
        }
    }

    apply_cached_ranks(state, allies);
    apply_cached_ranks(state, enemies);

    let missing: Vec<String> = {
        let already_tried = state.ranks_mmr_fetched.read();
        allies
            .iter()
            .chain(enemies.iter())
            .filter(|p| p.rank_tier <= 0 && !already_tried.contains(&p.puuid))
            .map(|p| p.puuid.clone())
            .collect()
    };

    if missing.is_empty() {
        return;
    }

    tracing::debug!(
        "[rank] MMR lookup for {} player(s) missing tiers (match {})",
        missing.len(),
        match_id
    );

    // Parallel MMR fetches — only for players still missing a tier
    let futs: Vec<_> = missing
        .iter()
        .map(|puuid| {
            let api = api;
            let puuid = puuid.clone();
            async move {
                let result = api.get_player_mmr(&puuid).await;
                (puuid, result)
            }
        })
        .collect();

    let results = futures_util::future::join_all(futs).await;
    for (puuid, result) in results {
        match result {
            // Transient failure — do NOT mark as fetched so the next poll retries.
            None => {
                tracing::debug!("[rank] MMR miss (will retry) for {}", puuid);
            }
            // Confirmed response (tier may be 0 = unranked)
            Some((tier, rr)) => {
                state.ranks_mmr_fetched.write().insert(puuid.clone());
                let tier = tier as i32;
                if tier > 0 {
                    store_rank_in_cache(state, &puuid, tier);
                    if let Some(p) = allies
                        .iter_mut()
                        .chain(enemies.iter_mut())
                        .find(|p| p.puuid == puuid)
                    {
                        p.rank_tier = tier;
                        p.rank_rr = rr as i32;
                    }
                }
            }
        }
    }
}

async fn build_range_game_state(
    state: &AppState,
    api: &crate::api::ValorantAPI,
    match_id: &str,
    match_data: crate::api::types::CoregameMatch,
) -> GameState {
    let my_puuid = api.puuid.read().clone();
    let puuids: Vec<String> = match_data.players.iter().map(|p| p.subject.clone()).collect();
    let names = api.get_player_names(&puuids).await;

    let mut allies = Vec::new();
    for p in match_data.players {
        let agent_name = get_agent_name(&p.character_id);
        let (level, player_card_id) = match p.player_identity {
            Some(id) => (
                id.account_level,
                id.player_card_id.filter(|s| !s.is_empty()),
            ),
            None => (0, None),
        };
        let rank = p.seasonal_badge_info.and_then(|s| s.rank).unwrap_or(0);
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
            locked: true,
            party: "Solo".into(),
            is_me: p.subject == my_puuid || puuids.len() == 1,
            rank_tier: rank,
            rank_rr: 0,
            level,
            previous_encounter: None,
            previous_encounter_agent: None,
            previous_encounter_was_enemy: None,
            player_card_id,
        });
    }

    if allies.is_empty() && !my_puuid.is_empty() {
        let names = api.get_player_names(&[my_puuid.clone()]).await;
        let display_name = names.get(&my_puuid).cloned().filter(|s| !s.is_empty());
        allies.push(PlayerData {
            puuid: my_puuid.clone(),
            name: display_name.unwrap_or_default(),
            agent: String::new(),
            locked: true,
            party: "Solo".into(),
            is_me: true,
            rank_tier: 0,
            rank_rr: 0,
            level: 0,
            previous_encounter: None,
            previous_encounter_agent: None,
            previous_encounter_was_enemy: None,
            player_card_id: None,
        });
    }

    enrich_missing_ranks(state, api, match_id, &mut allies).await;

    GameState {
        state: "ingame".into(),
        match_id: Some(match_id.to_string()),
        map_name: Some(RANGE_MAP_NAME.into()),
        mode_name: Some(RANGE_MAP_NAME.into()),
        side: None,
        allies,
        enemies: vec![],
        ally_score: None,
        enemy_score: None,
    }
}

fn apply_cached_ranks(state: &AppState, players: &mut [PlayerData]) {
    for p in players.iter_mut() {
        if p.rank_tier <= 0 {
            let cached = cached_rank(state, &p.puuid);
            if cached > 0 {
                p.rank_tier = cached;
            }
        }
    }
}

/// Fill missing ranks for a single team (pregame — only allies exist).
///
/// Coregame no longer reliably exposes ranks (`SeasonalBadgeInfo.Rank` is often 0).
/// Order: match payload → match-scoped cache → `/mmr/v1/players/{puuid}`.
async fn enrich_missing_ranks(
    state: &AppState,
    api: &crate::api::ValorantAPI,
    match_id: &str,
    players: &mut [PlayerData],
) {
    // Empty second team — same code path as roster enrich.
    let mut empty: Vec<PlayerData> = Vec::new();
    enrich_missing_ranks_for_roster(state, api, match_id, players, &mut empty).await;
}

/// Get parties with caching - persists across pregame->ingame transition
/// Only clears when returning to idle state (lobby) OR when match_id changes
async fn get_cached_parties(
    state: &AppState,
    match_id: &str,
    puuids: &[String],
    team_of: &HashMap<String, String>,
    api: &crate::api::ValorantAPI,
) -> HashMap<String, String> {
    use crate::party::{is_group_tag, seed_from_last_match};

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
            *state.last_party_history_fetch.write() = None;
            *state.party_presence_passes.write() = 0;
            *state.cached_parties_match_id.write() = Some(match_id.to_string());
        }
    }

    // Instant seed from the last completed match (same people who stacked
    // there and are still on the same side this game).
    if let Some(last) = state.last_match.read().clone() {
        let cached = state.cached_parties.read().clone();
        let seeded = seed_from_last_match(&last, puuids, team_of, &cached);
        if !seeded.is_empty() {
            let mut cache = state.cached_parties.write();
            for (puuid, tag) in seeded {
                if !cache.get(&puuid).is_some_and(|t| is_group_tag(t)) {
                    cache.insert(puuid, tag);
                }
            }
        }
    }

    let cached = state.cached_parties.read().clone();

    // Everyone already in a confirmed group — nothing left to detect.
    if puuids
        .iter()
        .all(|p| cached.get(p).is_some_and(|t| is_group_tag(t)))
    {
        return cached;
    }

    // History only for players we have not successfully fetched yet and who
    // are still ungrouped.
    let mut players_needing_fetch: Vec<String> = {
        let fetched = state.fetched_history_players.read();
        puuids
            .iter()
            .filter(|p| !fetched.contains(*p))
            .filter(|p| !cached.get(*p).is_some_and(|t| is_group_tag(t)))
            .cloned()
            .collect()
    };

    if !players_needing_fetch.is_empty() {
        let too_soon = state
            .last_party_history_fetch
            .read()
            .is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(5));
        if too_soon {
            players_needing_fetch.clear();
        } else {
            *state.last_party_history_fetch.write() = Some(std::time::Instant::now());
        }
    }

    // A late presence can upgrade a Solo, but GLZ party/presence must not
    // run on every 1s poll. After a few passes, only continue for history.
    const PRESENCE_PASSES: u32 = 3;
    let presence_passes = *state.party_presence_passes.read();
    if presence_passes >= PRESENCE_PASSES && players_needing_fetch.is_empty() {
        return cached;
    }

    let detected = api
        .detect_parties_with_cache(puuids, &players_needing_fetch, &cached, team_of)
        .await;

    {
        let mut fetched = state.fetched_history_players.write();
        for p in detected.history_fetched {
            fetched.insert(p);
        }
    }

    *state.cached_parties.write() = detected.parties.clone();
    *state.party_presence_passes.write() += 1;

    detected.parties
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
pub fn set_auto_lock_delay(state: State<'_, AppState>, seconds: u64) {
    let clamped_seconds = seconds.clamp(1, 10);
    *state.auto_lock_delay_ms.write() = clamped_seconds * 1000;
}

#[tauri::command]
pub fn get_auto_lock_delay(state: State<'_, AppState>) -> u64 {
    (*state.auto_lock_delay_ms.read() / 1000).clamp(1, 10)
}

#[tauri::command]
pub fn set_map_preferences(state: State<'_, AppState>, preferences: HashMap<String, String>) {
    *state.map_agent_preferences.write() = preferences;
}

/// Pause match watching - the supervisor stops polling/autolock until resumed.
#[tauri::command]
pub fn pause_watching(state: State<'_, AppState>) {
    *state.is_paused.write() = true;
    tracing::info!("[Command] pause_watching");
}

/// Resume match watching and force an immediate reconnect.
#[tauri::command]
pub fn resume_watching(state: State<'_, AppState>) {
    *state.is_paused.write() = false;
    *state.api.needs_reinit.write() = true;
    tracing::info!("[Command] resume_watching");
}

/// Manual reconnect - asks the supervisor to re-initialize the connection now.
/// Emits `connecting` immediately so the UI does not wait for the next poll tick.
#[tauri::command]
pub fn reconnect(app: tauri::AppHandle, state: State<'_, AppState>) {
    *state.api.needs_reinit.write() = true;
    tracing::info!("[Command] reconnect requested");
    let ev = ConnectionEvent {
        status: "connecting".to_string(),
        region: state.api.region.read().to_uppercase(),
    };
    let _ = app.emit("connection_changed", &ev);
}

/// Enable/disable the Discord Rich Presence integration. The supervisor pushes
/// the live state to Discord on its next tick; disabling clears it immediately.
#[tauri::command]
pub fn set_discord_rpc(state: State<'_, AppState>, enabled: bool) {
    state.discord.set_enabled(enabled);
}

/// Returns whether the Discord Rich Presence integration is currently enabled.
#[tauri::command]
pub fn get_discord_rpc(state: State<'_, AppState>) -> bool {
    state.discord.is_enabled()
}

/// Enable/disable outgoing chat shortcuts (`sa`, `as`, `<3`, `!t <lang> …`).
/// Covers both paths: the in-game keyboard expander and messages sent from the
/// overlay's own chat panel.
#[tauri::command]
pub fn set_chat_shortcuts(enabled: bool) {
    crate::chat_text::set_shortcuts_enabled(enabled);
    #[cfg(windows)]
    crate::chat_expander::on_enabled_changed(enabled);
    tracing::info!("[Command] set_chat_shortcuts enabled={}", enabled);
}

/// Returns whether outgoing chat shortcuts are currently enabled.
#[tauri::command]
pub fn get_chat_shortcuts() -> bool {
    crate::chat_text::shortcuts_enabled()
}

/// List editable chat shortcut rules (system defaults + user rules).
#[tauri::command]
pub fn get_chat_shortcut_rules() -> Vec<crate::chat_rules::ChatRule> {
    crate::chat_rules::get_rules()
}

/// Replace the full rules list and persist to disk.
#[tauri::command]
pub fn save_chat_shortcut_rules(
    rules: Vec<crate::chat_rules::ChatRule>,
) -> Result<Vec<crate::chat_rules::ChatRule>, String> {
    crate::chat_rules::set_rules(rules)
}

/// Restore factory default shortcuts (`sa`/`as`/symbols) and persist.
#[tauri::command]
pub fn reset_chat_shortcut_rules() -> Result<Vec<crate::chat_rules::ChatRule>, String> {
    crate::chat_rules::reset_to_defaults()
}

/// Initial-sync helper: returns the current connection status so the frontend
/// can render correctly without waiting for the next `connection_changed` event.
#[tauri::command]
pub fn get_connection_status(state: State<'_, AppState>) -> ConnectionEvent {
    let paused = *state.is_paused.read();
    let connected = *state.api.connected.read();
    let needs_reinit = *state.api.needs_reinit.read();
    let status = if paused {
        "paused"
    } else if needs_reinit {
        "connecting"
    } else if connected {
        "connected"
    } else {
        "waiting_for_game"
    };
    ConnectionEvent {
        status: status.to_string(),
        region: state.api.region.read().to_uppercase(),
    }
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

const SPRAY_ITEM_TYPE_ID: &str = "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475";
const CHROMA_ITEM_TYPE_ID: &str = "3ad1b2b2-acdb-4524-852f-954a76ddae0a";
const BUDDY_ITEM_TYPE_ID: &str = "dd3bf334-87f3-40bd-b043-682a57a8dc3a";

fn parse_weapon_skins(items: std::collections::HashMap<String, LoadoutItem>) -> Vec<WeaponSkin> {
    let mut skins = Vec::new();
    for (weapon_id, item) in items {
        let mut chroma_id = None;
        let mut buddy_id = None;

        if let Some(sockets) = &item.sockets {
            for (_socket_id, socket_item) in sockets {
                if socket_item.item.type_id == CHROMA_ITEM_TYPE_ID {
                    chroma_id = Some(socket_item.item.id.clone());
                }
                if socket_item.item.type_id == BUDDY_ITEM_TYPE_ID {
                    buddy_id = Some(socket_item.item.id.clone());
                }
            }
        }

        skins.push(WeaponSkin {
            weapon_id,
            skin_id: item.id,
            chroma_id,
            buddy_id,
        });
    }
    skins
}

fn is_empty_expression_id(id: &str) -> bool {
    let trimmed = id.trim();
    trimmed.is_empty()
        || trimmed == "00000000-0000-0000-0000-000000000000"
        // Unequip / "None" flex slot
        || trimmed.eq_ignore_ascii_case("90f0a554-41b3-355b-6846-74a27aa3f7b9")
}

fn collect_expressions(
    sprays: Option<&LoadoutSprays>,
    expressions: Option<&LoadoutExpressions>,
) -> Vec<EquippedExpression> {
    if let Some(expr) = expressions {
        if let Some(sels) = expr.aes_selections.as_ref() {
            if !sels.is_empty() {
                return sels
                    .iter()
                    .filter(|s| !is_empty_expression_id(&s.asset_id))
                    .map(|s| EquippedExpression {
                        socket_id: s.socket_id.clone(),
                        asset_id: s.asset_id.clone(),
                        kind: if s.type_id.eq_ignore_ascii_case(SPRAY_ITEM_TYPE_ID) {
                            "spray".into()
                        } else {
                            "flex".into()
                        },
                    })
                    .collect();
            }
        }
    }

    if let Some(sp) = sprays {
        if let Some(sels) = sp.spray_selections.as_ref() {
            return sels
                .iter()
                .filter(|s| !is_empty_expression_id(&s.spray_id))
                .map(|s| EquippedExpression {
                    socket_id: s.socket_id.clone(),
                    asset_id: s.spray_id.clone(),
                    kind: "spray".into(),
                })
                .collect();
        }
    }

    Vec::new()
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

    // Check if match changed - clear cache
    {
        let cached_match = state.loadouts_match_id.read();
        if cached_match.as_ref() != Some(&match_id) {
            drop(cached_match);
            state.cached_loadouts.write().clear();
            *state.loadouts_match_id.write() = Some(match_id.clone());
        }
    }

    // Check cache after match validation (only if NOT pregame - in pregame we want fresh data for skin changes)
    if !is_pregame {
        let cached = state.cached_loadouts.read();
        if let Some(loadout) = cached.get(&puuid) {
            return Ok(Some(loadout.clone()));
        }
    }

    // Fetch loadouts based on game state
    if is_pregame {
        // Pregame loadouts
        if let Some(loadouts_response) = api.get_pregame_loadouts(&match_id).await {
            let mut cache = state.cached_loadouts.write();

            for loadout_data in loadouts_response.loadouts {
                let player_puuid = loadout_data.subject.clone();
                let skins = parse_weapon_skins(loadout_data.items);
                let expressions = collect_expressions(
                    loadout_data.sprays.as_ref(),
                    loadout_data.expressions.as_ref(),
                );

                cache.insert(
                    player_puuid.clone(),
                    crate::api::types::PlayerSkinData {
                        puuid: player_puuid,
                        skins,
                        expressions,
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
                let skins = parse_weapon_skins(player_loadout.loadout.items);
                let expressions = collect_expressions(
                    player_loadout.loadout.sprays.as_ref(),
                    player_loadout.loadout.expressions.as_ref(),
                );

                cache.insert(
                    player_puuid.clone(),
                    crate::api::types::PlayerSkinData {
                        puuid: player_puuid,
                        skins,
                        expressions,
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

    let mut conversations: Vec<Conversation> = api
        .get_conversations()
        .await
        .map(|c| c.conversations)
        .unwrap_or_default();

    // Force-include live game + party channels when present. These are the
    // in-match / lobby chats teammates see — not friend DMs. The general
    // conversations list sometimes omits them or lists them late.
    let merge_channel =
        |list: &mut Vec<Conversation>, extra: Option<ConversationsResponse>, label: &str| {
            let Some(extra) = extra else { return };
            for mut conv in extra.conversations {
                if !list.iter().any(|c| c.cid == conv.cid) {
                    conv.game_name = Some(label.to_string());
                    list.push(conv);
                } else if let Some(existing) = list.iter_mut().find(|c| c.cid == conv.cid) {
                    // Prefer a clear channel label over empty/raw names.
                    if existing.game_name.as_deref().unwrap_or("").is_empty() {
                        existing.game_name = Some(label.to_string());
                    }
                }
            }
        };

    merge_channel(&mut conversations, api.get_game_chat().await, "GAME");
    merge_channel(&mut conversations, api.get_party_chat().await, "PARTY");

    // Label group chats by CID when still unnamed.
    for conv in &mut conversations {
        if conv.conversation_type == "groupchat" {
            let cid = conv.cid.to_lowercase();
            if conv.game_name.as_deref().unwrap_or("").is_empty() {
                if cid.contains("coregame") {
                    conv.game_name = Some("GAME".into());
                } else if cid.contains("parties") {
                    conv.game_name = Some("PARTY".into());
                } else {
                    conv.game_name = Some("TEAM".into());
                }
            }
        }
    }

    // Enhance DM conversations with player names
    let mut puuids = Vec::new();
    for conv in &conversations {
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
        for conv in &mut conversations {
            if conv.conversation_type == "chat" && conv.cid.len() == 36 {
                if let Some(name) = names.get(&conv.cid) {
                    conv.game_name = Some(name.clone());
                }
            }
        }
    }

    // Pin in-game channels first so they're easy to pick during a match.
    conversations.sort_by(|a, b| {
        let rank = |c: &Conversation| -> u8 {
            let cid = c.cid.to_lowercase();
            if cid.contains("coregame") {
                0
            } else if cid.contains("parties") && c.conversation_type == "groupchat" {
                1
            } else if c.conversation_type == "groupchat" {
                2
            } else {
                3
            }
        };
        rank(a).cmp(&rank(b))
    });

    Ok(conversations)
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

/// Outgoing friend requests (`subscription == pending_out`).
#[tauri::command]
pub async fn get_outgoing_friend_requests(
    state: State<'_, AppState>,
) -> Result<Vec<FriendRequest>, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    if let Some(resp) = api.get_friend_requests().await {
        Ok(resp
            .requests
            .into_iter()
            .filter(|r| r.subscription.eq_ignore_ascii_case("pending_out"))
            .collect())
    } else {
        Ok(vec![])
    }
}

/// Send a friend request by Riot ID (`Name#TAG`).
#[tauri::command]
pub async fn send_friend_request(
    state: State<'_, AppState>,
    game_name: String,
    game_tag: String,
) -> Result<bool, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }
    let game_name = game_name.trim().to_string();
    let game_tag = game_tag.trim().to_string();
    if game_name.is_empty() || game_tag.is_empty() {
        return Err("Missing riot id".into());
    }

    tracing::info!("[send_friend_request] {}#{}", game_name, game_tag);
    if api.send_friend_request(&game_name, &game_tag).await {
        Ok(true)
    } else {
        Err("Friend request failed".into())
    }
}

/// Cancel an outgoing friend request.
#[tauri::command]
pub async fn cancel_friend_request(
    state: State<'_, AppState>,
    puuid: String,
) -> Result<bool, String> {
    let api = &state.api;
    if !*api.connected.read() {
        return Err("Not connected".into());
    }
    if puuid.trim().is_empty() {
        return Err("Missing puuid".into());
    }

    tracing::info!("[cancel_friend_request] puuid={}", puuid);
    if api.cancel_friend_request(&puuid).await {
        Ok(true)
    } else {
        Err("Friend request cancel failed".into())
    }
}

/// Read the player's current in-game Valorant settings (sensitivity, crosshair,
/// keybinds, video, audio, ...) so the frontend can save them as a preset.
#[tauri::command]
pub async fn get_player_settings(
    state: State<'_, AppState>,
) -> Result<PlayerSettingsResponse, String> {
    tracing::info!("[Command] get_player_settings() called");
    // Reads on-disk config files; works even without a live connection, though
    // an active connection lets us target the exact account by puuid.
    state.api.get_player_settings().await
}

// ===== Settings Presets =====

/// Helper: get the lazily-initialized preset store, or an error string.
fn preset_store(
    state: &State<'_, AppState>,
) -> Result<std::sync::Arc<crate::presets::PresetStore>, String> {
    state
        .presets
        .read()
        .clone()
        .ok_or_else(|| "Preset store not ready".to_string())
}

/// True if the VALORANT game process (not just Riot Client) is running.
/// Applying settings while the game is open would let the game overwrite the
/// cloud from its in-memory state, so apply is blocked when this is true.
///
/// Uses the native Toolhelp snapshot (see `crate::process`) instead of parsing
/// `tasklist`, so it answers identically regardless of Windows display language
/// or PATH — the previous string-parse was the source of cross-machine
/// inconsistency in when presets could be applied.
fn is_game_running() -> bool {
    crate::process::is_game_running()
}

/// Whether the VALORANT game process is currently running. The frontend uses
/// this (not connection status) to decide when applying a preset is allowed.
#[tauri::command]
pub async fn get_game_running() -> Result<bool, String> {
    Ok(is_game_running())
}

/// Capture the currently signed-in account's cloud settings as a named preset.
/// Requires an active connection (the game must be/have been open for tokens).
#[tauri::command]
pub async fn capture_player_settings(
    state: State<'_, AppState>,
    name: String,
) -> Result<crate::presets::PresetMeta, String> {
    tracing::info!("[Command] capture_player_settings(name={})", name);
    let name = name.trim();
    if name.is_empty() {
        return Err("EMPTY_NAME".into());
    }
    let raw = state.api.fetch_cloud_settings_raw().await?;
    let puuid = state.api.puuid.read().clone();
    let store = preset_store(&state)?;
    let preset = crate::presets::new_preset(name.to_string(), puuid, false, raw);
    store.add(preset)
}

/// Return the crosshair profiles stored inside a preset, parsed from the
/// `SavedCrosshairProfileData` string setting. Shape: `{currentProfile, profiles}`.
/// Lets the UI list/preview crosshairs without shipping the whole 60KB blob.
#[tauri::command]
pub async fn get_preset_crosshairs(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let store = preset_store(&state)?;
    let preset = store
        .get(&id)
        .ok_or_else(|| "Preset not found".to_string())?;

    let empty = serde_json::json!({ "currentProfile": 0, "profiles": [] });

    let raw = preset
        .data
        .get("stringSettings")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|item| {
                let name = item.get("settingEnum")?.as_str()?;
                if name.ends_with("SavedCrosshairProfileData") {
                    item.get("value")?.as_str()
                } else {
                    None
                }
            })
        });

    let Some(raw) = raw else {
        return Ok(empty);
    };

    // Usually a single JSON.parse is enough; rarely the value is double-encoded.
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .or_else(|_| {
            serde_json::from_str::<String>(raw).and_then(|inner| serde_json::from_str(&inner))
        })
        .unwrap_or(empty);

    Ok(parsed)
}

/// List all saved presets (metadata only).
#[tauri::command]
pub async fn list_presets(
    state: State<'_, AppState>,
) -> Result<Vec<crate::presets::PresetMeta>, String> {
    let store = preset_store(&state)?;
    Ok(store.list())
}

/// Delete a preset by id.
#[tauri::command]
pub async fn delete_preset(state: State<'_, AppState>, id: String) -> Result<(), String> {
    tracing::info!("[Command] delete_preset(id={})", id);
    let store = preset_store(&state)?;
    store.delete(&id)
}

/// Rename a preset.
#[tauri::command]
pub async fn rename_preset(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<crate::presets::PresetMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("EMPTY_NAME".into());
    }
    let store = preset_store(&state)?;
    store.rename(&id, name)
}

/// Duplicate a preset under a new name.
#[tauri::command]
pub async fn duplicate_preset(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<crate::presets::PresetMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("EMPTY_NAME".into());
    }
    let store = preset_store(&state)?;
    store.duplicate(&id, name)
}

/// Ensure a one-time safety backup of the signed-in account's current settings
/// exists before we overwrite them. Backup is always automatic (no user opt-in),
/// but kept to **one per account**: the very first apply to an account snapshots
/// its original settings; later applies skip backup so we never overwrite that
/// snapshot with an already-modified state. No-op if a backup already exists.
async fn ensure_account_backup(
    api: &std::sync::Arc<crate::api::ValorantAPI>,
    store: &std::sync::Arc<crate::presets::PresetStore>,
    backup_label: &str,
) -> Result<(), String> {
    let puuid = api.puuid.read().clone();
    // Already have the original for this account — leave it untouched.
    if store.has_account_backup(&puuid) {
        return Ok(());
    }
    let current = api.fetch_cloud_settings_raw().await?;
    let label = if backup_label.trim().is_empty() {
        "Backup".to_string()
    } else {
        backup_label.trim().to_string()
    };
    let backup = crate::presets::new_preset(label, puuid, true, current);
    if let Err(e) = store.add(backup) {
        // A failed backup shouldn't block applying; just log it.
        tracing::warn!("[ensure_account_backup] backup failed: {}", e);
    }
    Ok(())
}

/// Apply a preset to the currently signed-in account's cloud settings. The
/// account's original settings are auto-backed-up once (see
/// [`ensure_account_backup`]). Blocked while the game runs.
#[tauri::command]
pub async fn apply_preset(
    state: State<'_, AppState>,
    id: String,
    backup_label: Option<String>,
) -> Result<(), String> {
    tracing::info!("[Command] apply_preset(id={})", id);

    if is_game_running() {
        return Err("GAME_RUNNING".into());
    }

    let store = preset_store(&state)?;
    let preset = store
        .get(&id)
        .ok_or_else(|| "Preset not found".to_string())?;

    ensure_account_backup(&state.api, &store, backup_label.as_deref().unwrap_or("")).await?;
    state.api.apply_player_settings(&preset.data).await
}

/// Core apply routine shared by the manual command and the auto-apply hook:
/// back up the account's original settings once, then write the preset.
/// Assumes a live connection (caller ensures tokens are fresh).
pub async fn run_apply(
    api: &std::sync::Arc<crate::api::ValorantAPI>,
    store: &std::sync::Arc<crate::presets::PresetStore>,
    preset: &crate::presets::SettingsPreset,
    backup_label: &str,
) -> Result<(), String> {
    ensure_account_backup(api, store, backup_label).await?;
    api.apply_player_settings(&preset.data).await
}

/// Arm a preset to auto-apply on the next fresh connection (next game launch /
/// account login). This is the "gir-çık yok" flow: the user arms while the game
/// is closed; the supervisor applies the moment a fresh token arrives, before
/// the game reads its settings (~46s window).
#[tauri::command]
pub async fn arm_preset(
    state: State<'_, AppState>,
    id: String,
    backup_label: Option<String>,
) -> Result<(), String> {
    // Validate the preset exists before arming.
    let store = preset_store(&state)?;
    store
        .get(&id)
        .ok_or_else(|| "Preset not found".to_string())?;

    *state.armed_preset.write() = Some(crate::state::ArmedPreset {
        id,
        backup_label: backup_label.unwrap_or_default(),
    });
    tracing::info!("[Command] arm_preset armed");
    Ok(())
}

/// Force-close the Riot stack (game + client + Vanguard tray) and arm a preset
/// so it auto-applies the moment the user relaunches Valorant.
///
/// This backs the "Uygula" button when the game is open: the game owns the
/// in-memory settings and rewrites the cloud on exit, so we cannot safely write
/// while it runs. Killing the client too drops our local tokens — the supervisor
/// then re-applies the armed preset on the next fresh connection (relaunch),
/// before the game reads its settings. Returns the number of processes killed.
#[tauri::command]
pub async fn close_riot_and_arm_preset(
    state: State<'_, AppState>,
    id: String,
    backup_label: Option<String>,
) -> Result<u32, String> {
    tracing::info!("[Command] close_riot_and_arm_preset(id={})", id);

    // Validate the preset exists before doing anything destructive.
    let store = preset_store(&state)?;
    store
        .get(&id)
        .ok_or_else(|| "Preset not found".to_string())?;

    // Arm first so that even if the kill races a relaunch, the preset is pending.
    *state.armed_preset.write() = Some(crate::state::ArmedPreset {
        id,
        backup_label: backup_label.unwrap_or_default(),
    });

    // Kill the whole stack so the relaunch starts clean and re-issues tokens.
    let killed = crate::process::kill_riot_stack();
    tracing::info!("[close_riot_and_arm_preset] killed {} process(es)", killed);

    // Our tokens are now invalid; force the supervisor to reconnect (and pick up
    // the armed preset) on the next fresh connection.
    *state.api.needs_reinit.write() = true;

    Ok(killed)
}

/// Cancel a pending armed preset.
#[tauri::command]
pub async fn disarm_preset(state: State<'_, AppState>) -> Result<(), String> {
    *state.armed_preset.write() = None;
    Ok(())
}

/// Id of the currently armed preset, if any (so the UI can show "pending").
#[tauri::command]
pub async fn get_armed_preset(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.armed_preset.read().as_ref().map(|a| a.id.clone()))
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

/// Who this player regularly queued with in their last ~20 matches.
/// Cache-hit is free. A live scan is cooldown-gated so clicking several
/// people in a row cannot stampede match-details.
#[tauri::command]
pub async fn get_frequent_teammates(
    state: State<'_, AppState>,
    puuid: String,
) -> Result<crate::api::types::FrequentTeammatesResponse, String> {
    use crate::api::types::{FrequentAgentPick, FrequentTeammate, FrequentTeammatesResponse};
    use crate::party::{
        tally_frequent_party_mates, tally_top_agents, FrequentMatchRoster, FrequentRosterPlayer,
    };
    use futures_util::future::join_all;
    use std::sync::atomic::Ordering;

    const LOOKBACK: u32 = 20;
    const MIN_GAMES: u32 = 2;
    const MAX_RESULTS: usize = 8;
    const MAX_AGENTS: usize = 3;
    const DETAIL_CONCURRENCY: usize = 3;
    const COOLDOWN_SECS: u64 = 15;

    fn ok_cached(mut cached: FrequentTeammatesResponse) -> FrequentTeammatesResponse {
        cached.from_cache = true;
        cached.status = "ok".into();
        cached
    }

    if puuid.is_empty() {
        return Ok(FrequentTeammatesResponse {
            status: "error".into(),
            ..Default::default()
        });
    }

    if let Some(cached) = state.frequent_teammates_cache.read().get(&puuid).cloned() {
        return Ok(ok_cached(cached));
    }

    if !*state.api.connected.read() {
        return Ok(FrequentTeammatesResponse {
            status: "error".into(),
            ..Default::default()
        });
    }

    if let Some(last) = *state.last_frequent_lookup.read() {
        let elapsed = last.elapsed().as_secs();
        if elapsed < COOLDOWN_SECS {
            return Ok(FrequentTeammatesResponse {
                status: "rate_limited".into(),
                retry_after_secs: (COOLDOWN_SECS - elapsed) as u32,
                ..Default::default()
            });
        }
    }

    if state
        .frequent_lookup_busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(FrequentTeammatesResponse {
            status: "rate_limited".into(),
            retry_after_secs: COOLDOWN_SECS as u32,
            ..Default::default()
        });
    }

    // Re-check cache after winning the lock (another click may have finished).
    if let Some(cached) = state.frequent_teammates_cache.read().get(&puuid).cloned() {
        state.frequent_lookup_busy.store(false, Ordering::SeqCst);
        return Ok(ok_cached(cached));
    }

    *state.last_frequent_lookup.write() = Some(std::time::Instant::now());

    let api = state.api.clone();
    let result = async {
        let match_ids = api.get_match_history_opt(&puuid, LOOKBACK).await?;
        if match_ids.is_empty() {
            return Some((0u32, Vec::new(), Vec::new()));
        }

        let mut rosters: Vec<FrequentMatchRoster> = Vec::new();
        let mut remaining = match_ids.clone();
        while !remaining.is_empty() {
            let n = DETAIL_CONCURRENCY.min(remaining.len());
            let chunk: Vec<String> = remaining.drain(..n).collect();
            let futs: Vec<_> = chunk
                .iter()
                .map(|id| {
                    let mid = id.clone();
                    let api = api.clone();
                    async move { api.get_match_details(&mid).await }
                })
                .collect();
            for details in join_all(futs).await {
                let Some(details) = details else { continue };
                let Some(players) = details.players else { continue };
                let roster: FrequentMatchRoster = players
                    .into_iter()
                    .filter(|p| p.is_observer != Some(true))
                    .map(|p| {
                        let name = match (
                            p.game_name.as_deref().unwrap_or("").trim(),
                            p.tag_line.as_deref().unwrap_or("").trim(),
                        ) {
                            ("", _) => String::new(),
                            (n, "") => n.to_string(),
                            (n, t) => format!("{n}#{t}"),
                        };
                        FrequentRosterPlayer {
                            agent: get_agent_name(p.character_id.as_deref().unwrap_or("")),
                            puuid: p.subject,
                            party_id: p.party_id,
                            name,
                        }
                    })
                    .collect();
                if !roster.is_empty() {
                    rosters.push(roster);
                }
            }
        }

        let scanned = rosters.len() as u32;
        let tallied = tally_frequent_party_mates(&puuid, &rosters, MIN_GAMES, MAX_RESULTS);
        let subject_agents = tally_top_agents(&puuid, &rosters, MAX_AGENTS);

        let missing: Vec<String> = tallied
            .iter()
            .filter(|(_, name, _)| name.is_empty())
            .map(|(id, _, _)| id.clone())
            .collect();
        let resolved = if missing.is_empty() {
            std::collections::HashMap::new()
        } else {
            api.get_player_names(&missing).await
        };

        let teammates: Vec<FrequentTeammate> = tallied
            .into_iter()
            .map(|(id, name, games)| FrequentTeammate {
                top_agents: tally_top_agents(&id, &rosters, MAX_AGENTS)
                    .into_iter()
                    .map(|(agent, n)| FrequentAgentPick { agent, games: n })
                    .collect(),
                name: if name.is_empty() {
                    resolved.get(&id).cloned().unwrap_or_default()
                } else {
                    name
                },
                puuid: id,
                games_together: games,
            })
            .collect();

        let top_agents: Vec<FrequentAgentPick> = subject_agents
            .into_iter()
            .map(|(agent, n)| FrequentAgentPick { agent, games: n })
            .collect();

        Some((scanned, teammates, top_agents))
    }
    .await;

    state.frequent_lookup_busy.store(false, Ordering::SeqCst);

    let Some((scanned, teammates, top_agents)) = result else {
        tracing::warn!("[frequent] history fetch failed for {}", puuid);
        return Ok(FrequentTeammatesResponse {
            status: "error".into(),
            ..Default::default()
        });
    };

    let payload = FrequentTeammatesResponse {
        status: "ok".into(),
        retry_after_secs: 0,
        matches_scanned: scanned,
        from_cache: false,
        teammates,
        top_agents,
    };
    state
        .frequent_teammates_cache
        .write()
        .insert(puuid, payload.clone());
    tracing::info!(
        "[frequent] scanned={} found={}",
        payload.matches_scanned,
        payload.teammates.len()
    );
    Ok(payload)
}

/// Get the logged-in user's storefront (daily shop + optional night market).
#[tauri::command]
pub async fn get_storefront(
    state: State<'_, AppState>,
) -> Result<Option<crate::api::types::StorefrontData>, String> {
    use crate::api::types::*;
    let api = &state.api;

    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    let raw = match api.get_storefront().await {
        Some(r) => r,
        None => return Ok(None),
    };

    let vp =
        |c: &std::collections::HashMap<String, i64>| c.get(VP_CURRENCY_ID).copied().unwrap_or(0);

    let daily_offers: Vec<ShopOffer> = raw
        .skins_panel_layout
        .single_item_store_offers
        .iter()
        .map(|o| {
            let skin = o
                .rewards
                .first()
                .map(|r| r.item_id.to_lowercase())
                .unwrap_or_default();
            ShopOffer {
                offer_id: o.offer_id.clone(),
                skin_level_id: skin,
                vp_cost: vp(&o.cost),
            }
        })
        .collect();

    let (night_market, nm_secs) = match &raw.bonus_store {
        Some(bs) => {
            let offers: Vec<NightMarketOffer> = bs
                .bonus_store_offers
                .iter()
                .map(|b| {
                    let skin = b
                        .offer
                        .rewards
                        .first()
                        .map(|r| r.item_id.to_lowercase())
                        .unwrap_or_default();
                    NightMarketOffer {
                        offer_id: b.bonus_offer_id.clone(),
                        skin_level_id: skin,
                        vp_cost: vp(&b.offer.cost),
                        discounted_cost: vp(&b.discount_costs),
                        discount_percent: b.discount_percent,
                        is_seen: b.is_seen,
                    }
                })
                .collect();
            (
                Some(offers),
                Some(bs.bonus_store_remaining_duration_in_seconds),
            )
        }
        None => (None, None),
    };

    Ok(Some(StorefrontData {
        daily_offers,
        daily_remaining_seconds: raw
            .skins_panel_layout
            .single_item_offers_remaining_duration_in_seconds,
        night_market,
        night_market_remaining_seconds: nm_secs,
    }))
}

/// Get the logged-in user's currency balances (VP / Radianite / Kingdom).
#[tauri::command]
pub async fn get_wallet(
    state: State<'_, AppState>,
) -> Result<Option<crate::api::types::WalletData>, String> {
    use crate::api::types::*;
    let api = &state.api;

    if !*api.connected.read() {
        return Err("Not connected".into());
    }

    let raw = match api.get_wallet().await {
        Some(r) => r,
        None => return Ok(None),
    };

    let bal = |id: &str| raw.balances.get(id).copied().unwrap_or(0);

    Ok(Some(WalletData {
        vp: bal(VP_CURRENCY_ID),
        radianite: bal(RADIANITE_CURRENCY_ID),
        kingdom: bal(KINGDOM_CURRENCY_ID),
    }))
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

/// Unique-install total. Increments the remote counter at most once per machine.
#[tauri::command]
pub async fn get_install_count(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<u64>, String> {
    Ok(crate::usage::report(&app, &state.http_client).await)
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

#[tauri::command]
pub fn get_app_constants() -> crate::constants::AppConstants {
    crate::constants::APP_CONSTANTS.clone()
}

#[derive(serde::Serialize, Clone)]
pub struct TranslateResult {
    pub text: String,
    pub source_lang: String,
}

/// Translate free text via Google Translate (same path as chat `!t` shortcuts).
/// Runs on a blocking thread so the async runtime is not stalled.
/// Returns Err when the network/API fails so the UI can show an error state.
#[tauri::command]
pub async fn translate_text(
    text: String,
    target_lang: String,
) -> Result<TranslateResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Empty text".into());
    }
    if target_lang.trim().is_empty() || target_lang.len() > 12 {
        return Err("Invalid target language".into());
    }

    let target_lang = target_lang.trim().to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::chat_text::google_translate_detailed(&text, &target_lang)
    })
    .await
    .map_err(|e| format!("Translate task failed: {}", e))?;

    result
        .map(|r| TranslateResult {
            text: r.text,
            source_lang: r.source_lang,
        })
        .ok_or_else(|| "Translation failed".into())
}
