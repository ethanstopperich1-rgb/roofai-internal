// components/roof/PitchDisplay.tsx
export function PitchDisplay({
  degrees,
  className,
}: {
  degrees: number;
  className?: string;
}) {
  const rise = Math.round(Math.tan((degrees * Math.PI) / 180) * 12 * 10) / 10;
  return <span className={className}>{rise}/12</span>;
}
