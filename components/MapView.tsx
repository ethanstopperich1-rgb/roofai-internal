"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";
import { Satellite, Eye, Pencil, X } from "lucide-react";

export interface PenetrationMarker {
  kind: string;
  /** Pixel coords on the 640×640 zoom-20 satellite tile that vision analyzed */
  x: number;
  y: number;
  approxSizeFt?: number;
}

interface Props {
  lat?: number;
  lng?: number;
  address?: string;
  /** Source roof polygons (Solar API / OSM / Claude). MapView draws these
   *  initially. User edits don't come back through this prop — they bubble
   *  up via onPolygonsChanged so we don't enter a redraw loop. */
  segments?: Array<Array<{ lat: number; lng: number }>>;
  /** Penetrations from Claude vision (rendered as numbered circles) */
  penetrations?: PenetrationMarker[];
  /** Optional badges shown over the satellite map */
  metaBadges?: string[];
  /** When true, polygons are editable — rep can drag vertices, add/remove
   *  points by right-clicking. Each edit fires onPolygonsChanged with the
   *  new state of all polygons. */
  editable?: boolean;
  /** Fired when the rep edits any polygon vertex. Receives the full
   *  current state of all polygons (after the edit). */
  onPolygonsChanged?: (
    polygons: Array<Array<{ lat: number; lng: number }>>,
  ) => void;
  /** Average roof pitch in degrees (from Solar API). When provided, the
   *  floating sqft labels project footprint → slope area using cos(pitch)
   *  instead of the hardcoded 6/12 default. */
  pitchDegrees?: number | null;
}

/**
 * Pixel coords on the 640×640 zoom-20 tile → lat/lng we can drop a marker at.
 */
function pixelToLatLng(opts: {
  x: number;
  y: number;
  centerLat: number;
  centerLng: number;
  imgSize?: number;
  zoom?: number;
}): { lat: number; lng: number } {
  const { x, y, centerLat, centerLng, imgSize = 640, zoom = 20 } = opts;
  const mPerPx =
    (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) / Math.pow(2, zoom);
  const dx = x - imgSize / 2;
  const dy = y - imgSize / 2;
  const dLatDeg = (-dy * mPerPx) / 111_320;
  const dLngDeg =
    (dx * mPerPx) / (111_320 * Math.cos((centerLat * Math.PI) / 180));
  return { lat: centerLat + dLatDeg, lng: centerLng + dLngDeg };
}

