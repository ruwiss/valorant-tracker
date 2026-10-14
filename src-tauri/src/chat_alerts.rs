//! Riot Client chat socket. The overlay used to notice new messages by polling
//! conversations every 2s (and WebView timers slip when the window is unfocused),
//! so the sound landed late. This task hears `/chat/v6/messages` as Riot emits
//! them and plays the clip + a Windows toast immediately.

use crate::api::ValorantAPI;
use crate::state::AppState;
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, Message},
    Connector,
};

const MESSAGE_MP3: &[u8] = include_bytes!("../../src/assets/sounds/message.mp3");
const FRESH_SECS: i64 = 8;
const SOUND_HANDLED_MS: u64 = 4_000;

static LIVE: AtomicBool = AtomicBool::new(false);
static LAST_SOUND_MS: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn set_message_alerts(state: State<'_, AppState>, enabled: bool, locale: String) {
    state
        .chat_alerts_enabled
        .store(enabled, Ordering::Relaxed);
    if !locale.is_empty() {
        *state.chat_alert_locale.write() = locale;
    }
}

/// True while the Riot chat socket is connected. The poll path waits briefly
/// and skips its own sound when this is set, because the socket already played it.
#[tauri::command]
pub fn message_alerts_live() -> bool {
    LIVE.load(Ordering::Relaxed)
}

/// True if the socket just played the clip, so the 2s poll must not play it again.
#[tauri::command]
pub fn message_sound_handled() -> bool {
    let last = LAST_SOUND_MS.load(Ordering::Relaxed);
    if last == 0 {
        return false;
    }
    now_ms().saturating_sub(last) < SOUND_HANDLED_MS
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let api = app.state::<AppState>().api.clone();
        run(app, api).await;
    });
}

