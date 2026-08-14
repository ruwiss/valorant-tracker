//! Live party / "pre" grouping helpers.
//!
//! Official `partyId` only exists in post-game match-details. During pregame /
//! ingame we infer stacks from presence, our own party, and recent matches.

use crate::api::types::LastMatch;
use std::collections::{HashMap, HashSet};

/// `(puuid, match_id, party_id)` for a current-lobby player seen in a recent match.
pub type PartyAppearance = (String, String, String);

pub fn is_group_tag(tag: &str) -> bool {
    tag.starts_with("Grup-") || tag.starts_with("Group-")
}

pub fn next_group_num(existing: &HashMap<String, String>) -> u32 {
    let mut next = 1u32;
    for tag in existing.values() {
        if let Some(num) = parse_group_num(tag) {
            if num >= next {
                next = num + 1;
            }
        }
    }
    next
}

fn parse_group_num(tag: &str) -> Option<u32> {
    tag.strip_prefix("Grup-")
        .or_else(|| tag.strip_prefix("Group-"))
        .and_then(|s| s.parse().ok())
}

/// Cluster current-lobby players who queued together in a recent match.
///
/// Players on different *current* teams are never grouped (a last-game stack
/// that got split across sides this game is not a party now).
///
/// Returns puuid → cluster id (1-based, local to this call).
pub fn cluster_historical_parties(
    appearances: &[PartyAppearance],
    team_of: &HashMap<String, String>,
) -> HashMap<String, u32> {
    let mut uf = UnionFind::default();

    // (match_id, party_id, current_team) → members of that past party who
    // are in this lobby on the same side.
    let mut buckets: HashMap<(String, String, String), Vec<String>> = HashMap::new();
    for (puuid, match_id, party_id) in appearances {
        if party_id.is_empty() {
            continue;
        }
        let team = team_of
            .get(puuid)
            .cloned()
            .unwrap_or_else(|| "_".into());
        buckets
            .entry((match_id.clone(), party_id.clone(), team))
            .or_default()
            .push(puuid.clone());
    }

    for members in buckets.values() {
        if members.len() < 2 {
            continue;
        }
        let first = &members[0];
        uf.ensure(first);
        for other in members.iter().skip(1) {
            uf.union(first, other);
        }
    }

    let mut by_root: HashMap<String, Vec<String>> = HashMap::new();
    let involved: HashSet<String> = buckets
        .values()
        .filter(|m| m.len() >= 2)
        .flatten()
        .cloned()
        .collect();
    for puuid in involved {
        let root = uf.find(&puuid);
        by_root.entry(root).or_default().push(puuid);
    }

    let mut out = HashMap::new();
    let mut next = 1u32;
    let mut roots: Vec<String> = by_root.keys().cloned().collect();
    roots.sort();
    for root in roots {
        let members = by_root.get(&root).unwrap();
        if members.len() < 2 {
            continue;
        }
        let id = next;
        next += 1;
        for p in members {
            out.insert(p.clone(), id);
        }
    }
    out
}

