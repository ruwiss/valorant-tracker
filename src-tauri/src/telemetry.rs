use crate::api::types::GameState;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::Notify;

const HEARTBEAT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(4);
const NAME_RETRY: Duration = Duration::from_secs(300);
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const PREFER: &str = "return=minimal";
const ID_CAP: usize = 20;

struct Config {
    url: String,
    anon_key: String,
}

#[derive(Deserialize)]
struct TelemetryFile {
    url: String,
    #[serde(rename = "anonKey")]
    anon_key: String,
}

#[derive(Deserialize)]
struct ConnPayload {
    status: String,
    region: String,
}

#[derive(Default, Clone)]
struct Live {
    conn_status: String,
    region: String,
    game_state: String,
    map_name: Option<String>,
    mode_name: Option<String>,
    queue_id: Option<String>,
    activity: Option<String>,
    party_state: Option<String>,
    party_size: Option<i32>,
    ally_score: Option<i32>,
    enemy_score: Option<i32>,
    agent: Option<String>,
    roster: Vec<String>,
    me_puuid: Option<String>,
    me_name: Option<String>,
}

pub struct Bridge {
    cfg: Config,
    live: Arc<parking_lot::Mutex<Live>>,
    notify: Arc<Notify>,
}

struct NameCache {
    puuid: Option<String>,
    name: Option<String>,
    retry_at: Option<Instant>,
}

struct TaskState {
    session_id: String,
    started_at: String,
    session_inserted: bool,
    phase: Option<String>,
    map: Option<String>,
    mode: Option<String>,
    queue_id: Option<String>,
    party_state: Option<String>,
    party_size: Option<i32>,
    ally_score: Option<i32>,
    enemy_score: Option<i32>,
    agent: Option<String>,
    roster_fp: Option<String>,
    lobby_done: Option<String>,
    names: NameCache,
}

enum Wake {
    Launch,
    Heartbeat,
    Event,
}

struct InFlight<'a>(&'a AtomicBool);

impl<'a> InFlight<'a> {
    fn try_enter(flag: &'a AtomicBool) -> Option<Self> {
        if flag
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            Some(Self(flag))
        } else {
            None
        }
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub fn attach(app: &AppHandle) -> Option<Bridge> {
    let cfg = match load_config(app) {
        Some(cfg) => cfg,
        None => {
            tracing::info!("[Telemetry] disabled (no config)");
            return None;
        }
    };
    let bridge = Bridge {
        cfg,
        live: Arc::new(parking_lot::Mutex::new(Live::default())),
        notify: Arc::new(Notify::new()),
    };
    subscribe(app, &bridge);
    Some(bridge)
}

pub async fn run(app: AppHandle, bridge: Bridge) {
    let Some(install_id) = crate::usage::ensure_install_id(&app).await else {
        tracing::info!("[Telemetry] disabled (no install id)");
        return;
    };
    let client = app.state::<AppState>().http_client.clone();
    let gate = AtomicBool::new(false);
    let mut state = TaskState {
        session_id: uuid::Uuid::new_v4().to_string(),
        started_at: rfc3339_now(),
        session_inserted: false,
        phase: None,
        map: None,
        mode: None,
        queue_id: None,
        party_state: None,
        party_size: None,
        ally_score: None,
        enemy_score: None,
        agent: None,
        roster_fp: None,
        lobby_done: None,
        names: NameCache {
            puuid: None,
            name: None,
            retry_at: None,
        },
    };

    flush(&app, &bridge, &client, &install_id, &gate, &mut state, Wake::Launch).await;

    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT,
        HEARTBEAT,
    );
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        let wake = tokio::select! {
            _ = interval.tick() => Wake::Heartbeat,
            _ = bridge.notify.notified() => Wake::Event,
        };
        flush(&app, &bridge, &client, &install_id, &gate, &mut state, wake).await;
    }
}

