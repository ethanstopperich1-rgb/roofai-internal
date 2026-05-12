-- =====================================================================
-- 0005_nolands_office.sql
--
-- Seed Noland's Roofing office so Sydney's voice agent has a tenant to
-- attribute inbound calls to.
--
-- Sydney's worker (agents/sydney/agent.py) sets WorkerOptions.agent_name
-- to "sydney" on dispatch. /api/agent/events resolves agent_name →
-- office_id via offices.livekit_agent_name. Without this row, every
-- Sydney call would fail the agent_name lookup and be silently dropped
-- by the event sink.
--
-- inbound_number matches agents/sydney/setup_sip.py default (the Twilio
-- number wired to Sydney's dispatch rule in LiveKit Cloud).
--
-- ON CONFLICT DO UPDATE so a re-run reconciles drift if someone tweaks
-- the row through the dashboard.
-- =====================================================================

insert into public.offices (slug, name, state, livekit_agent_name, inbound_number, is_active)
values (
  'nolands',
  'Noland''s Roofing',
  'FL',
  'sydney',
  '+13219851104',
  true
)
on conflict (slug) do update set
  livekit_agent_name = excluded.livekit_agent_name,
  inbound_number = excluded.inbound_number,
  is_active = excluded.is_active;
