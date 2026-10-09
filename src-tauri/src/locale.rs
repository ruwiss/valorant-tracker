use std::path::PathBuf;

/// First `locale:` value in Riot Client settings (`tr_TR`, `en_US`, ...).
pub fn parse_riot_locale(yaml: &str) -> Option<String> {
    for line in yaml.lines() {
        let line = line.trim().trim_start_matches('-').trim();
        let Some(rest) = line.strip_prefix("locale:") else {
            continue;
        };
        let token = rest.trim().trim_matches(['"', '\'']);
        if is_locale_token(token) {
            return Some(token.to_string());
        }
    }
    None
}

fn is_locale_token(token: &str) -> bool {
    let mut parts = token.split(['_', '-']);
    let lang = parts.next().unwrap_or("");
    let region = parts.next().unwrap_or("");
    parts.next().is_none()
        && (2..=3).contains(&lang.len())
        && lang.chars().all(|c| c.is_ascii_alphabetic())
        && (2..=3).contains(&region.len())
        && region.chars().all(|c| c.is_ascii_alphabetic())
}

/// Valorant follows the Riot Client locale
/// (`%LOCALAPPDATA%\Riot Games\Riot Client\Config\RiotClientSettings.yaml`).
pub fn read_riot_client_locale() -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let path = PathBuf::from(local)
        .join("Riot Games")
        .join("Riot Client")
        .join("Config")
        .join("RiotClientSettings.yaml");
    let text = std::fs::read_to_string(path).ok()?;
    parse_riot_locale(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_first_locale_token() {
        let yaml = r#"
install:
    globals:
        locale: "tr_TR"
        region: "TR"
    localization:
        locale: "tr_TR"
"#;
        assert_eq!(parse_riot_locale(yaml).as_deref(), Some("tr_TR"));
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert_eq!(parse_riot_locale("region: TR\n").as_deref(), None);
        assert_eq!(parse_riot_locale("locale: \"\"\n").as_deref(), None);
    }
}
