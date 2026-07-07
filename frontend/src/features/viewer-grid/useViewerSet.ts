// useViewerSet — マルチビューア state hook (#11)。ViewerSet 全体 (N 個の独立 BSP layout +
// active viewer pointer) を持ち、以下を公開する:
//   - viewer 単位: add / close / rename / setActive
//   - panel 単位 (open / split / move 等): **active viewer** の layout を対象
//   - openInViewer / openManyInViewer / openManyAsSplitInViewer: SampleModal の viewer
//     ピッカー + bulk UI が使う薄いラッパ
//   - moveTabToViewer: TabContextMenu の viewer 間移動 (§5.7)
//
// state は 1 つの useState (ViewerSet 全体) に集約。純関数は viewers.ts / layout/、この
// ファイルは React 配線 + pre-flight + toast + logging だけ。共有 stateless helper は
// useViewerSet.helpers.ts。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GetImageInfo } from "../../../wailsjs/go/main/App";
import { useToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { basename } from "../../shared/utils/path";
import {
  appendOrFocusInActive,
  closeTabInLeaf,
  closeTabsForPathInLayout,
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
  updateTabInLeaf,
  type Edge,
  type Layout,
  type SplitDirection,
} from "./layout";
import { type Tab } from "./useTabs";
import {
  activeViewer,
  addViewer,
  closeViewer,
  initialViewerSet,
  MAX_VIEWERS,
  moveTabAcrossViewers,
  moveViewer,
  openPathInViewer,
  renameViewer,
  sanitizeName,
  setActiveViewer,
  updateViewerLayout,
  type ViewerSet,
} from "./viewers";
import {
  leafTabsCount,
  openPathAsSplitOrAppend,
} from "./useViewerSet.helpers";

export type ConfirmFn = (message: string) => Promise<boolean>;

// 歴史的な hardcode 上限 (200 MP)。App.tsx が settings.maxImagePixelsMP から live 値を計算し
// opts.maxImagePixels で渡す。この定数は settings ロード中の fallback のみ。
export const DEFAULT_MAX_PIXELS = 200_000_000;

export { MAX_PANELS, MAX_VIEWERS };
export type { Edge, Layout, SplitDirection };

// この hook はあえて confirm callback を受けない。viewer close の確認は App.tsx
// (closeViewerWithConfirm) にある — dialog 文言に hook が持たない context (対象名 + tab 数) が
// 要るため。ConfirmFn 型を export し続けるのは useClassification がここから import して使うから。
export function useViewerSet(opts?: {
  initialSet?: ViewerSet;
  maxImagePixels?: number;
}) {
  const [set, setSet] = useState<ViewerSet>(
    opts?.initialSet ?? initialViewerSet(),
  );

  const maxPixelsRef = useRef(opts?.maxImagePixels ?? DEFAULT_MAX_PIXELS);
  useEffect(() => {
    maxPixelsRef.current = opts?.maxImagePixels ?? DEFAULT_MAX_PIXELS;
  }, [opts?.maxImagePixels]);

  // 最新 set を ref に保ち、async callback (preflight + bulk loop) が毎変更で作り直さず live state を読めるように。
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

  // 呼び出し側が必要なら確認済みと仮定 (§5.4、confirm dialog は App.tsx)。最後の 1 個は閉じない。
  const closeViewerCb = useCallback((id: string) => {
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
  }, []);

  const renameViewerCb = useCallback(
    (id: string, name: string) => {
      // renameViewer が同じ set を返す 2 理由を区別する:
      //   (a) sanitize → null (空/空白) — toast + warn すべき本当の拒否。
      //   (b) sanitized 名が既存名と同じ — silent no-op (変更なしの blur / Enter)。
      // ここで先に sanitize することで綺麗に分岐できる。無いと両方が next === cur に潰れ、
      // 変更なし commit のたびに誤解を招く "名前を空にできません" toast が出る。
      const sanitized = sanitizeName(name);
      if (sanitized === null) {
        toast("名前を空にできません", "warn");
        logger.warn("viewer-set", "rename refused", {
          id,
          attempted: name,
        });
        return;
      }
      setSet((cur) => {
        const target = cur.viewers.find((v) => v.id === id);
        if (!target) return cur;
        if (target.name === sanitized) return cur; // (b) — silent no-op
        const next = renameViewer(cur, id, sanitized);
        if (next === cur) return cur; // 防御的; sanitize は既に通過
        logger.info("viewer-set", "rename", {
          id,
          oldName: target.name,
          newName: sanitized,
        });
        return next;
      });
    },
    [toast],
  );

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

  // moveViewer 純関数のラッパ。呼び出し側は挿入位置 (0..len, DnD insertIdx と同じ) を渡す。
  // activeViewerId は不変 (移動 viewer は identity を保つので index ベースのキーバインドも自然に追従)。
  const reorderViewerCb = useCallback((fromIdx: number, toIdx: number) => {
    setSet((cur) => {
      const next = moveViewer(cur, fromIdx, toIdx);
      if (next === cur) return cur;
      logger.info("viewer-set", "reorder", {
        from: fromIdx,
        to: toIdx,
      });
      return next;
    });
  }, []);

  // ─── helpers: apply a Layout transform to one viewer ───────────────

  // fn(activeViewerLayout) を実行して書き戻す。cross-viewer state が不要な単一 viewer mutation 用。
  const applyToActive = useCallback((fn: (layout: Layout) => Layout) => {
    setSet((cur) => {
      const av = activeViewer(cur);
      const nextLayout = fn(av.layout);
      if (nextLayout === av.layout) return cur;
      return updateViewerLayout(cur, av.id, nextLayout);
    });
  }, []);

  // applyToActive の任意 viewerId 版。bulk の "open in viewer X" が使う。
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

  // active / 対象 layout が既に MAX_PANELS leaf のとき panel 作成 op を短絡。toast+warn を集約。
  const enforcePanelLimit = useCallback(
    (layout: Layout, attempt: string): boolean => {
      if (countLeaves(layout.root) < MAX_PANELS) return true;
      toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
      logger.warn("dnd", "panel limit reached", {
        panels: MAX_PANELS,
        attempt,
      });
      return false;
    },
    [toast],
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
    (srcLeafId: string, srcIdx: number, dstLeafId: string, dstIdx?: number) => {
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

  // 成功を返し、呼び出し側 (DnD) が pending state を畳むか判断できるようにする。
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
        if (!enforcePanelLimit(av.layout, "split")) return cur;
        const r = splitTabIntoEdge(av.layout, srcLeafId, srcIdx, dstLeafId, edge);
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
    [enforcePanelLimit],
  );

  const splitFromContext = useCallback(
    (leafId: string, tabIdx: number, direction: SplitDirection): boolean => {
      let ok = false;
      setSet((cur) => {
        const av = activeViewer(cur);
        if (!enforcePanelLimit(av.layout, "context-menu")) return cur;
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
    [enforcePanelLimit],
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

  // ─── bulk-apply helpers ────────────────────────────────────────────

  // 各 path に preflight + apply を実行。opened / skipped を集計し ${op} start / done をログ。
  // extra フィールド (viewerId 等) は各ログ行にマージ。
  const applyManyWithPreflight = useCallback(
    async (
      paths: string[],
      apply: (path: string) => void,
      op: string,
      extra: Record<string, unknown> = {},
    ): Promise<{ opened: number; skipped: number }> => {
      let opened = 0;
      let skipped = 0;
      logger.info("viewer", `${op} start`, { count: paths.length, ...extra });
      for (const path of paths) {
        const ok = await preflight(path);
        if (!ok) {
          skipped++;
          continue;
        }
        apply(path);
        opened++;
      }
      logger.info("viewer", `${op} done`, { opened, skipped, ...extra });
      return { opened, skipped };
    },
    [preflight],
  );

  // applyManyWithPreflight + iteration ごとの panel 数 snapshot (getLayout 経由)。各ステップが
  // panel を足す "open as split" bulk 用。getLayout が null なら silent abort (loop 中に対象 viewer 消失)。
  const applyManyWithLimit = useCallback(
    async (
      paths: string[],
      getLayout: () => Layout | null,
      apply: (path: string) => void,
      op: string,
      extra: Record<string, unknown> = {},
    ): Promise<{ opened: number; skipped: number }> => {
      let opened = 0;
      let skipped = 0;
      logger.info("viewer", `${op} start`, { count: paths.length, ...extra });
      for (const path of paths) {
        // viewer 存在チェックは preflight の前: viewer の有無は前 iteration の apply() commit に
        // 依存しないので待つ race が無い。早期 bail で、既に消えた viewer 向け path に誤った
        // file-error toast を出さない。
        if (getLayout() === null) {
          skipped += paths.length - (opened + skipped);
          break;
        }
        const ok = await preflight(path);
        if (!ok) {
          skipped++;
          continue;
        }
        // preflight await の *後* に再 snapshot。(a) 前 iteration の apply() の setState は yield 中に
        // commit されるので、await 前に countLeaves を読むと stale で MAX_PANELS を超えて走り
        // splitWithNewLeaf が各ステップ silent 拒否する。(b) preflight 中に対象 viewer が閉じられうるので、
        // 2 度目の null チェックで集計を正しく保つ。
        const l = getLayout();
        if (!l) {
          skipped += paths.length - (opened + skipped);
          break;
        }
        if (countLeaves(l.root) >= MAX_PANELS) {
          toast(`パネル数の上限 (${MAX_PANELS}) に達しました`, "warn");
          const remaining = paths.length - (opened + skipped);
          logger.warn("viewer", `${op} aborted`, {
            opened,
            skippedSoFar: skipped,
            remaining,
            reason: "panel limit",
            ...extra,
          });
          skipped += remaining;
          break;
        }
        apply(path);
        opened++;
      }
      logger.info("viewer", `${op} done`, { opened, skipped, ...extra });
      return { opened, skipped };
    },
    [preflight, toast],
  );

  // ─── open paths (active viewer) ────────────────────────────────────

  const openInActive = useCallback(
    async (path: string) => {
      // fast path: active leaf に既に tab があれば refocus だけ。
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
    (paths: string[]) =>
      applyManyWithPreflight(
        paths,
        (path) => applyToActive((l) => appendOrFocusInActive(l, path)),
        "open-many-in-tabs",
      ),
    [applyManyWithPreflight, applyToActive],
  );

  const openManyAsSplit = useCallback(
    (paths: string[]) =>
      applyManyWithLimit(
        paths,
        () => activeViewer(setRef.current).layout,
        (path) => applyToActive((l) => openPathAsSplitOrAppend(l, path)),
        "open-many-split",
      ),
    [applyManyWithLimit, applyToActive],
  );

  // ─── open paths (specific viewer, used by SampleModal + bulk) ─────

  // *対象* viewer の active leaf に同じ semantics を適用。active viewer は切り替えない —
  // 切替 / setTopTab は呼び出し側 (App.tsx onOpenInViewer) が決める。
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
    (viewerId: string, paths: string[]) =>
      applyManyWithPreflight(
        paths,
        (path) => setSet((cur) => openPathInViewer(cur, viewerId, path)),
        "open-many-in-tabs(viewer)",
        { viewerId },
      ),
    [applyManyWithPreflight],
  );

  const openManyAsSplitInViewer = useCallback(
    (viewerId: string, paths: string[]) =>
      applyManyWithLimit(
        paths,
        () =>
          setRef.current.viewers.find((vv) => vv.id === viewerId)?.layout ??
          null,
        (path) =>
          applyToViewer(viewerId, (l) => openPathAsSplitOrAppend(l, path)),
        "open-many-split(viewer)",
        { viewerId },
      ),
    [applyManyWithLimit, applyToViewer],
  );

  // ─── delete-driven tab cleanup (#47) ───────────────────────────────

  // 全 viewer の layout を walk し path === absPath の tab を全て閉じる。画像削除成功後に
  // ghost tab を残さない用。一致なしなら no-op なので、呼び出し側は delete 後に無条件で呼べる。
  const closeTabsForPath = useCallback((absPath: string) => {
    setSet((cur) => {
      let changed = false;
      const nextViewers = cur.viewers.map((v) => {
        const nextLayout = closeTabsForPathInLayout(v.layout, absPath);
        if (nextLayout === v.layout) return v;
        changed = true;
        return { ...v, layout: nextLayout };
      });
      if (!changed) return cur;
      logger.info("viewer-set", "closeTabsForPath", { path: absPath });
      return { ...cur, viewers: nextViewers };
    });
  }, []);

  // ─── cross-viewer tab move ─────────────────────────────────────────

  // active viewer のパネルで tab を右クリックし「ビューア X へ移動」を選ぶ。activeViewerId は
  // 変えない (ユーザーは src で作業を続ける; spec §4.6)。
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

  // 下流 effect (App.tsx keydown) が毎 re-render で churn しないよう memo 化。identity は set 変更時
  // (callback は setSet + stable ref を閉じ込むので変わらない) のみ変わる。
  const av = activeViewer(set);
  return useMemo(
    () => ({
      // viewer set の state
      viewers: set.viewers,
      activeViewerId: set.activeViewerId,
      activeViewer: av,
      layout: av.layout,
      // viewer-level
      addViewer: addViewerCb,
      closeViewer: closeViewerCb,
      renameViewer: renameViewerCb,
      setActiveViewer: setActiveViewerCb,
      reorderViewer: reorderViewerCb,
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
      // delete-driven cleanup
      closeTabsForPath,
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
      reorderViewerCb,
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
      closeTabsForPath,
      moveTabToViewer,
    ],
  );
}