/// Seed live party tags from the last completed match: anyone who stacked
/// there and is still on the same side together this game is almost certainly
/// still a pre.
pub fn seed_from_last_match(
    last: &LastMatch,
    current_puuids: &[String],
    team_of: &HashMap<String, String>,
    existing: &HashMap<String, String>,
) -> HashMap<String, String> {
    let current: HashSet<&str> = current_puuids.iter().map(|s| s.as_str()).collect();
    let mut seeded: HashMap<String, String> = HashMap::new();
    let mut next = next_group_num(existing);

    // last-match group tag → current-lobby members of that group
    let mut last_groups: HashMap<String, Vec<String>> = HashMap::new();
    let everyone = last
        .allies
        .iter()
        .chain(last.enemies.iter())
        .chain(std::iter::once(&last.me));
    for p in everyone {
        if !current.contains(p.puuid.as_str()) {
            continue;
        }
        if !is_group_tag(&p.party) {
            continue;
        }
        last_groups
            .entry(p.party.clone())
            .or_default()
            .push(p.puuid.clone());
    }

    for members in last_groups.values() {
        let mut by_team: HashMap<String, Vec<String>> = HashMap::new();
        for puuid in members {
            let team = team_of.get(puuid).cloned().unwrap_or_default();
            by_team.entry(team).or_default().push(puuid.clone());
        }
        for teammates in by_team.values() {
            if teammates.len() < 2 {
                continue;
            }
            let existing_tag = teammates.iter().find_map(|p| {
                existing
                    .get(p)
                    .filter(|t| is_group_tag(t.as_str()))
                    .cloned()
                    .or_else(|| seeded.get(p).filter(|t| is_group_tag(t.as_str())).cloned())
            });
            let tag = existing_tag.unwrap_or_else(|| {
                let t = format!("Grup-{}", next);
                next += 1;
                t
            });
            for p in teammates {
                if existing.get(p).is_some_and(|t| is_group_tag(t)) {
                    continue;
                }
                seeded.insert(p.clone(), tag.clone());
            }
        }
    }

    seeded
}

pub struct FrequentRosterPlayer {
    pub puuid: String,
    pub party_id: String,
    pub name: String,
    pub agent: String,
}

pub type FrequentMatchRoster = Vec<FrequentRosterPlayer>;

/// Count how often other players shared `target`'s party in the given matches.
/// Names prefer the most recent non-empty display name.
pub fn tally_frequent_party_mates(
    target: &str,
    matches: &[FrequentMatchRoster],
    min_games: u32,
    max_results: usize,
) -> Vec<(String, String, u32)> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    let mut names: HashMap<String, String> = HashMap::new();

    for roster in matches {
        let my_party = roster
            .iter()
            .find(|p| p.puuid == target)
            .map(|p| p.party_id.as_str())
            .filter(|p| !p.is_empty());
        let Some(my_party) = my_party else {
            continue;
        };
        for p in roster {
            if p.puuid == target || p.party_id != my_party {
                continue;
            }
            *counts.entry(p.puuid.clone()).or_insert(0) += 1;
            if !p.name.is_empty() {
                names.entry(p.puuid.clone()).or_insert_with(|| p.name.clone());
            }
        }
    }

    let mut out: Vec<(String, String, u32)> = counts
        .into_iter()
        .filter(|(_, n)| *n >= min_games)
        .map(|(puuid, n)| {
            let name = names.get(&puuid).cloned().unwrap_or_default();
            (puuid, name, n)
        })
        .collect();
    out.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
    out.truncate(max_results);
    out
}

/// Most-played agents for `puuid` across the given matches. Empty agent ids skipped.
pub fn tally_top_agents(
    puuid: &str,
    matches: &[FrequentMatchRoster],
    max_agents: usize,
) -> Vec<(String, u32)> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for roster in matches {
        if let Some(p) = roster.iter().find(|p| p.puuid == puuid) {
            if p.agent.is_empty() {
                continue;
            }
            *counts.entry(p.agent.clone()).or_insert(0) += 1;
        }
    }
    let mut out: Vec<(String, u32)> = counts.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.truncate(max_agents);
    out
}

#[derive(Default)]
struct UnionFind {
    parent: HashMap<String, String>,
}

impl UnionFind {
    fn ensure(&mut self, x: &str) {
        self.parent
            .entry(x.to_string())
            .or_insert_with(|| x.to_string());
    }

    fn find(&mut self, x: &str) -> String {
        self.ensure(x);
        let p = self.parent.get(x).cloned().unwrap_or_else(|| x.to_string());
        if p != x {
            let root = self.find(&p);
            self.parent.insert(x.to_string(), root.clone());
            root
        } else {
            p
        }
    }

