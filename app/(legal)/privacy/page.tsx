import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy · Voxaris Pitch",
  description: "How Voxaris collects, uses, and protects information from homeowners and partner contractors using the Voxaris Pitch roofing-estimate platform.",
  robots: { index: true, follow: true },
};

// Last updated — bump whenever material changes are made, so the
// header date matches what's actually live. The TCPA / SMS rules
// require the privacy policy to be the version in effect at the time
// of consent; surface the date so a customer can verify.
const LAST_UPDATED = "May 11, 2026";

export default function PrivacyPage() {
  return (
    <div className="text-slate-200 leading-relaxed space-y-8">
      <header>
        <h1 className="font-display text-[42px] sm:text-[56px] font-semibold tracking-[-0.025em] text-slate-50 mb-2">
          Privacy Policy
        </h1>
        <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-slate-500">
          Last updated · {LAST_UPDATED}
        </p>
      </header>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Who we are
        </h2>
        <p>
          Voxaris, Inc. (&ldquo;Voxaris,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) operates the Voxaris Pitch
          roofing-estimate platform at pitch.voxaris.io and the embedded
          quote widgets deployed on partner contractor websites. This
          policy describes what information we collect, how we use it,
          who we share it with, and the choices you have.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Information we collect
        </h2>
        <p>When you request a roofing estimate, we collect:</p>
        <ul className="list-disc pl-6 mt-3 space-y-1.5">
          <li>Your name, phone number, and email address</li>
          <li>The property address you want estimated</li>
          <li>
            Your responses about roof material, preferences, and any
            optional details you provide
          </li>
          <li>
            The fact that you affirmatively consented to receive
            marketing communications (TCPA receipt), and the timestamp
            of that consent
          </li>
          <li>
            Standard web telemetry (IP address, browser, device type,
            referring page, timestamps) used to operate the site,
            prevent abuse, and improve performance
          </li>
        </ul>
        <p className="mt-4">
          We also access public satellite imagery and government storm
          records for the property address you provide. We do not
          collect imagery of the inside of your home, and we do not
          access any data on your device beyond what your browser
          sends with each request.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          How we use information
        </h2>
        <ul className="list-disc pl-6 mt-3 space-y-1.5">
          <li>
            Generate your roofing estimate (measure the roof, identify
            material and complexity, price the work)
          </li>
          <li>
            Deliver the estimate to you and to the partner contractor
            you select
          </li>
          <li>
            Send you the marketing communications you consented to —
            calls, texts, and emails about your estimate and related
            roofing services
          </li>
          <li>
            Operate, troubleshoot, and improve the platform — including
            measuring accuracy of the estimate vs the contractor&apos;s
            final quote so we can improve the model over time
          </li>
          <li>
            Detect and prevent fraud, abuse, and unauthorized access
          </li>
        </ul>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Who we share with
        </h2>
        <p>
          The contractor you pick — and only that contractor — receives
          your estimate request and contact information. We do not sell
          or rent your data to third-party marketing lists. We share
          information with a limited set of service providers strictly
          to operate the platform:
        </p>
        <ul className="list-disc pl-6 mt-3 space-y-1.5">
          <li>
            Cloud hosting (Vercel, Supabase) — where the application
            runs and where your record is stored
          </li>
          <li>
            Communication providers (Twilio, transactional email) —
            for sending the SMS / email you consented to
          </li>
          <li>
            Mapping and imagery (Google Maps Platform) — to look up
            your address and retrieve satellite imagery
          </li>
          <li>
            Analytics and error monitoring (PostHog, Sentry) — to
            understand how the site is used and diagnose failures
          </li>
        </ul>
        <p className="mt-4">
          We may disclose information when legally required (court
          order, subpoena, regulatory request) or when needed to
          investigate fraud or protect the safety of users.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          SMS program
        </h2>
        <p>
          By providing your phone number and checking the consent box,
          you agree to receive automated text messages from Voxaris
          and your selected contractor regarding your estimate and
          related services. Message frequency varies based on your
          inquiry — typically 1&ndash;5 messages per inquiry.{" "}
          <strong className="text-slate-50">
            Message and data rates may apply.
          </strong>{" "}
          Reply <code className="font-mono text-cy-300">STOP</code> to
          unsubscribe at any time. Reply{" "}
          <code className="font-mono text-cy-300">HELP</code> for help
          or contact{" "}
          <a href="mailto:support@voxaris.io" className="text-cy-300 hover:underline">
            support@voxaris.io
          </a>
          . Consent to receive marketing communications is not a
          condition of any purchase.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Your choices
        </h2>
        <ul className="list-disc pl-6 mt-3 space-y-1.5">
          <li>
            <strong className="text-slate-50">Opt out of SMS:</strong>{" "}
            reply STOP to any text. The opt-out is honored immediately
            and is permanent unless you re-enroll.
          </li>
          <li>
            <strong className="text-slate-50">Opt out of email:</strong>{" "}
            use the unsubscribe link in any marketing email, or contact
            support.
          </li>
          <li>
            <strong className="text-slate-50">Access, correct, delete:</strong>{" "}
            email{" "}
            <a href="mailto:privacy@voxaris.io" className="text-cy-300 hover:underline">
              privacy@voxaris.io
            </a>{" "}
            from the address on file with a copy/correction/deletion
            request. We respond within 30 days.
          </li>
          <li>
            <strong className="text-slate-50">California, Colorado, Virginia residents:</strong>{" "}
            you have specific rights under state privacy law (CCPA /
            CPA / VCDPA), including the right to know what data we
            hold, to delete it, and to opt out of any &ldquo;sale&rdquo;
            or &ldquo;sharing&rdquo; of personal information. We do not
            sell personal information.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Data retention
        </h2>
        <p>
          We retain your inquiry and consent record for as long as the
          partner contractor is actively engaged with your estimate,
          plus seven years for legal-compliance and dispute-resolution
          purposes (TCPA cases have long statutes of limitation). After
          that, records are deleted or anonymized.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Security
        </h2>
        <p>
          Records are encrypted in transit (TLS) and at rest. Access is
          restricted to operations staff and the selected contractor.
          We do not store payment-card data — billing for partner
          contractors is handled by a PCI-compliant payment processor.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Children
        </h2>
        <p>
          Voxaris Pitch is intended for property owners 18 or older.
          We do not knowingly collect information from anyone under
          18. If you believe a minor has submitted information,
          contact us and we will delete the record.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Changes
        </h2>
        <p>
          We may revise this policy as the platform evolves. Material
          changes will be reflected in the &ldquo;Last updated&rdquo;
          date at the top and, where required, communicated to active
          users via email.
        </p>
      </section>

      <section>
        <h2 className="font-display text-[24px] font-semibold text-slate-50 mt-10 mb-3">
          Contact
        </h2>
        <p>
          Privacy questions:{" "}
          <a href="mailto:privacy@voxaris.io" className="text-cy-300 hover:underline">
            privacy@voxaris.io
          </a>
          <br />
          General support:{" "}
          <a href="mailto:support@voxaris.io" className="text-cy-300 hover:underline">
            support@voxaris.io
          </a>
        </p>
      </section>
    </div>
  );
}
