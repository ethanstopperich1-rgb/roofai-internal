"use client";

import React, { useRef, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  label: string;
  href: string;
}

interface Props {
  items: NavItem[];
  className?: string;
}

interface CursorPosition {
  left: number;
  width: number;
  opacity: number;
}

/**
 * Animated tab navigation — sliding cursor behind the active/hovered tab.
 *
 * Adapted from 21st.dev/r/abdulali254/nav-header for the Pitch dark theme:
 *   - White-on-black palette → cyan-on-ink palette (matches the rest of
 *     the app's editorial-precision aesthetic)
 *   - Hard-coded English tabs → driven by an `items` prop so the same
 *     component serves the internal staff routes (/, /history, /admin)
 *     and the public quote routes (/, How It Works, Pricing, FAQ, Get
 *     Quote) with carrier-different content
 *   - Active route detection via Next.js usePathname so the cursor parks
 *     under the current page when no tab is being hovered
 */
export default function NavHeader({ items, className = "" }: Props) {
  const pathname = usePathname() ?? "/";
  const [position, setPosition] = useState<CursorPosition>({
    left: 0,
    width: 0,
    opacity: 0,
  });

  const activeIdx = items.findIndex(
    (i) => i.href === pathname || (i.href !== "/" && pathname.startsWith(i.href)),
  );

  return (
    <ul
      className={`relative mx-auto flex w-fit rounded-full border border-white/[0.10] bg-[#0c1118]/70 backdrop-blur-md p-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.04)] ${className}`}
      onMouseLeave={() => setPosition((pv) => ({ ...pv, opacity: 0 }))}
    >
      {items.map((item, i) => (
        <Tab
          key={item.href}
          href={item.href}
          setPosition={setPosition}
          isActive={i === activeIdx}
        >
          {item.label}
        </Tab>
      ))}
      <Cursor position={position} />
    </ul>
  );
}

const Tab = ({
  children,
  href,
  setPosition,
  isActive,
}: {
  children: React.ReactNode;
  href: string;
  setPosition: (p: CursorPosition) => void;
  isActive?: boolean;
}) => {
  const ref = useRef<HTMLLIElement>(null);
  return (
    <li
      ref={ref}
      onMouseEnter={() => {
        if (!ref.current) return;
        const { width } = ref.current.getBoundingClientRect();
        setPosition({
          width,
          opacity: 1,
          left: ref.current.offsetLeft,
        });
      }}
      className="relative z-10 block"
    >
      <Link
        href={href}
        className={`block cursor-pointer px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] font-mono md:px-5 md:py-2.5 md:text-[12px] transition-colors ${
          isActive ? "text-[#051019]" : "text-slate-300 hover:text-white"
        }`}
      >
        {children}
      </Link>
    </li>
  );
};

const Cursor = ({ position }: { position: CursorPosition }) => {
  return (
    <motion.li
      animate={position}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className="absolute z-0 h-7 md:h-9 rounded-full bg-cy-300 shadow-[0_4px_12px_-2px_rgba(103,220,255,0.45)]"
    />
  );
};
