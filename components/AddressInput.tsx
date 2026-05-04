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

export default function AddressInput({ onSelect, onSubmit, value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasGoogle, setHasGoogle] = useState(false);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) return;
    let ac: google.maps.places.Autocomplete | undefined;
    loadGoogle()
      .then((g) => {
        if (!inputRef.current) return;
        ac = new g.maps.places.Autocomplete(inputRef.current, {
          types: ["address"],
          componentRestrictions: { country: ["us"] },
          fields: ["formatted_address", "geometry", "address_components"],
        });
        ac.addListener("place_changed", () => {
          const p = ac!.getPlace();
          const formatted = p.formatted_address || inputRef.current!.value;
          const zip =
            p.address_components?.find((c) => c.types.includes("postal_code"))?.short_name;
          const lat = p.geometry?.location?.lat();
          const lng = p.geometry?.location?.lng();
          onChange(formatted);
          onSelect({ formatted, zip, lat, lng });
        });
        setHasGoogle(true);
      })
      .catch(() => setHasGoogle(false));
    return () => {
      if (ac) google.maps.event.clearInstanceListeners(ac);
    };
  }, [onSelect, onChange]);

  return (
    <div className="relative">
      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
        <Search size={20} />
      </div>
      <input
        ref={inputRef}
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
      <button onClick={onSubmit} className="btn btn-primary absolute right-2 top-1/2 -translate-y-1/2">
        Estimate <span className="kbd">↵</span>
      </button>
      {!hasGoogle && (
        <div className="text-xs text-slate-500 mt-2 px-1">
          Tip: set <code className="kbd">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> in .env.local for autocomplete.
        </div>
      )}
    </div>
  );
}
