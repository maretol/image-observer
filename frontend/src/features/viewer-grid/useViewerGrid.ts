import { useCallback, useEffect, useRef, useState } from "react";
import { GetImageInfo } from "../../../wailsjs/go/main/App";
import { useToastFn } from "../../shared/components/Toast";
import {
  appendOrFocusInActive,
  closeTabInLeaf,
  countLeaves,
  findLeaf,
  initialLayout,
  MAX_PANELS,
  moveTabIntoLeaf,
  reorderTabInLeaf,
  setActivePanel,
  setActiveTabInLeaf,
  setSplitRatio,
  splitFromContextMenu,
  splitTabIntoEdge,
  updateTabInLeaf,
  type Edge,
  type Layout,
  type SplitDirection,
} from "./layout";
import type { Tab } from "./useTabs";

export type ConfirmFn = (message: string) => Promise<boolean>;

export const MAX_PIXELS = 200_000_000; // 200MP

export { MAX_PANELS } from "./layout";
export type { Edge, Layout, SplitDirection } from "./layout";

export function useViewerGrid(opts?: {
  initialLayout?: Layout;
  confirm?: ConfirmFn;
}) {
  const [layout, setLayout] = useState<Layout>(
    opts?.initialLayout ?? initialLayout(),
  );

  // Mirror latest layout into a ref so async callbacks (openInActive) can read
  // current state without re-creating callbacks on every layout change.
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const toast = useToastFn();

  const setActivePanelCb = useCallback((leafId: string) => {
    setLayout((cur) => setActivePanel(cur, leafId));
  }, []);

  const setActiveTab = useCallback((leafId: string, tabIndex: number) => {
    setLayout((cur) => setActiveTabInLeaf(cur, leafId, tabIndex));
  }, []);

  const closeTab = useCallback((leafId: string, tabIndex: number) => {
    setLayout((cur) => closeTabInLeaf(cur, leafId, tabIndex));
  }, []);

  const updateTabState = useCallback(
    (leafId: string, tabIndex: number, patch: Partial<Tab>) => {
      setLayout((cur) => updateTabInLeaf(cur, leafId, tabIndex, patch));
    },
    [],
  );

  const openInActive = useCallback(
    async (path: string) => {
      // Fast path: switch to existing tab without re-checking image info.
      const cur = layoutRef.current;
      const active = findLeaf(cur.root, cur.activeId);
      const existing = active?.tabs.findIndex((t) => t.path === path) ?? -1;
      if (active && existing >= 0) {
        setLayout((l) => setActiveTabInLeaf(l, active.id, existing));
        return;
      }

      // Pre-flight: header-only read for size threshold check.
      let info: { width: number; height: number };
      try {
        info = await GetImageInfo(path);
      } catch (e) {
        toast(`画像を開けません: ${basename(path)} — ${errorMessage(e)}`, "error");
        return;
      }
      if (info.width * info.height > MAX_PIXELS) {
        const mp = ((info.width * info.height) / 1_000_000).toFixed(1);
        const limit = MAX_PIXELS / 1_000_000;
        toast(
          `画像が大きすぎます: ${basename(path)} (${mp}MP > ${limit}MP)`,
          "warn",
        );
        return;
      }

      setLayout((l) => appendOrFocusInActive(l, path));
    },
    [toast],
  );

  const moveTab = useCallback(
    (
      srcLeafId: string,
      srcIdx: number,
      dstLeafId: string,
      dstIdx?: number,
    ) => {
      setLayout((cur) =>
        moveTabIntoLeaf(cur, srcLeafId, srcIdx, dstLeafId, dstIdx),
      );
    },
    [],
  );

  const reorderTab = useCallback(
    (leafId: string, srcIdx: number, dstIdx: number) => {
      setLayout((cur) => reorderTabInLeaf(cur, leafId, srcIdx, dstIdx));
    },
    [],
  );

  // Returns true on success, false when the panel cap is reached.
  const splitTab = useCallback(
    (
      srcLeafId: string,
      srcIdx: number,
      dstLeafId: string,
      edge: Edge,
    ): boolean => {
      let ok = false;
      setLayout((cur) => {
        if (countLeaves(cur.root) >= MAX_PANELS) {
          toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
          return cur;
        }
        const r = splitTabIntoEdge(cur, srcLeafId, srcIdx, dstLeafId, edge);
        ok = r.ok;
        return r.layout;
      });
      return ok;
    },
    [toast],
  );

  const splitFromContext = useCallback(
    (leafId: string, tabIdx: number, direction: SplitDirection): boolean => {
      let ok = false;
      setLayout((cur) => {
        if (countLeaves(cur.root) >= MAX_PANELS) {
          toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
          return cur;
        }
        const r = splitFromContextMenu(cur, leafId, tabIdx, direction);
        ok = r.ok;
        return r.layout;
      });
      return ok;
    },
    [toast],
  );

  const setSplitRatioCb = useCallback((splitId: string, ratio: number) => {
    setLayout((cur) => setSplitRatio(cur, splitId, ratio));
  }, []);

  return {
    layout,
    openInActive,
    setActivePanel: setActivePanelCb,
    setActiveTab,
    closeTab,
    updateTabState,
    moveTab,
    reorderTab,
    splitTab,
    splitFromContext,
    setSplitRatio: setSplitRatioCb,
  };
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
