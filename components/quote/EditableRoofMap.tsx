"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";
import { Pencil, RotateCcw, MousePointerClick, Square, Loader2 } from "lucide-react";

interface Props {
  lat: number;
  lng: number;
  /** Auto-detected polygon to show as the starting outline. Customer
   *  can drag vertices to correct it; "Reset" reverts to this polygon. */
  initialPolygon: Array<{ lat: number; lng: number }> | null;
  /** Fired whenever the customer modifies the polygon (drag, add, or
   *  remove a vertex, or completes a manual draw). Receives the new
   *  vertex list. */
  onPolygonChanged?: (poly: Array<{ lat: number; lng: number }>) => void;
  /** Fired when the customer toggles "Wrong roof? Tap your house" and
   *  then taps a building on the map. Receives the tapped lat/lng.
   *  Parent is responsible for forwarding to /api/sam3-roof with
   *  ?clickLat=&clickLng= and updating `initialPolygon` with the
   *  re-traced result. While null, the button is hidden. */
  onClickPick?: (clickLat: number, clickLng: number) => void;
  /** True while the parent is fetching a re-traced polygon after a
   *  click-pick. Disables both buttons and shows a spinner so the
   *  customer doesn't tap repeatedly. */
  pickingLoading?: boolean;
  /** Read-only facet-by-facet outlines from RoofData.facets[].polygon.
   *  When provided AND the editable polygon is unedited, these render
   *  underneath the editable polygon at low opacity so the customer
   *  sees the per-facet structure (ridges, hip lines, dormers) rather
   *  than a single flat outline. Hidden during picking/drawing modes
   *  and once the customer starts editing. Strictly visual — no
   *  interaction, no impact on sqft / pricing. */
  facetOverlay?: Array<Array<{ lat: number; lng: number }>> | null;
}

/**
 * Customer-facing satellite map with an editable roof polygon.
 *
 * Three customer modes:
 *   • idle (default) — auto-detected polygon shown, drag vertices to
 *     fine-tune, Reset restores the auto trace.
 *   • picking — "Wrong roof? Tap your house". Cursor flips to crosshair,
 *     a tap on any building fires onClickPick which the parent
 *     forwards to /api/sam3-roof for a fresh trace.
 *   • drawing — "Draw outline myself". Customer click-traces the
 *     polygon corner-by-corner. The drawn polygon replaces the
 *     existing one (no merge).
 *
 * Differs from the rep-side `MapView` in deliberate ways:
 *   • No Street View pane (customer doesn't need it for self-service)
 *   • One polygon only — no multi-source palette
 *   • Reset button restores the auto-detected polygon if they edit
 *     too far
 *   • Cost-bounded: picking/drawing are gated behind explicit button
 *     presses so accidental map clicks don't fire SAM3 retraces
 */