fn subscribe(app: &AppHandle, bridge: &Bridge) {
    let live = bridge.live.clone();
    let notify = bridge.notify.clone();
    app.listen("connection_changed", move |event| {
        match serde_json::from_str::<ConnPayload>(event.payload()) {
            Ok(payload) => {
                let mut slot = live.lock();
                slot.conn_status = payload.status;
                slot.region = payload.region;
                drop(slot);
                notify.notify_one();
            }
            Err(err) => tracing::debug!("[Telemetry] bad connection_changed: {err}"),
        }
    });

    let live = bridge.live.clone();
    let notify = bridge.notify.clone();
    app.listen("game_state_changed", move |event| {
        match serde_json::from_str::<GameState>(event.payload()) {
            Ok(gs) => {
                let me = gs
                    .allies
                    .iter()
                    .chain(gs.enemies.iter())
                    .find(|p| p.is_me);
                let mut roster = Vec::with_capacity(gs.allies.len() + gs.enemies.len());
                for player in gs.allies.iter().chain(gs.enemies.iter()) {
                    roster.push(player.puuid.clone());
                }
                let mut slot = live.lock();
                slot.game_state = gs.state;
                slot.map_name = blank_to_none(gs.map_name);
                slot.mode_name = blank_to_none(gs.report_mode).or_else(|| blank_to_none(gs.mode_name));
                slot.queue_id = blank_to_none(gs.queue_id);
                slot.activity = blank_to_none(gs.activity);
                slot.party_state = blank_to_none(gs.party_state);
                slot.party_size = gs.party_size.filter(|n| *n > 0);
                slot.ally_score = gs.ally_score;
                slot.enemy_score = gs.enemy_score;
                slot.roster = roster;
                if let Some(me) = me {
                    if normalize_puuid(&me.puuid).is_some() {
                        slot.me_puuid = Some(me.puuid.clone());
                    }
                    if let Some(name) = blank_to_none(Some(me.name.clone())) {
                        slot.me_name = Some(name);
                    }
                    slot.agent = blank_to_none(Some(me.agent.clone()));
                } else {
                    slot.agent = None;
                }
                drop(slot);
                notify.notify_one();
            }
            Err(err) => tracing::debug!("[Telemetry] bad game_state_changed: {err}"),
        }
    });
}

