import { Database, ExternalLink, Layers } from "lucide-react";
import {
  COUNTY_DATA_SOURCES,
  STATEWIDE_FL_PARCELS,
  cadenceLabel,
} from "@/lib/county-data-sources";

/**
 * Parcel + property-appraiser data-source card. Renders the wired
 * counties (Seminole, Orange, Lake, Osceola, Volusia) with their PA
 * homepage, GIS portal, and refresh cadence — so reps know where the
 * canvass list comes from, and prospects on the marketing page see
 * the data spine isn't smoke.
 *
 * Pure data-driven: add a county to lib/county-data-sources.ts and it
 * shows up here automatically.
 */
export default function CountyDataSourcesCard() {
  return (
    <section
      aria-labelledby="county-data-heading"
      className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 sm:p-8"
    >
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-cy-300/30 bg-cy-300/[0.06] p-2.5">
            <Database className="w-5 h-5 text-cy-300" aria-hidden />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 font-mono">
              Data spine
            </div>
            <h3
              id="county-data-heading"
              className="text-[18px] sm:text-[20px] font-display font-semibold tracking-tight text-white mt-1"
            >
              Parcel + property-appraiser feeds
            </h3>
            <p className="text-[13px] text-white/55 mt-1.5 max-w-xl leading-relaxed">
              Every canvass address Voxaris surfaces is anchored to an
              official tax roll — owner name, situs, assessed value,
              parcel polygon. Statewide baseline below, with daily/nightly
              fast feeds layered over our 5 priority counties.
            </p>
          </div>
        </div>
        <div className="text-right whitespace-nowrap">
          <div className="text-[10px] uppercase tracking-[0.16em] text-white/45 font-mono">
            Coverage
          </div>
          <div className="font-mono tabular text-[18px] text-cy-300 mt-1">
            {(STATEWIDE_FL_PARCELS.populationApprox / 1_000_000).toFixed(1)}M
          </div>
          <div className="text-[11px] text-white/45 font-mono tabular">
            residents · {(STATEWIDE_FL_PARCELS.parcelCountApprox / 1_000_000).toFixed(1)}M parcels
          </div>
        </div>
      </header>

      {/* Tier 1 — statewide baseline. Single hero card, sets the floor
          for total coverage. */}
      <div className="mb-3 text-[10px] uppercase tracking-[0.16em] text-white/45 font-mono">
        Tier 1 · Statewide baseline
      </div>
      <div className="mb-6 rounded-xl border border-cy-300/20 bg-gradient-to-br from-cy-300/[0.05] to-cy-300/[0.01] p-5">
        <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="rounded-lg border border-cy-300/30 bg-cy-300/[0.08] p-1.5 mt-0.5">
              <Layers className="w-4 h-4 text-cy-300" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-white">
                {STATEWIDE_FL_PARCELS.name}
              </div>
              <div className="text-[11px] text-white/55">
                {STATEWIDE_FL_PARCELS.publisher}
              </div>
            </div>
          </div>
          <span className="text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded-full text-cy-300 border border-cy-300/30 bg-cy-300/[0.06] whitespace-nowrap">
            {cadenceLabel(STATEWIDE_FL_PARCELS.updateCadence)}
          </span>
        </div>
        <dl className="text-[11.5px] mt-3">
          <SourceRow
            label="Dataset"
            name="FGIO Open Data portal"
            href={STATEWIDE_FL_PARCELS.downloadUrl}
            suffix={STATEWIDE_FL_PARCELS.format.toUpperCase()}
          />
        </dl>
        <p className="text-[11px] text-white/55 mt-3 leading-relaxed">
          All 67 FL counties · {(STATEWIDE_FL_PARCELS.parcelCountApprox / 1_000_000).toFixed(1)}M parcels · normalized schema. {STATEWIDE_FL_PARCELS.notes}
        </p>
      </div>

      <div className="mb-3 text-[10px] uppercase tracking-[0.16em] text-white/45 font-mono">
        Tier 2 · Priority county fast feeds
      </div>

      <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {COUNTY_DATA_SOURCES.map((c) => (
          <li
            key={c.slug}
            className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4 hover:border-cy-300/30 transition-colors"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-white">
                  {c.name} County
                </div>
                <div className="text-[11px] text-white/55 truncate">
                  {c.region}
                </div>
              </div>
              <span className="text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded-full text-cy-300 border border-cy-300/30 bg-cy-300/[0.06] whitespace-nowrap">
                {cadenceLabel(c.updateCadence)}
              </span>
            </div>

            <dl className="text-[11.5px] space-y-1.5 mt-3">
              <SourceRow
                label="Tax roll"
                name={c.propertyAppraiser.name}
                href={c.propertyAppraiser.downloadUrl}
              />
              <SourceRow
                label="GIS / polygons"
                name={c.gis.name}
                href={c.gis.downloadUrl}
                suffix={c.gis.format.toUpperCase()}
              />
            </dl>

            <p className="text-[11px] text-white/45 mt-3 leading-relaxed">
              {c.notes}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-white/40 mt-5 leading-relaxed">
        All sources are public records — Florida Department of Revenue's
        statewide compilation distributed by FGIO at the state level, and
        each county's Property Appraiser + GIS office at the county
        level. Published under Florida's Sunshine Law. No scraping, no
        anti-bot evasion — direct from the open-data portals each agency
        maintains for civic use.
      </p>
    </section>
  );
}

function SourceRow({
  label,
  name,
  href,
  suffix,
}: {
  label: string;
  name: string;
  href: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-white/45 shrink-0">{label}</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-cy-300/85 hover:text-cy-300 truncate"
      >
        <span className="truncate">{name}</span>
        {suffix && (
          <span className="text-[9.5px] font-mono uppercase text-white/45 ml-0.5 shrink-0">
            · {suffix}
          </span>
        )}
        <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
      </a>
    </div>
  );
}
