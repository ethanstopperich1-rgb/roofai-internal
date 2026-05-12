import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How we measure · Voxaris Pitch",
  description: "Step-by-step methodology for how Voxaris produces a roofing estimate from an address — what data we use, what we don't, and where the accuracy bands come from.",
  robots: { index: true, follow: true },
};

const LAST_UPDATED = "May 12, 2026";

export default function MethodologyPage() {
  return (
    <div className="text-slate-200 leading-relaxed space-y-8">
      <header>
        <h1 className="font-display text-[42px] sm:text-[56px] font-semibold tracking-[-0.025em] text-slate-50 mb-2">
          How we measure your roof
        </h1>
        <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-slate-500">
          Last updated · {LAST_UPDATED}
        </p>
        <p className="mt-6 text-[15px] text-slate-300 leading-relaxed max-w-prose">
          You typed your address. Here is exactly what happened, in order,
          to produce the number you saw. No black boxes — if anything
          below conflicts with what you experienced on your estimate
          page, email{" "}
          <a href="mailto:support@voxaris.io" className="text-cy-300 hover:underline">
            support@voxaris.io
          </a>{" "}
          and we&apos;ll investigate.
        </p>
      </header>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Step 1 — Address → coordinates
        </h2>
        <p>
          Your typed address is sent to Google&apos;s Places API to
          resolve to a specific property (latitude, longitude, ZIP
          code, formatted address). When we can&apos;t confirm a house
          number — for example, you typed only a street name — we
          refuse to proceed and ask you to be more specific. Quoting a
          street is not the same as quoting a house, and we won&apos;t
          do the former and pretend it&apos;s the latter.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Step 2 — Roof outline
        </h2>
        <p>
          We attempt to trace your roof&apos;s outline from
          high-resolution aerial imagery, in order of preference:
        </p>
        <ol className="list-decimal pl-6 mt-3 space-y-2">
          <li>
            <strong className="text-slate-50">Voxaris SAM3 (primary):</strong>{" "}
            our fine-tuned Segment Anything Model 3 instance, prompted to
            isolate the main roof envelope from the surrounding context
            (driveways, trees, neighboring houses). The output is
            reconciled against ground-projected building footprints from
            either OpenStreetMap or Microsoft Building Footprints to
            catch cases where the AI confidently traced the wrong
            structure.
          </li>
          <li>
            <strong className="text-slate-50">Google Solar API mask (fallback):</strong>{" "}
            when SAM3 returns nothing usable, we fall back to Google&apos;s
            own photogrammetric roof mask — the same underlying data
            Google uses for its solar-panel sizing tool.
          </li>
          <li>
            <strong className="text-slate-50">Building footprint (last resort):</strong>{" "}
            when neither AI nor Solar produces a usable trace, we apply a
            standard 6% eave-overhang factor to the ground building
            footprint as a coarse approximation. We tell you when this
            happened.
          </li>
        </ol>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Step 3 — Roof pitch
        </h2>
        <p>
          Roof pitch (how steep) materially affects how many square feet
          of roof material your project needs — a 12/12 roof has roughly
          40% more surface area than the same footprint at 4/12. When
          Google Solar returns a pitch measurement for your property,
          we use it directly. When it doesn&apos;t, we{" "}
          <strong className="text-slate-50">assume 6/12</strong> and
          label it clearly on your estimate page. A 6/12 assumption
          is industry standard for medium-pitch residential, but if
          your roof is significantly flatter or steeper, the actual
          quote will adjust accordingly — get an on-site confirmation
          before committing to the number.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Step 4 — Material and price
        </h2>
        <p>
          You pick a material (3-tab asphalt, architectural shingle,
          standing-seam metal, concrete tile). We multiply the roof
          surface area by a regional installed-cost rate that combines
          material price and typical labor rates for your state. The
          result is a range, not a single number, because actual job
          costs vary with deck condition, code compliance, accessibility,
          and current material supply pricing — none of which we can see
          from satellite.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Step 5 — Storm context
        </h2>
        <p>
          We ingest the National Weather Service&apos;s MRMS hail radar
          data daily and correlate it to your address. If your property
          has had a significant hail event in the last 5 years, the
          contractor handling your area will see that on their side and
          may flag the work as insurance-eligible. We don&apos;t bill
          insurance carriers or homeowners directly; we provide
          documentation tools the contractor uses on your behalf.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          What we don&apos;t know
        </h2>
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            <strong className="text-slate-50">Deck condition.</strong>{" "}
            Rotten or damaged decking is invisible from satellite. If
            replacement is needed, it&apos;s typically $2-4/sqft on top
            of the estimate.
          </li>
          <li>
            <strong className="text-slate-50">Code requirements.</strong>{" "}
            Florida HVHZ counties (Miami-Dade, Broward, Monroe) require
            specific fastening + product approvals; the contractor will
            adjust your scope to match.
          </li>
          <li>
            <strong className="text-slate-50">Tear-off complexity.</strong>{" "}
            Two existing layers of shingles take longer (and cost more)
            to tear off than one. We don&apos;t know how many you have.
          </li>
          <li>
            <strong className="text-slate-50">Access difficulty.</strong>{" "}
            Steep grades, blocked driveways, second-story dormers — all
            increase labor.
          </li>
          <li>
            <strong className="text-slate-50">Current pricing.</strong>{" "}
            Shingle, metal, and tile supply prices move every quarter.
            We use regional averages; your contractor uses today&apos;s
            truck price.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Accuracy expectations
        </h2>
        <p>
          On standard residential single-family properties with recent
          imagery and a measured pitch, the estimate is typically
          within a 10-15% band of the contractor&apos;s on-site quote.
          We widen the band — and tell you so — when:
        </p>
        <ul className="list-disc pl-6 mt-3 space-y-1.5">
          <li>Imagery is older than 5 years</li>
          <li>Pitch was assumed (Solar didn&apos;t return one)</li>
          <li>The roof has multiple sections or complex geometry</li>
          <li>The property is rural or has multiple buildings on the parcel</li>
        </ul>
        <p className="mt-4">
          The estimate is non-binding. The only number that matters is
          the one on a signed contract from a licensed contractor after
          they&apos;ve been on your roof.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Where the data goes
        </h2>
        <p>
          Your address, name, email, phone, and TCPA consent receipt
          are stored encrypted in our database, isolated to the
          contractor servicing your area. We don&apos;t sell or share
          this data with marketing networks. Full detail in our{" "}
          <a href="/privacy" className="text-cy-300 hover:underline">
            Privacy Policy
          </a>
          .
        </p>
      </section>
    </div>
  );
}
