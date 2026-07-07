// トップタブ viewer 並べ替え DnD (#50, docs/spec-viewer-tab-reorder.md)。
// .top-tabs-viewers 用の最小 pointer-events DnD — panel 内の useDnD (より複雑な
// panel/edge/tab-bar drop) とは独立。useDnD と共通の idiom: 5px 閾値 / pushBodyStyle /
// pointercancel + Escape キャンセル / module scope state なし。

import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../../shared/utils/logger";
import { pushBodyStyle } from "../../shared/utils/bodyStyles";

// container 内の draggable な子要素の目印。hook が querySelectorAll で rect を集める。
// 属性値は index の文字列だが hook は rect の順序しか使わない。
export const DATA_VIEWER_TAB = "data-viewer-tab";

const DRAG_THRESHOLD_PX = 5;

export type ReorderState = {
  srcIdx: number;
  // splice 位置 0..len。srcIdx と srcIdx + 1 は共に視覚 no-op スロット (現在順に戻る)。
  insertIdx: number;
  // 閾値を超えるまで "armed"、超えたら "active"。click 抑止は active になってから。
  active: boolean;
};

// 挿入計算には left + width で十分。DOM なしで純関数を test できるよう plain shape を受ける。
export type RectLike = { left: number; width: number };

// x に最も合う splice index 0..rects.length を返す。各 tab は [left, left+width/2) を
// 「前に挿入」、[left+width/2, left+width) を「後に挿入」とする。最後の tab の中点を
// 越えたら rects.length (= append)。
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
  // viewer 総数 — count < 2 (並べ替え先なし) ならドラッグ抑止。
  count: number;
  // 並べ替えを適用。moveViewer が no-op / 範囲外を扱うが、動いていない info-level commit を
  // ログしないようここでも事前フィルタする (spec §12.4)。
  onReorder: (fromIdx: number, toIdx: number) => void;
};

export type UseViewerTabReorder = {
  state: ReorderState | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  // per-tab の onPointerDown に配線。上流の guard (閉じるボタン / rename モード / button !== 0)
  // は hook から見えないので呼び出し側の責任 (spec §5.2)。pointerId は他の並行 pointer の
  // move/up を無視するため必須 (multi-touch)。
  startDrag: (
    srcIdx: number,
    ev: { clientX: number; clientY: number; pointerId: number },
  ) => void;
  // active になった drag が終わった (commit / pointercancel / Escape) 直後 1 tick だけ true。
  // pointerup が飛ばす合成 click が source tab を再アクティブ化しないように。armed のみの
  // release は通常クリックで影響を受けない (spec §5.3)。
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
  // drag を起点 pointer に固定する。document リスナは global なので、これがないと 2 本目の指 /
  // マウスが insertIdx を動かしたり active drag に pointerup を飛ばしうる (AGENTS.md H-2)。
  const pointerIdRef = useRef<number | null>(null);
  // pointerup→click 抑止の追跡。active drag 終了 (commit/cancel) 後 1 render cycle だけ true、
  // 次の animation frame でクリア。
  const justFinishedDragRef = useRef(false);
  // onReorder を ref で捕捉し、document リスナ (drag 開始/終了時のみ再アタッチ) が callback
  // identity churn で作り直さずに済むように。
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  // active drag 終了後の trailing click 1 回分の latch + 自動クリア。commit / pointercancel /
  // Escape が共通実装を使うよう集約。
  const armSuppressClick = useCallback(() => {
    justFinishedDragRef.current = true;
    requestAnimationFrame(() => {
      justFinishedDragRef.current = false;
    });
  }, []);

  const startDrag = useCallback(
    (
      srcIdx: number,
      ev: { clientX: number; clientY: number; pointerId: number },
    ) => {
      // 並べ替えが無意味なら (単一 viewer) 拒否。
      if (count < 2) return;
      // H-2: drag 中の 2 本目の pointerdown を guard。でないと最初の drag の release() が
      // ここで置き換わり body styles が orphan になる。
      if (stateRef.current) return;
      pointerIdRef.current = ev.pointerId;
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
    // この drag を始めた pointer 以外の event を拒否する (AGENTS.md H-2、上の pointerIdRef と同旨)。
    const isOurPointer = (e: PointerEvent) =>
      pointerIdRef.current === null || e.pointerId === pointerIdRef.current;
    const onMove = (e: PointerEvent) => {
      if (!isOurPointer(e)) return;
      const cur = stateRef.current;
      if (!cur) return;
      const start = startRef.current;
      const movedFar =
        cur.active ||
        (start != null &&
          Math.hypot(e.clientX - start.x, e.clientY - start.y) >=
            DRAG_THRESHOLD_PX);
      if (!movedFar) {
        // armed だが閾値未満 — state 更新不要。ghost 位置は追わず (Phase 1 で ghost 描画なし)、
        // insertIdx は閾値を越えるまで srcIdx (no-op スロット) のままなので、ここで再 render は無駄。
        return;
      }
      const insertIdx = computeInsertIdxFromContainer(
        containerRef.current,
        e.clientX,
        cur.insertIdx,
      );
      // 見た目が変わらなければ state 更新を skip (同 insertIdx かつ active 済みなら indicator は動かない)。
      if (cur.active && insertIdx === cur.insertIdx) return;
      setState({
        ...cur,
        insertIdx,
        active: true,
      });
    };
    const onUp = (e: PointerEvent) => {
      if (!isOurPointer(e)) return;
      const cur = stateRef.current;
      endDrag();
      if (!cur) return;
      if (!cur.active) {
        // armed のみの pointerup は通常クリック — wrapper に任せる。
        return;
      }
      // active 終了は trailing click を常に抑止 (reorder commit でも同スロット no-op でも、
      // 両方 "drop" に感じられ source tab を再アクティブ化すべきでない)。
      armSuppressClick();
      const from = cur.srcIdx;
      const to = cur.insertIdx;
      if (to === from || to === from + 1) {
        logger.debug("viewer-tab-dnd", "no-op", { from, to });
        return;
      }
      logger.info("viewer-tab-dnd", "commit", { from, to });
      onReorderRef.current(from, to);
    };
    const onCancel = (e: PointerEvent) => {
      if (!isOurPointer(e)) return;
      const cur = stateRef.current;
      if (cur?.active) {
        logger.info("viewer-tab-dnd", "cancel", { reason: "pointercancel" });
        // commit と同じ trailing-click 抑止。pointercancel が合成 click を出すのは稀だが、出ても
        // source tab を再アクティブ化させない (Escape 経路との UX 対称)。
        armSuppressClick();
      }
      endDrag();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const cur = stateRef.current;
        if (cur?.active) {
          logger.info("viewer-tab-dnd", "cancel", { reason: "escape" });
          armSuppressClick();
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
      // drag 中に hook が unmount した場合の best-effort 復元 (H-2)。
      releaseStyleRef.current?.();
      releaseStyleRef.current = null;
    };
    // drag 開始/終了時のみ再アタッチ。
  }, [Boolean(state)]);

  function endDrag() {
    setState(null);
    startRef.current = null;
    pointerIdRef.current = null;
    releaseStyleRef.current?.();
    releaseStyleRef.current = null;
  }

  const shouldSuppressClick = useCallback(() => justFinishedDragRef.current, []);

  return { state, containerRef, startDrag, shouldSuppressClick };
}

// container から tab rect を読み splice index を返す。container が無い / pointer が横範囲外の
// ときは前の insertIdx を保つ (ユーザーが "一覧" タブ / "+" ボタン上を一瞬 hover しても indicator が
// 勝手な位置に飛ばないように, spec §12.5)。
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
