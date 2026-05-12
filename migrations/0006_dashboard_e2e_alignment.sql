-- =====================================================================
-- 0006_dashboard_e2e_alignment.sql
--
-- 1) Unique LiveKit room_name on calls — required for PostgREST upsert
--    (onConflict: room_name) used by /api/agent/events call_started.
--    Without this, call_started inserts fail and no call rows exist.
--
-- 2) Align Sydney (agent_name "sydney") with the same office as the
--    default /api/leads + /api/proposals slug ("voxaris") so the staff
--    dashboard (Basic-auth fallback office) shows leads, proposals,
--    and voice calls in one tenant. Noland's seed row keeps slug
--    "nolands" for branding but releases the exclusive livekit mapping.
-- =====================================================================

create unique index if not exists calls_room_name_key
  on public.calls (room_name);

-- Prefer the Twilio inbound from the Noland's seed when voxaris has none.
update public.offices as v
set
  inbound_number = coalesce(nullif(trim(v.inbound_number), ''), nullif(trim(n.inbound_number), ''))
from public.offices n
where v.slug = 'voxaris'
  and n.slug = 'nolands';

update public.offices
set livekit_agent_name = null
where slug = 'nolands';

-- Always pin Sydney to voxaris (works even if the nolands seed row was skipped).
update public.offices
set livekit_agent_name = 'sydney'
where slug = 'voxaris';
