"use client";

/**
 * Ground-truth annotation page.
 *
 * Workflow:
 *   1. Type or pick an address → MapView centers on the property at zoom 20
 *      (same imagery the production pipeline runs on).
 *   2. Click "Draw fresh" inside the MapView → click around the actual roof
 *      perimeter → click the first vertex to close.
 *   3. Drag vertices to fine-tune. Right-click a vertex to remove it.
 *   4. Click "Save ground truth" → polygon gets persisted to
 *      scripts/eval-truth/<slug>.json. The eval harness picks these up.
 *
 * This page is dev-only — the save endpoint refuses POSTs in production.
 */

import { useEffect, useState } from "react";
import AddressInput from "@/components/AddressInput";
import MapView from "@/components/MapView";
import type { AddressInfo } from "@/types/estimate";
import { Loader2, Save, CheckCircle2, AlertCircle } from "lucide-react";

interface Existing {
  slug: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  vertices: number;
  savedAt: string | null;
}

export default function EvalTracePage() {
  const [addressText, setAddressText] = useState("");
  const [address, setAddress] = useState<AddressInfo | null>(null);
  const [polygons, setPolygons] = useState<
    Array<Array<{ lat: number; lng: number }>>
  >([]);
  const [slug, setSlug] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<
    { ok: true; slug: string; file: string } | { ok: false; error: string } | null
  >(null);
  const [existing, setExisting] = useState<Existing[]>([]);

  const refreshList = async () => {
    try {
      const res = await fetch("/api/eval-truth/list");
      const data = (await res.json()) as { entries?: Existing[] };
      setExisting(data.entries ?? []);
    } catch {
      /* empty */
    }
  };

  useEffect(() => {
    refreshList();
  }, []);

  const onAddressSelect = (a: AddressInfo) => {
    setAddress(a);
    setSaveResult(null);
    setPolygons([]);
    if (!slug && a.formatted) {
      // Auto-suggest a slug from the address; user can override.
      setSlug(
        a.formatted
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50),
      );
    }
  };

  const primary = polygons[0] ?? null;
  const canSave =
    !!address &&
    typeof address.lat === "number" &&
    typeof address.lng === "number" &&
    !!primary &&
    primary.length >= 3 &&
    !saving;

  const onSave = async () => {
    if (!canSave || !address || !primary) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/eval-truth/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: slug || undefined,
          address: address.formatted,
          lat: address.lat,
          lng: address.lng,
          polygon: primary,
          notes: notes || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSaveResult({ ok: true, slug: data.slug, file: data.file });
        await refreshList();
      } else {
        setSaveResult({
          ok: false,
          error: data.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      setSaveResult({
        ok: false,
        error: err instanceof Error ? err.message : "save_failed",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Ground-truth annotation
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed max-w-3xl">
          Hand-trace the correct roof outline on the same Google zoom-20 satellite
          tile the pipeline uses. These polygons become the answer key for
          <code className="kbd mx-1">npm run eval:truth</code>, which scores each
          source (Solar, Roboflow, SAM, MS Buildings, OSM) by IoU and area ratio.
          Aim for 10+ addresses across roof types (gable / hip / L-shape / complex).
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        <div className="space-y-4">
          <AddressInput
            value={addressText}
            onChange={setAddressText}
            onSelect={onAddressSelect}
            onSubmit={(a) => {
              if (a) onAddressSelect(a);
            }}
          />
          {address?.lat != null && address?.lng != null && (
            <div className="h-[640px]">
              <MapView
                lat={address.lat}
                lng={address.lng}
                address={address.formatted}
                segments={polygons}
                editable
                onPolygonsChanged={setPolygons}
              />
            </div>
          )}
          {!address && (
            <div className="rounded-2xl border border-white/[0.07] bg-black/30 p-10 text-center">
              <p className="text-sm text-slate-400">
                Enter an address above to load the satellite tile.
              </p>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/[0.07] bg-black/30 p-4 space-y-3">
            <h2 className="font-display text-sm font-semibold tracking-tight text-slate-200">
              Save ground truth
            </h2>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500">
                Slug
              </label>
              <input
                type="text"
                value={slug}
                onChange={(e) =>
                  setSlug(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]+/g, "-")
                      .slice(0, 60),
                  )
                }
                placeholder="auto from address"
                className="w-full rounded-md border border-white/[0.1] bg-black/40 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500">
                Notes (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. complex hip + dormers, attached garage"
                className="w-full rounded-md border border-white/[0.1] bg-black/40 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 min-h-[64px]"
              />
            </div>

            <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500">
              {primary
                ? `${primary.length} verts · ready`
                : "draw a polygon to enable save"}
            </div>

            <button
              onClick={onSave}
              disabled={!canSave}
              className="chip chip-accent w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <Loader2 size={11} className="animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Save size={11} /> Save ground truth
                </>
              )}
            </button>

            {saveResult?.ok && (
              <div className="flex items-start gap-2 text-[12px] text-emerald-300">
                <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
                <div>
                  Saved <code className="kbd">{saveResult.slug}</code>
                  <div className="text-slate-500 mt-0.5">{saveResult.file}</div>
                </div>
              </div>
            )}
            {saveResult && !saveResult.ok && (
              <div className="flex items-start gap-2 text-[12px] text-rose-300">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <div>{saveResult.error}</div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-black/30 p-4 space-y-2">
            <h2 className="font-display text-sm font-semibold tracking-tight text-slate-200">
              Already traced ({existing.length})
            </h2>
            {existing.length === 0 ? (
              <p className="text-[12px] text-slate-500">None yet.</p>
            ) : (
              <ul className="space-y-1.5 text-[12px] max-h-[420px] overflow-y-auto">
                {existing.map((e) => (
                  <li
                    key={e.slug}
                    className="rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-1.5"
                  >
                    <div className="font-mono text-slate-200">{e.slug}</div>
                    <div className="text-slate-500 mt-0.5 truncate">
                      {e.address ?? `${e.lat?.toFixed(5)}, ${e.lng?.toFixed(5)}`}
                    </div>
                    <div className="text-slate-600 text-[10px] mt-0.5">
                      {e.vertices} verts
                      {e.savedAt &&
                        ` · ${new Date(e.savedAt).toLocaleDateString()}`}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
