-- =====================================================================
-- 0016_canvass_outcomes.sql
--
-- Closed-loop learning moat — outcome capture infrastructure.
--
-- Every canvass_target eventually carries an outcome record. When the
-- rep (or a CRM webhook) marks the row "won" or "lost," we record:
--   * the outcome enum
--   * revenue + cost when won
--   * days_to_close (computed)
--   * lost_reason when lost
--   * the CRM source (manual / jobnimbus / servicetitan / ...)
--
-- Combined with `canvass_targets.features_snapshot` frozen at creation
-- time, this gives us the (features, outcome) training pairs needed to
-- replace the heuristic scoring rubric with a learned model in
-- Phase 4. Without features_snapshot frozen, we'd never be able to
-- train — the parcels table updates and we'd lose what the row LOOKED
-- LIKE when it was scored.
--
-- One row per status transition (append-only), not one-per-target.
-- This lets us model funnel conversion (new → contacted → quoted →
-- won) AND lets reps revise without losing history.
-- =====================================================================

-- ─── Features snapshot on canvass_targets ─────────────────────────────
--
-- Frozen at row-creation time by /api/cron/storm-pulse. JSONB so the
-- feature schema can evolve without breaking historical rows; the ML
-- trainer reads whatever fields are present and treats missing ones as
-- nulls. Snapshot includes:
--   * hail_inches, distance_miles
--   * year_built, just_value, owner_type
--   * has_recent_roof_permit, last_permit_date (at creation time)
--   * day_of_week_created, hour_of_day_created
--   * score (heuristic at creation), rubric_version (the version of
--     the rubric in effect — drift tracking)
--   * any tenant-specific feature flags (storm_id, region_name, etc.)
alter table public.canvass_targets
  add column if not exists features_snapshot jsonb,
  -- Outcome cache — denormalized from canvass_outcomes for fast UI
  -- reads. The latest outcome per target. Trigger keeps in sync.
  add column if not exists latest_outcome text
    check (latest_outcome is null or latest_outcome in (
      'new', 'contacted', 'quoted', 'won', 'lost',
      'no_contact', 'disqualified', 'in_progress'
    )),
  add column if not exists latest_outcome_at timestamptz,
  add column if not exists won_revenue_cents bigint;

