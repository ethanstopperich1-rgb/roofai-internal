"use client";

import { cn } from "@/lib/utils";

interface Props {
  /** Word to animate. Default "Generating". */
  text?: string;
  /** Optional className applied to the outer wrapper */
  className?: string;
  /** Color of the letters / bar accent. Default uses --color-cy-300 */
  accentColor?: string;
}

export const QuantumPulseLoader = ({
  text = "Generating",
  className,
  accentColor,
}: Props) => {
  const letters = Array.from(text);
  return (
    <div
      className={cn("generating-loader-wrapper", className)}
      style={accentColor ? ({ ["--qpl-accent" as string]: accentColor } as React.CSSProperties) : undefined}
    >
      <div className="generating-loader-text" aria-label={text}>
        {letters.map((ch, i) => (
          <span
            key={i}
            className="generating-loader-letter"
            style={{ animationDelay: `${i * 0.12}s` }}
          >
            {ch === " " ? " " : ch}
          </span>
        ))}
      </div>
      <div className="generating-loader-bar" aria-hidden />
    </div>
  );
};

export default QuantumPulseLoader;
