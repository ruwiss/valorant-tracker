use crate::api::types::GameState;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::Notify;

const HEARTBEAT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(4);
const NAME_RETRY: Duration = Duration::from_secs(300);
/// Round score changes every ~100 s. Reporting each one doubled request
/// volume for a field nobody needs to the second; batch score-only changes.
const SCORE_THROTTLE: Duration = Duration::from_secs(120);
/// Exit must not hold the app open: best effort, then give up.
const EXIT_TIMEOUT: Duration = Duration::from_millis(1500);
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const PREFER: &str = "return=minimal";
const ID_CAP: usize = 20;
const REPORT_PATH: &str = "/rest/v1/rpc/report_telemetry";

#[derive(Clone)]
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

/// What the exit hook needs to mark this install closed.
struct ExitCtx {
    cfg: Config,
    install_id: String,
    session_id: String,
}

static EXIT_CTX: parking_lot::Mutex<Option<ExitCtx>> = parking_lot::Mutex::new(None);

struct TaskState {
    session_id: String,
    last_report: Option<Instant>,
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
    let session_id = uuid::Uuid::new_v4().to_string();
    *EXIT_CTX.lock() = Some(ExitCtx {
        cfg: bridge.cfg.clone(),
        install_id: install_id.clone(),
        session_id: session_id.clone(),
    });
    let mut state = TaskState {
        session_id,
        last_report: None,
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

/// Fields that make the admin row stale when they change. Scores are kept
/// apart so they can be throttled.
#[derive(Clone, PartialEq)]
struct Core {
    phase: &'static str,
    map: Option<String>,
    mode: Option<String>,
    queue_id: Option<String>,
    party_state: Option<String>,
    party_size: Option<i32>,
    agent: Option<String>,
}

fn remember(state: &mut TaskState, core: &Core, scores: Option<(Option<i32>, Option<i32>)>, fp: &str) {
    state.phase = Some(core.phase.to_string());
    state.map = core.map.clone();
    state.mode = core.mode.clone();
    state.queue_id = core.queue_id.clone();
    state.party_state = core.party_state.clone();
    state.party_size = core.party_size;
    state.agent = core.agent.clone();
    if let Some((ally, enemy)) = scores {
        state.ally_score = ally;
        state.enemy_score = enemy;
    }
    state.roster_fp = Some(fp.to_string());
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
    let core = Core {
        phase: phase_label(&snap.game_state, &snap.conn_status, snap.activity.as_deref()),
        map: snap.map_name.clone(),
        mode: snap.mode_name.clone(),
        queue_id: snap.queue_id.clone(),
        party_state: snap.party_state.clone(),
        party_size: snap.party_size,
        agent: snap.agent.clone(),
    };
    let (ally_score, enemy_score) = (snap.ally_score, snap.enemy_score);
    let compact = compact_ids(&snap.roster);
    let fp = roster_fingerprint(&compact);
    let launch_or_heartbeat = matches!(wake, Wake::Launch | Wake::Heartbeat);
    let core_changed = state.phase.as_deref() != Some(core.phase)
        || state.map != core.map
        || state.mode != core.mode
        || state.queue_id != core.queue_id
        || state.party_state != core.party_state
        || state.party_size != core.party_size
        || state.agent != core.agent;
    let score_changed = state.ally_score != ally_score || state.enemy_score != enemy_score;
    let roster_changed = state.roster_fp.as_deref() != Some(fp.as_str());

    if matches!(wake, Wake::Event) && !core_changed && !score_changed && !roster_changed {
        return;
    }

    let score_throttled = score_throttled(
        launch_or_heartbeat,
        core_changed,
        score_changed,
        state.last_report.map(|t| t.elapsed()),
    );
    let want_report = launch_or_heartbeat || core_changed || (score_changed && !score_throttled);
    let fingerprint_done = state.lobby_done.as_deref() == Some(fp.as_str());
    let want_lobby = should_lookup_lobby(
        !compact.is_empty(),
        fingerprint_done,
        roster_changed,
        core_changed,
        launch_or_heartbeat,
    );

    if !want_report && !want_lobby {
        // Leave throttled scores unrecorded so a later flush still sees them.
        remember(state, &core, None, &fp);
        return;
    }

    let Some(_inflight) = InFlight::try_enter(gate) else {
        tracing::debug!("[Telemetry] skip in-flight");
        return;
    };

    let scores = want_report.then_some((ally_score, enemy_score));
    remember(state, &core, scores, &fp);

    if want_report {
        let (mut raw_puuid, mut roster_name) = current_identity(app, &snap);
        // The local Riot ID lookup is only needed when the roster did not
        // carry our identity and the name cache has nothing for it either.
        let cached_name = raw_puuid
            .as_deref()
            .and_then(normalize_puuid)
            .is_some_and(|n| state.names.puuid.as_deref() == Some(n.as_str()) && state.names.name.is_some());
        if raw_puuid.is_none() || (roster_name.is_none() && !cached_name) {
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
        let body = ReportBody {
            install_id,
            session_id: &state.session_id,
            puuid: norm,
            riot_name,
            app_version: APP_VERSION,
            region: current_region(app, &snap),
            phase: core.phase,
            map_name: core.map,
            mode_name: core.mode,
            queue_id: core.queue_id,
            party_state: core.party_state,
            party_size: core.party_size,
            ally_score,
            enemy_score,
            agent: core.agent,
        };
        // Stamp before sending so a failing endpoint is not hammered by
        // every score change.
        state.last_report = Some(Instant::now());
        match write_json(client, &bridge.cfg, REPORT_PATH, &ReportRequest { payload: body }).await {
            Ok(status) if status.is_success() => {}
            Ok(status) => tracing::warn!("[Telemetry] report HTTP {status}"),
            Err(err) => tracing::warn!("[Telemetry] report failed: {err}"),
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

/// Exit hook: mark this install closed so the admin panel does not show it
/// online for another six minutes. Blocks at most `EXIT_TIMEOUT`.
pub fn report_closed(app: &AppHandle) {
    let Some(ctx) = EXIT_CTX.lock().take() else {
        return;
    };
    let client = app.state::<AppState>().http_client.clone();
    let body = ReportRequest {
        payload: ReportBody {
            install_id: &ctx.install_id,
            session_id: &ctx.session_id,
            puuid: None,
            riot_name: None,
            app_version: APP_VERSION,
            region: None,
            phase: "closed",
            map_name: None,
            mode_name: None,
            queue_id: None,
            party_state: None,
            party_size: None,
            ally_score: None,
            enemy_score: None,
            agent: None,
        },
    };
    let result = tauri::async_runtime::block_on(async {
        tokio::time::timeout(EXIT_TIMEOUT, write_json(&client, &ctx.cfg, REPORT_PATH, &body)).await
    });
    match result {
        Ok(Ok(status)) if status.is_success() => tracing::info!("[Telemetry] marked closed"),
        Ok(Ok(status)) => tracing::debug!("[Telemetry] close report HTTP {status}"),
        Ok(Err(err)) => tracing::debug!("[Telemetry] close report failed: {err}"),
        Err(_) => tracing::debug!("[Telemetry] close report timed out"),
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
    path: &str,
    body: &impl Serialize,
) -> Result<reqwest::StatusCode, String> {
    let resp = send(client, cfg, path, body, true).await?;
    Ok(resp.status())
}

async fn send(
    client: &reqwest::Client,
    cfg: &Config,
    path: &str,
    body: &impl Serialize,
    prefer: bool,
) -> Result<reqwest::Response, String> {
    let url = format!("{}{path}", cfg.url);
    let mut req = client
        .post(&url)
        .timeout(HTTP_TIMEOUT)
        .header("User-Agent", "valorant-tracker")
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key));
    if prefer {
        req = req.header("Prefer", PREFER);
    }
    req.json(body).send().await.map_err(|err| err.to_string())
}

/// `report_telemetry(payload jsonb)`: presence, user and session in one call.
/// Timestamps are set by the server so a wrong local clock cannot skew them.
#[derive(Serialize)]
struct ReportBody<'a> {
    install_id: &'a str,
    session_id: &'a str,
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
}

#[derive(Serialize)]
struct ReportRequest<'a> {
    payload: ReportBody<'a>,
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

/// A score-only change waits until `SCORE_THROTTLE` has passed since the
/// last report. Any other change, launch or heartbeat sends right away.
fn score_throttled(
    launch_or_heartbeat: bool,
    core_changed: bool,
    score_changed: bool,
    since_last_report: Option<Duration>,
) -> bool {
    !launch_or_heartbeat
        && !core_changed
        && score_changed
        && since_last_report.is_some_and(|d| d < SCORE_THROTTLE)
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
    fn lobby_lookup_only_for_new_rosters() {
        assert!(!should_lookup_lobby(true, true, false, false, false));
        assert!(!should_lookup_lobby(true, false, false, false, false));
        assert!(should_lookup_lobby(true, false, true, false, false));
        assert!(should_lookup_lobby(true, false, false, true, false));
    }

    #[test]
    fn score_only_changes_are_throttled() {
        let recent = Some(Duration::from_secs(30));
        let old = Some(SCORE_THROTTLE + Duration::from_secs(1));
        // Score-only change shortly after a report waits.
        assert!(score_throttled(false, false, true, recent));
        // ...but goes out once the window passed or nothing was sent yet.
        assert!(!score_throttled(false, false, true, old));
        assert!(!score_throttled(false, false, true, None));
        // Phase/map/agent changes and heartbeats are never held back.
        assert!(!score_throttled(false, true, true, recent));
        assert!(!score_throttled(true, false, true, recent));
    }

    #[test]
    fn empty_env_falls_through_to_file() {
        let cfg = resolve_config(Some(""), Some("key"), Some("https://x.supabase.co/"), Some("anon")).unwrap();
        assert_eq!(cfg.url, "https://x.supabase.co");
        assert_eq!(cfg.anon_key, "anon");
        assert!(resolve_config(Some(""), Some(""), None, None).is_none());
    }
}
