"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { deleteEstimate, loadEstimates } from "@/lib/storage";
import { fmt } from "@/lib/pricing";
import type { Estimate } from "@/types/estimate";
import { Trash2, Search, ArrowRight } from "lucide-react";

export default function HistoryPage() {
  const [list, setList] = useState<Estimate[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setList(loadEstimates());
  }, []);

  const filtered = list.filter((e) => {
    const q = filter.toLowerCase();
    return (
      !q ||
      e.address.formatted.toLowerCase().includes(q) ||
      (e.customerName ?? "").toLowerCase().includes(q) ||
      (e.staff ?? "").toLowerCase().includes(q) ||
      (e.address.zip ?? "").includes(q)
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
                <td className="px-5 py-3.5 max-w-md truncate font-medium">{e.address.formatted}</td>
                <td className="px-5 py-3.5 text-slate-300">{e.customerName || <span className="text-slate-600">—</span>}</td>
                <td className="px-5 py-3.5 text-slate-400">{e.staff || <span className="text-slate-600">—</span>}</td>
                <td className="px-5 py-3.5 text-right font-display tabular font-semibold">{fmt(e.total)}</td>
                <td className="px-5 py-3.5 text-right">
                  <button
                    className="opacity-0 group-hover:opacity-100 transition btn btn-ghost py-1 px-2"
                    onClick={() => {
                      if (confirm("Delete this estimate?")) {
                        deleteEstimate(e.id);
                        setList(loadEstimates());
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