export default function EditableRoofMap({
  lat,
  lng,
  initialPolygon,
  onPolygonChanged,
  onClickPick,
  pickingLoading = false,
  facetOverlay = null,
}: Props) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const polyRef = useRef<google.maps.Polygon | null>(null);
  // Read-only facet polygons rendered beneath the editable polygon.
  // Cleared and recreated whenever facetOverlay changes.
  const facetPolysRef = useRef<google.maps.Polygon[]>([]);
  const drawingManagerRef = useRef<google.maps.drawing.DrawingManager | null>(null);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const callbackRef = useRef(onPolygonChanged);
  callbackRef.current = onPolygonChanged;
  const clickPickRef = useRef(onClickPick);
  clickPickRef.current = onClickPick;

  // Snapshot of the auto-detected polygon for the Reset button.
  const initialRef = useRef(initialPolygon);
  initialRef.current = initialPolygon;

  const [ready, setReady] = useState(false);
  // UI mode. Mutually exclusive — toggling one resets the other.
  const [mode, setMode] = useState<"idle" | "picking" | "drawing">("idle");
  // Track the latest mode in a ref so the click listener (created once
  // when picking starts) can short-circuit if the user already moved on.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Initialise the map once per mount. Cleanup releases the map ref on
  // unmount — required because Next has reactStrictMode: true, so this
  // effect runs mount → cleanup → mount again on every dev render. Without
  // releasing mapRef on cleanup, the second mount finds the orphaned first
  // map (attached to a removed div) and skips creating a fresh one,
  // leaving the new mapEl div empty and no polygon ever drawn.
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) return;
    if (lat == null || lng == null) return;
    let cancelled = false;
    loadGoogle().then((g) => {
      if (cancelled || !mapEl.current) return;
      const pos = { lat, lng };
      // Always create a fresh map on this mount's div. We can't safely
      // re-attach a Maps instance to a different DOM element, so per-
      // mount creation is the simplest correct behaviour.
      mapRef.current = new g.maps.Map(mapEl.current, {
        center: pos,
        zoom: 20,
        mapTypeId: "satellite",
        tilt: 0,
        disableDefaultUI: true,
        keyboardShortcuts: false,
        clickableIcons: false,
        draggable: true,
        zoomControl: true,
        scrollwheel: true,
        disableDoubleClickZoom: false,
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      if (clickListenerRef.current) {
        clickListenerRef.current.remove();
        clickListenerRef.current = null;
      }
      if (drawingManagerRef.current) {
        drawingManagerRef.current.setMap(null);
        drawingManagerRef.current = null;
      }
      if (polyRef.current) {
        polyRef.current.setMap(null);
        polyRef.current = null;
      }
      for (const fp of facetPolysRef.current) fp.setMap(null);
      facetPolysRef.current = [];
      mapRef.current = null;
      setReady(false);
    };
  }, [lat, lng]);

  // Read-only facet overlay (per-facet polygons under the editable
  // outline). Renders only in idle mode — hidden during picking/drawing
  // so the customer focuses on the single overlay they're editing.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;
    // Always clear prior facet polygons before re-rendering.
    for (const fp of facetPolysRef.current) fp.setMap(null);
    facetPolysRef.current = [];
    if (mode !== "idle") return;
    if (!facetOverlay || facetOverlay.length === 0) return;
    void loadGoogle().then((g) => {
      if (!map) return;
      for (const facet of facetOverlay) {
        if (!facet || facet.length < 3) continue;
        const fp = new g.maps.Polygon({
          paths: facet,
          // Slightly darker stroke than the editable polygon so facet
          // lines read as "structure" rather than competing edits.
          strokeColor: "#1aa3d6",
          strokeOpacity: 0.85,
          strokeWeight: 1.5,
          fillColor: "#38c5ee",
          fillOpacity: 0.08,
          editable: false,
          clickable: false,
          zIndex: 2,
          map,
        });
        facetPolysRef.current.push(fp);
      }
    });
  }, [ready, facetOverlay, mode]);

  // Render / re-render the polygon when initialPolygon changes.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;
    if (polyRef.current) {
      polyRef.current.setMap(null);
      polyRef.current = null;
    }
    if (!initialPolygon || initialPolygon.length < 3) return;

    void loadGoogle().then((g) => {
      if (!map) return;
      const poly = new g.maps.Polygon({
        paths: initialPolygon,
        strokeColor: "#67dcff",
        strokeOpacity: 0.95,
        strokeWeight: 3,
        fillColor: "#38c5ee",
        fillOpacity: 0.22,
        editable: true,
        clickable: true,
        zIndex: 5,
        map,
      });
      polyRef.current = poly;
      const path = poly.getPath();
      const broadcast = () => {
        const arr: Array<{ lat: number; lng: number }> = [];
        path.forEach((v) => arr.push({ lat: v.lat(), lng: v.lng() }));
        callbackRef.current?.(arr);
      };
      path.addListener("set_at", broadcast);
      path.addListener("insert_at", broadcast);
      path.addListener("remove_at", broadcast);
    });
  }, [initialPolygon, ready]);

  // Picking mode: install map click listener + flip cursor + stop the
  // polygon from eating clicks. Cleanup restores everything on exit.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;
    if (mode !== "picking") {
      // Restore default cursor + polygon interactivity.
      map.setOptions({ draggableCursor: null, draggingCursor: null });
      if (polyRef.current) {
        polyRef.current.setOptions({ clickable: true, editable: true });
      }
      if (clickListenerRef.current) {
        clickListenerRef.current.remove();
        clickListenerRef.current = null;
      }
      return;
    }
    // Enter pick mode.
    map.setOptions({ draggableCursor: "crosshair", draggingCursor: "crosshair" });
    // Make the polygon non-interactive so taps pass through to the
    // underlying map. Without this, tapping inside the wrong-building
    // polygon (the common case) never fires the map click handler.
    if (polyRef.current) {
      polyRef.current.setOptions({ clickable: false, editable: false });
    }
    clickListenerRef.current = map.addListener(
      "click",
      (e: google.maps.MapMouseEvent) => {
        if (modeRef.current !== "picking") return;
        if (!e.latLng) return;
        const cb = clickPickRef.current;
        if (cb) cb(e.latLng.lat(), e.latLng.lng());
        // Snap back to idle once the click registers. The parent will
        // flow new polygon data via initialPolygon after its fetch.
        setMode("idle");
      },
    );
    return () => {
      if (clickListenerRef.current) {
        clickListenerRef.current.remove();
        clickListenerRef.current = null;
      }
    };
  }, [mode, ready]);

  // Drawing mode: spawn a DrawingManager pre-configured for polygons.
  // On completion, replace the existing polygon with the drawn one and
  // exit drawing mode.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;
    if (mode !== "drawing") {
      if (drawingManagerRef.current) {
        drawingManagerRef.current.setMap(null);
        drawingManagerRef.current = null;
      }
      // Show existing polygon again if drawing was cancelled.
      if (polyRef.current) polyRef.current.setVisible(true);
      return;
    }
    // Hide the existing polygon while drawing so it doesn't visually
    // compete with the new outline being traced.
    if (polyRef.current) polyRef.current.setVisible(false);
    void loadGoogle().then((g) => {
      if (!mapRef.current) return;
      const dm = new g.maps.drawing.DrawingManager({
        drawingMode: g.maps.drawing.OverlayType.POLYGON,
        drawingControl: false,
        polygonOptions: {
          strokeColor: "#67dcff",
          strokeOpacity: 0.95,
          strokeWeight: 3,
          fillColor: "#38c5ee",
          fillOpacity: 0.22,
          editable: true,
          clickable: true,
          zIndex: 5,
        },
      });
      dm.setMap(mapRef.current);
      drawingManagerRef.current = dm;
      g.maps.event.addListenerOnce(dm, "polygoncomplete", (poly: google.maps.Polygon) => {
        // Replace the existing polygon. Detach the old one and adopt
        // the just-drawn one — same vertex-edit wiring as the
        // initialPolygon path.
        if (polyRef.current) polyRef.current.setMap(null);
        polyRef.current = poly;
        // Tear down the drawing manager once a polygon is captured so
        // a stray second drag doesn't add another shape.
        dm.setMap(null);
        drawingManagerRef.current = null;

        const path = poly.getPath();
        const broadcast = () => {
          const arr: Array<{ lat: number; lng: number }> = [];
          path.forEach((v) => arr.push({ lat: v.lat(), lng: v.lng() }));
          callbackRef.current?.(arr);
        };
        path.addListener("set_at", broadcast);
        path.addListener("insert_at", broadcast);
        path.addListener("remove_at", broadcast);
        // Initial broadcast so the parent picks up the new sqft.
        broadcast();

        setMode("idle");
      });
    });
  }, [mode, ready]);

  const handleReset = () => {
    const map = mapRef.current;
    if (!map || !initialRef.current || initialRef.current.length < 3) return;
    if (polyRef.current) {
      polyRef.current.setMap(null);
      polyRef.current = null;
    }
    void loadGoogle().then((g) => {
      const poly = new g.maps.Polygon({
        paths: initialRef.current!,
        strokeColor: "#67dcff",
        strokeOpacity: 0.95,
        strokeWeight: 3,
        fillColor: "#38c5ee",
        fillOpacity: 0.22,
        editable: true,
        clickable: true,
        zIndex: 5,
        map,
      });
      polyRef.current = poly;
      const path = poly.getPath();
      const broadcast = () => {
        const arr: Array<{ lat: number; lng: number }> = [];
        path.forEach((v) => arr.push({ lat: v.lat(), lng: v.lng() }));
        callbackRef.current?.(arr);
      };
      path.addListener("set_at", broadcast);
      path.addListener("insert_at", broadcast);
      path.addListener("remove_at", broadcast);
      callbackRef.current?.(initialRef.current!);
    });
  };

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-500 text-[12px] p-6 text-center">
        Map preview unavailable.
      </div>
    );
  }

  // Help-pill copy varies by mode. Each is single-line and addressed
  // directly to the customer ("your house") — avoids "polygon" or other
  // tool jargon.
  const helpText =
    mode === "picking"
      ? "Tap your house on the satellite"
      : mode === "drawing"
        ? "Click each corner of your roof, double-click to close"
        : initialPolygon && initialPolygon.length >= 3
          ? "Drag dots to fit your roof"
          : "Draw your roof outline below";

  // Whether the auto-detected polygon ever landed. Some controls only
  // make sense after at least one polygon exists.
  const hasInitial = initialPolygon != null && initialPolygon.length >= 3;
  const disabled = pickingLoading;

  return (
    <div className="relative w-full h-full">
      <div
        ref={mapEl}
        className="absolute inset-0 rounded-2xl overflow-hidden"
        aria-label="Editable roof map"
      />
      {ready && (
        <>
          <div className="pointer-events-none absolute top-3 left-3 rounded-full border border-white/15 bg-black/65 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-white/90 backdrop-blur-md flex items-center gap-2 max-w-[calc(100%-1.5rem)]">
            {pickingLoading ? (
              <Loader2 size={11} className="animate-spin" />
            ) : mode === "picking" ? (
              <MousePointerClick size={11} />
            ) : mode === "drawing" ? (
              <Square size={11} />
            ) : (
              <Pencil size={11} />
            )}
            <span className="truncate">{pickingLoading ? "Re-tracing…" : helpText}</span>
          </div>

          {/* Action buttons — top-right cluster. Stacks vertically on
              narrow screens via flex-wrap so a long button label
              doesn't push another button off-screen. */}
          <div className="absolute top-3 right-3 flex flex-wrap gap-2 justify-end max-w-[60%]">
            {/* Reset — only when an auto-detected polygon exists and
                we're idle. Drawing/picking modes have their own cancel. */}
            {hasInitial && mode === "idle" && (
              <button
                type="button"
                onClick={handleReset}
                className="rounded-full border border-white/15 bg-black/65 hover:bg-black/85 text-white/90 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.10em] backdrop-blur-md flex items-center gap-1.5 disabled:opacity-40"
                title="Restore auto-detected outline"
                disabled={disabled}
              >
                <RotateCcw size={11} /> Reset
              </button>
            )}
            {/* Wrong roof — only when we have an auto-detected polygon
                (otherwise there's nothing to fix yet) AND the parent
                wired onClickPick. Styled to match Reset/Draw (solid
                dark backdrop for readability against any satellite
                tile) with a brighter cyan accent so it still reads as
                "fix this" vs the neutral surrounding buttons. The
                pre-fix styling (cyan-on-cyan at 8-16% opacity) was
                near-invisible on light-toned imagery — Florida sand /
                concrete / pavement washed it out. */}
            {hasInitial && onClickPick && (
              <button
                type="button"
                onClick={() =>
                  setMode((m) => (m === "picking" ? "idle" : "picking"))
                }
                className="rounded-full border border-cy-300/70 bg-black/75 hover:bg-black/90 text-cy-100 px-3 py-1.5 text-[11px] font-mono font-medium uppercase tracking-[0.10em] backdrop-blur-md flex items-center gap-1.5 disabled:opacity-40 shadow-[0_0_0_1px_rgba(103,220,255,0.15),0_2px_8px_-2px_rgba(0,0,0,0.5)]"
                title="Tap a different building to re-trace"
                disabled={disabled}
              >
                <MousePointerClick size={11} />
                {mode === "picking" ? "Cancel" : "Wrong roof?"}
              </button>
            )}
            {/* Draw outline manually — always available (customer can
                use this even if auto-detection completely failed). */}
            <button
              type="button"
              onClick={() =>
                setMode((m) => (m === "drawing" ? "idle" : "drawing"))
              }
              className="rounded-full border border-white/15 bg-black/65 hover:bg-black/85 text-white/90 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.10em] backdrop-blur-md flex items-center gap-1.5 disabled:opacity-40"
              title="Click each corner of your roof"
              disabled={disabled}
            >
              <Square size={11} />
              {mode === "drawing" ? "Cancel" : "Draw outline"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
