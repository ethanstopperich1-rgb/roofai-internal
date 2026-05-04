# Perplexity Deep Research Brief — Xactimate Integration & Insurance-Roofing Tools

> Paste this into **Perplexity Deep Research** (the heavier reasoning mode that synthesizes 50+ sources). Run as one query. The output is what we'll use to scope our Xactimate-compatibility roadmap.

---

## My company

I'm building **Voxaris Pitch** — a roofing estimator product. Reps type an address → AI measures the roof from satellite, vision-analyzes damage, generates a tiered proposal with line items in **Xactimate-compatible format** (RFG ARCH, RFG SHGLR, RFG IWS, RFG VAL, etc.). PDF export today; insurance-claim workflow is the next big push.

I want to ship Xactimate XML export so contractors can hand a `.xml` file directly to insurance adjusters, who import it into their Xactimate desktop. End-state: Pitch becomes the front-end measurement + estimating tool, Xactimate stays the back-end claims processor.

I have a 2016 reverse-engineered XACTDOC reference (DanTutt/XML_Project on GitHub) but the schema may have evolved.

---

## What I need from Deep Research

Synthesize **current (2024–2026)** state across the following 9 areas. Be specific, cite sources, name names, and call out where info is gated / unverifiable.

### 1. Xactware / Xactimate XML schema — current state

- What is the current XACTDOC XML schema version? (The reference I have is from 2016.)
- Is `.esx` (Xactimate's archive format) **just a zipped container** of XACTDOC XML + assets, or is it cryptographically signed / DRM'd?
- Are third-party tools allowed to **generate** .esx or .xml import files Xactimate will accept, or is this gated to certified partners?
- What's the official documentation source? Is it public, partner-only, or leaked?
- Specific schema changes between 2016 and now — list them.

### 2. Verisk / Xactware partner certification

- What's the **Verisk Xactware Partner Program** — cost, timeline, requirements?
- Do you need certification to write a tool that exports Xactimate-compatible files?
- Are there tiered partnerships (read-only vs read/write, sketch vs estimate, etc.)?
- Who has it today (HOVER, EagleView, CompanyCam, AccuLynx, Roofr, etc.)?
- What's the practical bar — can a small startup get certified, or is it enterprise-only?

### 3. Competitor landscape — Xactimate-compatible roofing tools

For each of these, what exactly do they offer and at what price?

- **HOVER** — measurement reports, do they export to Xactimate?
- **EagleView** — measurement + estimating, Xactimate integration depth?
- **CompanyCam** — photo documentation, claim packets, does it speak Xactimate?
- **AccuLynx** — full CRM + estimating, claim integration?
- **Roofr** — newer entrant, what's their Xactimate story?
- **JobNimbus** — CRM angle, claim handling
- **Pitchbook (the literal name conflict)** — anything?
- Any **open-source or community** tools generating Xactimate-compatible files?

What's the **actual gap** in the market right now? What does no one offer?

### 4. Insurance carrier submission workflows (US, 2026)

- How do roofers actually submit claims to **State Farm, Allstate, USAA, Farmers, Citizens, Travelers, Liberty Mutual, Progressive** today? Email PDF? Carrier portal? EagleView? Xactimate Cloud?
- Does **each carrier accept Xactimate XML** as the standard format, or do they have their own proprietary intake systems?
- Is there a **standardized XML format** carriers use (other than XACTDOC)?
- What's the role of **Symbility** (Xactware's main competitor)? Is it still relevant in 2026?
- Are there **regional differences** — e.g. Florida vs Texas vs Colorado? Different carriers dominate different regions, different submission norms.

### 5. Recent regulatory / legal landscape (2024–2026)

- **Florida HB 837 / HB 7065** — what changed for roof claims after the AOB reform? Is this still bottle-necking insurance roofing in FL?
- **Texas hail litigation reform** — current state.
- Other states (CO, OK, NE, KS — hail alley) — recent changes.
- **AI / vision-based estimates** — any state-level rules requiring human-signed estimates? CARF, NACBI, or other industry certifications relevant?
- **Roofing licensure & "matching" laws** — any active legal trends about matching shingle color across full slopes?

### 6. Pricing & pain points — what do contractors pay today?

- **Xactimate license cost** for a small roofing contractor (per seat, per year)?
- **EagleView measurement report** cost per address? How much volume do roofing companies typically buy?
- **HOVER** — same question.
- **CompanyCam** — pricing, where it shines.
- What are the **biggest cost / time pain points** roofing contractors complain about in 2026? What do they wish their estimating tool did?

### 7. AI / vision in insurance roofing — current state

- Who's using **AI for damage detection** in claim workflows?
- Is **drone imagery** (from contractor or carrier side) becoming standard for hail claims? Which providers?
- Are **carriers themselves** using AI to triage claims (e.g. State Farm's CCC One)? What does this mean for contractor-side tools?
- Any **adjuster-facing AI tools** that we'd be competing with or complementing?

### 8. Photo documentation standards for claims

- What's the **typical photo packet** for a roof damage claim — count, angles, metadata required?
- Do insurance carriers require **EXIF preservation, GPS tagging, timestamps**?
- Are there **photo-tagging standards** in the industry (e.g. front-elevation, north-slope, hail-impact close-up)?
- What's the **minimum viable photo packet** that satisfies the typical adjuster?

### 9. Open questions — what should I be worried about?

- What's the **legal risk** of generating Xactimate-compatible files without partnership? (UCC implications? Lanham Act? DMCA reverse-engineering carve-out?)
- Are there **non-obvious moats** competitors have that I'm not seeing?
- What's the **biggest reason roofing contractors don't switch tools**? (Switching cost, training, integration with existing CRM, etc.)
- If you were starting Voxaris Pitch today, **what would you do that I haven't mentioned?**

---

## Output format I want

For each of the 9 sections:

1. **Executive summary** — 2-3 sentences
2. **Key facts with sources** — bulleted, each with a citation URL
3. **What's confirmed vs speculation** — flag clearly
4. **Implication for Voxaris Pitch** — one sentence on what we should do about it

End with a **prioritized 90-day roadmap** for the insurance / Xactimate angle, ranked by ROI vs effort.

---

End of brief.
