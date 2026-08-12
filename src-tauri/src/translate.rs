//! Reverse-engineered Google Translate client.
//!
//! The old unofficial `client=gtx` URL is rate-limited and often returns 403 /
//! HTML captchas. Chrome itself talks to `translate-pa.googleapis.com` with
//! public widget keys, so we hit that protocol first and fall back through
//! the other still-working Google surfaces.
//!
//! Keys below are the public Chrome Translate / Translate Element client keys
//! (shipped in the browser, not a private Cloud project).

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Public key used by Chrome's `translateHtml` / Translate Element widget.
const KEY_HTML: &str = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
/// Public key used by Chrome's `translate-pa` gtx client.
const KEY_PA: &str = "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA";

const CACHE_CAP: usize = 256;

static HTTP: Lazy<reqwest::blocking::Client> = Lazy::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .user_agent(CHROME_UA)
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
});

static CACHE: Lazy<Mutex<HashMap<String, TranslateOutput>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
pub struct TranslateOutput {
    pub text: String,
    /// ISO language code from Google (e.g. "ru", "ja"), empty if unknown.
    pub source_lang: String,
}

/// Translate `text` into `target_lang` (source auto-detected).
/// Returns None on network/parse failure or empty translation.
pub fn google_translate_detailed(text: &str, target_lang: &str) -> Option<TranslateOutput> {
    let text = text.trim();
    let target_lang = target_lang.trim();
    if text.is_empty() || target_lang.is_empty() {
        return None;
    }

    let cache_key = format!("{}\0{}", target_lang, text);
    if let Some(hit) = CACHE.lock().get(&cache_key).cloned() {
        return Some(hit);
    }

    let attempts: &[(&str, fn(&str, &str) -> Option<TranslateOutput>)] = &[
        ("pa-html", try_translate_html),
        ("pa-gtx", try_translate_pa),
        ("dict-chrome", try_dict_chrome),
        ("gtx", try_gtx),
    ];

    for (name, attempt) in attempts {
        match attempt(text, target_lang) {
            Some(out) => {
                tracing::info!(
                    "[Translate] {} ok tl={} src={} chars={}",
                    name,
                    target_lang,
                    out.source_lang,
                    out.text.chars().count()
                );
                let mut cache = CACHE.lock();
                if cache.len() >= CACHE_CAP {
                    cache.clear();
                }
                cache.insert(cache_key, out.clone());
                return Some(out);
            }
            None => {
                tracing::debug!("[Translate] {} missed tl={}", name, target_lang);
            }
        }
    }

    tracing::warn!("[Translate] all endpoints failed tl={}", target_lang);
    None
}

pub fn google_translate(text: &str, target_lang: &str) -> Option<String> {
    google_translate_detailed(text, target_lang).map(|r| r.text)
}

/// Chrome Translate Element: POST translate-pa `/v1/translateHtml`.
/// Body: `[[["text"],"auto","tl"],"te_lib"]`  →  `[["translated"],["ja"]]`
fn try_translate_html(text: &str, target_lang: &str) -> Option<TranslateOutput> {
    let payload = serde_json::json!([[[text], "auto", target_lang], "te_lib"]);
    let resp = HTTP
        .post("https://translate-pa.googleapis.com/v1/translateHtml")
        .header("Content-Type", "application/json+protobuf")
        .header("X-Goog-Api-Key", KEY_HTML)
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Origin", "https://translate.google.com")
        .header("Referer", "https://translate.google.com/")
        .body(payload.to_string())
        .send()
        .map_err(|e| {
            tracing::warn!("[Translate] pa-html request: {}", e);
            e
        })
        .ok()?;

    let status = resp.status();
    let raw = resp.text().ok()?;
    if !status.is_success() {
        tracing::warn!("[Translate] pa-html HTTP {} body={}", status, truncate(&raw));
        return None;
    }

    parse_translate_html(&raw)
}

