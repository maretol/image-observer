import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge } from "./layout";

// Drop targets recognized while dragging a tab.
export type DropHit =
  | { kind: "panel-center"; leafId: string }
  | { kind: "panel-edge"; leafId: string; edge: Edge }
  | { kind: "tab-bar"; leafId: string; insertIdx: number };

export type DnDState = {
  srcLeafId: string;
  srcTabIdx: number;
  tabPath: string;
  ghost: { x: number; y: number };
  hit: DropHit | null;
  // Drag is "armed" until movement exceeds the threshold, then "active".
  active: boolean;
};

const DRAG_THRESHOLD_PX = 5;

// data-* attributes used to locate drop targets via elementFromPoint.
export const DATA_LEAF = "data-dnd-leaf";
export const DATA_TAB_BAR = "data-dnd-tab-bar";
export const DATA_TAB = "data-dnd-tab";

export type DnDActions = {
  moveTab: (
    srcLeafId: string,
    srcIdx: number,
    dstLeafId: string,
    dstIdx?: number,
  ) => void;
  reorderTab: (leafId: string, srcIdx: number, dstIdx: number) => void;
  splitTab: (
    srcLeafId: string,
    srcIdx: number,
    dstLeafId: string,
    edge: Edge,
  ) => boolean;
};

export function useDnD(actions: DnDActions) {
  const [state, setState] = useState<DnDState | null>(null);
  // Mirror state so global handlers stay stable.
  const stateRef = useRef<DnDState | null>(null);
  stateRef.current = state;
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const startDrag = useCallback(
    (
      srcLeafId: string,
      srcTabIdx: number,
      tabPath: string,
      ev: { clientX: number; clientY: number },
    ) => {
      startRef.current = { x: ev.clientX, y: ev.clientY };
      // Block text selection (user-select) and the I-beam cursor across the
      // whole document while dragging. Restored in endDrag().
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      setState({
        srcLeafId,
        srcTabIdx,
        tabPath,
        ghost: { x: ev.clientX, y: ev.clientY },
        hit: null,
        active: false,
      });
    },
    [],
  );

  useEffect(() => {
    if (!state) return;
    const onMove = (e: PointerEvent) => {
      const cur = stateRef.current;
      if (!cur) return;
      const start = startRef.current;
      const movedFar =
        cur.active ||
        (start &&
          Math.hypot(e.clientX - start.x, e.clientY - start.y) >=
            DRAG_THRESHOLD_PX);
      if (!movedFar) {
        setState({
          ...cur,
          ghost: { x: e.clientX, y: e.clientY },
        });
        return;
      }
      const hit = computeHit(e.clientX, e.clientY);
      setState({
        ...cur,
        ghost: { x: e.clientX, y: e.clientY },
        hit,
        active: true,
      });
    };
    const onUp = () => {
      const cur = stateRef.current;
      endDrag();
      if (!cur || !cur.active || !cur.hit) return;
      commitDrop(cur, actionsRef.current);
    };
    const onCancel = () => {
      endDrag();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      // Best-effort restore in case the component unmounts mid-drag.
      restoreBodyStyles();
    };
  }, [Boolean(state)]); // re-attach when drag starts/stops

  // endDrag clears state + start ref + body styles. Used by both pointerup
  // (commit / no-hit) and pointercancel.
  function endDrag() {
    setState(null);
    startRef.current = null;
    restoreBodyStyles();
  }

  return { dnd: state, startDrag };
}

// Resolve the drop target under the cursor. Tab-bar zones win over panel
// zones because the tab bar visually sits inside the panel.
export function computeHit(x: number, y: number): DropHit | null {
  const el = document.elementFromPoint(x, y);
  if (!el || !(el instanceof Element)) return null;

  const tabBar = el.closest(`[${DATA_TAB_BAR}]`);
  if (tabBar instanceof HTMLElement) {
    const leafId = tabBar.getAttribute(DATA_TAB_BAR);
    if (!leafId) return null;
    const insertIdx = computeTabInsertIndex(tabBar, x);
    return { kind: "tab-bar", leafId, insertIdx };
  }

  const panel = el.closest(`[${DATA_LEAF}]`);
  if (panel instanceof HTMLElement) {
    const leafId = panel.getAttribute(DATA_LEAF);
    if (!leafId) return null;
    const rect = panel.getBoundingClientRect();
    const rx = (x - rect.left) / Math.max(1, rect.width);
    const ry = (y - rect.top) / Math.max(1, rect.height);
    return resolveZone(leafId, rx, ry);
  }
  return null;
}

// Spec §8.1: 20% edges, 60%×60% center, corners decide by closer relative
// distance.
function resolveZone(leafId: string, rx: number, ry: number): DropHit {
  const left = rx;
  const right = 1 - rx;
  const top = ry;
  const bottom = 1 - ry;
  const horizontalEdge: Edge | null =
    left < 0.2 ? "left" : right < 0.2 ? "right" : null;
  const verticalEdge: Edge | null =
    top < 0.2 ? "top" : bottom < 0.2 ? "bottom" : null;

  if (horizontalEdge && verticalEdge) {
    const hd = horizontalEdge === "left" ? left : right;
    const vd = verticalEdge === "top" ? top : bottom;
    return {
      kind: "panel-edge",
      leafId,
      edge: hd <= vd ? horizontalEdge : verticalEdge,
    };
  }
  if (horizontalEdge) {
    return { kind: "panel-edge", leafId, edge: horizontalEdge };
  }
  if (verticalEdge) {
    return { kind: "panel-edge", leafId, edge: verticalEdge };
  }
  return { kind: "panel-center", leafId };
}

function computeTabInsertIndex(tabBar: HTMLElement, x: number): number {
  const tabEls = Array.from(
    tabBar.querySelectorAll<HTMLElement>(`[${DATA_TAB}]`),
  );
  for (let i = 0; i < tabEls.length; i++) {
    const r = tabEls[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return tabEls.length;
}

function restoreBodyStyles() {
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
}

function commitDrop(state: DnDState, actions: DnDActions) {
  const hit = state.hit;
  if (!hit) return;
  switch (hit.kind) {
    case "tab-bar":
      if (hit.leafId === state.srcLeafId) {
        actions.reorderTab(hit.leafId, state.srcTabIdx, hit.insertIdx);
      } else {
        actions.moveTab(
          state.srcLeafId,
          state.srcTabIdx,
          hit.leafId,
          hit.insertIdx,
        );
      }
      break;
    case "panel-center":
      if (hit.leafId === state.srcLeafId) return;
      actions.moveTab(state.srcLeafId, state.srcTabIdx, hit.leafId);
      break;
    case "panel-edge":
      actions.splitTab(
        state.srcLeafId,
        state.srcTabIdx,
        hit.leafId,
        hit.edge,
      );
      break;
  }
}
