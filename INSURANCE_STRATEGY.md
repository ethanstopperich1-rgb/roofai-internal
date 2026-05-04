# Voxaris Pitch — Insurance Strategy (post deep-research, May 2026)

## Critical findings from deep research

1. **`.esx` files are encrypted/signed proprietary archives.** Xactimate
   refuses raw XML on import. The 2016 DanTutt XACTDOC reference cannot be
   used to ship a working ESX — would only generate the inner data, not the
   archive wrapper that Xactimate validates.

2. **Reverse-engineering ESX carries DMCA + ToS exposure.** Anti-circumvention
   provisions (17 USC §1201) plus Verisk's terms make this not just risky
   but a category of risk we shouldn't take given there's a legitimate path.

3. **Verisk Partner Program is open to startups.** Roofr (a competitor)
   shipped their `$10 ESX add-on` April 2026 after going through it.
   Requirements: NDA, data security compliance, insurance certificates,
   shared client references. **No public cost.** Estimated 3–6 month
   timeline.

4. **The market gap "satellite → AI damage → pre-scoped ESX" is unfilled.**
   Roofr has the ESX export but no AI satellite measurement. EagleView/HOVER
   have measurement but expensive and no AI-driven damage assessment.
   CompanyCam has photos only. **Pitch is currently the closest to complete;
   only ESX is missing.**

5. **Clean Xactimate workflow cuts settlement 6–8 weeks → 2–3 weeks.** Even
   with PDF (no ESX yet), a Pitch-quality estimate that maps cleanly to
   Xactimate codes already accelerates payment. The PDF claim packet is a
   real product before partnership lands.

## Strategy

### Day 0 (today)
- File Verisk Xactimate Partner Program application
- Begin compliance prep: SOC 2 readiness or equivalent, COI, NDA template,
  customer-reference list (need 3–5 contractor references willing to vouch)
- Add Texas-required AI-disclosure footer to all generated PDFs **(shipped)**

### Days 1–30 (while Verisk reviews)
- **Photo upload + EXIF preservation** — 30–50 GPS-tagged, timestamped
  photos is the practical claim standard. We don't have this yet.
- **Carrier-specific PDF variants** — State Farm, Allstate, USAA, Citizens,
  Travelers, Liberty Mutual each prefer slightly different layouts.
- **Florida SB 2-D-aware claim helper** — when roof age < 15 yr and damage
  signals present, surface adjuster ammunition: "FL SB 2-D bars age-only
  denial below 15 years." **(shipped, see VisionPanel)**
- **Multi-temporal change detection** — same roof in 2022 vs 2026 imagery
  via Solar API date metadata; diff with Claude vision; flag new damage
  since the matching NOAA storm event.
- **Claim packet PDF** — single bundled deliverable: photos + measurements
  + line items + storm correlation + AI assessment.

### Days 30–60
- Continue Verisk certification (security review, references)
- AI countermeasure positioning — State Farm's adjuster-side AI is creating
  contractor demand for AI-backed counter-estimates. Pitch *is* the answer.
- **Pricing experiment**: $25-50 per insurance estimate vs Roofr's $10. We
  bundle the AI + measurement + photo packet — premium-positioned because
  it's the complete claim, not just the ESX file.

### Days 60–90
- Verisk certification likely lands
- Ship ESX export
- Launch **Insurance Mode** as a paid tier

## Compliance / regulatory awareness

| State | Rule | Pitch action |
|---|---|---|
| **Texas** | AI estimate disclosure required | Footer on all PDFs **(shipped)** |
| **Texas** | Contractor-adjuster dual role banned (June 2024) | Documentation only — informational chip in proposal |
| **Florida** | SB 2-D bars age-only denial under 15 yr | Surface chip on Vision panel **(shipped)** |
| **Colorado** | Hail-resistant roof grants 2026 | Future: opt-in upsell tier when in CO |
| **Federal** | DMCA §1201 anti-circumvention | Do NOT reverse-engineer ESX |

## Pricing landscape (deep-research data)

| Tool | Price | Equivalent in Pitch |
|---|---|---|
| Xactimate Pro | $2,690/yr | (we don't replace — we feed) |
| EagleView Premium Report | $15-87/report | **Pitch replaces** with satellite + 3D + CAD + DXF |
| HOVER scan | $19-39/scan | **Pitch replaces** (we have AI; they don't) |
| CompanyCam | $79/mo | **Pitch surrounds** (we'll have photos + estimating) |
| Roofr ESX add-on | $10/ESX | **Pitch matches** post-Verisk certification |

Contractor pain: $6,000–$9,000/year fragmented SaaS. **Pitch single-pane-of-glass
ARR target: $2,000–4,000/year per contractor seat** (50% lift over the unit
economics, half the SaaS spend).

## Risks

- Verisk rejects partnership → can still sell PDF claim packets; ESX is icing
- Carrier-side AI (State Farm CCC One) becomes ubiquitous → we win this
  *more*, not less — contractor demand for counter-estimates intensifies
- Photo upload privacy law variance by state → solve via on-platform storage
  + auto-EXIF-strip option
- ESX schema evolves before our partnership lands → less risk because Verisk
  partners get spec updates

## Sources

- [Verisk Strategic Alliances](https://www.verisk.com/company/strategic-alliances/)
- [RoofingSoftwareGuide — Xactimate Roofing Guide](https://roofingsoftwareguide.com/guides/xactimate-roofing-guide/)
- [Roofr × Verisk PR (April 2026)](https://www.prnewswire.com/news-releases/roofr-verisk-team-up-to-help-contractors-submit-faster-more-accurate-insurance-estimates-302743334.html)
- [EagleView × Verisk JV](https://www.eagleview.com/eagleview/eagleview-and-verisk-join-forces-to-streamline-property-insurance-claims/)
- [r/xactimate — All Hands On Deck](https://www.reddit.com/r/xactimate/comments/1jd808s/allhandsondeck/)
- [HOVER Pricing](https://hover.to/insurance/)
