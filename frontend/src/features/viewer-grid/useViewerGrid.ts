import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GetImageInfo } from "../../../wailsjs/go/main/App";
import { useToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { basename } from "../../shared/utils/path";
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
  splitWithNewLeaf,
  updateTabInLeaf,
  type Edge,
  type Layout,
  type SplitDirection,
} from "./layout";
import { newTab, type Tab } from "./useTabs";

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
          logger.warn("dnd", "panel limit reached", {
            panels: MAX_PANELS,
            attempt: "split",
          });
          return cur;
        }
        const r = splitTabIntoEdge(cur, srcLeafId, srcIdx, dstLeafId, edge);
        ok = r.ok;
        if (!r.ok) {
          logger.warn("dnd", "split refused", {
            reason: r.reason,
            src: srcLeafId,
            dst: dstLeafId,
            edge,
          });
        }
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
          logger.warn("dnd", "panel limit reached", {
            panels: MAX_PANELS,
            attempt: "context-menu",
          });
          return cur;
        }
        const r = splitFromContextMenu(cur, leafId, tabIdx, direction);
        ok = r.ok;
        if (!r.ok) {
          logger.warn("dnd", "split refused", {
            reason: r.reason,
            leaf: leafId,
            direction,
          });
        }
        return r.layout;
      });
      return ok;
    },
    [toast],
  );

  const setSplitRatioCb = useCallback((splitId: string, ratio: number) => {
    setLayout((cur) => setSplitRatio(cur, splitId, ratio));
  }, []);

  // Pre-flight one image: returns true if the path is openable (size OK), false
  // if it's oversized or unreadable. Side-effects: emits a toast + log line on
  // rejection.
  const preflight = useCallback(
    async (path: string): Promise<boolean> => {
      let info: { width: number; height: number };
      try {
        info = await GetImageInfo(path);
      } catch (e) {
        const msg = errorMessage(e);
        toast(`画像を開けません: ${basename(path)} — ${msg}`, "error");
        logger.warn("image", "open failed", { path, err: msg });
        return false;
      }
      if (info.width * info.height > MAX_PIXELS) {
        const mp = ((info.width * info.height) / 1_000_000).toFixed(1);
        const limit = MAX_PIXELS / 1_000_000;
        toast(
          `画像が大きすぎます: ${basename(path)} (${mp}MP > ${limit}MP)`,
          "warn",
        );
        logger.warn("image", "oversized", {
          path,
          width: info.width,
          height: info.height,
          mp,
          limitMp: limit,
        });
        return false;
      }
      return true;
    },
    [toast],
  );

  // Bulk: append each image as a new tab in the active panel. Existing paths
  // are deduped (focus moves to the existing tab instead of creating one).
  const openManyInActive = useCallback(
    async (paths: string[]): Promise<{ opened: number; skipped: number }> => {
      let opened = 0;
      let skipped = 0;
      logger.info("viewer", "open-many-in-tabs start", { count: paths.length });
      for (const path of paths) {
        const ok = await preflight(path);
        if (!ok) {
          skipped++;
          continue;
        }
        setLayout((l) => appendOrFocusInActive(l, path));
        opened++;
      }
      logger.info("viewer", "open-many-in-tabs done", { opened, skipped });
      return { opened, skipped };
    },
    [preflight],
  );

  // Bulk: split the active panel for each image so each lands in its own
  // panel. The first image fills the active leaf if it is currently empty
  // (avoids creating a useless empty sibling on app start).
  const openManyAsSplit = useCallback(
    async (paths: string[]): Promise<{ opened: number; skipped: number }> => {
      let opened = 0;
      let skipped = 0;
      logger.info("viewer", "open-many-split start", { count: paths.length });
      for (const path of paths) {
        if (countLeaves(layoutRef.current.root) >= MAX_PANELS) {
          toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
          const remaining = paths.length - (opened + skipped);
          logger.warn("viewer", "open-many-split aborted", {
            opened,
            skippedSoFar: skipped,
            remaining,
            reason: "panel limit",
          });
          skipped += remaining;
          break;
        }
        const ok = await preflight(path);
        if (!ok) {
          skipped++;
          continue;
        }
        setLayout((l) => {
          const active = findLeaf(l.root, l.activeId);
          if (active && active.tabs.length === 0) {
            // First-image-into-empty-active: fill in place rather than split.
            return appendOrFocusInActive(l, path);
          }
          const r = splitWithNewLeaf(l, l.activeId, "right", newTab(path));
          return r.ok ? r.layout : l;
        });
        opened++;
      }
      logger.info("viewer", "open-many-split done", { opened, skipped });
      return { opened, skipped };
    },
    [preflight, toast],
  );

  // Stabilize the return object so downstream effects (e.g. App.tsx keydown)
  // only re-run when something actually changed — not on every parent render.
  return useMemo(
    () => ({
      layout,
      openInActive,
      openManyInActive,
      openManyAsSplit,
      setActivePanel: setActivePanelCb,
      setActiveTab,
      closeTab,
      updateTabState,
      moveTab,
      reorderTab,
      splitTab,
      splitFromContext,
      setSplitRatio: setSplitRatioCb,
    }),
    [
      layout,
      openInActive,
      openManyInActive,
      openManyAsSplit,
      setActivePanelCb,
      setActiveTab,
      closeTab,
      updateTabState,
      moveTab,
      reorderTab,
      splitTab,
      splitFromContext,
      setSplitRatioCb,
    ],
  );
}