    fn union(&mut self, a: &str, b: &str) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent.insert(ra, rb);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::types::LastMatchPlayer;

    fn team(map: &[(&str, &str)]) -> HashMap<String, String> {
        map.iter()
            .map(|(p, t)| (p.to_string(), t.to_string()))
            .collect()
    }

    fn lm_player(puuid: &str, party: &str, team_id: &str) -> LastMatchPlayer {
        LastMatchPlayer {
            puuid: puuid.into(),
            name: puuid.into(),
            agent: "jett".into(),
            team_id: team_id.into(),
            party: party.into(),
            is_me: false,
            rank_tier: 0,
            level: 1,
            player_card_id: None,
            kills: 0,
            deaths: 0,
            assists: 0,
            score: 0,
            acs: 0,
        }
    }

    #[test]
    fn stack_in_one_match_becomes_one_cluster() {
        let apps = vec![
            ("a".into(), "m1".into(), "pX".into()),
            ("b".into(), "m1".into(), "pX".into()),
            ("c".into(), "m1".into(), "pX".into()),
            ("d".into(), "m1".into(), "pY".into()),
        ];
        let teams = team(&[("a", "Blue"), ("b", "Blue"), ("c", "Blue"), ("d", "Blue")]);
        let out = cluster_historical_parties(&apps, &teams);
        assert_eq!(out.get("a"), out.get("b"));
        assert_eq!(out.get("a"), out.get("c"));
        assert!(out.contains_key("a"));
        assert!(!out.contains_key("d"));
    }

    #[test]
    fn opposite_teams_are_not_grouped() {
        let apps = vec![
            ("a".into(), "m1".into(), "pX".into()),
            ("b".into(), "m1".into(), "pX".into()),
        ];
        let teams = team(&[("a", "Blue"), ("b", "Red")]);
        let out = cluster_historical_parties(&apps, &teams);
        assert!(out.is_empty());
    }

    #[test]
    fn two_duos_stay_separate() {
        let apps = vec![
            ("a".into(), "m1".into(), "p1".into()),
            ("b".into(), "m1".into(), "p1".into()),
            ("c".into(), "m1".into(), "p2".into()),
            ("d".into(), "m1".into(), "p2".into()),
        ];
        let teams = team(&[
            ("a", "Blue"),
            ("b", "Blue"),
            ("c", "Blue"),
            ("d", "Blue"),
        ]);
        let out = cluster_historical_parties(&apps, &teams);
        assert_eq!(out.get("a"), out.get("b"));
        assert_eq!(out.get("c"), out.get("d"));
        assert_ne!(out.get("a"), out.get("c"));
    }

    #[test]
    fn overlapping_matches_merge_into_one_stack() {
        let apps = vec![
            ("a".into(), "m1".into(), "p1".into()),
            ("b".into(), "m1".into(), "p1".into()),
            ("b".into(), "m2".into(), "p2".into()),
            ("c".into(), "m2".into(), "p2".into()),
        ];
        let teams = team(&[("a", "Blue"), ("b", "Blue"), ("c", "Blue")]);
        let out = cluster_historical_parties(&apps, &teams);
        assert_eq!(out.get("a"), out.get("b"));
        assert_eq!(out.get("b"), out.get("c"));
    }

    fn last_match(me: LastMatchPlayer, allies: Vec<LastMatchPlayer>, enemies: Vec<LastMatchPlayer>) -> LastMatch {
        LastMatch {
            match_id: "old".into(),
            map_name: "Ascent".into(),
            queue_id: "competitive".into(),
            game_start_millis: 0,
            game_length_millis: None,
            ally_score: 13,
            enemy_score: 10,
            won: Some(true),
            completion_state: "Completed".into(),
            is_ranked: true,
            is_ffa: false,
            rounds_played: 23,
            placement: None,
            me,
            allies,
            enemies,
        }
    }