async fn flush(
    app: &AppHandle,
    bridge: &Bridge,
    client: &reqwest::Client,
    install_id: &str,
    gate: &AtomicBool,
    state: &mut TaskState,
    wake: Wake,
) {
    let snap = bridge.live.lock().clone();
    let phase = phase_label(&snap.game_state, &snap.conn_status, snap.activity.as_deref());
    let map = snap.map_name.clone();
    let mode = snap.mode_name.clone();
    let queue_id = snap.queue_id.clone();
    let party_state = snap.party_state.clone();
    let party_size = snap.party_size;
    let ally_score = snap.ally_score;
    let enemy_score = snap.enemy_score;
    let agent = snap.agent.clone();
    let compact = compact_ids(&snap.roster);
    let fp = roster_fingerprint(&compact);
    let launch_or_heartbeat = matches!(wake, Wake::Launch | Wake::Heartbeat);
    let phase_changed = state.phase.as_deref() != Some(phase)
        || state.map != map
        || state.mode != mode
        || state.queue_id != queue_id
        || state.party_state != party_state
        || state.party_size != party_size
        || state.ally_score != ally_score
        || state.enemy_score != enemy_score
        || state.agent != agent;
    let roster_changed = state.roster_fp.as_deref() != Some(fp.as_str());

    if matches!(wake, Wake::Event) && !phase_changed && !roster_changed {
        return;
    }

    let want_presence = should_upsert_presence(launch_or_heartbeat, phase_changed);
    let fingerprint_done = state.lobby_done.as_deref() == Some(fp.as_str());
    let want_lobby = should_lookup_lobby(
        !compact.is_empty(),
        fingerprint_done,
        roster_changed,
        phase_changed,
        launch_or_heartbeat,
    );
    let want_session = launch_or_heartbeat;

    if !want_presence && !want_lobby && !want_session {
        state.phase = Some(phase.to_string());
        state.map = map;
        state.mode = mode;
        state.queue_id = queue_id;
        state.party_state = party_state;
        state.party_size = party_size;
        state.ally_score = ally_score;
        state.enemy_score = enemy_score;
        state.agent = agent;
        state.roster_fp = Some(fp);
        return;
    }

    let Some(_inflight) = InFlight::try_enter(gate) else {
        tracing::debug!("[Telemetry] skip in-flight");
        return;
    };

    state.phase = Some(phase.to_string());
    state.map = map.clone();
    state.mode = mode.clone();
    state.queue_id = queue_id.clone();
    state.party_state = party_state.clone();
    state.party_size = party_size;
    state.ally_score = ally_score;
    state.enemy_score = enemy_score;
    state.agent = agent.clone();
    state.roster_fp = Some(fp.clone());

    let now = rfc3339_now();
    if want_presence {
        let (mut raw_puuid, mut roster_name) = current_identity(app, &snap);
        if raw_puuid.is_none() || roster_name.is_none() {
            if let Some((id, name)) = app.state::<AppState>().api.get_my_riot_id().await {
                if raw_puuid.is_none() && normalize_puuid(&id).is_some() {
                    raw_puuid = Some(id);
                }
                if roster_name.is_none() && !name.is_empty() {
                    roster_name = Some(name);
                }
            }
        }
        let norm = raw_puuid.as_deref().and_then(normalize_puuid);
        let riot_name = match (norm.clone(), raw_puuid) {
            (Some(norm), Some(raw)) => {
                riot_name(app, &mut state.names, &raw, &norm, roster_name).await
            }
            _ => None,
        };
        let region = current_region(app, &snap);
        let body = PresenceBody {
            install_id,
            puuid: norm.clone(),
            riot_name: riot_name.clone(),
            app_version: APP_VERSION,
            region,
            phase,
            map_name: map,
            mode_name: mode,
            queue_id,
            party_state,
            party_size,
            ally_score,
            enemy_score,
            agent,
            session_started_at: &state.started_at,
            last_seen: &now,
        };
        match write_json(client, &bridge.cfg, Method::Post, "/rest/v1/rpc/upsert_presence", &body).await {
            Ok(status) if status.is_success() => {}
            Ok(status) => tracing::warn!("[Telemetry] presence upsert HTTP {status}"),
            Err(err) => tracing::warn!("[Telemetry] presence upsert failed: {err}"),
        }
        if let Some(puuid) = norm.as_deref() {
            let user = UserBody {
                puuid,
                riot_name,
                app_version: APP_VERSION,
                install_id,
                last_seen: &now,
            };
            match write_json(client, &bridge.cfg, Method::Post, "/rest/v1/rpc/upsert_user", &user).await {
                Ok(status) if status.is_success() => {}
                Ok(status) => tracing::warn!("[Telemetry] users upsert HTTP {status}"),
                Err(err) => tracing::warn!("[Telemetry] users upsert failed: {err}"),
            }
        }
    }

    if want_session && !state.session_inserted {
        let body = SessionInsert {
            id: &state.session_id,
            install_id,
            started_at: &state.started_at,
            ended_at: &state.started_at,
            app_version: APP_VERSION,
        };
        match write_json(client, &bridge.cfg, Method::Post, "/rest/v1/rpc/upsert_session", &body).await {
            Ok(status) if status.is_success() || status == reqwest::StatusCode::CONFLICT => {
                state.session_inserted = true;
            }
            Ok(status) => tracing::warn!("[Telemetry] session insert HTTP {status}"),
            Err(err) => tracing::warn!("[Telemetry] session insert failed: {err}"),
        }
    }
    if want_session && state.session_inserted && matches!(wake, Wake::Heartbeat) {
        let body = SessionInsert {
            id: &state.session_id,
            install_id,
            started_at: &state.started_at,
            ended_at: &now,
            app_version: APP_VERSION,
        };
        match write_json(client, &bridge.cfg, Method::Post, "/rest/v1/rpc/upsert_session", &body).await {
            Ok(status) if status.is_success() => {}
            Ok(status) => tracing::warn!("[Telemetry] session patch HTTP {status}"),
            Err(err) => tracing::warn!("[Telemetry] session patch failed: {err}"),
        }
    }

    if want_lobby {
        match lookup_overlay_users(client, &bridge.cfg, &compact).await {
            Ok(matched) => {
                if matched.is_empty() {
                    state.lobby_done = Some(fp);
                } else if let Err(err) = app.emit("overlay_users", &OverlayUsers { puuids: &matched }) {
                    tracing::debug!("[Telemetry] emit overlay_users failed: {err}");
                } else {
                    state.lobby_done = Some(fp);
                }
            }
            Err(err) => tracing::warn!("[Telemetry] lobby lookup failed: {err}"),
        }
    }
}

