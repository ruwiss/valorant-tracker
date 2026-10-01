-- ============================================================
-- Valorant Tracker Overlay - Kullanım Telemetrisi Şeması
-- ============================================================
-- Kurulum adımları:
-- 1. Supabase ücretsiz proje aç.
-- 2. SQL Editor'da bu dosyayı çalıştır.
-- 3. Authentication > Users ile tek admin e-posta/şifre oluştur.
--    Public signups'ı kapat (Authentication > Settings > Sign In / Providers).
-- 4. O kullanıcının auth.users id'sini şu komutla admins tablosuna yaz:
--      insert into public.admins (user_id) values ('AUTH_USER_ID');
-- 5. Uygulama derlemeden önce SUPABASE_URL ve SUPABASE_ANON_KEY
--    ortam değişkenlerini ver, ya da app data dizinine telemetry.json koy:
--      {"url": "https://PROJE.supabase.co", "anonKey": "ANON_KEY"}
-- 6. admin/config.example.js dosyasını admin/config.js yapıp aynı url ve
--    anon key'i yaz. Sayfayı bir statik sunucuda aç (file:// çalışmaz).
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

create table if not exists public.sessions (
  id uuid primary key,
  install_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  app_version text not null
);

create index if not exists users_last_seen_idx on public.users (last_seen);
create index if not exists presence_last_seen_idx on public.presence (last_seen);
create index if not exists sessions_install_id_started_at_idx on public.sessions (install_id, started_at);

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
-- RLS
-- ------------------------------------------------------------

alter table public.admins enable row level security;
alter table public.users enable row level security;
alter table public.presence enable row level security;
alter table public.sessions enable row level security;

-- anon: sadece telemetry yazabilir (insert + update), okuyamaz, silemez.
drop policy if exists "anon insert users" on public.users;
create policy "anon insert users" on public.users
  for insert to anon with check (true);

drop policy if exists "anon update users" on public.users;
create policy "anon update users" on public.users
  for update to anon using (true) with check (true);

drop policy if exists "anon insert presence" on public.presence;
create policy "anon insert presence" on public.presence
  for insert to anon with check (true);

drop policy if exists "anon update presence" on public.presence;
create policy "anon update presence" on public.presence
  for update to anon using (true) with check (true);

drop policy if exists "anon insert sessions" on public.sessions;
create policy "anon insert sessions" on public.sessions
  for insert to anon with check (true);

drop policy if exists "anon update sessions" on public.sessions;
create policy "anon update sessions" on public.sessions
  for update to anon using (true) with check (true);

-- authenticated (yalnızca admins tablosundaki kullanıcılar) okuyabilir.
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

-- admins tablosu: admin kendi satırını görebilir.
drop policy if exists "admin select own row" on public.admins;
create policy "admin select own row" on public.admins
  for select to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Grants: public'den devralmayı kır, sonra dar yetkiler ver
-- ------------------------------------------------------------

revoke all on public.users from public;
revoke all on public.presence from public;
revoke all on public.sessions from public;
revoke all on public.admins from public;

grant insert, update on public.users to anon;
grant insert, update on public.presence to anon;
grant insert, update on public.sessions to anon;

grant select on public.users to authenticated;
grant select on public.presence to authenticated;
grant select on public.sessions to authenticated;
grant select on public.admins to authenticated;

-- ------------------------------------------------------------
-- RPC: overlay'de karşılaşılan puuid'lerin telemetride kayıtlı
-- olup olmadığını anon olarak kontrol etme (maksimum 20 id).
-- ------------------------------------------------------------

create or replace function public.match_overlay_users(ids text[])
returns text[]
language plpgsql
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
      select lower(replace(x, '-', ''))
      from unnest(ids) as t(x)
      where lower(replace(x, '-', '')) ~ '^[0-9a-f]{32}$'
    )
  );
end;
$$;

revoke all on function public.match_overlay_users(text[]) from public;
grant execute on function public.match_overlay_users(text[]) to anon, authenticated;

