// Pure helpers extracted from useViewerSet.ts. These don't touch React
// state / callbacks; keeping them out of the hook file leaves the hook
// focused on `useState` orchestration and `useCallback` wiring.

import {
  appendOrFocusInActive,
  findLeaf,
  splitWithNewLeaf,
  type Layout,
} from "./layout";
import { newTab } from "./useTabs";
import type { Viewer } from "./viewers";

// leafTabsCount sums the tab count across all leaves in a viewer's layout.
// Used only for the close-viewer log line ("did the user lose data?").
export function leafTabsCount(v: Viewer): number {
  let n = 0;
  walk(v.layout.root);
  return n;
  function walk(node: Layout["root"]) {
    if (node.kind === "leaf") {
      n += node.tabs.length;
      return;
    }
    walk(node.a);
    walk(node.b);
  }
}

// openPathAsSplitOrAppend is the layout transform used by the "open many as
// split" bulk flows: if the active leaf is empty, just append to it (so the
// first image fills the existing empty panel instead of creating an extra
// split). Otherwise split right with a fresh tab. The MAX_PANELS check is
// the caller's responsibility — by the time we get here we've already
// confirmed there's room.
export function openPathAsSplitOrAppend(
  layout: Layout,
  path: string,
): Layout {
  const leaf = findLeaf(layout.root, layout.activeId);
  if (leaf && leaf.tabs.length === 0) {
    return appendOrFocusInActive(layout, path);
  }
  const r = splitWithNewLeaf(layout, layout.activeId, "right", newTab(path));
  return r.ok ? r.layout : layout;
}