fn current_identity(app: &AppHandle, snap: &Live) -> (Option<String>, Option<String>) {
    if let Some(raw) = &snap.me_puuid {
        if normalize_puuid(raw).is_some() {
            return (Some(raw.clone()), snap.me_name.clone());
        }
    }
    let api_puuid = app.state::<AppState>().api.puuid.read().clone();
    if normalize_puuid(&api_puuid).is_some() {
        (Some(api_puuid), None)
    } else {
        (None, None)
    }
}

fn current_region(app: &AppHandle, snap: &Live) -> Option<String> {
    let raw = if snap.region.trim().is_empty() {
        app.state::<AppState>().api.region.read().clone()
    } else {
        snap.region.clone()
    };
    blank_to_none(Some(raw))
}

async fn riot_name(
    app: &AppHandle,
    cache: &mut NameCache,
    raw: &str,
    norm: &str,
    roster_name: Option<String>,
) -> Option<String> {
    if let Some(name) = roster_name.filter(|n| !n.is_empty()) {
        cache.puuid = Some(norm.to_string());
        cache.name = Some(name.clone());
        cache.retry_at = None;
        return Some(name);
    }
    if cache.puuid.as_deref() == Some(norm) {
        if let Some(name) = &cache.name {
            return blank_to_none(Some(name.clone()));
        }
        if let Some(at) = cache.retry_at {
            if Instant::now() < at {
                return None;
            }
        }
    }
    let api = app.state::<AppState>().api.clone();
    let map = api.get_player_names(&[raw.to_string()]).await;
    match name_from_map(&map, raw, norm) {
        Some(name) => {
            cache.puuid = Some(norm.to_string());
            cache.name = Some(name.clone());
            cache.retry_at = None;
            blank_to_none(Some(name))
        }
        None => {
            cache.puuid = Some(norm.to_string());
            cache.name = None;
            cache.retry_at = Some(Instant::now() + NAME_RETRY);
            tracing::debug!("[Telemetry] name lookup failed");
            None
        }
    }
}

fn name_from_map(map: &HashMap<String, String>, raw: &str, norm: &str) -> Option<String> {
    if let Some(name) = map.get(raw) {
        return Some(name.clone());
    }
    map.iter().find_map(|(key, name)| {
        (normalize_puuid(key).as_deref() == Some(norm)).then(|| name.clone())
    })
}

async fn lookup_overlay_users(
    client: &reqwest::Client,
    cfg: &Config,
    ids: &[String],
) -> Result<Vec<String>, String> {
    let resp = send(
        client,
        cfg,
        Method::Post,
        "/rest/v1/rpc/match_overlay_users",
        &serde_json::json!({ "ids": ids }),
        false,
    )
    .await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let parsed = resp
        .json::<Vec<String>>()
        .await
        .map_err(|err| err.to_string())?;
    Ok(compact_ids(&parsed))
}

async fn write_json(
    client: &reqwest::Client,
    cfg: &Config,
    method: Method,
    path: &str,
    body: &impl Serialize,
) -> Result<reqwest::StatusCode, String> {
    let resp = send(client, cfg, method, path, body, true).await?;
    Ok(resp.status())
}

async fn send(
    client: &reqwest::Client,
    cfg: &Config,
    method: Method,
    path: &str,
    body: &impl Serialize,
    prefer: bool,
) -> Result<reqwest::Response, String> {
    let url = format!("{}{path}", cfg.url);
    let mut req = match method {
        Method::Post => client.post(&url),
    };
    req = req
        .timeout(HTTP_TIMEOUT)
        .header("User-Agent", "valorant-tracker")
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key));
    if prefer {
        req = req.header("Prefer", PREFER);
    }
    req.json(body).send().await.map_err(|err| err.to_string())
}

