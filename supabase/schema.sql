-- ============================================================
-- Valorant Tracker Overlay - Kullanım Telemetrisi Şeması
-- ============================================================
-- Kurulum adımları:
-- 1. Supabase ücretsiz proje aç.
-- 2. SQL Editor'da bu dosyayı çalıştır. Tekrar çalıştırmak güvenlidir;
--    mevcut veriyi korur ve eski şemayı bu sürüme taşır.
-- 3. Authentication > Users ile tek admin e-posta/şifre oluştur.
--    Public signups'ı kapat (Authentication > Settings > Sign In / Providers).
-- 4. O kullanıcının auth.users id'sini şu komutla admins tablosuna yaz:
--      insert into public.admins (user_id) values ('AUTH_USER_ID');
-- 5. Uygulama derlemeden önce SUPABASE_URL ve SUPABASE_ANON_KEY
--    ortam değişkenlerini ver, ya da app data dizinine telemetry.json koy:
--      {"url": "https://PROJE.supabase.co", "anonKey": "ANON_KEY"}
-- 6. admin/config.example.js dosyasını admin/config.js yapıp aynı url ve
--    anon key'i yaz. Sayfayı bir statik sunucuda aç (file:// çalışmaz).
--
-- Ücretsiz kota notları:
-- - Realtime kullanılmaz (mesaj kotası yemez). Panel, sekme açıkken
--   30 sn'de bir tek RPC ile özet çeker.
-- - İstemci her bildirimde tek RPC (report_telemetry) çağırır.
-- - Bütün sayımlar sunucuda yapılır; panel satır indirmez.
-- - sessions 30 gün, sessiz presence satırları 90 gün tutulur
--   (500 MB veritabanı sınırının çok altında kalmak için).
-- - Zamanlar sunucu saatinden (now()) gelir; kullanıcının saati yanlış
--   olsa da çevrimiçi durumu doğru kalır.
-- ============================================================

