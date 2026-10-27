//! Runtime agent directory.
//!
//! The agent roster is fetched from valorant-api.com so a newly shipped agent
//! is picked up without a code change. `constants::APP_CONSTANTS` stays as the
//! offline fallback (and as the source of the per-agent brand colors, which the
//! API does not expose).

use crate::constants::{AgentData, AppConstants, APP_CONSTANTS};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const AGENTS_URL: &str = "https://valorant-api.com/v1/agents?isPlayableCharacter=true";

/// A response with fewer agents than this is treated as broken and ignored.
const MIN_AGENTS: usize = 20;

/// Successful refresh interval (also used by the background loop in lib.rs).
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Back-off after a failed fetch so we do not hammer the API.
const RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);

const DEFAULT_COLOR: &str = "#00d4aa";

/// "KAY/O" -> "kayo", "  Neon " -> "neon".
/// Mirrors the normalization the frontend uses for agent asset lookups.
pub fn normalize_agent_name(display_name: &str) -> String {
    display_name.trim().to_lowercase().replace('/', "")
}

#[derive(Debug, Clone)]
pub struct AgentDirectory {
    agents: Vec<AgentData>,
    by_name: HashMap<String, String>,
    by_uuid: HashMap<String, String>,
}

impl AgentDirectory {
    pub fn from_agents(agents: Vec<AgentData>) -> Self {
        let mut by_name = HashMap::with_capacity(agents.len());
        let mut by_uuid = HashMap::with_capacity(agents.len());
        for agent in &agents {
            let name = normalize_agent_name(&agent.name);
            by_name.insert(name.clone(), agent.uuid.clone());
            by_uuid.insert(agent.uuid.to_lowercase(), name);
        }
        Self {
            agents,
            by_name,
            by_uuid,
        }
    }

    pub fn agents(&self) -> &[AgentData] {
        &self.agents
    }

    pub fn uuid_for_name(&self, name: &str) -> Option<String> {
        self.by_name.get(&normalize_agent_name(name)).cloned()
    }

    pub fn name_for_uuid(&self, uuid: &str) -> Option<String> {
        self.by_uuid.get(&uuid.trim().to_lowercase()).cloned()
    }
}