/// Chrome gtx client: GET translate-pa `/v1/translate`.
/// JSON: `{ "translation": "...", "sourceLanguage": "ja" }`
fn try_translate_pa(text: &str, target_lang: &str) -> Option<TranslateOutput> {
    let resp = HTTP
        .get("https://translate-pa.googleapis.com/v1/translate")
        .query(&[
            ("params.client", "gtx"),
            ("query.source_language", "auto"),
            ("query.target_language", target_lang),
            ("query.text", text),
            ("key", KEY_PA),
            ("data_types", "TRANSLATION"),
            ("data_types", "SENTENCE_SPLITS"),
        ])
        .header("Accept", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://translate.google.com/")
        .send()
        .map_err(|e| {
            tracing::warn!("[Translate] pa-gtx request: {}", e);
            e
        })
        .ok()?;

    let status = resp.status();
    let raw = resp.text().ok()?;
    if !status.is_success() {
        tracing::warn!("[Translate] pa-gtx HTTP {} body={}", status, truncate(&raw));
        return None;
    }

    parse_translate_pa(&raw)
}

/// Chrome dictionary extension: `clients5` `client=dict-chrome-ex`.
/// JSON: `[["translated","ja"]]`
fn try_dict_chrome(text: &str, target_lang: &str) -> Option<TranslateOutput> {
    let resp = HTTP
        .get("https://clients5.google.com/translate_a/t")
        .query(&[
            ("client", "dict-chrome-ex"),
            ("sl", "auto"),
            ("tl", target_lang),
            ("q", text),
        ])
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://translate.google.com/")
        .send()
        .map_err(|e| {
            tracing::warn!("[Translate] dict-chrome request: {}", e);
            e
        })
        .ok()?;

    let status = resp.status();
    let raw = resp.text().ok()?;
    if !status.is_success() {
        tracing::warn!(
            "[Translate] dict-chrome HTTP {} body={}",
            status,
            truncate(&raw)
        );
        return None;
    }

    parse_dict_chrome(&raw)
}

/// Legacy unofficial gtx endpoint (last resort).
fn try_gtx(text: &str, target_lang: &str) -> Option<TranslateOutput> {
    let resp = HTTP
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"),
            ("sl", "auto"),
            ("tl", target_lang),
            ("dt", "t"),
            ("q", text),
        ])
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://translate.google.com/")
        .send()
        .map_err(|e| {
            tracing::warn!("[Translate] gtx request: {}", e);
            e
        })
        .ok()?;

    let status = resp.status();
    let raw = resp.text().ok()?;
    if !status.is_success() {
        tracing::warn!("[Translate] gtx HTTP {} body={}", status, truncate(&raw));
        return None;
    }

    parse_gtx(&raw)
}

fn parse_translate_html(raw: &str) -> Option<TranslateOutput> {
    let body: Value = serde_json::from_str(raw).ok()?;
    let texts = body.get(0)?.as_array()?;
    let mut out = String::new();
    for item in texts {
        if let Some(s) = item.as_str() {
            out.push_str(s);
        }
    }
    let out = unescape_html(out.trim());
    if out.is_empty() {
        return None;
    }
    let source_lang = body
        .get(1)
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(TranslateOutput {
        text: out,
        source_lang,
    })
}

fn parse_translate_pa(raw: &str) -> Option<TranslateOutput> {
    let body: Value = serde_json::from_str(raw).ok()?;
    let text = body
        .get("translation")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let source_lang = body
        .get("sourceLanguage")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(TranslateOutput { text, source_lang })
}

fn parse_dict_chrome(raw: &str) -> Option<TranslateOutput> {
    let body: Value = serde_json::from_str(raw).ok()?;
    let first_row = body.as_array()?.first()?;
    if let Some(row) = first_row.as_array() {
        let text = row.first()?.as_str()?.trim();
        if text.is_empty() {
            return None;
        }
        let source_lang = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
        return Some(TranslateOutput {
            text: text.to_string(),
            source_lang,
        });
    }
    // Rare: `["translated","ja"]`
    let text = first_row.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let source_lang = body
        .as_array()
        .and_then(|a| a.get(1))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(TranslateOutput {
        text: text.to_string(),
        source_lang,
    })
}

fn parse_gtx(raw: &str) -> Option<TranslateOutput> {
    let body: Value = serde_json::from_str(raw).ok()?;
    let segments = body.get(0)?.as_array()?;
    let mut out = String::new();
    for seg in segments {
        if let Some(piece) = seg.get(0).and_then(|v| v.as_str()) {
            out.push_str(piece);
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        return None;
    }
    let source_lang = body
        .get(2)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(TranslateOutput {
        text: out,
        source_lang,
    })
}

fn unescape_html(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn truncate(s: &str) -> String {
    const N: usize = 160;
    let t = s.replace('\n', " ");
    if t.chars().count() <= N {
        t
    } else {
        format!("{}…", t.chars().take(N).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_html_response() {
        let out = parse_translate_html(r#"[["Merhaba"],["ja"]]"#).unwrap();
        assert_eq!(out.text, "Merhaba");
        assert_eq!(out.source_lang, "ja");
    }

    #[test]
    fn parse_pa_response() {
        let out = parse_translate_pa(
            r#"{"translation":"Merhaba","sourceLanguage":"ja"}"#,
        )
        .unwrap();
        assert_eq!(out.text, "Merhaba");
        assert_eq!(out.source_lang, "ja");
    }

    #[test]
    fn parse_dict_response() {
        let out = parse_dict_chrome(r#"[["Merhaba","ja"]]"#).unwrap();
        assert_eq!(out.text, "Merhaba");
        assert_eq!(out.source_lang, "ja");
    }

    #[test]
    fn parse_gtx_response() {
        let out = parse_gtx(
            r#"[[["Merhaba","こんにちは",null,null,10]],null,"ja"]"#,
        )
        .unwrap();
        assert_eq!(out.text, "Merhaba");
        assert_eq!(out.source_lang, "ja");
    }

    #[test]
    fn unescape_entities() {
        assert_eq!(unescape_html("A &amp; B"), "A & B");
    }

    #[test]
    #[ignore]
    fn live_japanese_to_turkish() {
        let out = google_translate_detailed("こんにちは", "tr").expect("translate failed");
        assert!(!out.text.is_empty());
        assert_eq!(out.source_lang, "ja");
    }
}
