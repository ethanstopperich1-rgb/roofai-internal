# Supabase migrations

Versioned SQL migrations for the Voxaris Pitch Postgres schema. Hosted
on the Supabase project `htfhelquuvndfwfwqjmd` ("voxaris-roofing-pitch").

## How this directory works

Each file is a single transactional migration:

```
migrations/
├── 0001_initial_schema.sql   tables + indexes + triggers
├── 0002_rls_policies.sql     row-level security + helper functions
├── 0003_seed.sql             voxaris-office seed row
└── README.md                 this file
```

Files are applied in lexical order (numeric prefix). Once a migration
ships to production, never edit it in place — write a follow-up file
that adds / alters / drops what you need. The prod DB is the source of
truth; these files exist so we can:

  1. Spin up a clean dev / staging environment (`supabase db reset`
     applies them in order).
  2. Recover from a catastrophic DB loss without an "oh no" Slack
     thread reconstructing schema from React types.
  3. Onboard a new partner workspace (each of the 18 RSS offices gets
     its own Supabase project under the white-label rollout — every
     project must end up at the same schema state).

## Snapshot, not live

The current files are a **snapshot reconstruction** of the production
schema as of 2026-05-11, derived from `types/supabase.ts` and the
`lib/supabase.ts` comments. If you find a discrepancy between this
directory and the live DB, the live DB wins — capture the diff in a
new `0004_*.sql` migration rather than editing existing files.

## Adding a migration

```bash
# 1. Make the change in the Supabase Studio SQL editor, test it.
# 2. Once it works, dump the exact SQL into the next-numbered file:
touch migrations/0004_my_change.sql
# 3. Regenerate the typed Database type:
mcp__supabase__generate_typescript_types({ project_id: "htfhelquuvndfwfwqjmd" })
#    Or via the Supabase CLI:
supabase gen types typescript --project-id htfhelquuvndfwfwqjmd > types/supabase.ts
# 4. Commit both files in the same PR.
```

## Applying to a fresh project

```bash
# Local Supabase via CLI:
supabase db reset

# Hosted project — Studio → SQL Editor → paste each file in order.
# (No `supabase db push` because we're not using the migrations table.)
```

## RLS testing

After any migration that touches RLS, verify the policies still
isolate offices correctly:

```sql
-- As an authenticated user in office A:
select set_config('request.jwt.claims', '{"sub": "<user_in_office_A>"}', true);
select count(*) from leads;        -- expect: office A rows only
select count(*) from offices;      -- expect: 1 (own office)
```

The Cursor review pass added this as a tripwire — a missing RLS clause
can leak cross-tenant data without throwing any error.