enum Method {
    Post,
}

#[derive(Serialize)]
struct PresenceBody<'a> {
    install_id: &'a str,
    puuid: Option<String>,
    riot_name: Option<String>,
    app_version: &'static str,
    region: Option<String>,
    phase: &'a str,
    map_name: Option<String>,
    mode_name: Option<String>,
    queue_id: Option<String>,
    party_state: Option<String>,
    party_size: Option<i32>,
    ally_score: Option<i32>,
    enemy_score: Option<i32>,
    agent: Option<String>,
    session_started_at: &'a str,
    last_seen: &'a str,
}

#[derive(Serialize)]
struct UserBody<'a> {
    puuid: &'a str,
    riot_name: Option<String>,
    app_version: &'static str,
    install_id: &'a str,
    last_seen: &'a str,
}

#[derive(Serialize)]
struct SessionInsert<'a> {
    id: &'a str,
    install_id: &'a str,
    started_at: &'a str,
    ended_at: &'a str,
    app_version: &'static str,
}

#[derive(Serialize)]
struct OverlayUsers<'a> {
    puuids: &'a [String],
}

fn load_config(app: &AppHandle) -> Option<Config> {
    let file = read_file(app);
    resolve_config(
        option_env!("SUPABASE_URL"),
        option_env!("SUPABASE_ANON_KEY"),
        file.as_ref().map(|f| f.url.as_str()),
        file.as_ref().map(|f| f.anon_key.as_str()),
    )
}

fn read_file(app: &AppHandle) -> Option<TelemetryFile> {
    let dir = app.path().app_data_dir().ok()?;
    let raw = std::fs::read_to_string(dir.join("telemetry.json")).ok()?;
    match serde_json::from_str::<TelemetryFile>(&raw) {
        Ok(file) => Some(file),
        Err(err) => {
            tracing::debug!("[Telemetry] telemetry.json parse failed: {err}");
            None
        }
    }
}

fn resolve_config(
    env_url: Option<&str>,
    env_key: Option<&str>,
    file_url: Option<&str>,
    file_key: Option<&str>,
) -> Option<Config> {
    if let (Some(url), Some(key)) = (nonempty(env_url), nonempty(env_key)) {
        return Some(Config {
            url: trim_url(url),
            anon_key: key.to_string(),
        });
    }
    let url = nonempty(file_url)?;
    let key = nonempty(file_key)?;
    Some(Config {
        url: trim_url(url),
        anon_key: key.to_string(),
    })
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn trim_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn should_upsert_presence(launch_or_heartbeat: bool, phase_map_mode_changed: bool) -> bool {
    launch_or_heartbeat || phase_map_mode_changed
}

fn should_lookup_lobby(
    non_empty: bool,
    fingerprint_done: bool,
    roster_changed: bool,
    phase_changed: bool,
    launch_or_heartbeat: bool,
) -> bool {
    non_empty
        && !fingerprint_done
        && (roster_changed || phase_changed || launch_or_heartbeat)
}

fn normalize_puuid(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(32);
    for c in raw.chars() {
        if c == '-' {
            continue;
        }
        if !c.is_ascii_hexdigit() {
            return None;
        }
        out.push(c.to_ascii_lowercase());
        if out.len() > 32 {
            return None;
        }
    }
    (out.len() == 32).then_some(out)
}

fn compact_ids(ids: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        let Some(norm) = normalize_puuid(id) else {
            continue;
        };
        if seen.insert(norm.clone()) {
            out.push(norm);
            if out.len() == ID_CAP {
                break;
            }
        }
    }
    out
}

fn roster_fingerprint(ids: &[String]) -> String {
    let mut compact = compact_ids(ids);
    compact.sort();
    compact.join(",")
}

fn phase_label(game_state: &str, conn_status: &str, activity: Option<&str>) -> &'static str {
    if game_state == "pregame" {
        return "pregame";
    }
    if game_state == "ingame" {
        return "ingame";
    }
    if conn_status == "paused" {
        return "paused";
    }
    if conn_status == "waiting_for_game" || conn_status == "connecting" {
        return "offline";
    }
    match activity {
        Some("queue") => "queue",
        Some("custom") => "custom",
        _ => "idle",
    }
}