-- ─── canvass_outcomes table ───────────────────────────────────────────
create table if not exists public.canvass_outcomes (
  id                   uuid primary key default gen_random_uuid(),

  -- Identity / scoping
  canvass_target_id    uuid not null references public.canvass_targets (id) on delete cascade,
  office_id            uuid not null references public.offices (id) on delete restrict,
  -- Lead linkage — populated when this outcome was directly tied to a
  -- lead row (e.g. a phone call resulted in a quote request). Many
  -- outcomes won't have a lead_id (e.g. "no contact" outcomes).
  lead_id              uuid references public.leads (id) on delete set null,

  -- The transition
  outcome              text not null
                       check (outcome in (
                         'contacted', 'quoted', 'won', 'lost',
                         'no_contact', 'disqualified', 'in_progress'
                       )),
  -- ISO timestamp the rep / CRM said the transition happened. May
  -- differ from created_at (we're recording an event that already
  -- happened in the world).
  occurred_at          timestamptz not null default now(),

  -- Revenue / cost — populated when outcome = 'won'.
  revenue_cents        bigint,
  cost_cents           bigint,
  -- Computed at insert: (occurred_at - canvass_target.created_at)
  -- in days. Useful as a training feature ("hot leads close fast").
  days_to_close        integer,

  -- Lost reason — free text per rep, but we also enforce a coarse
  -- category for analytics. Reps pick the category, write the text.
  lost_reason_category text
                       check (lost_reason_category is null or lost_reason_category in (
                         'not_interested',     -- homeowner declined
                         'competitor_won',     -- another roofer beat us
                         'no_damage',          -- inspection showed no claim
                         'insurance_denied',   -- carrier denied claim
                         'price_too_high',     -- bid lost on price
                         'unreachable',        -- no contact possible
                         'wrong_house',        -- data error
                         'duplicate',          -- already in pipeline
                         'other'
                       )),
  lost_reason_text     text,                   -- free-form rep note

  -- Provenance — which system reported this transition.
  -- 'manual'        = rep clicked the dashboard button
  -- 'jobnimbus'     = JobNimbus webhook
  -- 'servicetitan'  = ServiceTitan polled job
  -- 'sydney_call'   = Sydney's call outcome (tool_fired event)
  -- 'sms'           = SMS conversation outcome
  crm_source           text not null default 'manual',
  -- ID assigned by the source system (JobNimbus job number, ST job ID,
  -- Sydney call_id, etc.) — used for dedup if the same event fires twice.
  crm_external_id      text,

  notes                text,
  -- Who logged this (when crm_source = 'manual'). Null for webhook
  -- inserts.
  logged_by_user_id    uuid,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Dedup constraint: a single CRM + external_id pair should never
-- create two rows. Webhooks retry; this catches that cleanly.
create unique index if not exists canvass_outcomes_crm_dedup
  on public.canvass_outcomes (crm_source, crm_external_id)
  where crm_external_id is not null;

-- ─── Indexes ──────────────────────────────────────────────────────────
create index if not exists canvass_outcomes_target_idx
  on public.canvass_outcomes (canvass_target_id, occurred_at desc);
create index if not exists canvass_outcomes_office_outcome_idx
  on public.canvass_outcomes (office_id, outcome, occurred_at desc);
-- For the ML trainer: pull all closed outcomes (won + lost) with a
-- features_snapshot present. Partial index keeps the working set small.
create index if not exists canvass_outcomes_closed_idx
  on public.canvass_outcomes (office_id, occurred_at desc)
  where outcome in ('won', 'lost');

-- ─── Sync trigger: outcome → canvass_targets latest_outcome ─────────
--
-- Denormalizes the most-recent outcome into canvass_targets so the
-- dashboard sort doesn't need a JOIN on every row read. Append-only
-- behavior preserved: canvass_outcomes is the source of truth, the
-- latest_outcome column is just a fast-read cache.
create or replace function public.sync_canvass_target_outcome()
returns trigger as $$
begin
  update public.canvass_targets
     set latest_outcome     = new.outcome,
         latest_outcome_at  = new.occurred_at,
         won_revenue_cents  = case
                                when new.outcome = 'won' then new.revenue_cents
                                else won_revenue_cents
                              end,
         -- Status field stays in sync with the lifecycle. 'no_contact'
         -- → status='contacted' (we tried), 'in_progress' → 'contacted'.
         -- 'won'/'lost' / 'disqualified' map 1:1.
         status = case new.outcome
                    when 'won'           then 'won'
                    when 'lost'          then 'lost'
                    when 'disqualified'  then 'suppressed'
                    when 'contacted'     then 'contacted'
                    when 'quoted'        then 'contacted'
                    when 'no_contact'    then 'contacted'
                    when 'in_progress'   then 'contacted'
                    else status
                  end,
         contacted_at = coalesce(contacted_at, new.occurred_at),
         updated_at = now()
   where id = new.canvass_target_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists canvass_outcomes_sync_target on public.canvass_outcomes;
create trigger canvass_outcomes_sync_target
  after insert on public.canvass_outcomes
  for each row execute procedure public.sync_canvass_target_outcome();

-- ─── days_to_close auto-compute ───────────────────────────────────────
create or replace function public.compute_days_to_close()
returns trigger as $$
declare
  target_created timestamptz;
begin
  if new.days_to_close is null and new.outcome in ('won', 'lost') then
    select created_at into target_created
      from public.canvass_targets
     where id = new.canvass_target_id;
    if target_created is not null then
      new.days_to_close := extract(day from new.occurred_at - target_created);
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists canvass_outcomes_days_compute on public.canvass_outcomes;
create trigger canvass_outcomes_days_compute
  before insert on public.canvass_outcomes
  for each row execute procedure public.compute_days_to_close();

-- ─── updated_at trigger ───────────────────────────────────────────────
drop trigger if exists canvass_outcomes_touch_updated_at on public.canvass_outcomes;
create trigger canvass_outcomes_touch_updated_at
  before update on public.canvass_outcomes
  for each row execute procedure public.touch_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────
alter table public.canvass_outcomes enable row level security;

-- Read: every authenticated user in the office can see outcomes.
drop policy if exists canvass_outcomes_select_office on public.canvass_outcomes;
create policy canvass_outcomes_select_office on public.canvass_outcomes
  for select using (
    office_id in (
      select office_id from public.user_office_membership
       where user_id = auth.uid()
    )
  );

-- Insert: any office member can log an outcome. The API enforces
-- additional business rules (e.g. only managers can override a 'won'
-- outcome that has already been logged).
drop policy if exists canvass_outcomes_insert_office on public.canvass_outcomes;
create policy canvass_outcomes_insert_office on public.canvass_outcomes
  for insert with check (
    office_id in (
      select office_id from public.user_office_membership
       where user_id = auth.uid()
    )
  );

-- Update: same scoping. UI uses inserts for new transitions; updates
-- only when a webhook retries with corrected data.
drop policy if exists canvass_outcomes_update_office on public.canvass_outcomes;
create policy canvass_outcomes_update_office on public.canvass_outcomes
  for update using (
    office_id in (
      select office_id from public.user_office_membership
       where user_id = auth.uid()
    )
  );

comment on table public.canvass_outcomes is
  'Outcome history per canvass_target. Append-only: one row per status transition. Drives both the dashboard funnel view and the ML training pairs (features_snapshot, outcome).';
comment on column public.canvass_targets.features_snapshot is
  'JSONB snapshot of features as they existed when this canvass_target row was scored. Frozen — never updated. The (features_snapshot, latest_outcome) pairs are the ML training data.';
