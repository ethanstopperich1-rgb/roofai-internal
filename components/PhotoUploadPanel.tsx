"use client";

import { useCallback, useRef, useState } from "react";
import {
  Camera,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  Trash2,
  MapPin,
  Plus,
} from "lucide-react";
import type { PhotoMeta, PhotoTagKind } from "@/types/photo";

interface Props {
  photos: PhotoMeta[];
  onChange: (photos: PhotoMeta[]) => void;
}

const TAG_LABEL: Record<PhotoTagKind, string> = {
  "missing-shingles": "missing shingles",
  "lifted-shingle": "lifted shingle",
  "hail-impact": "hail impact",
  "granule-loss": "granule loss",
  "moss-algae": "moss / algae",
  discoloration: "discoloration",
  tarp: "tarp",
  ponding: "ponding",
  "damaged-flashing": "flashing",
  "damaged-vent": "vent",
  "damaged-chimney": "chimney",
  "soffit-fascia-damage": "soffit / fascia",
  "gutter-damage": "gutter",
  "skylight-damage": "skylight",
  "drip-edge": "drip edge",
  "ridge-vent": "ridge vent",
  valley: "valley",
  "general-context": "context",
  "interior-leak": "interior leak",
  other: "other",
};

const DAMAGE_TAGS = new Set<PhotoTagKind>([
  "missing-shingles",
  "lifted-shingle",
  "hail-impact",
  "granule-loss",
  "moss-algae",
  "discoloration",
  "tarp",
  "ponding",
  "damaged-flashing",
  "damaged-vent",
  "damaged-chimney",
  "soffit-fascia-damage",
  "gutter-damage",
  "skylight-damage",
  "interior-leak",
]);

export default function PhotoUploadPanel({ photos, onChange }: Props) {
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (files: File[]) => {
      setError("");
      const valid = files.filter((f) => f.type.startsWith("image/"));
      if (valid.length === 0) return;
      setUploading((n) => n + valid.length);
      const results: PhotoMeta[] = [];
      for (const file of valid) {
        const fd = new FormData();
        fd.append("file", file);
        try {
          const res = await fetch("/api/photos", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) {
            setError(data.error ?? "upload failed");
            continue;
          }
          results.push(data as PhotoMeta);
        } catch (e) {
          setError(e instanceof Error ? e.message : "upload failed");
        } finally {
          setUploading((n) => n - 1);
        }
      }
      if (results.length) onChange([...photos, ...results]);
    },
    [photos, onChange],
  );

  const onSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) upload(Array.from(e.target.files));
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files) upload(Array.from(e.dataTransfer.files));
  };

  const remove = (id: string) => onChange(photos.filter((p) => p.id !== id));

  const damageCount = photos.reduce(
    (n, p) =>
      n +
      (p.tags.some((t) => DAMAGE_TAGS.has(t.kind)) ? 1 : 0),
    0,
  );
  const claimReadyCount = photos.filter((p) => p.claimReady).length;

  return (
    <div className="glass-panel p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-cy-300/10 border border-cy-300/20 flex items-center justify-center text-cy-300">
            <Camera size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px]">
              Field Photos
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              {photos.length} uploaded · {damageCount} with damage · {claimReadyCount} claim-ready
            </div>
          </div>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          className="glass-button-secondary py-1.5 px-3 text-[12px]"
        >
          <Plus size={12} /> Add
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        capture="environment"
        onChange={onSelect}
        className="hidden"
      />

      {photos.length === 0 && (
        <div
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => inputRef.current?.click()}
          className={`rounded-2xl border-2 border-dashed cursor-pointer transition p-6 text-center ${
            dragOver
              ? "border-cy-300/50 bg-cy-300/[0.05]"
              : "border-white/[0.10] hover:border-white/[0.20] hover:bg-white/[0.02]"
          }`}
        >
          <Camera size={20} className="mx-auto text-slate-500 mb-2" />
          <div className="text-[13px] text-slate-300 font-medium">
            Drop photos or click to upload
          </div>
          <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
            Pitch tags damage automatically · GPS + timestamp preserved for the
            insurance packet · 30–50 photos is the practical claim standard
          </div>
        </div>
      )}

      {photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {photos.map((p) => (
            <PhotoCard key={p.id} photo={p} onRemove={() => remove(p.id)} />
          ))}
          <button
            onClick={() => inputRef.current?.click()}
            className="rounded-xl border-2 border-dashed border-white/10 hover:border-cy-300/30 hover:bg-cy-300/[0.04] transition aspect-square flex flex-col items-center justify-center text-slate-500 hover:text-cy-300"
          >
            <Plus size={20} />
            <span className="text-[11px] font-mono uppercase tracking-[0.14em] mt-1">add</span>
          </button>
        </div>
      )}

      {uploading > 0 && (
        <div className="flex items-center gap-2 text-[12px] text-cy-300">
          <Loader2 size={12} className="animate-spin" />
          Uploading + analyzing {uploading} photo{uploading === 1 ? "" : "s"}…
        </div>
      )}

      {error && (
        <div className="text-[12px] text-rose px-3 py-2 rounded-lg bg-rose/[0.08] border border-rose/20">
          {error}
        </div>
      )}

      {photos.length > 0 && (
        <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 border-t border-white/[0.05] pt-3">
          Photos persist with the estimate · embedded in the proposal PDF
        </div>
      )}
    </div>
  );
}

