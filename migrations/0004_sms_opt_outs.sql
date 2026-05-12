-- =====================================================================
-- 0004_sms_opt_outs.sql
--
-- TCPA opt-out persistence.
--
-- Before this migration, /api/sms/inbound logged the STOP keyword to
-- the console and relied on Twilio's account-level STOP handler to
-- block outbound. That's only sufficient if EVERY outbound SMS goes
-- through that same Twilio account number — once a different code
-- path (a follow-up scheduled three weeks later, a different sender
-- ID, a future per-office Twilio number) is added, a STOP recorded
-- here is forgotten and the operator becomes the TCPA violator of
-- record.
--
-- This table is append-only-feeling but technically allows updates
-- to `opted_in_at` so a verified opt-back-in can be recorded without
-- losing the original opt-out audit trail.
-- =====================================================================

create table if not exists public.sms_opt_outs (
  -- E.164 phone number is the natural key — we don't want two rows
  -- for the same number.
  phone_e164    text primary key,

  -- Which tenant the opt-out belongs to. A number can be active under
  -- one office and opted-out under another, but practically we treat
  -- opt-out as system-wide to be defensible — operators can't argue
  -- "the opt-out was for office A only" in a TCPA suit. The office_id
  -- is captured for forensic + per-office reporting, not for scoping
  -- the gate.
  office_id     uuid references public.offices (id) on delete set null,

  -- When the STOP came in.
  opted_out_at  timestamptz not null default now(),

  -- Source of the opt-out (sms_stop, sms_unsubscribe, support_request,
  -- admin_action, customer_request). Free text — values not strictly
  -- enumerated so future channels (web form, voice, email) fit
  -- without a migration.
  source        text not null default 'sms_stop',

  -- Raw keyword that triggered the opt-out (STOP / STOPALL / UNSUBSCRIBE
  -- / CANCEL / END / QUIT) — useful for forensic review.
  keyword       text,

  -- If the customer subsequently opts back in (rare but legal under
  -- TCPA with a fresh affirmative consent), record that here. Both
  -- timestamps coexist so we can answer "did they ever opt out?"
  -- with the audit trail intact.
  opted_in_at   timestamptz
);

create index if not exists sms_opt_outs_office_idx on public.sms_opt_outs (office_id);
create index if not exists sms_opt_outs_opted_out_idx on public.sms_opt_outs (opted_out_at desc);

-- RLS
alter table public.sms_opt_outs enable row level security;

-- Staff in the office see opt-outs for that office. Admins see all.
-- WRITES happen only through service-role (the /api/sms/inbound webhook
-- has no user session); no INSERT/UPDATE policies for authenticated
-- users.
drop policy if exists sms_opt_outs_select_office on public.sms_opt_outs;
create policy sms_opt_outs_select_office on public.sms_opt_outs
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

-- Belt-and-suspenders: no UPDATE / DELETE by any non-service-role
-- caller. The original opt-out timestamp must be permanent.
drop policy if exists sms_opt_outs_no_update on public.sms_opt_outs;
create policy sms_opt_outs_no_update on public.sms_opt_outs
  for update to authenticated using (false);

drop policy if exists sms_opt_outs_no_delete on public.sms_opt_outs;
create policy sms_opt_outs_no_delete on public.sms_opt_outs
  for delete to authenticated using (false);
