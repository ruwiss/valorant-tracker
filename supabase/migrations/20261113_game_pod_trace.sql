-- Preserve raw Riot GamePodID in admin telemetry. Apply before shipping the client.
BEGIN;
ALTER TABLE public.presence ADD COLUMN IF NOT EXISTS game_pod_id text;

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
  -- Raw data-center trace; clear it outside a match and for older clients.
  update public.presence
  set game_pod_id = case when v_phase in ('pregame', 'ingame')
    then public.tl_text(payload->>'game_pod_id', 128) end
  where install_id = v_install;
  perform public.tl_write_session(v_session, v_install, v_version);
  perform public.tl_write_user(v_puuid, v_name, v_version, v_install);
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
      select install_id, puuid, riot_name,
             public.tl_live_phase(phase, party_state, last_seen) as phase,
             map_name, mode_name, queue_id, game_pod_id, party_state, party_size,
             ally_score, enemy_score, agent, region, app_version, last_seen
      from public.presence
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
          select install_id, puuid, riot_name, phase, map_name, mode_name, queue_id, game_pod_id,
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

COMMIT;
