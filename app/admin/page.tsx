"use client";

import { useEffect, useMemo, useState } from "react";
import { loadEstimates } from "@/lib/storage";
import { fmt } from "@/lib/pricing";
import type { Estimate } from "@/types/estimate";

export default function AdminPage() {
  const [list, setList] = useState<Estimate[]>([]);
  const [zip, setZip] = useState("");
  const [staff, setStaff] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => setList(loadEstimates()), []);

  const filtered = useMemo(() => {
    return list.filter((e) => {
      if (zip && (e.address.zip ?? "") !== zip) return false;
      if (staff && !(e.staff ?? "").toLowerCase().includes(staff.toLowerCase())) return false;
      const ts = new Date(e.createdAt).getTime();
      if (from && ts < new Date(from).getTime()) return false;
      if (to && ts > new Date(to).getTime() + 86400000) return false;
      return true;
    });
  }, [list, zip, staff, from, to]);

  const total = filtered.reduce((s, e) => s + e.total, 0);
  const avg = filtered.length ? total / filtered.length : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-black tracking-tight">Admin</h1>

      <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Estimates" value={String(filtered.length)} />
        <Stat label="Total Pipeline" value={fmt(total)} />
        <Stat label="Avg Estimate" value={fmt(avg)} />
        <Stat
          label="Unique Staff"
          value={String(new Set(filtered.map((e) => e.staff).filter(Boolean)).size)}
        />
      </div>

      <div className="glass rounded-2xl p-5 grid md:grid-cols-4 gap-3">
        <div>
          <div className="label mb-1">ZIP</div>
          <input className="input" value={zip} onChange={(e) => setZip(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Staff</div>
          <input className="input" value={staff} onChange={(e) => setStaff(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">From</div>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">To</div>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="glass rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-slate-400 text-left">
            <tr>
              <th className="p-3">Date</th>
              <th className="p-3">Address</th>
              <th className="p-3">ZIP</th>
              <th className="p-3">Staff</th>
              <th className="p-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="border-t border-white/5">
                <td className="p-3 text-slate-400">{new Date(e.createdAt).toLocaleDateString()}</td>
                <td className="p-3 max-w-md truncate">{e.address.formatted}</td>
                <td className="p-3">{e.address.zip || "—"}</td>
                <td className="p-3">{e.staff || "—"}</td>
                <td className="p-3 text-right font-mono">{fmt(e.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="label">{label}</div>
      <div className="text-2xl font-black mt-1">{value}</div>
    </div>
  );
}
