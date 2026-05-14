"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { deleteEstimate, loadEstimatesTagged } from "@/lib/storage";
import { fmt } from "@/lib/pricing";
import type { LoadedEstimate } from "@/types/roof";
import { Trash2, Search, ArrowRight } from "lucide-react";

/**
 * Normalized row shape — works for both v1 and v2 estimates. The table
 * only needs a handful of fields; this adapter pulls them from whichever
 * shape the row uses so the rendering stays uniform.
 */
interface Row {
  id: string;
  createdAt: string;
  staff: string;
  customerName: string;
  address: string;
  zip: string;
  total: number;
  kind: "v1" | "v2";
}

function toRow(loaded: LoadedEstimate): Row {
  if (loaded.kind === "v2") {
    const e = loaded.estimate;
    return {
      id: e.id,
      createdAt: e.createdAt,
      staff: e.staff ?? "",
      customerName: e.customerName ?? "",
      address: e.address.formatted,
      zip: e.address.zip ?? "",
      total: Math.round((e.priced.totalLow + e.priced.totalHigh) / 2),
      kind: "v2",
    };
  }
  const e = loaded.estimate;
  return {
    id: e.id,
    createdAt: e.createdAt,
    staff: e.staff ?? "",
    customerName: e.customerName ?? "",
    address: e.address.formatted,
    zip: e.address.zip ?? "",
    total: e.total ?? 0,
    kind: "v1",
  };
}

export default function HistoryPage() {
  const [list, setList] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setList(loadEstimatesTagged().map(toRow));
  }, []);

  const filtered = list.filter((e) => {
    const q = filter.toLowerCase();
    return (
      !q ||
      e.address.toLowerCase().includes(q) ||
      e.customerName.toLowerCase().includes(q) ||
      e.staff.toLowerCase().includes(q) ||
      e.zip.includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="chip mb-3">archive</div>
          <h1 className="font-display text-[32px] font-medium tracking-tight leading-none">
            History
          </h1>
          <p className="text-[13px] text-slate-400 mt-1">
            {list.length} saved estimate{list.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="relative w-80 max-w-full">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="input pl-9"
            placeholder="Filter by address, customer, ZIP, staff…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <div className="glass rounded-3xl overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <Th>Date</Th>
              <Th>Address</Th>
              <Th>Customer</Th>
              <Th>Staff</Th>
              <Th align="right">Total</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-6 py-16 text-center">
                  <div className="text-slate-400 text-[14px] mb-2">No estimates yet</div>
                  <Link
                    href="/"
                    className="inline-flex items-center gap-1.5 text-cy-300 text-[13px] hover:text-cy-200"
                  >
                    Create one <ArrowRight size={13} />
                  </Link>
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr
                key={e.id}
                className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition group"
              >
                <td className="px-5 py-3.5 text-slate-400 font-mono tabular text-[12px] whitespace-nowrap">
                  {new Date(e.createdAt).toLocaleDateString()}
                </td>
                <td className="px-5 py-3.5 max-w-md truncate font-medium">
                  {e.address}
                  {e.kind === "v2" && (
                    <span className="ml-2 inline-block rounded bg-cy-300/10 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-cy-300">
                      v2
                    </span>
                  )}
                </td>
                <td className="px-5 py-3.5 text-slate-300">{e.customerName || <span className="text-slate-600">—</span>}</td>
                <td className="px-5 py-3.5 text-slate-400">{e.staff || <span className="text-slate-600">—</span>}</td>
                <td className="px-5 py-3.5 text-right font-display tabular font-semibold">{fmt(e.total)}</td>
                <td className="px-5 py-3.5 text-right">
                  <button
                    className="opacity-0 group-hover:opacity-100 transition btn btn-ghost py-1 px-2"
                    onClick={() => {
                      if (confirm("Delete this estimate?")) {
                        deleteEstimate(e.id);
                        setList(loadEstimatesTagged().map(toRow));
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: "right" }) {
  return (
    <th
      className={`px-5 py-3 label font-normal ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
