// Top-tab viewer reordering DnD hook (#50). Spec: docs/spec-viewer-tab-reorder.md.
//
// Minimal pointer-events DnD for the .top-tabs-viewers strip — independent of
// the panel-internal useDnD which targets a richer panel/edge/tab-bar drop
// space. Shared idioms with useDnD: 5px threshold, pushBodyStyle release
// stack, pointercancel + Escape cancellation, no module-scoped state.

import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../../shared/utils/logger";
import { pushBodyStyle } from "../../shared/utils/bodyStyles";

// data-viewer-tab marks the draggable child elements within the container so
// the hook can collect their rects via querySelectorAll. The attribute value
// is the array index as a string but the hook only uses the rect order — index
// extraction happens via the container's child order.
export const DATA_VIEWER_TAB = "data-viewer-tab";

const DRAG_THRESHOLD_PX = 5;

export type ReorderState = {
  srcIdx: number;
  // insertIdx is the splice position 0..len. `srcIdx` and `srcIdx + 1` are
  // both visually-no-op slots — they round-trip to the current order.
  insertIdx: number;
  // Drag is "armed" until movement exceeds the threshold, then "active".
  // Click suppression only kicks in once active is true.
  active: boolean;
};

// Anything with left + width is enough for the insertion math; we accept a
// plain shape so the pure function can be tested without a DOM.
export type RectLike = { left: number; width: number };

// computeInsertIdxFromRects returns the splice index 0..rects.length that
// best matches `x`. Each tab claims [left, left + width/2) as "insert before
// me" and [left + width/2, left + width) as "insert after me". A click past
// the last tab's midpoint maps to rects.length (= append).
export function computeInsertIdxFromRects(
  rects: readonly RectLike[],
  x: number,
): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x < r.left + r.width / 2) return i;
  }
  return rects.length;
}

type Options = {
  // Total viewer count — drag is suppressed when count < 2 (no reorder target).
  count: number;
  // Apply the reorder. Spec §12.4: caller's pure-function layer (moveViewer)
  // already handles no-op and out-of-range cases, but we still pre-filter
  // here to avoid logging an info-level commit that didn't move anything.
  onReorder: (fromIdx: number, toIdx: number) => void;
};

export type UseViewerTabReorder = {
  state: ReorderState | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  // startDrag is wired to the per-tab onPointerDown. The caller is responsible
  // for the upstream guards (close-button hit, rename mode, button !== 0) —
  // see spec §5.2 — because the hook can't see those.
  startDrag: (srcIdx: number, ev: { clientX: number; clientY: number }) => void;
  // shouldSuppressClick returns true for one tick after a drag commit/cancel
  // so the wrapper click that fires right after pointerup can be ignored.
  // (Tabs use `onClick` for activate, which would otherwise race with the
  // drop the user just made — spec §5.5.)
  shouldSuppressClick: () => boolean;
};

