// useViewerSet — multi-viewer state hook (#11). Owns the entire `ViewerSet`
// (N independent BSP layouts + active viewer pointer) and exposes:
//
//   - viewer-level mutations: add / close / rename / setActive
//   - panel-level mutations (open / split / move / etc.) that target the
//     **active viewer's** layout. These are the same operations the old
//     useViewerGrid exposed; we now route them through the active viewer.
//   - "openInViewer" / "openManyInViewer" / "openManyAsSplitInViewer" thin
//     wrappers used by the SampleModal viewer-picker and bulk-actions UI.
//   - "moveTabToViewer" for the TabContextMenu cross-viewer move (§5.7).
//
// All state goes through one useState (the entire ViewerSet). Pure functions
// live in viewers.ts and layout.ts; this file only does the React glue +
// pre-flight + toasts + logging.

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
  MAX_PANELS,
  moveTabIntoLeaf,
  reorderTabInLeaf,
  setActivePanel,
  setActiveTabInLeaf,
  setSplitRatio as setSplitRatioFn,
  splitFromContextMenu,
  splitTabIntoEdge,
  splitWithNewLeaf,
  updateTabInLeaf,
  type Edge,
  type Layout,
  type SplitDirection,
} from "./layout";
import { newTab, type Tab } from "./useTabs";
import {
  activeViewer,
  addViewer,
  closeViewer,
  initialViewerSet,
  MAX_VIEWERS,
  moveTabAcrossViewers,
  openPathInViewer,
  renameViewer,
  setActiveViewer,
  updateViewerLayout,
  type Viewer,
  type ViewerSet,
} from "./viewers";

export type ConfirmFn = (message: string) => Promise<boolean>;

// DEFAULT_MAX_PIXELS is the historical hardcoded ceiling (200 MP). Callers
// (App.tsx) compute the live limit from settings.maxImagePixelsMP and pass it
// via `opts.maxImagePixels`; this constant only acts as a fallback while
// settings finish loading.
export const DEFAULT_MAX_PIXELS = 200_000_000;

export { MAX_PANELS, MAX_VIEWERS };
export type { Edge, Layout, SplitDirection };

