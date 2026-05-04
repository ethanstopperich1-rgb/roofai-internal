"use client";

import { useEffect, useRef, useState } from "react";
import { Search, Loader2, ArrowUp, ArrowDown, CornerDownLeft, MapPin } from "lucide-react";
import type { AddressInfo } from "@/types/estimate";
import { AuroraButton } from "@/components/ui/aurora-button";

interface Props {
  onSelect: (a: AddressInfo) => void;
  onSubmit: () => void;
  value: string;
  onChange: (s: string) => void;
}

interface Suggestion {
  placeId: string;
  text: string;
}

export default function AddressInput({ onSelect, onSubmit, value, onChange }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const skipNextFetch = useRef(false);

  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    if (!value || value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/places/autocomplete?q=${encodeURIComponent(value)}`,
          { signal: ctrl.signal }
        );
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
        setHi(0);
        setOpen(true);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const pick = async (s: Suggestion) => {
    skipNextFetch.current = true;
    onChange(s.text);
    setOpen(false);
    setSuggestions([]);
    try {
      const res = await fetch(`/api/places/details?placeId=${s.placeId}`);
      const data = await res.json();
      onSelect({
        formatted: data.formatted ?? s.text,
        zip: data.zip,
        lat: data.lat,
        lng: data.lng,
      });
    } catch {
      onSelect({ formatted: s.text });
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        pick(suggestions[hi]);
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={`flex items-center gap-2 rounded-2xl border transition-all pl-4 pr-2 py-2 ${
          open && suggestions.length > 0
            ? "border-cy-300/40 bg-black/30 shadow-[0_0_0_4px_rgba(56,197,238,0.10)]"
            : "border-white/[0.075] bg-black/30 hover:border-white/[0.13] focus-within:border-cy-300/55 focus-within:shadow-[0_0_0_4px_rgba(56,197,238,0.10)]"
        }`}
      >
        <Search size={18} strokeWidth={2} className="text-slate-500 flex-shrink-0" />
        <input
          ref={inputRef}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none py-2 text-[16px] font-medium tracking-tight text-slate-50 placeholder:text-slate-600"
          placeholder="123 Main Street, Austin, TX…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        {loading && (
          <Loader2 size={15} className="animate-spin text-slate-400 flex-shrink-0" />
        )}
        <AuroraButton
          onClick={onSubmit}
          className="flex-shrink-0 px-5 py-2.5 font-medium text-[14px] tracking-tight inline-flex items-center gap-2"
        >
          Estimate
          <span className="kbd">↵</span>
        </AuroraButton>
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-2 z-50 glass-strong rounded-2xl overflow-hidden shadow-2xl float-in">
          <div className="px-4 py-2 flex items-center justify-between border-b border-white/[0.06]">
            <span className="label">Suggestions</span>
            <div className="flex items-center gap-1.5 text-slate-500">
              <span className="kbd"><ArrowUp size={9} /></span>
              <span className="kbd"><ArrowDown size={9} /></span>
              <span className="text-[10px] font-mono">to navigate</span>
              <span className="kbd ml-1"><CornerDownLeft size={9} /></span>
              <span className="text-[10px] font-mono">to pick</span>
            </div>
          </div>
          <div>
            {suggestions.map((s, i) => (
              <button
                key={s.placeId}
                onClick={() => pick(s)}
                onMouseEnter={() => setHi(i)}
                className={`relative w-full text-left px-4 py-2.5 flex items-center gap-3 border-b border-white/[0.04] last:border-b-0 transition group ${
                  i === hi ? "bg-cy-300/[0.08]" : "hover:bg-white/[0.025]"
                }`}
              >
                {i === hi && (
                  <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r-full bg-cy-300" />
                )}
                <MapPin
                  size={14}
                  className={`flex-shrink-0 ${i === hi ? "text-cy-300" : "text-slate-500"}`}
                />
                <span
                  className={`truncate text-[13.5px] ${
                    i === hi ? "text-cy-100" : "text-slate-200"
                  }`}
                >
                  {s.text}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY && (
        <div className="text-[11px] text-slate-500 mt-2 px-1">
          Set <code className="kbd">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> in .env.local for autocomplete.
        </div>
      )}
    </div>
  );
}