export function useViewerTabReorder(opts: Options): UseViewerTabReorder {
  const { count, onReorder } = opts;
  const [state, setState] = useState<ReorderState | null>(null);
  const stateRef = useRef<ReorderState | null>(null);
  stateRef.current = state;
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const releaseStyleRef = useRef<(() => void) | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks pointerup→click suppression. true for one render cycle after the
  // pointerup that ended an active drag; cleared on the next animation frame.
  const justFinishedDragRef = useRef(false);
  // onReorder is captured via ref so the document listeners (re-attached only
  // when drag start/stops) don't have to redo work for callback identity churn.
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const startDrag = useCallback(
    (srcIdx: number, ev: { clientX: number; clientY: number }) => {
      // Reject if reorder is meaningless (single viewer).
      if (count < 2) return;
      // H-2: guard against a stray second pointerdown while a drag is in
      // progress. The first drag's release() would otherwise be replaced
      // here and orphan body styles.
      if (stateRef.current) return;
      startRef.current = { x: ev.clientX, y: ev.clientY };
      releaseStyleRef.current?.();
      releaseStyleRef.current = pushBodyStyle({
        cursor: "grabbing",
        userSelect: "none",
      });
      setState({
        srcIdx,
        insertIdx: srcIdx,
        active: false,
      });
    },
    [count],
  );

  useEffect(() => {
    if (!state) return;
    const onMove = (e: PointerEvent) => {
      const cur = stateRef.current;
      if (!cur) return;
      const start = startRef.current;
      const movedFar =
        cur.active ||
        (start != null &&
          Math.hypot(e.clientX - start.x, e.clientY - start.y) >=
            DRAG_THRESHOLD_PX);
      if (!movedFar) {
        // Armed but under threshold — no state update needed. Ghost position
        // isn't tracked (no ghost rendering in Phase 1), and insertIdx is
        // held at srcIdx (= no-op slot) until we cross the threshold, so
        // re-rendering here would be pure waste.
        return;
      }
      const insertIdx = computeInsertIdxFromContainer(
        containerRef.current,
        e.clientX,
        cur.insertIdx,
      );
      // Skip the state update when nothing visible changes — same insertIdx
      // and already-active means the indicator / dragging class don't move.
      if (cur.active && insertIdx === cur.insertIdx) return;
      setState({
        ...cur,
        insertIdx,
        active: true,
      });
    };
    const onUp = () => {
      const cur = stateRef.current;
      endDrag();
      if (!cur) return;
      if (!cur.active) {
        // armed-only pointerup is a normal click — leave it to the wrapper.
        return;
      }
      justFinishedDragRef.current = true;
      // Clear suppression on the next frame. requestAnimationFrame is enough
      // because the synthetic click fires within the same task as pointerup.
      requestAnimationFrame(() => {
        justFinishedDragRef.current = false;
      });
      const from = cur.srcIdx;
      const to = cur.insertIdx;
      if (to === from || to === from + 1) {
        logger.debug("viewer-tab-dnd", "no-op", { from, to });
        return;
      }
      logger.info("viewer-tab-dnd", "commit", { from, to });
      onReorderRef.current(from, to);
    };
    const onCancel = () => {
      const cur = stateRef.current;
      if (cur?.active) {
        logger.info("viewer-tab-dnd", "cancel", { reason: "pointercancel" });
      }
      endDrag();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const cur = stateRef.current;
        if (cur?.active) {
          logger.info("viewer-tab-dnd", "cancel", { reason: "escape" });
        }
        endDrag();
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey);
      // Best-effort restore in case the hook unmounts mid-drag (H-2).
      releaseStyleRef.current?.();
      releaseStyleRef.current = null;
    };
    // Re-attach only when drag start/stops, not on ghostX churn.
  }, [Boolean(state)]);

  function endDrag() {
    setState(null);
    startRef.current = null;
    releaseStyleRef.current?.();
    releaseStyleRef.current = null;
  }

  const shouldSuppressClick = useCallback(() => justFinishedDragRef.current, []);

  return { state, containerRef, startDrag, shouldSuppressClick };
}

// computeInsertIdxFromContainer reads the tab rects from `container` and
// returns the splice index. When `container` is missing or the pointer is
// outside its horizontal range, the previous insertIdx is preserved so the
// indicator doesn't snap to an arbitrary position while the user briefly
// hovers over the "一覧" tab / "+" button (spec §12.5).
function computeInsertIdxFromContainer(
  container: HTMLElement | null,
  x: number,
  fallback: number,
): number {
  if (!container) return fallback;
  const rect = container.getBoundingClientRect();
  if (x < rect.left || x > rect.right) return fallback;
  const tabs = Array.from(
    container.querySelectorAll<HTMLElement>(`[${DATA_VIEWER_TAB}]`),
  );
  const rects: RectLike[] = tabs.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  return computeInsertIdxFromRects(rects, x);
}
