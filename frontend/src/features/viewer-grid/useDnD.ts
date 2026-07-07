import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../../shared/utils/logger";
import { pushBodyStyle } from "../../shared/utils/bodyStyles";
import type { Edge } from "./layout";

// tab ドラッグ中に認識する drop ターゲット。
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
  // 閾値を超えるまで "armed"、超えたら "active"。
  active: boolean;
};

const DRAG_THRESHOLD_PX = 5;

// elementFromPoint で drop ターゲットを探す data-* 属性。
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
  // global handler を安定させるため state をミラー。
  const stateRef = useRef<DnDState | null>(null);
  stateRef.current = state;
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const releaseStyleRef = useRef<(() => void) | null>(null);
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
      // ドラッグ中は document 全体で text 選択と I-beam カーソルを抑止。endDrag() で token
      // stack 経由で解放し、並行要求元 (splitter 等) とクリーンに合成する。
      releaseStyleRef.current?.();
      releaseStyleRef.current = pushBodyStyle({
        cursor: "grabbing",
        userSelect: "none",
      });
      logger.info("dnd", "start", {
        src: srcLeafId,
        idx: srcTabIdx,
        path: tabPath,
      });
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
      if (!cur) return;
      if (!cur.active) {
        // 閾値を超える移動なしの pointerdown = 通常クリック。ログ不要。
        return;
      }
      if (!cur.hit) {
        logger.info("dnd", "cancel", { reason: "no drop target" });
        return;
      }
      commitDrop(cur, actionsRef.current);
    };
    const onCancel = () => {
      const cur = stateRef.current;
      if (cur?.active) logger.info("dnd", "cancel", { reason: "pointercancel" });
      endDrag();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const cur = stateRef.current;
        if (cur?.active) logger.info("dnd", "cancel", { reason: "escape" });
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
      // ドラッグ中に unmount した場合の best-effort 復元。
      releaseStyleRef.current?.();
      releaseStyleRef.current = null;
    };
  }, [Boolean(state)]); // drag 開始/終了で再アタッチ

  // state + start ref + body styles をクリア。pointerup (commit / no-hit) と pointercancel が使う。
  function endDrag() {
    setState(null);
    startRef.current = null;
    releaseStyleRef.current?.();
    releaseStyleRef.current = null;
  }

  return { dnd: state, startDrag };
}

// カーソル下の drop ターゲットを解決。tab-bar は視覚的にパネル内にあるのでパネルより優先。
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

// spec §8.1: 端 20% / 中央 60%×60%、角は相対距離の近い方で決める。
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

function commitDrop(state: DnDState, actions: DnDActions) {
  const hit = state.hit;
  if (!hit) return;
  switch (hit.kind) {
    case "tab-bar":
      if (hit.leafId === state.srcLeafId) {
        logger.info("dnd", "commit", {
          kind: "reorder",
          leaf: hit.leafId,
          from: state.srcTabIdx,
          to: hit.insertIdx,
        });
        actions.reorderTab(hit.leafId, state.srcTabIdx, hit.insertIdx);
      } else {
        logger.info("dnd", "commit", {
          kind: "move-tab-bar",
          src: state.srcLeafId,
          srcIdx: state.srcTabIdx,
          dst: hit.leafId,
          dstIdx: hit.insertIdx,
        });
        actions.moveTab(
          state.srcLeafId,
          state.srcTabIdx,
          hit.leafId,
          hit.insertIdx,
        );
      }
      break;
    case "panel-center":
      if (hit.leafId === state.srcLeafId) {
        logger.info("dnd", "no-op", { reason: "drop on same panel center" });
        return;
      }
      logger.info("dnd", "commit", {
        kind: "move-center",
        src: state.srcLeafId,
        srcIdx: state.srcTabIdx,
        dst: hit.leafId,
      });
      actions.moveTab(state.srcLeafId, state.srcTabIdx, hit.leafId);
      break;
    case "panel-edge":
      logger.info("dnd", "commit", {
        kind: "split",
        src: state.srcLeafId,
        srcIdx: state.srcTabIdx,
        dst: hit.leafId,
        edge: hit.edge,
      });
      actions.splitTab(
        state.srcLeafId,
        state.srcTabIdx,
        hit.leafId,
        hit.edge,
      );
      break;
  }
}