-- ------------------------------------------------------------
-- Tablolar
-- ------------------------------------------------------------

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.users (
  puuid text primary key,
  riot_name text,
  app_version text,
  install_id uuid,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table if not exists public.presence (
  install_id uuid primary key,
  puuid text,
  riot_name text,
  app_version text not null,
  region text,
  phase text not null,
  map_name text,
  mode_name text,
  queue_id text,
  party_state text,
  party_size integer,
  ally_score integer,
  enemy_score integer,
  agent text,
  session_started_at timestamptz not null,
  last_seen timestamptz not null default now()
);

alter table public.presence add column if not exists queue_id text;
alter table public.presence add column if not exists party_state text;
alter table public.presence add column if not exists party_size integer;
alter table public.presence add column if not exists ally_score integer;
alter table public.presence add column if not exists enemy_score integer;
alter table public.presence add column if not exists agent text;
alter table public.presence add column if not exists session_id uuid;

create table if not exists public.sessions (
  id uuid primary key,
  install_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  app_version text not null
);

create index if not exists users_last_seen_idx on public.users (last_seen);
create index if not exists users_install_id_idx on public.users (install_id);
create index if not exists presence_last_seen_idx on public.presence (last_seen);
create index if not exists sessions_install_id_started_at_idx on public.sessions (install_id, started_at);
create index if not exists sessions_started_at_idx on public.sessions (started_at);
create index if not exists sessions_ended_at_idx on public.sessions (ended_at);
create index if not exists sessions_duration_idx on public.sessions ((coalesce(ended_at, started_at) - started_at));

-- ------------------------------------------------------------
-- Trigger: users.first_seen asla güncellenmesin
-- ------------------------------------------------------------

create or replace function public.keep_first_seen()
returns trigger
language plpgsql
as $$
begin
  new.first_seen := old.first_seen;
  return new;
end;
$$;

drop trigger if exists keep_first_seen on public.users;
create trigger keep_first_seen
  before update on public.users
  for each row
  execute function public.keep_first_seen();

-- ------------------------------------------------------------
-- RLS ve yetkiler
-- anon tablolara hiç dokunamaz; yalnızca aşağıdaki RPC'leri çağırır.
-- Admin okumaları da security definer RPC'ler üzerinden yapılır.
-- ------------------------------------------------------------

alter table public.admins enable row level security;
alter table public.users enable row level security;
alter table public.presence enable row level security;
alter table public.sessions enable row level security;

drop policy if exists "anon insert users" on public.users;
drop policy if exists "anon update users" on public.users;
drop policy if exists "anon insert presence" on public.presence;
drop policy if exists "anon update presence" on public.presence;
drop policy if exists "anon insert sessions" on public.sessions;
drop policy if exists "anon update sessions" on public.sessions;

drop policy if exists "admin select users" on public.users;
create policy "admin select users" on public.users
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "admin select presence" on public.presence;
create policy "admin select presence" on public.presence
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "admin select sessions" on public.sessions;
create policy "admin select sessions" on public.sessions
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "admin select own row" on public.admins;
create policy "admin select own row" on public.admins
  for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.users, public.presence, public.sessions, public.admins from public, anon;
grant select on public.users, public.presence, public.sessions, public.admins to authenticated;

-- ------------------------------------------------------------
-- Yardımcılar (dahili; anon çağıramaz)
-- ------------------------------------------------------------

-- UTF-8 metnin Windows-1252 diye okunmasıyla oluşan bozulmayı (ör.
-- "RekabetÃ§i") Türkçe harfler için onarır. 1.9.4 istemcileri hâlâ
-- bozuk mod adı gönderiyor.
create or replace function public.tl_fix(t text)
returns text
language sql
immutable
as $$
  select case
    when t is null or t !~ '[ÃÄÅ]' then t
    else replace(replace(replace(replace(replace(replace(
         replace(replace(replace(replace(replace(replace(t,
           'Ã§', 'ç'), 'Ã‡', 'Ç'), 'ÄŸ', 'ğ'), 'Äž', 'Ğ'),
           'Ä±', 'ı'), 'Ä°', 'İ'), 'Ã¶', 'ö'), 'Ã–', 'Ö'),
           'ÅŸ', 'ş'), 'Åž', 'Ş'), 'Ã¼', 'ü'), 'Ãœ', 'Ü')
  end
$$;

-- Onar, kırp, uzunluğu sınırla; boşsa null.
create or replace function public.tl_text(t text, n integer)
returns text
language sql
immutable
as $$
  select nullif(left(btrim(public.tl_fix(t)), n), '')
$$;

create or replace function public.tl_int(v integer, lo integer, hi integer)
returns integer
language sql
immutable
as $$
  select case when v is null then null else greatest(lo, least(hi, v)) end
$$;

create or replace function public.tl_json_int(j jsonb, lo integer, hi integer)
returns integer
language sql
immutable
as $$
  select case when jsonb_typeof(j) = 'number'
    then public.tl_int(round((j #>> '{}')::numeric)::integer, lo, hi)
  end
$$;

create or replace function public.tl_puuid(t text)
returns text
language sql
immutable
as $$
  select case
    when lower(replace(coalesce(t, ''), '-', '')) ~ '^[0-9a-f]{32}$'
      then lower(replace(t, '-', ''))
  end
$$;

create or replace function public.tl_phase(t text)
returns text
language sql
immutable
as $$
  select case
    when t in ('idle', 'queue', 'custom', 'pregame', 'ingame', 'paused', 'offline', 'closed') then t
    else 'idle'
  end
$$;

create or replace function public.tl_uuid(t text)
returns uuid
language plpgsql
immutable
as $$
begin
  return nullif(btrim(t), '')::uuid;
exception when others then
  return null;
end;
$$;

-- Girdiler temizlenmiş kabul edilir.
create or replace function public.tl_write_presence(
  p_install uuid, p_session uuid, p_puuid text, p_name text, p_version text,
  p_region text, p_phase text, p_map text, p_mode text, p_queue text,
  p_party_state text, p_party_size integer, p_ally integer, p_enemy integer,
  p_agent text
) returns void
language plpgsql
as $$
begin
  insert into public.presence (
    install_id, puuid, riot_name, app_version, region, phase,
    map_name, mode_name, queue_id, party_state, party_size,
    ally_score, enemy_score, agent, session_id, session_started_at, last_seen
  ) values (
    p_install, p_puuid, p_name, coalesce(p_version, '?'), p_region, p_phase,
    p_map, p_mode, p_queue, p_party_state, p_party_size,
    p_ally, p_enemy, p_agent, p_session, now(), now()
  )
  on conflict (install_id) do update set
    puuid = coalesce(excluded.puuid, presence.puuid),
    riot_name = coalesce(excluded.riot_name, presence.riot_name),
    app_version = excluded.app_version,
    region = coalesce(excluded.region, presence.region),
    phase = excluded.phase,
    -- Ajan seçimi → maç arası bazı anlarda harita/mod boş gelir;
    -- hâlâ maçtayken eskiyi silme.
    map_name = case
      when excluded.map_name is not null then excluded.map_name
      when excluded.phase in ('ingame', 'pregame')
           and presence.phase in ('ingame', 'pregame')
        then presence.map_name
      else null
    end,
    mode_name = case
      when excluded.mode_name is not null then excluded.mode_name
      when excluded.phase in ('ingame', 'pregame', 'queue', 'custom')
           and presence.phase in ('ingame', 'pregame', 'queue', 'custom')
        then presence.mode_name
      else null
    end,
    queue_id = case
      when excluded.queue_id is not null then excluded.queue_id
      when excluded.phase in ('ingame', 'pregame', 'queue', 'custom')
        then presence.queue_id
      else null
    end,
    party_state = excluded.party_state,
    party_size = excluded.party_size,
    ally_score = excluded.ally_score,
    enemy_score = excluded.enemy_score,
    agent = excluded.agent,
    session_id = coalesce(excluded.session_id, presence.session_id),
    session_started_at = case
      when excluded.session_id is not null
           and excluded.session_id is distinct from presence.session_id
        then now()
      else presence.session_started_at
    end,
    last_seen = now();
end;
$$;

-- users satırını sadece bir şey değiştiyse ya da 30 dk geçtiyse yazar.
-- Gereksiz satır güncellemesi = gereksiz WAL ve şişme.
create or replace function public.tl_write_user(
  p_puuid text, p_name text, p_version text, p_install uuid
) returns void
language plpgsql
as $$
begin
  if p_puuid is null then
    return;
  end if;
  insert into public.users (puuid, riot_name, app_version, install_id, last_seen)
  values (p_puuid, p_name, coalesce(p_version, '?'), p_install, now())
  on conflict (puuid) do update set
    riot_name = coalesce(excluded.riot_name, users.riot_name),
    app_version = excluded.app_version,
    install_id = coalesce(excluded.install_id, users.install_id),
    last_seen = now()
  where users.app_version is distinct from excluded.app_version
     or (excluded.install_id is not null and users.install_id is distinct from excluded.install_id)
     or (excluded.riot_name is not null and users.riot_name is distinct from excluded.riot_name)
     or users.last_seen < now() - interval '30 minutes';
end;
$$;

create or replace function public.tl_write_session(
  p_session uuid, p_install uuid, p_version text
) returns void
language plpgsql
as $$
begin
  if p_session is null or p_install is null then
    return;
  end if;
  insert into public.sessions (id, install_id, started_at, ended_at, app_version)
  values (p_session, p_install, now(), now(), coalesce(p_version, '?'))
  on conflict (id) do update set
    ended_at = now()
  where sessions.install_id = excluded.install_id;
end;
$$;

-- Eski verinin silinmesi. Panel özetinde çağrılır, istemcinin sıcak
-- yolunda değil. İndeksli aralık silmesi; çoğu çağrıda hiç satır yok.
create or replace function public.tl_prune()
returns void
language sql
as $$
  delete from public.sessions where started_at < now() - interval '30 days';
  delete from public.presence where last_seen < now() - interval '90 days';
$$;

revoke all on function public.tl_fix(text) from public, anon, authenticated;
revoke all on function public.tl_text(text, integer) from public, anon, authenticated;
revoke all on function public.tl_int(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.tl_json_int(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.tl_puuid(text) from public, anon, authenticated;
revoke all on function public.tl_phase(text) from public, anon, authenticated;
revoke all on function public.tl_uuid(text) from public, anon, authenticated;
revoke all on function public.tl_write_presence(uuid, uuid, text, text, text, text, text, text, text, text, text, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.tl_write_user(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.tl_write_session(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.tl_prune() from public, anon, authenticated;

-- ------------------------------------------------------------
-- İstemci RPC'si: tek çağrıda presence + users + sessions
-- ------------------------------------------------------------

create or replace function public.report_telemetry(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_install uuid := public.tl_uuid(payload->>'install_id');
  v_session uuid := public.tl_uuid(payload->>'session_id');
  v_puuid text := public.tl_puuid(payload->>'puuid');
  v_name text := public.tl_text(payload->>'riot_name', 64);
  v_version text := public.tl_text(payload->>'app_version', 32);
  v_phase text := public.tl_phase(payload->>'phase');
begin
  if v_install is null then
    return;
  end if;
  perform public.tl_write_presence(
    v_install, v_session, v_puuid, v_name, v_version,
    public.tl_text(payload->>'region', 16),
    v_phase,
    public.tl_text(payload->>'map_name', 48),
    public.tl_text(payload->>'mode_name', 48),
    public.tl_text(payload->>'queue_id', 64),
    public.tl_text(payload->>'party_state', 48),
    public.tl_json_int(payload->'party_size', 1, 10),
    public.tl_json_int(payload->'ally_score', 0, 99),
    public.tl_json_int(payload->'enemy_score', 0, 99),
    public.tl_text(payload->>'agent', 32)
  );
  perform public.tl_write_session(v_session, v_install, v_version);
  perform public.tl_write_user(v_puuid, v_name, v_version, v_install);
end;
$$;

revoke all on function public.report_telemetry(jsonb) from public;
grant execute on function public.report_telemetry(jsonb) to anon, authenticated;

-- ------------------------------------------------------------
-- Eski istemci RPC'leri (1.9.4 ve öncesi). İmzalar aynı kalmalı;
-- istemci saatini yok sayar, girdileri temizler.
-- ------------------------------------------------------------

drop function if exists public.upsert_presence(uuid, text, text, text, text, text, text, text, timestamptz, timestamptz);

create or replace function public.upsert_presence(
  install_id uuid,
  puuid text,
  riot_name text,
  app_version text,
  region text,
  phase text,
  map_name text,
  mode_name text,
  session_started_at timestamptz,
  last_seen timestamptz,
  queue_id text default null,
  party_state text default null,
  party_size integer default null,
  ally_score integer default null,
  enemy_score integer default null,
  agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if upsert_presence.install_id is null then
    return;
  end if;
  perform public.tl_write_presence(
    upsert_presence.install_id, null,
    public.tl_puuid(upsert_presence.puuid),
    public.tl_text(upsert_presence.riot_name, 64),
    public.tl_text(upsert_presence.app_version, 32),
    public.tl_text(upsert_presence.region, 16),
    public.tl_phase(upsert_presence.phase),
    public.tl_text(upsert_presence.map_name, 48),
    public.tl_text(upsert_presence.mode_name, 48),
    public.tl_text(upsert_presence.queue_id, 64),
    public.tl_text(upsert_presence.party_state, 48),
    public.tl_int(upsert_presence.party_size, 1, 10),
    public.tl_int(upsert_presence.ally_score, 0, 99),
    public.tl_int(upsert_presence.enemy_score, 0, 99),
    public.tl_text(upsert_presence.agent, 32)
  );
end;
$$;

create or replace function public.upsert_user(
  puuid text,
  riot_name text,
  app_version text,
  install_id uuid,
  last_seen timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.tl_write_user(
    public.tl_puuid(upsert_user.puuid),
    public.tl_text(upsert_user.riot_name, 64),
    public.tl_text(upsert_user.app_version, 32),
    upsert_user.install_id
  );
end;
$$;

create or replace function public.upsert_session(
  id uuid,
  install_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  app_version text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.tl_write_session(
    upsert_session.id,
    upsert_session.install_id,
    public.tl_text(upsert_session.app_version, 32)
  );
end;
$$;

revoke all on function public.upsert_presence(uuid, text, text, text, text, text, text, text, timestamptz, timestamptz, text, text, integer, integer, integer, text) from public;
revoke all on function public.upsert_user(text, text, text, uuid, timestamptz) from public;
revoke all on function public.upsert_session(uuid, uuid, timestamptz, timestamptz, text) from public;
grant execute on function public.upsert_presence(uuid, text, text, text, text, text, text, text, timestamptz, timestamptz, text, text, integer, integer, integer, text) to anon, authenticated;
grant execute on function public.upsert_user(text, text, text, uuid, timestamptz) to anon, authenticated;
grant execute on function public.upsert_session(uuid, uuid, timestamptz, timestamptz, text) to anon, authenticated;

-- ------------------------------------------------------------
-- Lobi eşleşmesi: overlay'de görülen puuid'lerden hangileri overlay
-- kullanıyor (maksimum 20 id, sadece kesişim döner).
-- ------------------------------------------------------------

create or replace function public.match_overlay_users(ids text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if ids is null or cardinality(ids) = 0 or cardinality(ids) > 20 then
    return '{}';
  end if;
  return (
    select coalesce(array_agg(u.puuid), '{}')
    from public.users u
    where u.puuid in (
      select public.tl_puuid(x) from unnest(ids) as t(x)
    )
  );
end;
$$;

revoke all on function public.match_overlay_users(text[]) from public;
grant execute on function public.match_overlay_users(text[]) to anon, authenticated;

-- ------------------------------------------------------------
-- Admin RPC'leri. Hepsi admins tablosunu kontrol eder ve sayımları
-- sunucuda yapar; panel yalnızca küçük JSON indirir.
-- ------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.tl_require_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- ilike için % ve _ kaçışı.
create or replace function public.tl_like(q text)
returns text
language sql
immutable
as $$
  select '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;

create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul';
  v_live timestamptz := now() - interval '6 minutes';
  v_month timestamptz := now() - interval '30 days';
begin
  perform public.tl_require_admin();
  perform public.tl_prune();
  return jsonb_build_object(
    'server_time', now(),
    'online', (select count(*) from public.presence where last_seen >= v_live and phase <> 'closed'),
    'in_match', (select count(*) from public.presence where last_seen >= v_live and phase in ('pregame', 'ingame')),
    'today', (select count(distinct install_id) from public.sessions where started_at >= v_today or ended_at >= v_today),
    'launches_today', (select count(*) from public.sessions where started_at >= v_today),
    'users', (select count(*) from public.users),
    'installs_30d', (select count(*) from public.presence where last_seen >= v_month),
    'hours', (
      select jsonb_agg(coalesce(s.n, 0) order by h.h)
      from generate_series(0, 23) as h(h)
      left join (
        select extract(hour from started_at at time zone 'Europe/Istanbul')::int as hr, count(*) as n
        from public.sessions
        where started_at >= v_today
        group by 1
      ) s on s.hr = h.h
    ),
    'versions', (
      select coalesce(jsonb_agg(jsonb_build_object('v', app_version, 'n', n) order by n desc), '[]'::jsonb)
      from (
        select app_version, count(*) as n
        from public.presence
        where last_seen >= v_month
        group by 1
      ) x
    ),
    'phases', (
      select coalesce(jsonb_object_agg(phase, n), '{}'::jsonb)
      from (
        select phase, count(*) as n
        from public.presence
        where last_seen >= v_live and phase <> 'closed'
        group by 1
      ) x
    ),
    'live', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from (
        select install_id, puuid, riot_name, phase, map_name, mode_name,
               ally_score, enemy_score, agent, party_size, app_version, last_seen
        from public.presence
        where last_seen >= v_live and phase <> 'closed'
        order by (phase in ('ingame', 'pregame')) desc, last_seen desc
        limit 8
      ) x
    ),
    'recent', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from (
        select s.id, s.install_id, s.started_at, s.app_version, u.riot_name, u.puuid
        from public.sessions s
        left join lateral (
          select riot_name, puuid from public.users
          where users.install_id = s.install_id
          order by last_seen desc
          limit 1
        ) u on true
        order by s.started_at desc
        limit 8
      ) x
    )
  );
end;
$$;

create or replace function public.admin_live(
  p_phase text default null,
  p_version text default null,
  p_q text default null,
  p_offset integer default 0,
  p_limit integer default 25
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_live timestamptz := now() - interval '6 minutes';
  v_q text := nullif(btrim(p_q), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  perform public.tl_require_admin();
  return (
    with base as (
      select * from public.presence
      where last_seen >= v_live and phase <> 'closed'
    ), filt as (
      select * from base
      where (p_phase is null or phase = p_phase)
        and (p_version is null or app_version = p_version)
        and (v_q is null or riot_name ilike public.tl_like(v_q) or puuid like public.tl_like(lower(v_q)))
    )
    select jsonb_build_object(
      'total', (select count(*) from filt),
      'versions', (select coalesce(jsonb_agg(distinct app_version), '[]'::jsonb) from base),
      'rows', (
        select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
        from (
          select install_id, puuid, riot_name, phase, map_name, mode_name, queue_id,
                 ally_score, enemy_score, agent, party_size, region, app_version, last_seen
          from filt
          order by (phase in ('ingame', 'pregame')) desc, last_seen desc
          offset v_offset limit v_limit
        ) r
      )
    )
  );
end;
$$;

-- Liste sıralaması beyaz listeden seçilen tek bir ifadeyle dinamik kurulur;
-- CASE'li ORDER BY indeksi kullanamaz ve tüm tabloyu sıralar.
create or replace function public.admin_users(
  p_q text default null,
  p_version text default null,
  p_sort text default 'last_seen',
  p_asc boolean default false,
  p_offset integer default 0,
  p_limit integer default 25
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_live timestamptz := now() - interval '6 minutes';
  v_q text := nullif(btrim(p_q), '');
  v_like text := case when nullif(btrim(p_q), '') is not null then public.tl_like(p_q) end;
  v_like_id text := case when nullif(btrim(p_q), '') is not null then public.tl_like(lower(p_q)) end;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_dir text := case when coalesce(p_asc, false) then 'asc' else 'desc' end;
  v_order text;
  v_total bigint;
  v_rows jsonb;
begin
  perform public.tl_require_admin();
  v_order := case p_sort
    when 'riot_name' then 'lower(u.riot_name) ' || v_dir || ' nulls last'
    when 'app_version' then 'u.app_version ' || v_dir || ', u.last_seen desc'
    when 'first_seen' then 'u.first_seen ' || v_dir
    else 'u.last_seen ' || v_dir
  end;

  select count(*) into v_total
  from public.users u
  where (p_version is null or u.app_version = p_version)
    and (v_q is null or u.riot_name ilike v_like or u.puuid like v_like_id);

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    from (
      select u.puuid, u.riot_name, u.app_version, u.install_id, u.first_seen, u.last_seen,
             (select p.phase from public.presence p
               where p.install_id = u.install_id and p.puuid = u.puuid
                 and p.last_seen >= $1 and p.phase <> 'closed') as live_phase
      from (
        select * from public.users u
        where ($2::text is null or u.app_version = $2)
          and ($3::text is null or u.riot_name ilike $3 or u.puuid like $4)
        order by %s
        offset $5 limit $6
      ) u
      order by %s
    ) r
  $q$, v_order, v_order)
  into v_rows
  using v_live, p_version, v_like, v_like_id, v_offset, v_limit;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create or replace function public.admin_sessions(
  p_q text default null,
  p_version text default null,
  p_sort text default 'started_at',
  p_asc boolean default false,
  p_offset integer default 0,
  p_limit integer default 25
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_live timestamptz := now() - interval '6 minutes';
  v_q text := nullif(btrim(p_q), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_dir text := case when coalesce(p_asc, false) then 'asc' else 'desc' end;
  v_order text;
  v_installs uuid[];
  v_total bigint;
  v_rows jsonb;
begin
  perform public.tl_require_admin();
  -- Süre sıralaması sessions_duration_idx ifade indeksini kullanır.
  v_order := case p_sort
    when 'duration' then '(coalesce(s.ended_at, s.started_at) - s.started_at) ' || v_dir
    else 's.started_at ' || v_dir
  end;

  if v_q is not null then
    select coalesce(array_agg(install_id), '{}') into v_installs
    from (
      select distinct install_id from public.users
      where install_id is not null
        and (riot_name ilike public.tl_like(v_q) or puuid like public.tl_like(lower(v_q)))
      limit 500
    ) x;
  end if;

  select count(*) into v_total
  from public.sessions s
  where (p_version is null or s.app_version = p_version)
    and (v_installs is null or s.install_id = any(v_installs));

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    from (
      select s.id, s.install_id, s.started_at, s.ended_at, s.app_version,
             extract(epoch from (coalesce(s.ended_at, s.started_at) - s.started_at))::int as duration,
             u.riot_name, u.puuid,
             exists (
               select 1 from public.presence p
               where p.session_id = s.id and p.last_seen >= $1 and p.phase <> 'closed'
             ) as live
      from (
        select * from public.sessions s
        where ($2::text is null or s.app_version = $2)
          and ($3::uuid[] is null or s.install_id = any($3))
        order by %s
        offset $4 limit $5
      ) s
      left join lateral (
        select riot_name, puuid from public.users
        where users.install_id = s.install_id
        order by last_seen desc
        limit 1
      ) u on true
      order by %s
    ) r
  $q$, v_order, v_order)
  into v_rows
  using v_live, p_version, v_installs, v_offset, v_limit;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create or replace function public.admin_detail(
  p_puuid text default null,
  p_install uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user public.users;
  v_found boolean := false;
  v_install uuid := p_install;
begin
  perform public.tl_require_admin();
  if public.tl_puuid(p_puuid) is not null then
    select * into v_user from public.users where puuid = public.tl_puuid(p_puuid);
    v_found := found;
  end if;
  if not v_found and p_install is not null then
    -- Bir bilgisayarda birden fazla Riot hesabı olabilir: en son görüleni al.
    select * into v_user from public.users where install_id = p_install
    order by last_seen desc limit 1;
    v_found := found;
  end if;
  if v_found then
    v_install := coalesce(v_user.install_id, p_install);
  end if;
  return jsonb_build_object(
    'user', case when v_found then to_jsonb(v_user) end,
    'presence', (select to_jsonb(p) from public.presence p where p.install_id = v_install),
    'accounts', (
      select coalesce(jsonb_agg(jsonb_build_object('puuid', puuid, 'riot_name', riot_name, 'last_seen', last_seen) order by last_seen desc), '[]'::jsonb)
      from public.users where install_id = v_install
    ),
    'sessions', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from (
        select id, started_at, ended_at, app_version,
               extract(epoch from (coalesce(ended_at, started_at) - started_at))::int as duration
        from public.sessions
        where install_id = v_install
        order by started_at desc
        limit 10
      ) x
    )
  );
end;
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.tl_require_admin() from public, anon, authenticated;
revoke all on function public.tl_like(text) from public, anon, authenticated;
revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_live(text, text, text, integer, integer) from public, anon;
revoke all on function public.admin_users(text, text, text, boolean, integer, integer) from public, anon;
revoke all on function public.admin_sessions(text, text, text, boolean, integer, integer) from public, anon;
revoke all on function public.admin_detail(text, uuid) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_live(text, text, text, integer, integer) to authenticated;
grant execute on function public.admin_users(text, text, text, boolean, integer, integer) to authenticated;
grant execute on function public.admin_sessions(text, text, text, boolean, integer, integer) to authenticated;
grant execute on function public.admin_detail(text, uuid) to authenticated;

-- ------------------------------------------------------------
-- Realtime kapalı: panel periyodik RPC kullanır. Tabloları yayından
-- çıkar ve tam satır kopyasını (replica identity full) kapat.
-- ------------------------------------------------------------

do $$
begin
  alter publication supabase_realtime drop table public.presence;
exception when others then null;
end $$;

do $$
begin
  alter publication supabase_realtime drop table public.users;
exception when others then null;
end $$;

do $$
begin
  alter publication supabase_realtime drop table public.sessions;
exception when others then null;
end $$;

alter table public.presence replica identity default;
alter table public.users replica identity default;
alter table public.sessions replica identity default;

-- ------------------------------------------------------------
-- Veri onarımı (tekrar çalıştırmak zararsız)
-- ------------------------------------------------------------

update public.presence
set mode_name = public.tl_fix(mode_name)
where mode_name ~ '[ÃÄÅ]';

update public.presence
set map_name = public.tl_fix(map_name)
where map_name ~ '[ÃÄÅ]';
