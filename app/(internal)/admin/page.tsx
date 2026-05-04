"use client";

import { useEffect, useMemo, useState } from "react";
import { loadEstimates } from "@/lib/storage";
import { fmt } from "@/lib/pricing";
import type { Estimate } from "@/types/estimate";
import { TrendingUp, Users, Wallet, Hash } from "lucide-react";

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
  const uniqueStaff = new Set(filtered.map((e) => e.staff).filter(Boolean)).size;

  return (
    <div className="space-y-6">
      <div>
        <div className="chip mb-3">analytics</div>
        <h1 className="font-display text-[32px] font-medium tracking-tight leading-none">Admin</h1>
        <p className="text-[13px] text-slate-400 mt-1">Pipeline overview · filter by territory, rep, or date</p>
      </div>

      <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={<Hash size={13} />} label="Estimates" value={String(filtered.length)} />
        <Kpi icon={<Wallet size={13} />} label="Total Pipeline" value={fmt(total)} accent />
        <Kpi icon={<TrendingUp size={13} />} label="Avg Estimate" value={fmt(avg)} />
        <Kpi icon={<Users size={13} />} label="Unique Staff" value={String(uniqueStaff)} />
      </div>

      <div className="glass rounded-3xl p-5 grid md:grid-cols-4 gap-4">
        <Field label="ZIP">
          <input className="input" value={zip} onChange={(e) => setZip(e.target.value)} placeholder="e.g. 32801" />
        </Field>
        <Field label="Staff">
          <input className="input" value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="Name" />
        </Field>
        <Field label="From">
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>

      <div className="glass rounded-3xl overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <Th>Date</Th>
              <Th>Address</Th>
              <Th>ZIP</Th>
              <Th>Staff</Th>
              <Th align="right">Total</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-slate-500 text-[13px]">
                  No estimates match these filters.
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition">
                <td className="px-5 py-3 text-slate-400 font-mono tabular text-[12px]">
                  {new Date(e.createdAt).toLocaleDateString()}
                </td>
                <td className="px-5 py-3 max-w-md truncate font-medium">{e.address.formatted}</td>
                <td className="px-5 py-3 text-slate-300 font-mono tabular">{e.address.zip || <span className="text-slate-600">—</span>}</td>
                <td className="px-5 py-3 text-slate-400">{e.staff || <span className="text-slate-600">—</span>}</td>
                <td className="px-5 py-3 text-right font-display tabular font-semibold">{fmt(e.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className={`glass rounded-2xl p-4 card-hover ${accent ? "ring-1 ring-cy-300/20" : ""}`}>
      <div className="label flex items-center gap-1.5">
        <span className={accent ? "text-cy-300" : "text-slate-500"}>{icon}</span>
        {label}
      </div>
      <div
        className={`mt-2 font-display tabular text-[28px] font-semibold tracking-tight ${
          accent ? "bg-gradient-to-r from-cy-200 to-mint bg-clip-text text-transparent" : "text-slate-50"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      {children}
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