export default function MapView({
  lat,
  lng,
  address,
  segments,
  penetrations,
  metaBadges,
  editable = false,
  onPolygonsChanged,
  pitchDegrees,
}: Props) {
  // Stable ref to the latest callback so we don't have to re-bind polygon
  // event listeners every render.
  const onPolygonsChangedRef = useRef(onPolygonsChanged);
  onPolygonsChangedRef.current = onPolygonsChanged;
  const mapEl = useRef<HTMLDivElement>(null);
  const svEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const svRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const polysRef = useRef<google.maps.Polygon[]>([]);
  const penMarkersRef = useRef<google.maps.Marker[]>([]);
  const labelMarkersRef = useRef<google.maps.Marker[]>([]);
  const animTimersRef = useRef<number[]>([]);
  const drawingManagerRef = useRef<google.maps.drawing.DrawingManager | null>(null);
  const drawingListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const [svUnavailable, setSvUnavailable] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [drawing, setDrawing] = useState(false);

  // Cleanup the DrawingManager (and its event listener) without touching
  // anything else. Called when the user cancels OR completes a draw.
  const cleanupDrawing = useCallback(() => {
    if (drawingListenerRef.current) {
      drawingListenerRef.current.remove();
      drawingListenerRef.current = null;
    }
    if (drawingManagerRef.current) {
      drawingManagerRef.current.setMap(null);
      drawingManagerRef.current = null;
    }
    setDrawing(false);
  }, []);

  // "Draw fresh" — wipe existing polygon(s) and enter click-to-trace mode.
  // Use Google's DrawingManager (loaded via the "drawing" library, see
  // lib/google.ts). On polygoncomplete we capture vertices, hand them up
  // via onPolygonsChanged, and convert the just-drawn drawing-manager
  // polygon into a regular editable polygon so the rep can immediately
  // adjust corners.
  const startDrawing = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const g = await loadGoogle();
    if (!g.maps.drawing) return;

    // Clear any existing rendered polygons + sqft labels so the canvas is fresh.
    for (const p of polysRef.current) p.setMap(null);
    polysRef.current = [];
    for (const lm of labelMarkersRef.current) lm.setMap(null);
    labelMarkersRef.current = [];
    for (const t of animTimersRef.current) window.clearTimeout(t);
    animTimersRef.current = [];

    if (drawingManagerRef.current) {
      drawingManagerRef.current.setMap(null);
      drawingManagerRef.current = null;
    }

    const dm = new g.maps.drawing.DrawingManager({
      drawingMode: g.maps.drawing.OverlayType.POLYGON,
      drawingControl: false,
      polygonOptions: {
        strokeColor: "#67dcff",
        strokeWeight: 2.5,
        strokeOpacity: 0.95,
        fillColor: "#38c5ee",
        fillOpacity: 0.22,
        editable: true,
        clickable: true,
        zIndex: 5,
      },
    });
    dm.setMap(map);
    drawingManagerRef.current = dm;
    setDrawing(true);

    drawingListenerRef.current = g.maps.event.addListener(
      dm,
      "polygoncomplete",
      (poly: google.maps.Polygon) => {
        // Treat the drawn polygon as a regular vertex-editable polygon.
        polysRef.current.push(poly);
        const path = poly.getPath();
        const broadcast = () => {
          if (!onPolygonsChangedRef.current) return;
          const next = polysRef.current.map((p) => {
            const arr: Array<{ lat: number; lng: number }> = [];
            p.getPath().forEach((v) => arr.push({ lat: v.lat(), lng: v.lng() }));
            return arr;
          });
          onPolygonsChangedRef.current(next);
        };
        path.addListener("set_at", broadcast);
        path.addListener("insert_at", broadcast);
        path.addListener("remove_at", broadcast);
        broadcast();
        cleanupDrawing();
      },
    );
  }, [cleanupDrawing]);

  // Tear down drawing on unmount so we don't leak listeners
  useEffect(() => () => cleanupDrawing(), [cleanupDrawing]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) return;
    if (lat == null || lng == null) return;
    const pos = { lat, lng };
    loadGoogle().then((g) => {
      if (!mapEl.current || !svEl.current) return;
      if (!mapRef.current) {
        mapRef.current = new g.maps.Map(mapEl.current, {
          center: pos,
          zoom: 20,
          mapTypeId: "satellite",
          tilt: 0,
          disableDefaultUI: true,
          // Pan / zoom enabled — reps need to look at neighbor reference
          // points and zoom in to verify polygon vertex placement on tricky
          // properties. Polygon vertex drag events still bubble correctly
          // because we never set gestureHandling: "none".
          keyboardShortcuts: false,
          clickableIcons: false,
          draggable: true,
          zoomControl: true,
          scrollwheel: true,
          disableDoubleClickZoom: false,
        });
      } else {
        mapRef.current.setCenter(pos);
        mapRef.current.setZoom(20);
      }
      setMapReady(true);
      if (markerRef.current) markerRef.current.setMap(null);
      markerRef.current = new g.maps.Marker({ position: pos, map: mapRef.current });

      // Probe Street View coverage before we try to render — many rural
      // residential roads have no panorama at all and would otherwise
      // show as a black tile with no explanation.
      const svc = new g.maps.StreetViewService();
      svc
        .getPanorama({ location: pos, radius: 75, source: g.maps.StreetViewSource.OUTDOOR })
        .then(({ data }) => {
          setSvUnavailable(false);
          const panoPos = data.location?.latLng ?? pos;
          if (!svRef.current) {
            svRef.current = new g.maps.StreetViewPanorama(svEl.current!, {
              position: panoPos,
              pov: { heading: 0, pitch: 0 },
              visible: true,
              disableDefaultUI: true,
              addressControl: false,
            });
          } else {
            svRef.current.setPosition(panoPos);
            svRef.current.setVisible(true);
          }
        })
        .catch(() => {
          // No coverage within 75m — fall back to the "unavailable" overlay
          setSvUnavailable(true);
          if (svRef.current) svRef.current.setVisible(false);
        });

      // Clear previous polygons, sqft labels, and any in-flight animation timers
      for (const p of polysRef.current) p.setMap(null);
      polysRef.current = [];
      for (const lm of labelMarkersRef.current) lm.setMap(null);
      labelMarkersRef.current = [];
      for (const t of animTimersRef.current) window.clearTimeout(t);
      animTimersRef.current = [];

      if (segments && segments.length && mapRef.current) {
        // Cool palette so multi-facet roofs read as visually distinct
        // without screaming "rainbow." Single-polygon source uses [0].
        const PALETTE: Array<{ stroke: string; fill: string }> = [
          { stroke: "#67dcff", fill: "#38c5ee" }, // cyan
          { stroke: "#5fe3b0", fill: "#34c89a" }, // mint
          { stroke: "#c8a4ff", fill: "#a883e6" }, // lavender
          { stroke: "#ffc878", fill: "#e0a14c" }, // gold
          { stroke: "#ffa8d9", fill: "#e688be" }, // pink
          { stroke: "#88e6ff", fill: "#5cc7ed" }, // sky
        ];
        const FILL_TARGET = 0.22;
        const STROKE_TARGET = 0.95;
        const ANIM_MS = 520;
        const STAGGER_MS = 70;

        const broadcast = () => {
          if (!onPolygonsChangedRef.current) return;
          const next = polysRef.current.map((p) => {
            const arr: Array<{ lat: number; lng: number }> = [];
            p.getPath().forEach((v) => arr.push({ lat: v.lat(), lng: v.lng() }));
            return arr;
          });
          onPolygonsChangedRef.current(next);
        };

        segments.forEach((path, idx) => {
          if (!path || path.length < 3) return;
          const palette = PALETTE[idx % PALETTE.length];
          const poly = new g.maps.Polygon({
            paths: path,
            strokeColor: palette.stroke,
            strokeOpacity: 0,
            strokeWeight: 2,
            fillColor: palette.fill,
            fillOpacity: 0,
            clickable: editable,
            editable: editable,
            // editable polygons get a slightly heavier stroke so the drag
            // handles read against the imagery
            ...(editable && { strokeWeight: 2.5 }),
            map: mapRef.current!,
          });
          polysRef.current.push(poly);

          // Wire vertex-edit events when in editable mode. Google fires
          // set_at on drag-end, insert_at on right-click insert, remove_at
          // on right-click delete.
          if (editable) {
            const path = poly.getPath();
            path.addListener("set_at", broadcast);
            path.addListener("insert_at", broadcast);
            path.addListener("remove_at", broadcast);
          }

          // Animate stroke + fill from 0 → target with staggered start so
          // multi-facet roofs trace in sequence (looks like AI scanning).
          const startDelay = idx * STAGGER_MS;
          const start = Date.now() + startDelay;
          const tick = () => {
            const elapsed = Date.now() - start;
            const t = Math.max(0, Math.min(1, elapsed / ANIM_MS));
            // ease-out cubic
            const eased = 1 - Math.pow(1 - t, 3);
            poly.setOptions({
              strokeOpacity: eased * STROKE_TARGET,
              fillOpacity: eased * FILL_TARGET,
            });
            if (t < 1) {
              const id = window.setTimeout(tick, 16);
              animTimersRef.current.push(id);
            }
          };
          const startId = window.setTimeout(tick, startDelay);
          animTimersRef.current.push(startId);

          // Floating sqft label at polygon centroid (after animation finishes)
          if (g.maps.geometry?.spherical) {
            const areaM2 = g.maps.geometry.spherical.computeArea(path);
            // Project polygon footprint → roof surface area using the real
            // pitch when Solar gave us one; otherwise fall back to 6/12
            // (1 / cos(26.57°) ≈ 1.118).
            const slopeMult =
              pitchDegrees != null && pitchDegrees > 0 && pitchDegrees < 60
                ? 1 / Math.cos((pitchDegrees * Math.PI) / 180)
                : 1.118;
            const sqft = Math.round(areaM2 * 10.7639 * slopeMult);
            if (sqft >= 200) {
              let cLat = 0, cLng = 0;
              for (const v of path) { cLat += v.lat; cLng += v.lng; }
              cLat /= path.length; cLng /= path.length;

              // Custom inline-SVG label that matches the polygon palette.
              const label = `${sqft.toLocaleString()} sf`;
              const textW = label.length * 7.2 + 18;
              const svg = `
                <svg xmlns='http://www.w3.org/2000/svg' width='${textW}' height='22'>
                  <rect x='0' y='0' width='${textW}' height='22' rx='11' ry='11'
                        fill='rgba(7,9,13,0.78)' stroke='${palette.stroke}' stroke-opacity='0.55' stroke-width='1' />
                  <text x='${textW / 2}' y='15' text-anchor='middle'
                        font-family='ui-monospace,SFMono-Regular,monospace' font-size='11' font-weight='600'
                        fill='${palette.stroke}'>${label}</text>
                </svg>
              `;
              const labelDelay = startDelay + ANIM_MS;
              const labelId = window.setTimeout(() => {
                const lm = new g.maps.Marker({
                  position: { lat: cLat, lng: cLng },
                  map: mapRef.current!,
                  clickable: false,
                  icon: {
                    url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
                    anchor: new g.maps.Point(textW / 2, 11),
                  },
                  zIndex: 9999,
                });
                labelMarkersRef.current.push(lm);
              }, labelDelay);
              animTimersRef.current.push(labelId);
            }
          }
        });
      }

    });
  }, [lat, lng, segments, pitchDegrees]);

  // Penetration markers in their OWN effect — when filteredPenetrations
  // changes (e.g. because user drew/edited a polygon and the inside-polygon
  // filter recomputed), only these markers update. The main useEffect
  // above no longer fires for penetration changes, so manually-drawn
  // polygons survive the re-render.
  useEffect(() => {
    if (lat == null || lng == null) return;
    if (!mapRef.current) return;
    loadGoogle().then((g) => {
      for (const m of penMarkersRef.current) m.setMap(null);
      penMarkersRef.current = [];
      if (!penetrations || penetrations.length === 0 || !mapRef.current) return;
      penetrations.forEach((p, idx) => {
        const ll = pixelToLatLng({
          x: p.x,
          y: p.y,
          centerLat: lat,
          centerLng: lng,
        });
        const marker = new g.maps.Marker({
          position: ll,
          map: mapRef.current!,
          label: {
            text: String(idx + 1),
            color: "#0a0d12",
            fontSize: "11px",
            fontWeight: "700",
          },
          title: `${p.kind}${p.approxSizeFt ? ` (~${p.approxSizeFt}ft)` : ""}`,
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: 9,
            fillColor: "#f3b14b",
            fillOpacity: 0.92,
            strokeColor: "#0a0d12",
            strokeWeight: 2,
          },
        });
        penMarkersRef.current.push(marker);
      });
    });
  }, [penetrations, lat, lng]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) {
    return (
      <div className="glass rounded-3xl h-full min-h-[280px] flex items-center justify-center text-slate-400 text-[13px] p-6 text-center">
        Set <code className="kbd mx-1">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> to enable map.
      </div>
    );
  }

  const ready = lat != null && lng != null;
  return (
    <div className="grid grid-rows-[2.4fr_1fr] gap-3 h-full">
      <Tile
        ready={ready}
        elRef={mapEl}
        address={address}
        icon={<Satellite size={14} />}
        emptyTitle="Satellite View"
        emptyBody="Pick an address to load high-resolution satellite imagery"
      >
        {ready && mapReady && (
          <div className="absolute top-2 right-2 z-10">
            {drawing ? (
              <button
                onClick={cleanupDrawing}
                className="rounded-full border border-rose/30 bg-rose/[0.15] hover:bg-rose/[0.22] text-rose px-2.5 py-1 text-[11px] font-mono uppercase tracking-[0.10em] backdrop-blur-md flex items-center gap-1.5"
                title="Cancel drawing — to commit, click your FIRST corner again"
              >
                <X size={11} /> Cancel · click 1st corner to close
              </button>
            ) : (
              <button
                onClick={startDrawing}
                className="rounded-full border border-white/15 bg-black/65 hover:bg-black/85 text-white/90 px-2.5 py-1 text-[11px] font-mono uppercase tracking-[0.10em] backdrop-blur-md flex items-center gap-1.5"
                title="Clear and draw a new polygon by clicking corners"
              >
                <Pencil size={11} /> Draw fresh
              </button>
            )}
          </div>
        )}
        {ready && metaBadges && metaBadges.length > 0 && (
          <div className="pointer-events-none absolute left-2 bottom-2 flex flex-wrap gap-1 max-w-[calc(100%-1rem)]">
            {metaBadges.map((b, i) => (
              <span
                key={i}
                className="rounded-full border border-white/15 bg-black/65 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.10em] text-white/85 backdrop-blur"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </Tile>
      <Tile
        ready={ready}
        elRef={svEl}
        address={address}
        icon={<Eye size={14} />}
        emptyTitle="Street View"
        emptyBody="On-the-ground panorama of the property"
      >
        {ready && svUnavailable && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-black/60 backdrop-blur-sm">
            <div className="w-8 h-8 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-400 mb-3">
              <Eye size={14} />
            </div>
            <div className="font-display text-[13px] font-semibold tracking-tight text-slate-200">
              Street View unavailable
            </div>
            <div className="text-[11.5px] text-slate-500 mt-1 max-w-[260px] leading-relaxed">
              Google hasn't driven this road. Common for rural and gated properties.
            </div>
          </div>
        )}
      </Tile>
    </div>
  );
}

function Tile({
  ready,
  elRef,
  address,
  icon,
  emptyTitle,
  emptyBody,
  children,
}: {
  ready: boolean;
  elRef: React.RefObject<HTMLDivElement | null>;
  address?: string;
  icon: React.ReactNode;
  emptyTitle: string;
  emptyBody: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative rounded-2xl overflow-hidden border border-white/[0.07] bg-black/30">
      <div ref={elRef} className="absolute inset-0" aria-label={address} />
      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
          <div className="w-8 h-8 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-slate-500 mb-3">
            {icon}
          </div>
          <div className="font-display text-[13px] font-semibold tracking-tight text-slate-300">
            {emptyTitle}
          </div>
          <div className="text-[11.5px] text-slate-500 mt-1 max-w-[220px] leading-relaxed">
            {emptyBody}
          </div>
        </div>
      )}
      {ready && (
        <div className="absolute top-2.5 left-2.5 z-10 chip chip-accent backdrop-blur-md bg-[#07090d]/60">
          {icon}
        </div>
      )}
      {children}
    </div>
  );
}
