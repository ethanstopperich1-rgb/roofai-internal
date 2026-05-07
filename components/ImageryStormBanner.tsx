"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Camera, Calendar, ShieldAlert } from "lucide-react";
import { correlate, type StormEventInput } from "@/lib/imagery-storm-correlation";

interface Props {
  /** Solar API imagery date — ISO YYYY-MM-DD */
  imageryDate: string | null | undefined;
  /** Lat/lng to fetch storms for */
  lat: number | null | undefined;
  lng: number | null | undefined;
}

/**
 * Banner that surfaces ONLY when there's actionable imagery↔storm mismatch:
 * a major storm hit AFTER the satellite imagery was captured. In that case
 * the roof scan UNDERWEIGHTS damage and the rep needs to capture on-site
 * photos to support the claim. Otherwise this banner stays hidden — no
 * "everything's fine" noise.
 */
export default function ImageryStormBanner({ imageryDate, lat, lng }: Props) {
  const [events, setEvents] = useState<StormEventInput[] | null>(null);

  useEffect(() => {
    if (lat == null || lng == null) return;
    // 5mi default — matches the StormHistoryCard's default radius so
    // the imagery-vs-storm warning fires for the same severe-weather
    // exposure window the rep is reading downstairs.
    fetch(`/api/storms?lat=${lat}&lng=${lng}&radiusMiles=5&yearsBack=5`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setEvents(d.events ?? []))
      .catch(() => setEvents([]));
  }, [lat, lng]);

  if (!imageryDate || !events) return null;
  const summary = correlate(imageryDate, events);
  if (summary.status !== "underweighted" || !summary.postImageryEvent) return null;

  const event = summary.postImageryEvent;
  const months = event.daysFromImagery
    ? Math.round(event.daysFromImagery / 30)
    : 0;
  const eventDate = event.date ? new Date(event.date).toLocaleDateString() : "—";
  const imageryDateStr = new Date(imageryDate).toLocaleDateString();
  const isHail = /hail/i.test(event.type);
  const sizeStr = event.magnitude
    ? `${event.magnitude}${isHail ? '"' : " kt"}`
    : "";

  return (
    <div
      className="rounded-2xl border p-4"
      style={{
        background: "rgba(243,177,75,0.06)",
        borderColor: "rgba(243,177,75,0.32)",
      }}
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center text-amber bg-amber/10 border border-amber/30">
          <ShieldAlert size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-display font-semibold tracking-tight text-[14px] text-amber">
            Roof scan may underweight damage — major storm hit after imagery
          </div>
          <div className="text-[12.5px] text-slate-300 mt-1.5 leading-relaxed">
            Satellite imagery was captured{" "}
            <span className="font-mono tabular text-slate-100">{imageryDateStr}</span>
            . A <span className="font-mono tabular text-amber">{sizeStr} {event.type.toLowerCase()}</span> event
            hit{" "}
            <span className="font-mono tabular text-slate-100">{eventDate}</span>{" "}
            ({months > 0 ? `~${months} month${months === 1 ? "" : "s"}` : "shortly"}{" "}
            after the tile was captured). Damage from this storm physically
            exists on the roof but is invisible to the AI scan. Capture on-site
            photos to document the post-storm condition.
          </div>
          <div className="flex items-center gap-3 mt-3 flex-wrap text-[11px] font-mono uppercase tracking-[0.12em] text-slate-400">
            <span className="flex items-center gap-1">
              <Calendar size={10} /> imagery {summary.imageryAgeDays}d old
            </span>
            <span className="text-slate-600">·</span>
            <span className="flex items-center gap-1 text-amber">
              <AlertTriangle size={10} /> {summary.postImageryCount} post-imagery event
              {summary.postImageryCount === 1 ? "" : "s"}
            </span>
            <span className="text-slate-600">·</span>
            <span className="flex items-center gap-1">
              <Camera size={10} /> field photos critical
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