export function useViewerSet(opts?: {
  initialSet?: ViewerSet;
  confirm?: ConfirmFn;
  maxImagePixels?: number;
}) {
  const [set, setSet] = useState<ViewerSet>(
    opts?.initialSet ?? initialViewerSet(),
  );

  const maxPixelsRef = useRef(opts?.maxImagePixels ?? DEFAULT_MAX_PIXELS);
  useEffect(() => {
    maxPixelsRef.current = opts?.maxImagePixels ?? DEFAULT_MAX_PIXELS;
  }, [opts?.maxImagePixels]);

  // Keep the latest set in a ref so async callbacks (preflight + bulk loops)
  // can read live state without re-creating themselves on every change.
  const setRef = useRef(set);
  useEffect(() => {
    setRef.current = set;
  }, [set]);

  const toast = useToastFn();

  // ─── viewer-level mutations ────────────────────────────────────────

  const addViewerCb = useCallback(() => {
    setSet((cur) => {
      if (cur.viewers.length >= MAX_VIEWERS) {
        toast(`ビューア数の上限 (${MAX_VIEWERS}) に達しました`, "warn");
        logger.warn("viewer-set", "add refused", { max: MAX_VIEWERS });
        return cur;
      }
      const next = addViewer(cur);
      logger.info("viewer-set", "add", {
        id: next.viewers[next.viewers.length - 1].id,
        total: next.viewers.length,
      });
      return next;
    });
  }, [toast]);

  // closeViewerCb assumes the caller already obtained user confirmation when
  // appropriate (per §5.4 the confirm dialog lives in App.tsx). It still
  // refuses to close the last viewer (no UI for that path either).
  const closeViewerCb = useCallback(
    (id: string) => {
      setSet((cur) => {
        if (cur.viewers.length <= 1) {
          logger.warn("viewer-set", "close refused", {
            id,
            reason: "last viewer",
          });
          return cur;
        }
        const target = cur.viewers.find((v) => v.id === id);
        if (!target) return cur;
        const tabCount = leafTabsCount(target);
        const next = closeViewer(cur, id);
        logger.info("viewer-set", "close", {
          id,
          hadTabs: tabCount > 0,
          total: next.viewers.length,
        });
        return next;
      });
    },
    [],
  );

  const renameViewerCb = useCallback((id: string, name: string) => {
    setSet((cur) => {
      const target = cur.viewers.find((v) => v.id === id);
      if (!target) return cur;
      const next = renameViewer(cur, id, name);
      if (next === cur) {
        logger.warn("viewer-set", "rename refused", {
          id,
          attempted: name,
        });
        toast("名前を空にできません", "warn");
        return cur;
      }
      const newName = next.viewers.find((v) => v.id === id)?.name ?? "";
      logger.info("viewer-set", "rename", {
        id,
        oldName: target.name,
        newName,
      });
      return next;
    });
  }, [toast]);

  const setActiveViewerCb = useCallback((id: string) => {
    setSet((cur) => {
      if (cur.activeViewerId === id) return cur;
      const next = setActiveViewer(cur, id);
      if (next === cur) return cur;
      logger.debug("viewer-set", "setActive", {
        from: cur.activeViewerId,
        to: id,
      });
      return next;
    });
  }, []);

  // ─── helpers: apply a Layout transform to the active viewer ────────

  // applyToActive runs `fn(activeViewerLayout)` and writes back. Used for the
  // single-viewer mutations that don't need cross-viewer state (the bulk of
  // the Phase 5 layout operations).
  const applyToActive = useCallback(
    (fn: (layout: Layout) => Layout) => {
      setSet((cur) => {
        const av = activeViewer(cur);
        const nextLayout = fn(av.layout);
        if (nextLayout === av.layout) return cur;
        return updateViewerLayout(cur, av.id, nextLayout);
      });
    },
    [],
  );

  // applyToViewer is the same but for an arbitrary viewer ID — used by the
  // bulk-actions "open in viewer X" path.
  const applyToViewer = useCallback(
    (viewerId: string, fn: (layout: Layout) => Layout) => {
      setSet((cur) => {
        const v = cur.viewers.find((vv) => vv.id === viewerId);
        if (!v) return cur;
        const nextLayout = fn(v.layout);
        if (nextLayout === v.layout) return cur;
        return updateViewerLayout(cur, viewerId, nextLayout);
      });
    },
    [],
  );

  // ─── panel-level mutations (active viewer) ─────────────────────────

  const setActivePanelCb = useCallback(
    (leafId: string) => {
      applyToActive((l) => setActivePanel(l, leafId));
    },
    [applyToActive],
  );

  const setActiveTab = useCallback(
    (leafId: string, tabIndex: number) => {
      applyToActive((l) => setActiveTabInLeaf(l, leafId, tabIndex));
    },
    [applyToActive],
  );

  const closeTab = useCallback(
    (leafId: string, tabIndex: number) => {
      applyToActive((l) => closeTabInLeaf(l, leafId, tabIndex));
    },
    [applyToActive],
  );

  const updateTabState = useCallback(
    (leafId: string, tabIndex: number, patch: Partial<Tab>) => {
      applyToActive((l) => updateTabInLeaf(l, leafId, tabIndex, patch));
    },
    [applyToActive],
  );

  const moveTab = useCallback(
    (
      srcLeafId: string,
      srcIdx: number,
      dstLeafId: string,
      dstIdx?: number,
    ) => {
      applyToActive((l) =>
        moveTabIntoLeaf(l, srcLeafId, srcIdx, dstLeafId, dstIdx),
      );
    },
    [applyToActive],
  );

  const reorderTab = useCallback(
    (leafId: string, srcIdx: number, dstIdx: number) => {
      applyToActive((l) => reorderTabInLeaf(l, leafId, srcIdx, dstIdx));
    },
    [applyToActive],
  );

  // splitTab / splitFromContext mirror the previous useViewerGrid ones —
  // returning success so the caller (DnD) knows whether to dismiss its
  // pending state.
  const splitTab = useCallback(
    (
      srcLeafId: string,
      srcIdx: number,
      dstLeafId: string,
      edge: Edge,
    ): boolean => {
      let ok = false;
      setSet((cur) => {
        const av = activeViewer(cur);
        if (countLeaves(av.layout.root) >= MAX_PANELS) {
          toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
          logger.warn("dnd", "panel limit reached", {
            panels: MAX_PANELS,
            attempt: "split",
          });
          return cur;
        }
        const r = splitTabIntoEdge(
          av.layout,
          srcLeafId,
          srcIdx,
          dstLeafId,
          edge,
        );
        ok = r.ok;
        if (!r.ok) {
          logger.warn("dnd", "split refused", {
            reason: r.reason,
            src: srcLeafId,
            dst: dstLeafId,
            edge,
          });
        }
        return r.ok ? updateViewerLayout(cur, av.id, r.layout) : cur;
      });
      return ok;
    },
    [toast],
  );

  const splitFromContext = useCallback(
    (leafId: string, tabIdx: number, direction: SplitDirection): boolean => {
      let ok = false;
      setSet((cur) => {
        const av = activeViewer(cur);
        if (countLeaves(av.layout.root) >= MAX_PANELS) {
          toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
          logger.warn("dnd", "panel limit reached", {
            panels: MAX_PANELS,
            attempt: "context-menu",
          });
          return cur;
        }
        const r = splitFromContextMenu(av.layout, leafId, tabIdx, direction);
        ok = r.ok;
        if (!r.ok) {
          logger.warn("dnd", "split refused", {
            reason: r.reason,
            leaf: leafId,
            direction,
          });
        }
        return r.ok ? updateViewerLayout(cur, av.id, r.layout) : cur;
      });
      return ok;
    },
    [toast],
  );

  const setSplitRatioCb = useCallback(
    (splitId: string, ratio: number) => {
      applyToActive((l) => setSplitRatioFn(l, splitId, ratio));
    },
    [applyToActive],
  );

  // ─── pre-flight (size + decode) ────────────────────────────────────

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
      if (info.width * info.height > maxPixelsRef.current) {
        const mp = ((info.width * info.height) / 1_000_000).toFixed(1);
        const limit = Math.round(maxPixelsRef.current / 1_000_000);
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

  // ─── open paths (active viewer) ────────────────────────────────────

  const openInActive = useCallback(
    async (path: string) => {
      // Fast path: if the active leaf already has the tab, just refocus.
      const cur = setRef.current;
      const av = activeViewer(cur);
      const leaf = findLeaf(av.layout.root, av.layout.activeId);
      const existing = leaf?.tabs.findIndex((t) => t.path === path) ?? -1;
      if (leaf && existing >= 0) {
        applyToActive((l) => setActiveTabInLeaf(l, leaf.id, existing));
        return;
      }
      const ok = await preflight(path);
      if (!ok) return;
      applyToActive((l) => appendOrFocusInActive(l, path));
    },
    [applyToActive, preflight],
  );

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
        applyToActive((l) => appendOrFocusInActive(l, path));
        opened++;
      }
      logger.info("viewer", "open-many-in-tabs done", { opened, skipped });
      return { opened, skipped };
    },
    [applyToActive, preflight],
  );

  const openManyAsSplit = useCallback(
    async (paths: string[]): Promise<{ opened: number; skipped: number }> => {
      let opened = 0;
      let skipped = 0;
      logger.info("viewer", "open-many-split start", { count: paths.length });
      for (const path of paths) {
        const av = activeViewer(setRef.current);
        if (countLeaves(av.layout.root) >= MAX_PANELS) {
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
        applyToActive((l) => {
          const leaf = findLeaf(l.root, l.activeId);
          if (leaf && leaf.tabs.length === 0) {
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
    [applyToActive, preflight, toast],
  );

  // ─── open paths (specific viewer, used by SampleModal + bulk) ─────

  // openInViewer applies the same active-leaf semantics to the *target*
  // viewer's active leaf. Active viewer is NOT switched here — the caller
  // (App.tsx onOpenInViewer) decides whether to switch and to setTopTab.
  const openInViewer = useCallback(
    async (viewerId: string, path: string) => {
      const cur = setRef.current;
      const v = cur.viewers.find((vv) => vv.id === viewerId);
      if (!v) return;
      const leaf = findLeaf(v.layout.root, v.layout.activeId);
      const existing = leaf?.tabs.findIndex((t) => t.path === path) ?? -1;
      if (leaf && existing >= 0) {
        applyToViewer(viewerId, (l) =>
          setActiveTabInLeaf(l, leaf.id, existing),
        );
        return;
      }
      const ok = await preflight(path);
      if (!ok) return;
      setSet((cur2) => openPathInViewer(cur2, viewerId, path));
    },
    [applyToViewer, preflight],
  );

  const openManyInViewer = useCallback(
    async (
      viewerId: string,
      paths: string[],
    ): Promise<{ opened: number; skipped: number }> => {
      let opened = 0;
      let skipped = 0;
      logger.info("viewer", "open-many-in-tabs(viewer) start", {
        viewerId,
        count: paths.length,
      });
      for (const path of paths) {
        const ok = await preflight(path);
        if (!ok) {
          skipped++;
          continue;
        }
        setSet((cur) => openPathInViewer(cur, viewerId, path));
        opened++;
      }
      logger.info("viewer", "open-many-in-tabs(viewer) done", {
        viewerId,
        opened,
        skipped,
      });
      return { opened, skipped };
    },
    [preflight],
  );

  const openManyAsSplitInViewer = useCallback(
    async (
      viewerId: string,
      paths: string[],
    ): Promise<{ opened: number; skipped: number }> => {
      let opened = 0;
      let skipped = 0;
      logger.info("viewer", "open-many-split(viewer) start", {
        viewerId,
        count: paths.length,
      });
      for (const path of paths) {
        const v = setRef.current.viewers.find((vv) => vv.id === viewerId);
        if (!v) {
          skipped += paths.length - (opened + skipped);
          break;
        }
        if (countLeaves(v.layout.root) >= MAX_PANELS) {
          toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
          const remaining = paths.length - (opened + skipped);
          logger.warn("viewer", "open-many-split(viewer) aborted", {
            viewerId,
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
        applyToViewer(viewerId, (l) => {
          const leaf = findLeaf(l.root, l.activeId);
          if (leaf && leaf.tabs.length === 0) {
            return appendOrFocusInActive(l, path);
          }
          const r = splitWithNewLeaf(l, l.activeId, "right", newTab(path));
          return r.ok ? r.layout : l;
        });
        opened++;
      }
      logger.info("viewer", "open-many-split(viewer) done", {
        viewerId,
        opened,
        skipped,
      });
      return { opened, skipped };
    },
    [applyToViewer, preflight, toast],
  );

  // ─── cross-viewer tab move ─────────────────────────────────────────

  // moveTabToViewer: the user right-clicks a tab in the active viewer's
  // panel and picks "ビューア X へ移動". We never change activeViewerId
  // (the user keeps working in src; spec §4.6).
  const moveTabToViewer = useCallback(
    (srcLeafId: string, srcIdx: number, dstViewerId: string) => {
      setSet((cur) => {
        const srcViewerId = cur.activeViewerId;
        if (srcViewerId === dstViewerId) return cur;
        const next = moveTabAcrossViewers(
          cur,
          srcViewerId,
          srcLeafId,
          srcIdx,
          dstViewerId,
        );
        if (next === cur) return cur;
        const dstName =
          next.viewers.find((v) => v.id === dstViewerId)?.name ?? "";
        toast(`ビューア "${dstName}" に移動しました`, "info");
        logger.info("viewer-set", "moveTabToViewer", {
          srcViewerId,
          dstViewerId,
        });
        return next;
      });
    },
    [toast],
  );

  // ─── return ────────────────────────────────────────────────────────

  // Memoize so downstream effects (App.tsx keydown) don't churn on every
  // re-render. Identity changes only when the set changes or a callback
  // identity changes (which they don't, since they all close over setSet
  // and stable refs).
  const av = activeViewer(set);
  return useMemo(
    () => ({
      // viewer set state
      viewers: set.viewers,
      activeViewerId: set.activeViewerId,
      activeViewer: av,
      layout: av.layout,
      // viewer-level
      addViewer: addViewerCb,
      closeViewer: closeViewerCb,
      renameViewer: renameViewerCb,
      setActiveViewer: setActiveViewerCb,
      // panel-level (active viewer)
      setActivePanel: setActivePanelCb,
      setActiveTab,
      closeTab,
      updateTabState,
      moveTab,
      reorderTab,
      splitTab,
      splitFromContext,
      setSplitRatio: setSplitRatioCb,
      // open
      openInActive,
      openManyInActive,
      openManyAsSplit,
      openInViewer,
      openManyInViewer,
      openManyAsSplitInViewer,
      // cross-viewer
      moveTabToViewer,
    }),
    [
      set,
      av,
      addViewerCb,
      closeViewerCb,
      renameViewerCb,
      setActiveViewerCb,
      setActivePanelCb,
      setActiveTab,
      closeTab,
      updateTabState,
      moveTab,
      reorderTab,
      splitTab,
      splitFromContext,
      setSplitRatioCb,
      openInActive,
      openManyInActive,
      openManyAsSplit,
      openInViewer,
      openManyInViewer,
      openManyAsSplitInViewer,
      moveTabToViewer,
    ],
  );
}

// leafTabsCount sums the tab count across all leaves in a viewer's layout.
// Used only for the close-viewer log line ("did the user lose data?").
function leafTabsCount(v: Viewer): number {
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