fn rfc3339_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339(secs)
}

fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hour = tod / 3600;
    let min = (tod % 3600) / 60;
    let sec = tod % 60;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_id(n: u32) -> String {
        format!("{n:032x}")
    }

    #[test]
    fn normalize_puuid_accepts_hyphenated_uppercase() {
        let raw = "550E8400-E29B-41D4-A716-446655440000";
        assert_eq!(
            normalize_puuid(raw).as_deref(),
            Some("550e8400e29b41d4a716446655440000")
        );
    }

    #[test]
    fn compact_ids_drops_invalid() {
        let ids = vec![
            "not-a-puuid".to_string(),
            "550E8400-E29B-41D4-A716-44665544000".to_string(),
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz".to_string(),
            hex_id(1),
        ];
        assert_eq!(compact_ids(&ids), vec![hex_id(1)]);
    }

    #[test]
    fn compact_ids_dedupes_preserving_first_seen() {
        let hyphenated = "550E8400-E29B-41D4-A716-446655440000".to_string();
        let plain = "550e8400e29b41d4a716446655440000".to_string();
        let other = hex_id(2);
        let ids = vec![hyphenated, other.clone(), plain, "nope".to_string()];
        assert_eq!(
            compact_ids(&ids),
            vec!["550e8400e29b41d4a716446655440000".to_string(), other]
        );
    }

    #[test]
    fn compact_ids_caps_at_20() {
        let ids: Vec<String> = (1..=25).map(hex_id).collect();
        let out = compact_ids(&ids);
        assert_eq!(out.len(), 20);
        assert_eq!(out[0], hex_id(1));
        assert_eq!(out[19], hex_id(20));
        assert!(!out.contains(&hex_id(21)));
    }

    #[test]
    fn roster_fingerprint_ignores_order() {
        let a = hex_id(2);
        let b = hex_id(1);
        assert_eq!(
            roster_fingerprint(&[a.clone(), b.clone()]),
            roster_fingerprint(&[b, a])
        );
        assert_ne!(
            roster_fingerprint(&[hex_id(1)]),
            roster_fingerprint(&[hex_id(1), hex_id(2)])
        );
    }

    #[test]
    fn phase_label_ingame_beats_connecting() {
        assert_eq!(phase_label("ingame", "connecting", None), "ingame");
        assert_eq!(phase_label("pregame", "paused", Some("queue")), "pregame");
    }

    #[test]
    fn phase_label_paused_only_outside_match() {
        assert_eq!(phase_label("idle", "paused", Some("queue")), "paused");
        assert_eq!(phase_label("", "paused", None), "paused");
        assert_eq!(phase_label("ingame", "paused", None), "ingame");
        assert_eq!(phase_label("idle", "waiting_for_game", Some("queue")), "offline");
        assert_eq!(phase_label("idle", "connecting", None), "offline");
        assert_eq!(phase_label("idle", "connected", None), "idle");
        assert_eq!(phase_label("idle", "connected", Some("queue")), "queue");
        assert_eq!(phase_label("idle", "connected", Some("custom")), "custom");
    }

    #[test]
    fn score_only_change_does_not_request() {
        assert!(!should_upsert_presence(false, false));
        assert!(!should_lookup_lobby(true, true, false, false, false));
        assert!(!should_lookup_lobby(true, false, false, false, false));
        assert!(should_lookup_lobby(true, false, true, false, false));
        assert!(should_lookup_lobby(true, false, false, true, false));
        assert!(should_upsert_presence(true, false));
    }

    #[test]
    fn empty_env_falls_through_to_file() {
        let cfg = resolve_config(Some(""), Some("key"), Some("https://x.supabase.co/"), Some("anon")).unwrap();
        assert_eq!(cfg.url, "https://x.supabase.co");
        assert_eq!(cfg.anon_key, "anon");
        assert!(resolve_config(Some(""), Some(""), None, None).is_none());
    }

    #[test]
    fn rfc3339_formats_unix_epoch() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(86_400), "1970-01-02T00:00:00Z");
    }
}
