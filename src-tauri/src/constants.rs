use once_cell::sync::Lazy;
use std::collections::HashMap;

pub static AGENTS: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert("jett", "add6443a-41bd-e414-f6ad-e58d267f4e95");
    m.insert("reyna", "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc");
    m.insert("raze", "f94c3b30-42be-e959-889c-5aa313dba261");
    m.insert("phoenix", "eb93336a-449b-9c1b-0a54-a891f7921d69");
    m.insert("breach", "5f8d3a7f-467b-97f3-062c-13acf203c006");
    m.insert("sova", "320b2a48-4d9b-a075-30f1-1f93a9b638fa");
    m.insert("sage", "569fdd95-4d10-43ab-ca70-79becc718b46");
    m.insert("cypher", "117ed9e3-49f3-6512-3ccf-0cada7e3823b");
    m.insert("brimstone", "9f0d8ba9-4140-b941-57d3-a7ad57c6b417");
    m.insert("killjoy", "1e58de9c-4950-5125-93e9-a0aee9f98746");
    m.insert("viper", "707eab51-4836-f488-046a-cda6bf494859");
    m.insert("omen", "8e253930-4c05-31dd-1b6c-968525494517");
    m.insert("skye", "6f2a04ca-43e0-be17-7f36-b3908627744d");
    m.insert("yoru", "7f94d92c-4234-0a36-9646-3a87eb8b5c89");
    m.insert("astra", "41fb69c1-4189-7b37-f117-bcaf1e96f1bf");
    m.insert("kayo", "601dbbe7-43ce-be57-2a40-4abd24953621");
    m.insert("chamber", "22697a3d-45bf-8dd7-4fec-84a9e28c69d7");
    m.insert("neon", "bb2a4828-46eb-8cd1-e765-15848195d751");
    m.insert("fade", "dade69b4-4f5a-8528-247b-219e5a1facd6");
    m.insert("harbor", "95b78ed7-4637-86d9-7e41-71ba8c293152");
    m.insert("gekko", "e370fa57-4757-3604-3648-499e1f642d3f");
    m.insert("deadlock", "cc8b64c8-4b25-4ff9-6e7f-37b4da43d235");
    m.insert("iso", "0e38b510-41a8-5780-5e8f-568b2a4f2d6c");
    m.insert("clove", "1dbf2edd-4729-0984-3115-daa5eed44993");
    m.insert("vyse", "efba5359-4016-a1e5-7626-b1ae76895940");
    m.insert("tejo", "b444168c-4e35-8076-db47-ef9bf368f384");
    m.insert("veto", "92eeef5d-43b5-1d4a-8d03-b3927a09034b");
    m.insert("waylay", "df1cb487-4902-002e-5c17-d28e83e78588");
    m.insert("miks", "7c8a4701-4de6-9355-b254-e09bc2a34b72");
    m
});

pub static MAP_NAMES: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert("/Game/Maps/Ascent/Ascent", "Ascent");
    m.insert("/Game/Maps/Bonsai/Bonsai", "Split");
    m.insert("/Game/Maps/Canyon/Canyon", "Fracture");
    m.insert("/Game/Maps/Duality/Duality", "Bind");
    m.insert("/Game/Maps/Foxtrot/Foxtrot", "Breeze");
    m.insert("/Game/Maps/HURM/HURM_Alley/HURM_Alley", "District");
    m.insert("/Game/Maps/HURM/HURM_Bowl/HURM_Bowl", "Kasbah");
    m.insert("/Game/Maps/HURM/HURM_Yard/HURM_Yard", "Piazza");
    m.insert("/Game/Maps/Jam/Jam", "Lotus");
    m.insert("/Game/Maps/Juliett/Juliett", "Sunset");
    m.insert("/Game/Maps/Pitt/Pitt", "Pearl");
    m.insert("/Game/Maps/Port/Port", "Icebox");
    m.insert("/Game/Maps/Poveglia/Range", "The Range");
    m.insert("/Game/Maps/Triad/Triad", "Haven");
    m.insert("/Game/Maps/Infinity/Infinity", "Abyss");
    m.insert("/Game/Maps/Rook/Rook", "Corrode");
    m
});

