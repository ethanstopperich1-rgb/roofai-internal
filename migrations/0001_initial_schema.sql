-- =====================================================================
-- 0001_initial_schema.sql
--
-- Schema snapshot for Voxaris Pitch (Supabase project htfhelquuvndfwfwqjmd).
-- Reconstructed from types/supabase.ts on 2026-05-11.
--
-- Tables:
--   offices      tenant unit — one per RSS office + Voxaris HQ + Noland's
--   users        staff users, scoped 1:N to one office, mirrors auth.users.id
--   leads        every /quote, /embed, and Sydney call submission
--   proposals    full estimate snapshot (replaces legacy /p/[id] localStorage)
--   calls        Sydney voice agent call records
--   events       per-call timeline (tool fires, barge-ins, fallbacks)
--   consents     append-only TCPA + call-recording receipts
--
-- RLS lives in 0002_rls_policies.sql — this file only declares structure.
-- The seed office row lives in 0003_seed.sql so a fresh dev project has
-- something for /api/leads to write to before the onboarding flow runs.
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
-- offices
-- =====================================================================
create table if not exists public.offices (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  state               text,
  brand_color         text,
  logo_url            text,
  inbound_number      text,
  twilio_number       text,
  livekit_agent_name  text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

create index if not exists offices_slug_idx on public.offices (slug);

-- =====================================================================
-- users (mirrors auth.users.id 1:1, adds office + role)
-- =====================================================================
create table if not exists public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  office_id   uuid not null references public.offices (id) on delete restrict,
  email       text not null,
  full_name   text,
  role        text not null default 'staff' check (role in ('staff', 'manager', 'admin')),
  created_at  timestamptz not null default now()
);

create index if not exists users_office_idx on public.users (office_id);
create index if not exists users_email_idx on public.users (lower(email));

-- =====================================================================
-- leads
-- =====================================================================
create table if not exists public.leads (
  id                  uuid primary key default gen_random_uuid(),
  office_id           uuid not null references public.offices (id) on delete restrict,
  public_id           text not null unique,

  -- Contact
  name                text not null,
  email               text not null,
  phone               text,

  -- Property
  address             text not null,
  zip                 text,
  county              text,
  lat                 double precision,
  lng                 double precision,

  -- Estimate snapshot at lead-capture time
  estimated_sqft      integer,
  estimate_low        integer,
  estimate_high       integer,
  material            text,
  selected_add_ons    text[],

  -- Lead lifecycle
  source              text,
  status              text not null default 'new'
                      check (status in ('new', 'contacted', 'qualified', 'won', 'lost', 'spam')),
  notes               text,

  -- TCPA receipt (mirrored into consents on insert; kept here for fast
  -- denormalised read on the leads list page).
  tcpa_consent        boolean not null default false,
  tcpa_consent_at     timestamptz,
  tcpa_consent_text   text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists leads_office_created_idx on public.leads (office_id, created_at desc);
create index if not exists leads_office_status_idx on public.leads (office_id, status);
create index if not exists leads_public_id_idx on public.leads (public_id);
create index if not exists leads_phone_idx on public.leads (phone) where phone is not null;

-- Bump updated_at on every UPDATE without requiring every caller to set
-- it explicitly. Matches the comment in supabase.ts about a
-- touch_updated_at() trigger.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_touch_updated_at on public.leads;
create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- proposals
-- =====================================================================
create table if not exists public.proposals (
  id              uuid primary key default gen_random_uuid(),
  office_id       uuid not null references public.offices (id) on delete restrict,
  lead_id         uuid references public.leads (id) on delete set null,
  public_id       text not null unique,

  -- Full estimate state — assumptions, add-ons, line items, tier
  -- selection. Stored as JSON so we can evolve the shape without a
  -- migration per change. Snapshot is immutable once written; edits
  -- create a new proposal row.
  snapshot        jsonb not null,
  total_low       integer,
  total_high      integer,

  pdf_url         text,
  generated_by    text,
  created_at      timestamptz not null default now()
);

create index if not exists proposals_office_created_idx on public.proposals (office_id, created_at desc);
create index if not exists proposals_lead_idx on public.proposals (lead_id);
create index if not exists proposals_public_id_idx on public.proposals (public_id);

-- =====================================================================
-- calls (Sydney voice agent)
-- =====================================================================
create table if not exists public.calls (
  id                       uuid primary key default gen_random_uuid(),
  office_id                uuid not null references public.offices (id) on delete restrict,
  lead_id                  uuid references public.leads (id) on delete set null,

  agent_name               text not null,
  room_name                text not null,
  caller_number            text,

  started_at               timestamptz not null,
  ended_at                 timestamptz,
  duration_sec             integer,

  llm_prompt_tokens        integer,
  llm_completion_tokens    integer,
  stt_secs                 integer,
  tts_chars                integer,
  turn_count               integer,
  estimated_cost_usd       numeric(10, 4),

  outcome                  text,
  summary                  text,
  transcript               text,

  created_at               timestamptz not null default now()
);

create index if not exists calls_office_started_idx on public.calls (office_id, started_at desc);
create index if not exists calls_lead_idx on public.calls (lead_id);
create index if not exists calls_room_idx on public.calls (room_name);

-- =====================================================================
-- events (per-call timeline)
-- =====================================================================
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  office_id   uuid not null references public.offices (id) on delete restrict,
  call_id     uuid references public.calls (id) on delete cascade,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);

create index if not exists events_call_at_idx on public.events (call_id, at);
create index if not exists events_office_at_idx on public.events (office_id, at desc);
create index if not exists events_type_idx on public.events (type);

-- =====================================================================
-- consents (append-only TCPA + call-recording receipts)
-- =====================================================================
create table if not exists public.consents (
  id                uuid primary key default gen_random_uuid(),
  office_id         uuid not null references public.offices (id) on delete restrict,
  lead_id           uuid references public.leads (id) on delete set null,
  call_id           uuid references public.calls (id) on delete set null,

  -- 'tcpa_marketing' | 'call_recording' | 'sms' | 'email_marketing'
  consent_type      text not null,
  consented_at      timestamptz not null default now(),
  disclosure_text   text not null,

  phone             text,
  email             text,

  -- inet for IP-address audit trail (TCPA cases regularly require it)
  ip_address        inet,
  user_agent        text
);

create index if not exists consents_lead_idx on public.consents (lead_id);
create index if not exists consents_call_idx on public.consents (call_id);
create index if not exists consents_phone_idx on public.consents (phone) where phone is not null;
create index if not exists consents_office_at_idx on public.consents (office_id, consented_at desc);
