import { useEffect, useRef } from "react";
import { findLeaf } from "./features/viewer-grid/layout";
import type { useViewerSet } from "./features/viewer-grid/useViewerSet";
import {
  isEditableTarget,
  isPrimaryModifier,
  zoomCommandBus,
} from "./shared/utils/keybindings";
import type { TopTab } from "./topTab";

// useGlobalKeybindings wires the App-level keyboard shortcuts (Phase H4 + #7
// + #11):
//
//   Ctrl+Shift+1     → switch to the "list" top-tab
//   Ctrl+Shift+2..9 → switch to the (N-1)th viewer
//   Ctrl+W           → close the active tab in the active viewer panel
//   Ctrl+Tab / Ctrl+Shift+Tab → cycle tabs within the active panel
//   Ctrl+0 / Ctrl+1  → fit / actual-size (relayed via zoomCommandBus)
//   Ctrl+= / Ctrl+- → zoom in / out
//
// The window keydown listener is registered exactly once with an empty deps
// array; live state is read through refs that are kept in sync at render
// time. Re-creating the listener on every state change would risk dropping
// a key during the unmount/remount window.

type Opts = {
  topTab: TopTab;
  setTopTab: (t: TopTab) => void;
  viewer: ReturnType<typeof useViewerSet>;
  settingsOpen: boolean;
};

export function useGlobalKeybindings({
  topTab,
  setTopTab,
  viewer,
  settingsOpen,
}: Opts): void {
  const topTabRef = useRef(topTab);
  const settingsOpenRef = useRef(settingsOpen);
  const viewerRef = useRef(viewer);
  // Render-time sync: the keydown handler reads through these refs, so they
  // must reflect the latest state on every render (no useEffect delay).
  topTabRef.current = topTab;
  settingsOpenRef.current = settingsOpen;
  viewerRef.current = viewer;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (settingsOpenRef.current) return; // dialog has its own Esc handler

      // Global top-tab switching (#7 + #11). Ctrl+Shift+1 → list,
      // Ctrl+Shift+2..9 → N-1th viewer (so Ctrl+Shift+2 still means "first
      // viewer", preserving the old single-viewer keybinding's meaning).
      // e.code is layout-independent; e.key would be the shifted character
      // on most layouts.
      if (isPrimaryModifier(e) && e.shiftKey) {
        if (e.code === "Digit1") {
          e.preventDefault();
          setTopTab("list");
          return;
        }
        const digitMatch = /^Digit([2-9])$/.exec(e.code);
        if (digitMatch) {
          const idx = Number(digitMatch[1]) - 2; // Digit2 → viewer index 0
          const viewerLive = viewerRef.current;
          if (idx >= 0 && idx < viewerLive.viewers.length) {
            e.preventDefault();
            viewerLive.setActiveViewer(viewerLive.viewers[idx].id);
            setTopTab("viewer");
          }
          return;
        }
      }

      if (topTabRef.current !== "viewer") return;

      const viewerLive = viewerRef.current;
      const layout = viewerLive.layout;
      const activeLeaf = findLeaf(layout.root, layout.activeId);
      if (!activeLeaf) return;

      if (!isPrimaryModifier(e)) return;

      // Ctrl+W: close active tab
      if ((e.key === "w" || e.key === "W") && !e.shiftKey) {
        e.preventDefault();
        if (activeLeaf.activeIndex >= 0) {
          viewerLive.closeTab(activeLeaf.id, activeLeaf.activeIndex);
        }
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs in active panel
      if (e.key === "Tab") {
        e.preventDefault();
        const n = activeLeaf.tabs.length;
        if (n <= 1) return;
        const dir = e.shiftKey ? -1 : 1;
        const next = (((activeLeaf.activeIndex + dir) % n) + n) % n;
        viewerLive.setActiveTab(activeLeaf.id, next);
        return;
      }
      // Ctrl+0: fit to viewport
      if (e.key === "0") {
        e.preventDefault();
        zoomCommandBus.emit("fit");
        return;
      }
      // Ctrl+1: actual size (100%)
      if (e.key === "1") {
        e.preventDefault();
        zoomCommandBus.emit("actualSize");
        return;
      }
      // Ctrl+= / Ctrl++ : zoom in (also accept "+" shifted)
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomCommandBus.emit("in");
        return;
      }
      // Ctrl+- : zoom out
      if (e.key === "-") {
        e.preventDefault();
        zoomCommandBus.emit("out");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTopTab]);
}
