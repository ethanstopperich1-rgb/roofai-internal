import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service · Voxaris Pitch",
  description: "Terms governing use of the Voxaris Pitch roofing-estimate platform and SMS program.",
  robots: { index: true, follow: true },
};

const LAST_UPDATED = "May 11, 2026";

export default function TermsPage() {
  return (
    <div className="text-slate-200 leading-relaxed space-y-8">
      <header>
        <h1 className="font-display text-[42px] sm:text-[56px] font-semibold tracking-[-0.025em] text-slate-50 mb-2">
          Terms of Service
        </h1>
        <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-slate-500">
          Last updated · {LAST_UPDATED}
        </p>
      </header>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Acceptance
        </h2>
        <p>
          By using Voxaris Pitch — including submitting an estimate
          request through pitch.voxaris.io or a partner contractor&apos;s
          embedded widget — you agree to these Terms and to our{" "}
          <a href="/privacy" className="text-cy-300 hover:underline">
            Privacy Policy
          </a>
          . If you do not agree, do not submit a request.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          What we do
        </h2>
        <p>
          Voxaris Pitch is an estimating platform. We measure a roof
          from public satellite imagery, identify likely material and
          condition, and produce a price range. We then deliver your
          request to a single partner contractor of your choosing who
          may follow up with a binding quote and perform the work.
          <strong className="text-slate-50">
            {" "}
            Voxaris does not perform roofing work, employ roofing
            contractors, or guarantee the work of partner contractors.
          </strong>{" "}
          The relationship for any work performed is solely between
          you and the contractor.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Estimate accuracy
        </h2>
        <p>
          The price range you see is an estimate based on satellite
          imagery and regional pricing data, not a binding quote.
          Actual prices depend on factors the platform cannot see —
          deck condition, code compliance, accessibility, change in
          material prices, and so on. A typical estimate falls within
          roughly 10 percent of a contractor&apos;s in-person quote on
          standard residential roofs, but variance can be wider on
          complex roofs, very large properties, or properties where
          our imagery is stale. We flag stale-imagery cases when we
          detect them.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          SMS program terms
        </h2>
        <p>
          By submitting the consent box on the estimate form, you
          agree to receive automated text messages from Voxaris and
          your selected partner contractor at the phone number you
          provided, sent via Twilio or a comparable service.
        </p>
        <ul className="list-disc pl-6 mt-3 space-y-1.5">
          <li>
            <strong className="text-slate-50">Program purpose:</strong>{" "}
            delivering your roofing estimate, follow-up about the
            estimate, and related roofing-services communications
          </li>
          <li>
            <strong className="text-slate-50">Frequency:</strong>{" "}
            varies by inquiry, typically 1&ndash;5 messages per
            inquiry
          </li>
          <li>
            <strong className="text-slate-50">Carrier charges:</strong>{" "}
            message and data rates may apply per your wireless plan;
            neither Voxaris nor your carrier is responsible for
            delayed or undelivered messages
          </li>
          <li>
            <strong className="text-slate-50">Opt out:</strong> reply{" "}
            <code className="font-mono text-cy-300">STOP</code> to any
            message to cancel. We confirm cancellation and stop
            messages immediately.
          </li>
          <li>
            <strong className="text-slate-50">Help:</strong> reply{" "}
            <code className="font-mono text-cy-300">HELP</code> or
            contact{" "}
            <a href="mailto:support@voxaris.io" className="text-cy-300 hover:underline">
              support@voxaris.io
            </a>
          </li>
          <li>
            <strong className="text-slate-50">Consent is not required:</strong>{" "}
            agreeing to receive marketing messages is not a condition
            of purchasing roofing services. You may decline this box
            and instead request a callback through other channels.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Acceptable use
        </h2>
        <p>You agree not to:</p>
        <ul className="list-disc pl-6 mt-3 space-y-1.5">
          <li>
            Submit information about a property you do not own or have
            authority to obtain an estimate for
          </li>
          <li>
            Submit fake, scraped, or automated requests, or attempt to
            overwhelm the platform with traffic
          </li>
          <li>
            Use any imagery, estimate, or other output for any purpose
            other than evaluating roofing services for the property
            you requested
          </li>
          <li>
            Reverse-engineer, scrape, or otherwise extract data from
            the platform&apos;s pages or APIs
          </li>
        </ul>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Intellectual property
        </h2>
        <p>
          The platform, including the AI model output, page design,
          and underlying code, is owned by Voxaris and protected by
          applicable copyright and trademark law. Partner contractors
          may use the estimate delivered to them in the course of
          providing services to you; they do not receive a license to
          the platform itself. Satellite imagery is provided by
          third parties (Google Maps Platform and others) under their
          own terms.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Disclaimers
        </h2>
        <p className="uppercase text-[12px] leading-[1.6] tracking-wide text-slate-300">
          The platform is provided &ldquo;as is&rdquo; and &ldquo;as
          available.&rdquo; Voxaris disclaims all warranties, express
          or implied, including merchantability, fitness for a
          particular purpose, and non-infringement. Estimates are not
          binding offers and do not constitute professional advice.
          Roofing work performed by a partner contractor is governed
          by your direct agreement with that contractor.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Limitation of liability
        </h2>
        <p className="uppercase text-[12px] leading-[1.6] tracking-wide text-slate-300">
          To the maximum extent permitted by law, Voxaris&apos;s
          liability for any claim arising out of or related to your
          use of the platform is limited to the greater of $100 or
          the amounts Voxaris has received from you in the prior 12
          months (typically zero, because the platform is free to
          homeowners). Voxaris is not liable for any indirect,
          incidental, special, consequential, or punitive damages,
          including loss of profits, business, or data.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Governing law and disputes
        </h2>
        <p>
          These Terms are governed by the laws of the State of Florida
          without regard to its conflict-of-laws principles. Any
          dispute will be resolved by binding arbitration in Orange
          County, Florida, under the American Arbitration
          Association&apos;s Consumer Arbitration Rules — except that
          either party may bring a claim in small-claims court for
          eligible matters. You may opt out of arbitration within
          30 days of first using the platform by emailing{" "}
          <a href="mailto:legal@voxaris.io" className="text-cy-300 hover:underline">
            legal@voxaris.io
          </a>
          .
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Changes
        </h2>
        <p>
          We may update these Terms over time. Material changes will
          be reflected in the &ldquo;Last updated&rdquo; date and,
          where required, communicated to users with an active
          inquiry. Continued use of the platform after a change
          constitutes acceptance of the revised Terms.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Contact
        </h2>
        <p>
          Legal:{" "}
          <a href="mailto:legal@voxaris.io" className="text-cy-300 hover:underline">
            legal@voxaris.io
          </a>
          <br />
          Support:{" "}
          <a href="mailto:support@voxaris.io" className="text-cy-300 hover:underline">
            support@voxaris.io
          </a>
        </p>
      </section>
    </div>
  );
}
