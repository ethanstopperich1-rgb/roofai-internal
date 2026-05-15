# Phase 1.5: Migrate tier ladders to /api/parcel-polygon, remove /api/microsoft-building

**Target:** open this issue 7 days after Phase 1 ships to production.

**Status:** Phase 1 shipped — this file is the durable record so the
cleanup doesn't get lost in a "we'll get to it" backlog.

---

## Context

Phase 1 introduced `lib/sources/parcel-polygon.ts` (the multi-source
picker) and `lib/sources/ms-buildings.ts` (Azure-backed MS Buildings
with three-tier caching). The old `lib/microsoft-buildings.ts`
(Nashville-scoped TSV impl) is deleted, but `/api/microsoft-building`
remains as a **deprecated shim** that delegates to `fetchMsBuildingsOnly`
in the new module so the four known consumers don't break.

Phase 1.5 removes that shim once the consumers migrate to the new
`/api/parcel-polygon` route.

## Why this is split out

Doing both in Phase 1 confounded two changes:
1. Footprint-clipping accuracy (the Phase 1 goal)
2. Tier-ladder semantics (each consumer's fallback chain changes when
   it switches from "give me MS Buildings polygon or 404" to "give me
   the picker's best polygon")

The 3-day observation window for Phase 1 measures **only** footprint
clipping. Phase 1.5 measures **only** tier-ladder semantics. Each PR
gets clean attribution.

## Consumer migration list

The four call sites that currently hit `/api/microsoft-building`:

| File | Line | Migration target |
|---|---|---|
| `app/quote/page.tsx` | 760 | `fetch("/api/parcel-polygon?...")` — customer tier ladder. Verify the response shape change doesn't break downstream logic. |
| `app/dashboard/estimate/page.tsx` | 1370 | Same — rep tier ladder. |
| `scripts/eval-truth.ts` | 210 | Same — eval harness. Update scoring rubric if it differentiated MS Buildings from other sources. |
| `lib/reconcile-roof-polygon.ts` | 25 | Already migrated in Phase 1 — imports `fetchMsBuildingsOnly` directly from the new module. **No action needed in Phase 1.5**; left in this list for completeness. |

## Deprecation telemetry

The Phase 1 shim logs every call with caller IP / referer / user-agent:

```
[deprecated] /api/microsoft-building called {"ip":"...","referer":"...","userAgent":"...","query":"..."}
```

Before opening the Phase 1.5 PR:

1. Pull 7 days of these warn lines from production logs.
2. Confirm the only callers are the four expected paths above.
3. If any unexpected caller appears (forgotten cron job, internal
   tool, etc.), add it to the migration list before deletion.

## Phase 1.5 PR contents

- `app/quote/page.tsx` — migrate fetch call
- `app/dashboard/estimate/page.tsx` — migrate fetch call
- `scripts/eval-truth.ts` — migrate fetch call
- Delete `app/api/microsoft-building/route.ts`
- Update any docs that reference the route URL (`EVAL_RUNBOOK.md`,
  `scripts/eval-truth/README.md`, `middleware.ts` rate-limit
  comments)
- Verify `middleware.ts` rate-limit allowlist doesn't reference the
  removed route

## Out of scope for Phase 1.5

- The `"microsoft-buildings"` string in type unions
  (`types/estimate.ts`, `components/Roof3DViewer.tsx`,
  `app/dashboard/estimate/page.tsx`). That's an enum value for "this
  polygon's data came from MS Buildings as a source," semantically
  independent of the route's existence. Rename to `"ms_buildings"`
  in a separate enum-unification PR if/when desired.
- Adding an OSM source to the picker. Tracked separately under
  "Phase 1.6: OSM building-footprints in picker."

## Open as GitHub issue when ready

Suggested title: **Phase 1.5: Migrate tier ladders to /api/parcel-polygon, remove /api/microsoft-building**

Suggested labels: `cleanup`, `tracked`, `phase-1.5`