function PhotoCard({
  photo,
  onRemove,
}: {
  photo: PhotoMeta;
  onRemove: () => void;
}) {
  const damageTags = photo.tags.filter((t) => DAMAGE_TAGS.has(t.kind));
  const primary = damageTags[0] ?? photo.tags[0];

  return (
    <div className="relative group rounded-xl overflow-hidden border border-white/[0.08] bg-black/30 aspect-square">
      <img
        src={photo.url}
        alt={photo.caption ?? photo.filename}
        className="w-full h-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      {/* Top-right badges */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
        {photo.claimReady ? (
          <span
            className="rounded-md px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.10em] flex items-center gap-1 backdrop-blur"
            style={{
              background: "rgba(95,227,176,0.16)",
              color: "#5fe3b0",
              border: "1px solid rgba(95,227,176,0.40)",
            }}
            title="Has GPS + valid timestamp — qualifies for an insurance claim packet"
          >
            <ShieldCheck size={9} />
            claim
          </span>
        ) : (
          <span
            className="rounded-md px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.10em] flex items-center gap-1 backdrop-blur"
            style={{
              background: "rgba(243,177,75,0.16)",
              color: "#f3b14b",
              border: "1px solid rgba(243,177,75,0.40)",
            }}
            title="Missing GPS or timestamp — cannot be used as claim evidence"
          >
            <AlertTriangle size={9} />
            no exif
          </span>
        )}
        <button
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 transition rounded-md w-5 h-5 flex items-center justify-center bg-rose/30 hover:bg-rose/50 text-rose-100 backdrop-blur"
          title="Remove photo"
        >
          <Trash2 size={10} />
        </button>
      </div>
      {/* Bottom info */}
      <div className="absolute left-1.5 right-1.5 bottom-1.5 space-y-1">
        {primary && (
          <div className="flex items-center gap-1 flex-wrap">
            <span
              className="rounded-md px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.10em] backdrop-blur"
              style={{
                background: DAMAGE_TAGS.has(primary.kind)
                  ? "rgba(255,122,138,0.18)"
                  : "rgba(103,220,255,0.16)",
                color: DAMAGE_TAGS.has(primary.kind) ? "#ff7a8a" : "#67dcff",
                border: `1px solid ${DAMAGE_TAGS.has(primary.kind) ? "rgba(255,122,138,0.40)" : "rgba(103,220,255,0.40)"}`,
              }}
            >
              {TAG_LABEL[primary.kind]}
            </span>
            {photo.tags.length > 1 && (
              <span className="text-[9px] text-white/70 font-mono">
                +{photo.tags.length - 1}
              </span>
            )}
          </div>
        )}
        {photo.caption && (
          <div className="text-[10px] text-white/85 leading-snug line-clamp-2">
            {photo.caption}
          </div>
        )}
        {photo.location && (
          <div className="text-[9px] text-white/60 font-mono flex items-center gap-1">
            <MapPin size={8} />
            {photo.location.lat?.toFixed(4)}, {photo.location.lng?.toFixed(4)}
          </div>
        )}
      </div>
    </div>
  );
}
