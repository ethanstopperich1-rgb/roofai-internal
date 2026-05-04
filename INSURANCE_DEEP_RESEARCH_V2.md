# Deep Research Report v2 — Voxaris Pitch · Insurance & Xactimate Landscape

> Saved verbatim from Perplexity Deep Research (May 2026). Cross-references the
> earlier `INSURANCE_STRATEGY.md` — major facts that change our product
> decisions are flagged as **DECISION**.

## Decisions this report drives

1. **Verisk Partner application URL is `verisk.com/company/strategic-alliances/partner-application`.** File Day 1.
2. **ESX is confirmed encrypted, not zipped XML.** Reverse-engineering = DMCA §1201 exposure. Off the roadmap permanently.
3. **Roofr's $10 / ESX is the market anchor.** Beat it on AI damage scope, not on file format alone.
4. **Supplement Analyzer is genuine new ground.** Per Section 9: "the biggest pain point is the 20–40% of claim value left on the table." An AI that flags missing O&P / pitch factors / code items in a carrier's initial Xactimate scope is direct recovered revenue for contractors. **Highest-leverage v3 feature.**
5. **Matching-law auto-detection.** 30+ states. Auto-flag when a partial repair should trigger a full-slope replacement.
6. **Photo capture flow replaces CompanyCam.** $79/mo stack item we can absorb. Already shipped EXIF preservation; need structured checklist next.
7. **HOVER's 22 billion sq ft of training data is the deepest competitor moat.** Our counter: AI that combines satellite + vision + supplement intelligence — they have data, we have judgment.
8. **Drone integration is now expected.** EagleView Assess + HOVER both standardized. Future: ingest contractor drone runs.

## Headline market shape (confirmed)

- Xactimate processes >90% of US property insurance claims
- Symbility (CoreLogic) is ~10%, adjuster-side only — not a primary integration target
- Average insurance roofing stack costs $6,000–$9,000/yr in fragmented SaaS
- Clean Xactimate submission cuts settlement 6–8 weeks → 2–3 weeks
- Initial carrier scope underpays by 35–50% on average — supplement is where revenue lives

## Compliance items already shipped or in motion

- ✅ AI-disclosure footer on PDF (Texas SB 1665 compliance)
- ✅ Florida SB 2-D claim helper chip (when ZIP=FL + age <15 yr + damage detected)
- ✅ Field photo upload + EXIF preservation
- ✅ Imagery × storm correlation banner (multi-temporal)
- ✅ 10 carrier-specific PDF profiles
- ⏳ Verisk Partner Program application (user action)

## Backlog ranked by deep-research data

| # | Feature | Source | Effort | Impact |
| --- | --- | --- | --- | --- |
| 1 | Supplement Analyzer (flag missing O&P / pitch / code items in carrier PDF) | Section 9 | 8-12 hr | Highest — directly recovers 20-40% of claim |
| 2 | Matching-law auto-detection (30+ states) | Section 9 | 4-6 hr | High — pure upsell trigger |
| 3 | Structured photo-capture checklist | Section 8 | 4 hr | High — replaces CompanyCam workflow |
| 4 | State Farm Premier Service Program / Citizens portal pre-fill | Section 4 | 6-8 hr | High — FL/TX markets |
| 5 | Drone imagery ingest (Zeitview / DroneDeploy / DJI .DNG) | Section 7 | 8 hr | Medium — wow factor |
| 6 | Vercel KV cache layer | Audit | 30 min | Medium — kills 60% of paid-API spend |
| 7 | Auth (Clerk magic-link) | Audit | 2 hr | Critical infra |
| 8 | Supabase persistence | Audit | 3-4 hr | Critical infra |

## Notes on threat vectors

- Carrier-side AI (State Farm Xactimate lawsuits, non-renewal scanning) → INCREASES contractor demand for our tooling (we're the counter-AI)
- HOVER's deep carrier integration → moat we won't beat on integration depth, beat on AI damage scope
- ESX reverse engineering → DO NOT
- magicplan / DocuSketch ESX relay (Section 9 idea #9) → worth a 30-min phone call, could shave 3-6 months off our Xactimate-export timeline if they'd white-label

## Source: Perplexity Deep Research, May 2026