    #[test]
    fn last_match_seeds_same_side_stack() {
        let last = last_match(
            lm_player("me", "Grup-1", "Blue"),
            vec![
                lm_player("a", "Grup-1", "Blue"),
                lm_player("b", "Solo", "Blue"),
            ],
            vec![
                lm_player("c", "Grup-2", "Red"),
                lm_player("d", "Grup-2", "Red"),
            ],
        );
        let current = vec!["me".into(), "a".into(), "c".into(), "d".into(), "x".into()];
        // me+a still allies; c+d still together on the other side
        let teams = team(&[
            ("me", "Blue"),
            ("a", "Blue"),
            ("c", "Red"),
            ("d", "Red"),
            ("x", "Blue"),
        ]);
        let seeded = seed_from_last_match(&last, &current, &teams, &HashMap::new());
        assert_eq!(seeded.get("me"), seeded.get("a"));
        assert!(seeded.get("me").is_some());
        assert_eq!(seeded.get("c"), seeded.get("d"));
        assert_ne!(seeded.get("me"), seeded.get("c"));
        assert!(!seeded.contains_key("x"));
    }

    #[test]
    fn last_match_does_not_seed_split_stack() {
        let last = last_match(
            lm_player("me", "Solo", "Blue"),
            vec![lm_player("a", "Grup-1", "Blue")],
            vec![lm_player("b", "Grup-1", "Red")],
        );
        // a and b were a stack last game but landed on opposite sides now
        let current = vec!["me".into(), "a".into(), "b".into()];
        let teams = team(&[("me", "Blue"), ("a", "Blue"), ("b", "Red")]);
        let seeded = seed_from_last_match(&last, &current, &teams, &HashMap::new());
        assert!(seeded.is_empty());
    }

    fn rp(puuid: &str, party: &str, name: &str, agent: &str) -> FrequentRosterPlayer {
        FrequentRosterPlayer {
            puuid: puuid.into(),
            party_id: party.into(),
            name: name.into(),
            agent: agent.into(),
        }
    }

    #[test]
    fn tally_counts_same_party_only() {
        let m1 = vec![
            rp("me", "p1", "Me#1", "jett"),
            rp("a", "p1", "A#1", "reyna"),
            rp("b", "p2", "B#1", "sage"),
        ];
        let m2 = vec![
            rp("me", "p3", "Me#1", "raze"),
            rp("a", "p3", "A#1", "reyna"),
            rp("c", "p3", "C#1", "omen"),
        ];
        let m3 = vec![
            rp("me", "p4", "Me#1", "jett"),
            rp("a", "p4", "A#1", "jett"),
        ];
        let out = tally_frequent_party_mates("me", &[m1, m2, m3], 2, 8);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "a");
        assert_eq!(out[0].2, 3);
    }

    #[test]
    fn tally_ignores_solo_and_missing_target() {
        let m1 = vec![
            rp("me", "solo", "Me#1", "jett"),
            rp("a", "other", "A#1", "reyna"),
        ];
        let m2 = vec![rp("a", "p", "A#1", "reyna")];
        let out = tally_frequent_party_mates("me", &[m1, m2], 2, 8);
        assert!(out.is_empty());
    }

    #[test]
    fn tally_top_agents_caps_at_three() {
        let matches = vec![
            vec![rp("me", "p", "Me#1", "jett")],
            vec![rp("me", "p", "Me#1", "jett")],
            vec![rp("me", "p", "Me#1", "jett")],
            vec![rp("me", "p", "Me#1", "reyna")],
            vec![rp("me", "p", "Me#1", "reyna")],
            vec![rp("me", "p", "Me#1", "sage")],
            vec![rp("me", "p", "Me#1", "omen")],
        ];
        let out = tally_top_agents("me", &matches, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], ("jett".into(), 3));
        assert_eq!(out[1], ("reyna".into(), 2));
        assert_eq!(out[2], ("omen".into(), 1)); // omen before sage alphabetically on tie
    }
}