pub static QUEUE_NAMES: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert("competitive", "Rekabetçi");
    m.insert("unrated", "Normal");
    m.insert("spikerush", "Spike Rush");
    m.insert("deathmatch", "Deathmatch");
    m.insert("ggteam", "Escalation");
    m.insert("newmap", "Yeni Harita");
    m.insert("onefa", "Replication");
    m.insert("swiftplay", "Swiftplay");
    m.insert("hurm", "Team Deathmatch");
    m.insert("premier", "Premier");
    m.insert("custom", "Özel Oyun");
    m
});

/// Seasons before Ascendant rank was added (Episode 4 Act 3 and earlier)
/// These seasons need +3 tier offset for ranks above Diamond (tier > 20)
pub static BEFORE_ASCENDANT_SEASONS: &[&str] = &[
    // Episode 1
    "0df5adb9-4dcb-6899-1306-3e9860661dd3", // E1A1
    "3f61c772-4560-cd3f-5d3f-a7ab5abda6b3", // E1A2
    "0530b9c4-4980-f2ee-df5d-09864cd00542", // E1A3
    // Episode 2
    "46ea6166-4573-1128-9cea-60a15640059b", // E2A1
    "fcf2c8f4-4324-e50b-2e23-718e4a3ab046", // E2A2
    "97b6e739-44cc-ffa7-49ad-398ba502ceb0", // E2A3
    // Episode 3
    "ab57ef51-4e59-da91-cc7d-51a5a2b9b8ff", // E3A1
    "52e9749a-429b-7060-99fe-4595426a0cf7", // E3A2
    "71c81c67-4fae-ceb1-844c-aab2bb8710fa", // E3A3
    // Episode 4
    "2a27e5d2-4d30-c9e2-b15a-93b8909a442c", // E4A1
    "4cb622e1-4244-6f41-a05f-2c7b300ee8fc", // E4A2
    "a16955a5-4ad0-f761-5e9e-389df1c892fb", // E4A3 (last season before Ascendant)
];

/// Rank tier to name mapping
pub static RANK_NAMES: Lazy<HashMap<u32, (&'static str, &'static str)>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert(0, ("Unranked", "#768079"));
    m.insert(1, ("Unranked", "#768079"));
    m.insert(2, ("Unranked", "#768079"));
    m.insert(3, ("Iron 1", "#4f4f4f"));
    m.insert(4, ("Iron 2", "#4f4f4f"));
    m.insert(5, ("Iron 3", "#4f4f4f"));
    m.insert(6, ("Bronze 1", "#a5855d"));
    m.insert(7, ("Bronze 2", "#a5855d"));
    m.insert(8, ("Bronze 3", "#a5855d"));
    m.insert(9, ("Silver 1", "#b4b4b4"));
    m.insert(10, ("Silver 2", "#b4b4b4"));
    m.insert(11, ("Silver 3", "#b4b4b4"));
    m.insert(12, ("Gold 1", "#dbb726"));
    m.insert(13, ("Gold 2", "#dbb726"));
    m.insert(14, ("Gold 3", "#dbb726"));
    m.insert(15, ("Platinum 1", "#339999"));
    m.insert(16, ("Platinum 2", "#339999"));
    m.insert(17, ("Platinum 3", "#339999"));
    m.insert(18, ("Diamond 1", "#b388ff"));
    m.insert(19, ("Diamond 2", "#b388ff"));
    m.insert(20, ("Diamond 3", "#b388ff"));
    m.insert(21, ("Ascendant 1", "#2e8b57"));
    m.insert(22, ("Ascendant 2", "#2e8b57"));
    m.insert(23, ("Ascendant 3", "#2e8b57"));
    m.insert(24, ("Immortal 1", "#ff5551"));
    m.insert(25, ("Immortal 2", "#ff5551"));
    m.insert(26, ("Immortal 3", "#ff5551"));
    m.insert(27, ("Radiant", "#ffffaa"));
    m
});