async fn run(app: AppHandle, api: Arc<ValorantAPI>) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut order: VecDeque<String> = VecDeque::new();
    let mut muted: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let mut failures: u32 = 0;
    let mut muted_at = Instant::now() - Duration::from_secs(60);

    loop {
        if !*api.connected.read() {
            LIVE.store(false, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        let Some(creds) = api.local_basic_auth() else {
            LIVE.store(false, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };

        if muted_at.elapsed() >= Duration::from_secs(15) {
            if let Some(list) = api.get_conversations().await {
                muted.clear();
                for conv in list.conversations {
                    muted.insert(conv.cid, conv.muted);
                }
                muted_at = Instant::now();
            }
        }

        match listen(&app, &api, &creds, &mut seen, &mut order, &mut muted).await {
            Ok(()) => failures = 0,
            Err(err) => {
                failures = failures.saturating_add(1);
                if failures == 1 || failures % 10 == 0 {
                    tracing::debug!("[ChatAlert] socket closed: {err}");
                }
            }
        }
        LIVE.store(false, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn listen(
    app: &AppHandle,
    api: &ValorantAPI,
    creds: &(String, String),
    seen: &mut HashSet<String>,
    order: &mut VecDeque<String>,
    muted: &mut std::collections::HashMap<String, bool>,
) -> Result<(), String> {
    let (port, auth) = creds;
    let mut request = format!("wss://127.0.0.1:{port}/")
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let header = auth
        .parse()
        .map_err(|_| "bad local auth header".to_string())?;
    request
        .headers_mut()
        .insert("Authorization", header);

    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| e.to_string())?;

    let (socket, _) = connect_async_tls_with_config(
        request,
        None,
        false,
        Some(Connector::NativeTls(tls)),
    )
    .await
    .map_err(|e| e.to_string())?;

    let (mut write, mut read) = socket.split();
    write
        .send(Message::Text(
            "[5,\"OnJsonApiEvent_chat_v6_messages\"]".into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    write
        .send(Message::Text(
            "[5,\"OnJsonApiEvent_chat_v6_conversations\"]".into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    // Catch-all in case the client only fans out the generic event.
    // Duplicate frames are dropped by the message id.
    write
        .send(Message::Text("[5,\"OnJsonApiEvent\"]".into()))
        .await
        .map_err(|e| e.to_string())?;

    LIVE.store(true, Ordering::Relaxed);
    tracing::info!("[ChatAlert] listening on Riot chat socket");
    let started = Instant::now();

    loop {
        tokio::select! {
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        on_frame(app, api, text.as_str(), seen, order, muted, started);
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        write.send(Message::Pong(payload)).await.map_err(|e| e.to_string())?;
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(err)) => return Err(err.to_string()),
                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(20)) => {
                if api.local_basic_auth().as_ref() != Some(creds) || !*api.connected.read() {
                    return Ok(());
                }
                write
                    .send(Message::Ping(Vec::<u8>::new().into()))
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
}

fn on_frame(
    app: &AppHandle,
    api: &ValorantAPI,
    text: &str,
    seen: &mut HashSet<String>,
    order: &mut VecDeque<String>,
    muted: &mut std::collections::HashMap<String, bool>,
    started: Instant,
) {
    match parse_frame(text) {
        Frame::Conversations(rows) => {
            for (cid, is_muted) in rows {
                muted.insert(cid, is_muted);
            }
        }
        Frame::Messages(messages) => {
            let now = Utc::now();
            let self_puuid = api.puuid.read().clone();
            for msg in messages {
                let is_muted = muted.get(&msg.cid).copied().unwrap_or(false);
                if !should_notify(&msg, &self_puuid, is_muted, now) {
                    continue;
                }
                let key = dedupe_key(&msg);
                if !remember(seen, order, key) {
                    continue;
                }
                // The first frames after subscribe are often a replay, not a new
                // message. Remember them so they stay quiet; the poll still
                // covers anything that actually arrived in that sliver.
                if started.elapsed() < Duration::from_millis(500) {
                    continue;
                }
                if !app
                    .state::<AppState>()
                    .chat_alerts_enabled
                    .load(Ordering::Relaxed)
                {
                    continue;
                }
                let locale = app.state::<AppState>().chat_alert_locale.read().clone();
                let (title, body) = notification_text(&locale, &msg.game_name, &msg.game_tag, &msg.body);
                tracing::info!("[ChatAlert] {}", title);
                play_clip();
                LAST_SOUND_MS.store(now_ms(), Ordering::Relaxed);
                if let Err(err) = app
                    .notification()
                    .builder()
                    .title(title)
                    .body(body)
                    .show()
                {
                    tracing::warn!("[ChatAlert] toast failed: {err}");
                }
            }
        }
        Frame::Ignore => {}
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn play_clip() {
    #[cfg(windows)]
    {
        if let Some(path) = sound_path() {
            let path = path.display().to_string();
            // Restart so a second message isn't stuck behind a long clip.
            if mci("status vtoMsg mode") != 0 {
                let open = format!("open \"{path}\" type mpegvideo alias vtoMsg");
                if mci(&open) != 0 {
                    tracing::warn!("[ChatAlert] could not open message sound");
                    return;
                }
            }
            let _ = mci("seek vtoMsg to start");
            if mci("play vtoMsg") != 0 {
                tracing::warn!("[ChatAlert] could not play message sound");
            }
        }
    }
}

#[cfg(windows)]
fn sound_path() -> Option<std::path::PathBuf> {
    let path = std::env::temp_dir().join("valorant-tracker-message.mp3");
    if std::fs::read(&path).ok().as_deref() != Some(MESSAGE_MP3) {
        if std::fs::write(&path, MESSAGE_MP3).is_err() {
            return None;
        }
    }
    Some(path)
}

#[cfg(windows)]
fn mci(cmd: &str) -> u32 {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "winmm")]
    extern "system" {
        fn mciSendStringW(cmd: *const u16, ret: *mut u16, ret_len: u32, hwnd: isize) -> u32;
    }
    let wide: Vec<u16> = OsStr::new(cmd).encode_wide().chain(Some(0)).collect();
    let mut ret = [0u16; 64];
    unsafe { mciSendStringW(wide.as_ptr(), ret.as_mut_ptr(), ret.len() as u32, 0) }
}

struct RawMsg {
    mid: String,
    cid: String,
    puuid: String,
    body: String,
    game_name: String,
    game_tag: String,
    message_type: String,
    read: bool,
    time: String,
}

enum Frame {
    Messages(Vec<RawMsg>),
    Conversations(Vec<(String, bool)>),
    Ignore,
}

fn parse_frame(text: &str) -> Frame {
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return Frame::Ignore,
    };
    let Some(arr) = value.as_array() else {
        return Frame::Ignore;
    };
    if arr.len() < 3 {
        return Frame::Ignore;
    }
    let name = arr[1].as_str().unwrap_or("");
    let payload = &arr[2];
    let uri = payload.get("uri").and_then(|u| u.as_str()).unwrap_or("");
    let event = payload
        .get("eventType")
        .and_then(|u| u.as_str())
        .unwrap_or("");
    let data = payload.get("data").cloned().unwrap_or(Value::Null);

    if uri.contains("/chat/v6/messages") || name.contains("chat_v6_messages") {
        if event != "Create" {
            return Frame::Ignore;
        }
        return Frame::Messages(extract_messages(&data));
    }
    if uri.contains("/chat/v6/conversations") || name.contains("chat_v6_conversations") {
        return Frame::Conversations(extract_muted(&data));
    }
    Frame::Ignore
}

fn extract_messages(data: &Value) -> Vec<RawMsg> {
    if let Some(list) = data.get("messages").and_then(|m| m.as_array()) {
        return list.iter().filter_map(one_message).collect();
    }
    one_message(data).into_iter().collect()
}

fn one_message(value: &Value) -> Option<RawMsg> {
    let cid = value.get("cid")?.as_str()?.to_string();
    if cid.is_empty() {
        return None;
    }
    let mid = value
        .get("mid")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| value.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string();
    let time = match value.get("time").or_else(|| value.get("timestamp")) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    Some(RawMsg {
        mid,
        cid,
        puuid: json_str(value, "puuid"),
        body: json_str(value, "body"),
        game_name: json_str(value, "game_name"),
        game_tag: json_str(value, "game_tag"),
        message_type: json_str(value, "type"),
        read: value.get("read").and_then(|v| v.as_bool()).unwrap_or(false),
        time,
    })
}

fn json_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn extract_muted(data: &Value) -> Vec<(String, bool)> {
    let mut rows = Vec::new();
    if let Some(list) = data.get("conversations").and_then(|c| c.as_array()) {
        for item in list {
            push_muted(&mut rows, item);
        }
        return rows;
    }
    push_muted(&mut rows, data);
    rows
}

fn push_muted(rows: &mut Vec<(String, bool)>, value: &Value) {
    let Some(cid) = value.get("cid").and_then(|c| c.as_str()) else {
        return;
    };
    if cid.is_empty() {
        return;
    }
    if let Some(muted) = value.get("muted").and_then(|m| m.as_bool()) {
        rows.push((cid.to_string(), muted));
    }
}

fn should_notify(msg: &RawMsg, self_puuid: &str, muted: bool, now: DateTime<Utc>) -> bool {
    if muted || self_puuid.is_empty() {
        return false;
    }
    if msg.puuid.is_empty() || msg.puuid.eq_ignore_ascii_case(self_puuid) {
        return false;
    }
    if msg.read || msg.body.trim().is_empty() || is_live_cid(&msg.cid) {
        return false;
    }
    if !is_user_chat(&msg.message_type) {
        return false;
    }
    is_fresh(&msg.time, now)
}

fn is_live_cid(cid: &str) -> bool {
    let cid = cid.to_ascii_lowercase();
    cid.contains("ares-coregame") || cid.contains("ares-pregame") || cid.contains("ares-parties")
}

fn is_user_chat(message_type: &str) -> bool {
    let kind = message_type.to_ascii_lowercase();
    kind.is_empty() || kind == "chat" || kind == "groupchat"
}

fn is_fresh(time: &str, now: DateTime<Utc>) -> bool {
    if time.is_empty() {
        return false;
    }
    let parsed = DateTime::parse_from_rfc3339(time)
        .map(|t| t.with_timezone(&Utc))
        .or_else(|_| {
            time.parse::<i64>()
                .ok()
                .and_then(|ms| {
                    if ms > 10_000_000_000 {
                        DateTime::from_timestamp_millis(ms)
                    } else {
                        DateTime::from_timestamp(ms, 0)
                    }
                })
                .ok_or(())
        });
    match parsed {
        Ok(then) => {
            let age = now.signed_duration_since(then);
            age < chrono::Duration::seconds(FRESH_SECS) && age > chrono::Duration::seconds(-5)
        }
        Err(_) => true,
    }
}

fn dedupe_key(msg: &RawMsg) -> String {
    if !msg.mid.is_empty() {
        msg.mid.clone()
    } else {
        format!("{}|{}|{}", msg.cid, msg.time, msg.body)
    }
}

fn remember(seen: &mut HashSet<String>, order: &mut VecDeque<String>, key: String) -> bool {
    if !seen.insert(key.clone()) {
        return false;
    }
    order.push_back(key);
    while order.len() > 400 {
        if let Some(old) = order.pop_front() {
            seen.remove(&old);
        }
    }
    true
}

fn notification_text(locale: &str, name: &str, tag: &str, body: &str) -> (String, String) {
    let tr = locale.to_ascii_lowercase().starts_with("tr");
    let sender = match (name.is_empty(), tag.is_empty()) {
        (true, _) => String::new(),
        (false, true) => name.to_string(),
        (false, false) => format!("{name}#{tag}"),
    };
    let title = if sender.is_empty() {
        if tr {
            "Yeni mesaj".to_string()
        } else {
            "New message".to_string()
        }
    } else {
        sender
    };
    let text: String = body.trim().chars().take(180).collect();
    let text = if text.is_empty() {
        if tr {
            "Sohbete mesaj geldi".to_string()
        } else {
            "You have a new chat message".to_string()
        }
    } else {
        text
    };
    (title, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(time: &str) -> String {
        format!(
            r#"[8,"OnJsonApiEvent_chat_v6_messages",{{"data":{{"body":"selam","cid":"friend-cid","game_name":"Ada","game_tag":"TR1","id":"1","mid":"m1","puuid":"them","read":false,"time":"{time}","type":"chat"}},"eventType":"Create","uri":"/chat/v6/messages"}}]"#
        )
    }

    #[test]
    fn fresh_message_from_someone_else_alerts() {
        let now = Utc::now();
        let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let Frame::Messages(messages) = parse_frame(&sample(&stamp)) else {
            panic!("expected a message frame");
        };
        assert!(should_notify(&messages[0], "me", false, now));
        let (title, body) = notification_text("tr", "Ada", "TR1", &messages[0].body);
        assert_eq!(title, "Ada#TR1");
        assert_eq!(body, "selam");
    }

    #[test]
    fn own_old_live_and_muted_messages_stay_quiet() {
        let now = Utc::now();
        let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let Frame::Messages(messages) = parse_frame(&sample(&stamp)) else {
            panic!("expected a message frame");
        };
        let msg = &messages[0];
        assert!(!should_notify(msg, "them", false, now));
        assert!(!should_notify(msg, "me", true, now));

        let old = (now - chrono::Duration::seconds(60)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let Frame::Messages(old_msgs) = parse_frame(&sample(&old)) else {
            panic!("expected a message frame");
        };
        assert!(!should_notify(&old_msgs[0], "me", false, now));

        let mut live = messages;
        live[0].cid = "ares-parties-room".into();
        assert!(!should_notify(&live[0], "me", false, now));
    }

    #[test]
    fn conversation_update_tracks_mute() {
        let raw = r#"[8,"OnJsonApiEvent_chat_v6_conversations",{"data":{"cid":"friend-cid","muted":true},"eventType":"Update","uri":"/chat/v6/conversations"}]"#;
        match parse_frame(raw) {
            Frame::Conversations(rows) => assert_eq!(rows, vec![("friend-cid".into(), true)]),
            _ => panic!("expected conversation frame"),
        }
    }
}
