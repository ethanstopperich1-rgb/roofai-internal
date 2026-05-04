"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { deleteEstimate, loadEstimates } from "@/lib/storage";
import { fmt } from "@/lib/pricing";
import type { Estimate } from "@/types/estimate";
import { Trash2 } from "lucide-react";

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
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-black tracking-tight">History</h1>
          <p className="text-sm text-slate-400">Last {list.length} saved estimates</p>
        </div>
        <input
          className="input w-72"
          placeholder="Filter by address, customer, ZIP, staff…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="glass rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-slate-400 text-left">
            <tr>
              <th className="p-3">Date</th>
              <th className="p-3">Address</th>
              <th className="p-3">Customer</th>
              <th className="p-3">Staff</th>
              <th className="p-3 text-right">Total</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="p-10 text-center text-slate-500">
                  No estimates yet. <Link href="/" className="text-sky-400">Create one →</Link>
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                <td className="p-3 whitespace-nowrap text-slate-400">
                  {new Date(e.createdAt).toLocaleDateString()}
                </td>
                <td className="p-3 max-w-md truncate">{e.address.formatted}</td>
                <td className="p-3">{e.customerName || "—"}</td>
                <td className="p-3 text-slate-400">{e.staff || "—"}</td>
                <td className="p-3 text-right font-mono font-bold">{fmt(e.total)}</td>
                <td className="p-3 text-right">
                  <button
                    className="btn btn-ghost py-1 px-2"
                    onClick={() => {
                      if (confirm("Delete this estimate?")) {
                        deleteEstimate(e.id);
                        setList(loadEstimates());
                      }
                    }}
                  >
                    <Trash2 size={14} />
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
