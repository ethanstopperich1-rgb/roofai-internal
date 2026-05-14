// components/roof/LowSlopeBadge.tsx
export function LowSlopeBadge({ className }: { className?: string }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 " +
        (className ?? "")
      }
      title="Low slope (under 4/12) — may require different material spec"
    >
      Low slope
    </span>
  );
}
