"use client";

import { useEffect } from "react";

interface ShortcutMap {
  /** ⌘S / Ctrl+S */
  onSave?: () => void;
  /** ⌘P / Ctrl+P */
  onPdf?: () => void;
  /** ⌘E / Ctrl+E */
  onEmail?: () => void;
  /** ⌘N / Ctrl+N */
  onNew?: () => void;
  /** ⌘K / Ctrl+K — focus address input */
  onFocusAddress?: () => void;
  /** ⌘/ — show keymap */
  onHelp?: () => void;
}

export function useKeyboardShortcuts(map: ShortcutMap) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const meta = isMac ? e.metaKey : e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inField = tag === "input" || tag === "textarea" || tag === "select";

      // ⌘K always works (its purpose is to focus into a field)
      if (key === "k" && map.onFocusAddress) {
        e.preventDefault();
        map.onFocusAddress();
        return;
      }

      if (inField) return;

      if (key === "s" && map.onSave) {
        e.preventDefault();
        map.onSave();
      } else if (key === "p" && map.onPdf) {
        e.preventDefault();
        map.onPdf();
      } else if (key === "e" && map.onEmail) {
        e.preventDefault();
        map.onEmail();
      } else if (key === "n" && map.onNew) {
        e.preventDefault();
        map.onNew();
      } else if (key === "/" && map.onHelp) {
        e.preventDefault();
        map.onHelp();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [map]);
}