#[derive(Deserialize)]
struct AgentsResponse {
    data: Vec<ApiAgent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiAgent {
    uuid: String,
    display_name: Option<String>,
    /// Missing/null counts as playable; only an explicit `false` is skipped.
    #[serde(default)]
    is_playable_character: Option<bool>,
}

/// Parse the valorant-api payload into our own agent records.
/// Pure (no network) so it can be unit tested.
pub fn parse_agents(json: &str) -> Result<Vec<AgentData>, String> {
    let response: AgentsResponse =
        serde_json::from_str(json).map_err(|e| format!("invalid payload: {e}"))?;

    let colors = brand_colors();
    let mut seen = std::collections::HashSet::new();
    let mut agents = Vec::with_capacity(response.data.len());

    for agent in response.data {
        if agent.is_playable_character == Some(false) {
            continue;
        }
        let uuid = agent.uuid.trim().to_lowercase();
        let Some(display_name) = agent.display_name else {
            continue;
        };
        let name = normalize_agent_name(&display_name);
        if uuid.is_empty() || name.is_empty() || !seen.insert(uuid.clone()) {
            continue;
        }
        let color = colors
            .get(&name)
            .cloned()
            .unwrap_or_else(|| DEFAULT_COLOR.to_string());
        agents.push(AgentData { uuid, name, color });
    }

    if agents.is_empty() {
        return Err("payload contained no playable agents".into());
    }

    Ok(agents)
}

/// Guard against truncated/garbage payloads replacing a good roster.
fn is_sane(agents: &[AgentData]) -> bool {
    agents.len() >= MIN_AGENTS
}

fn brand_colors() -> HashMap<String, String> {
    APP_CONSTANTS
        .agents
        .iter()
        .map(|a| (a.name.clone(), a.color.clone()))
        .collect()
}

static DIRECTORY: Lazy<RwLock<AgentDirectory>> =
    Lazy::new(|| RwLock::new(AgentDirectory::from_agents(APP_CONSTANTS.agents.clone())));
static REFRESH_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static LAST_ATTEMPT: Lazy<RwLock<Option<(Instant, Duration)>>> = Lazy::new(|| RwLock::new(None));

fn should_skip() -> bool {
    LAST_ATTEMPT
        .read()
        .map(|(at, ttl)| at.elapsed() < ttl)
        .unwrap_or(false)
}

pub fn app_constants() -> AppConstants {
    AppConstants {
        agents: DIRECTORY.read().agents().to_vec(),
    }
}

pub fn uuid_for_name(name: &str) -> Option<String> {
    DIRECTORY.read().uuid_for_name(name)
}

pub fn name_for_uuid(uuid: &str) -> Option<String> {
    DIRECTORY.read().name_for_uuid(uuid)
}

pub fn agent_count() -> usize {
    DIRECTORY.read().agents().len()
}

async fn fetch(client: &reqwest::Client) -> Result<Vec<AgentData>, String> {
    let res = client
        .get(AGENTS_URL)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let body = res.text().await.map_err(|e| format!("body: {e}"))?;
    parse_agents(&body)
}

/// Fetch the roster if we have no recent answer. Safe to call often: it is
/// single-flight and rate limited internally.
pub async fn ensure_loaded(client: &reqwest::Client) {
    if should_skip() {
        return;
    }
    refresh(client).await;
}

/// Force a refresh (used by the background loop).
pub async fn refresh(client: &reqwest::Client) {
    let _guard = REFRESH_LOCK.lock().await;
    if should_skip() {
        return;
    }
    match fetch(client).await {
        Ok(agents) if !is_sane(&agents) => {
            *LAST_ATTEMPT.write() = Some((Instant::now(), RETRY_INTERVAL));
            tracing::warn!(
                "[Agents] Ignoring suspicious roster ({} agents); keeping {}",
                agents.len(),
                agent_count()
            );
        }
        Ok(agents) => {
            let count = agents.len();
            *DIRECTORY.write() = AgentDirectory::from_agents(agents);
            *LAST_ATTEMPT.write() = Some((Instant::now(), REFRESH_INTERVAL));
            tracing::info!("[Agents] Roster refreshed from valorant-api ({} agents)", count);
        }
        Err(e) => {
            *LAST_ATTEMPT.write() = Some((Instant::now(), RETRY_INTERVAL));
            tracing::warn!("[Agents] Refresh failed, keeping {} known agents: {e}", agent_count());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api_json(agents: &[(&str, &str, bool)]) -> String {
        let rows: Vec<String> = agents
            .iter()
            .map(|(uuid, name, playable)| {
                format!(
                    r#"{{"uuid":"{uuid}","displayName":"{name}","isPlayableCharacter":{playable}}}"#
                )
            })
            .collect();
        format!(r#"{{"status":200,"data":[{}]}}"#, rows.join(","))
    }

    fn roster(count: usize) -> Vec<(String, String, bool)> {
        (0..count)
            .map(|i| (format!("uuid-{i}"), format!("Agent{i}"), true))
            .collect()
    }

    #[test]
    fn normalizes_names_like_the_frontend() {
        assert_eq!(normalize_agent_name("KAY/O"), "kayo");
        assert_eq!(normalize_agent_name("Sage"), "sage");
        assert_eq!(normalize_agent_name("  Neon  "), "neon");
    }

    #[test]
    fn parses_playable_agents_and_normalizes() {
        let json = api_json(&[
            ("uuid-kayo", "KAY/O", true),
            ("uuid-sage", "Sage", true),
            ("uuid-npc", "Sarge", false),
        ]);
        let agents = parse_agents(&json).expect("should parse");
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().any(|a| a.name == "kayo"));
        assert!(!agents.iter().any(|a| a.name == "sarge"));
    }

    #[test]
    fn rejects_broken_or_empty_payloads() {
        assert!(parse_agents("not json").is_err());
        assert!(parse_agents(r#"{"data":[]}"#).is_err());
    }

    #[test]
    fn guards_against_truncated_rosters() {
        let small = parse_agents(&api_json(&[("uuid-one", "One", true)])).expect("parses");
        assert!(!is_sane(&small));

        let rows = roster(MIN_AGENTS);
        let refs: Vec<(&str, &str, bool)> =
            rows.iter().map(|(u, n, p)| (u.as_str(), n.as_str(), *p)).collect();
        let full = parse_agents(&api_json(&refs)).expect("parses");
        assert!(is_sane(&full));
    }

    #[test]
    fn keeps_known_colors_and_defaults_new_ones() {
        let agents = vec![
            AgentData { uuid: "uuid-jett".into(), name: "jett".into(), color: "#7de8e0".into() },
            AgentData { uuid: "uuid-hush".into(), name: "hush".into(), color: DEFAULT_COLOR.into() },
        ];
        let dir = AgentDirectory::from_agents(agents);
        assert_eq!(dir.uuid_for_name("Jett").as_deref(), Some("uuid-jett"));
        assert_eq!(dir.uuid_for_name("KAY/O"), None);
        assert_eq!(dir.name_for_uuid("UUID-HUSH").as_deref(), Some("hush"));
        assert_eq!(dir.name_for_uuid("missing"), None);
    }

    #[test]
    fn parses_full_roster_payload_shape() {
        let rows: Vec<(String, String, bool)> = roster(MIN_AGENTS)
            .into_iter()
            .map(|(u, n, p)| (u, n, p))
            .collect();
        let refs: Vec<(&str, &str, bool)> =
            rows.iter().map(|(u, n, p)| (u.as_str(), n.as_str(), *p)).collect();
        let agents = parse_agents(&api_json(&refs)).expect("full roster parses");
        assert_eq!(agents.len(), MIN_AGENTS);
    }

    /// Manual check against the real endpoint: `cargo test --lib live_roster -- --ignored`
    #[tokio::test]
    #[ignore = "network: hits valorant-api.com"]
    async fn live_roster_parses_and_is_sane() {
        let agents = fetch(&reqwest::Client::new()).await.expect("live fetch");
        assert!(is_sane(&agents), "only {} agents returned", agents.len());
        assert!(agents.iter().any(|a| a.name == "jett"));
        assert!(agents.iter().any(|a| a.name == "kayo"));
    }
}
