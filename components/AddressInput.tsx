"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";
import { Search } from "lucide-react";
import type { AddressInfo } from "@/types/estimate";

interface Props {
  onSelect: (a: AddressInfo) => void;
  onSubmit: () => void;
  value: string;
  onChange: (s: string) => void;
}

interface PlacePredictionLite {
  toPlace(): {
    fetchFields(req: { fields: string[] }): Promise<unknown>;
    formattedAddress?: string;
    addressComponents?: Array<{ types: string[]; shortText?: string }>;
    location?: { lat(): number; lng(): number };
  };
}

export default function AddressInput({ onSelect, onSubmit, value, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLElement | null>(null);
  const [hasGoogle, setHasGoogle] = useState(false);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) return;
    let cancelled = false;
    loadGoogle()
      .then(async (g) => {
        if (cancelled || !containerRef.current) return;
        const places = (await g.maps.importLibrary("places")) as unknown as {
          PlaceAutocompleteElement: new (opts: {
            includedRegionCodes?: string[];
          }) => HTMLElement;
        };
        const el = new places.PlaceAutocompleteElement({
          includedRegionCodes: ["us"],
        });
        el.id = "roofai-place-autocomplete";
        // Strip Google's default styling so our Tailwind takes over
        el.setAttribute("style", "width:100%;");
        containerRef.current.innerHTML = "";
        containerRef.current.appendChild(el);
        elRef.current = el;

        el.addEventListener("gmp-select", async (ev: Event) => {
          const detail = (ev as CustomEvent<{ placePrediction: PlacePredictionLite }>).detail;
          const place = detail.placePrediction.toPlace();
          await place.fetchFields({
            fields: ["formattedAddress", "addressComponents", "location"],
          });
          const formatted = place.formattedAddress ?? "";
          const zip = place.addressComponents?.find((c) =>
            c.types.includes("postal_code")
          )?.shortText;
          const lat = place.location?.lat();
          const lng = place.location?.lng();
          onChange(formatted);
          onSelect({ formatted, zip, lat, lng });
        });

        // Track typed input so manual Enter still works
        el.addEventListener("input", (ev: Event) => {
          const t = ev.target as HTMLInputElement;
          if (t && typeof t.value === "string") onChange(t.value);
        });
        el.addEventListener("keydown", (ev: Event) => {
          const ke = ev as KeyboardEvent;
          if (ke.key === "Enter") {
            ke.preventDefault();
            onSubmit();
          }
        });

        setHasGoogle(true);
      })
      .catch(() => setHasGoogle(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative">
      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 z-10 pointer-events-none">
        <Search size={20} />
      </div>
      {hasGoogle ? (
        <div
          ref={containerRef}
          className="pl-12 pr-32 py-2 rounded-xl bg-black/30 border border-white/10 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-400/15 [&_input]:!bg-transparent [&_input]:!border-0 [&_input]:!outline-none [&_input]:!text-white [&_input]:!text-lg [&_input]:!py-3 [&_input]:!w-full"
        />
      ) : (
        <input
          className="input pl-12 pr-32 py-5 text-lg"
          placeholder="Enter property address..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      )}
      <button
        onClick={onSubmit}
        className="btn btn-primary absolute right-2 top-1/2 -translate-y-1/2 z-10"
      >
        Estimate <span className="kbd">↵</span>
      </button>
      {!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY && (
        <div className="text-xs text-slate-500 mt-2 px-1">
          Set <code className="kbd">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> in .env.local for autocomplete.
        </div>
      )}
    </div>
  );
}
