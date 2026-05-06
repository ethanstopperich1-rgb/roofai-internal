# Ground-truth annotations

This directory holds hand-traced roof polygons used as the answer key for
`npm run eval:truth`. Each file is a single property:

```json
{
  "slug": "tn-beulah-rose",
  "address": "465 Beulah Rose Dr, Murfreesboro, TN 37128, USA",
  "lat": 35.8134,
  "lng": -86.4521,
  "polygon": [{ "lat": 35.8135, "lng": -86.4522 }, ...],
  "notes": "complex hip + attached garage",
  "savedAt": "2026-05-05T20:00:00.000Z"
}
```

## How to add one

1. `npm run dev`
2. Open `/eval-trace` in the app (only mounted in dev — the save endpoint
   refuses POSTs in production).
3. Pick an address → click **Draw fresh** on the map → trace the actual
   roof outline → fine-tune vertices → **Save ground truth**.
4. Commit the resulting `<slug>.json` file alongside your eval results.

## How to use them

```sh
# In one terminal
npm run dev

# In another
npm run eval:truth
```

The harness hits `/api/solar-mask`, `/api/building`, `/api/roboflow`,
`/api/microsoft-building`, and `/api/sam-refine` for each ground truth,
then prints per-address scores plus a summary table:

```
source            hits   avg IoU   p50 IoU   p90 IoU   avg Area×   avg Haus_m
solar-mask        7/10      0.91      0.92      0.95         0.99          1.6
roboflow         10/10      0.68      0.71      0.84         1.07          5.8
sam-refine        8/10      0.74      0.77      0.86         0.93          4.1
ms-buildings      4/10      0.82      0.83      0.88         0.91          3.2
osm               3/10      0.79      0.80      0.85         0.94          3.6
```

Use these numbers to (a) decide which sources to keep and at what priority,
and (b) verify that future changes actually move IoU up rather than down.

## Coverage targets

Aim for at least 10 ground truths spanning:

- **3 simple**: rectangular ranch / single gable
- **3 medium**: L-shape, attached garage, hip
- **2 complex**: multi-wing, dormers, mixed gable+hip
- **2 hard**: rural with stale imagery, dense urban with tree occlusion

Don't cherry-pick easy houses — the eval is only useful if it reflects
production traffic.