-- Eski imza (10 argüman) yeni istemcinin ek alanlarını kabul etmez.
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
  insert into public.presence (
    install_id, puuid, riot_name, app_version, region, phase,
    map_name, mode_name, queue_id, party_state, party_size,
    ally_score, enemy_score, agent, session_started_at, last_seen
  ) values (
    upsert_presence.install_id, upsert_presence.puuid, upsert_presence.riot_name,
    upsert_presence.app_version, upsert_presence.region, upsert_presence.phase,
    upsert_presence.map_name, upsert_presence.mode_name,
    upsert_presence.queue_id, upsert_presence.party_state, upsert_presence.party_size,
    upsert_presence.ally_score, upsert_presence.enemy_score, upsert_presence.agent,
    upsert_presence.session_started_at, upsert_presence.last_seen
  )
  on conflict on constraint presence_pkey do update set
    puuid = coalesce(excluded.puuid, presence.puuid),
    riot_name = coalesce(excluded.riot_name, presence.riot_name),
    app_version = excluded.app_version,
    region = excluded.region,
    phase = excluded.phase,
    -- Eski istemci maça girince mode_name'i null yazar. Ajan seçiminde
    -- öğrenilmiş modu, hâlâ maçtayken silme.
    map_name = case
      when excluded.map_name is not null then excluded.map_name
      when excluded.phase in ('ingame', 'pregame')
           and presence.phase in ('ingame', 'pregame')
           and presence.map_name is not null
        then presence.map_name
      else excluded.map_name
    end,
    mode_name = case
      when excluded.mode_name is not null then excluded.mode_name
      when excluded.phase in ('ingame', 'pregame', 'queue', 'custom')
           and presence.phase in ('ingame', 'pregame', 'queue', 'custom')
           and presence.mode_name is not null
        then presence.mode_name
      else excluded.mode_name
    end,
    queue_id = case
      when excluded.queue_id is not null then excluded.queue_id
      when excluded.phase in ('ingame', 'pregame', 'queue', 'custom')
           and presence.queue_id is not null
        then presence.queue_id
      else excluded.queue_id
    end,
    party_state = excluded.party_state,
    party_size = excluded.party_size,
    ally_score = excluded.ally_score,
    enemy_score = excluded.enemy_score,
    agent = excluded.agent,
    session_started_at = excluded.session_started_at,
    last_seen = excluded.last_seen;
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
  insert into public.users (puuid, riot_name, app_version, install_id, last_seen)
  values (
    upsert_user.puuid, upsert_user.riot_name, upsert_user.app_version,
    upsert_user.install_id, upsert_user.last_seen
  )
  on conflict on constraint users_pkey do update set
    riot_name = coalesce(excluded.riot_name, users.riot_name),
    app_version = excluded.app_version,
    install_id = coalesce(excluded.install_id, users.install_id),
    last_seen = excluded.last_seen;
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
  insert into public.sessions (id, install_id, started_at, ended_at, app_version)
  values (
    upsert_session.id, upsert_session.install_id, upsert_session.started_at,
    upsert_session.ended_at, upsert_session.app_version
  )
  on conflict on constraint sessions_pkey do update set
    ended_at = excluded.ended_at;
end;
$$;

revoke all on function public.upsert_presence(uuid, text, text, text, text, text, text, text, timestamptz, timestamptz, text, text, integer, integer, integer, text) from public;
revoke all on function public.upsert_user(text, text, text, uuid, timestamptz) from public;
revoke all on function public.upsert_session(uuid, uuid, timestamptz, timestamptz, text) from public;
grant execute on function public.upsert_presence(uuid, text, text, text, text, text, text, text, timestamptz, timestamptz, text, text, integer, integer, integer, text) to anon, authenticated;
grant execute on function public.upsert_user(text, text, text, uuid, timestamptz) to anon, authenticated;
grant execute on function public.upsert_session(uuid, uuid, timestamptz, timestamptz, text) to anon, authenticated;

revoke insert, update, select, delete, truncate, references, trigger on public.users from anon;
revoke insert, update, select, delete, truncate, references, trigger on public.presence from anon;
revoke insert, update, select, delete, truncate, references, trigger on public.sessions from anon;

-- ------------------------------------------------------------
-- Realtime (yeniden çalıştırmada hata vermemesi için DO bloğu)
-- ------------------------------------------------------------

alter table public.presence replica identity full;
alter table public.users replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.presence;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.users;
exception
  when duplicate_object then null;
end $$;
