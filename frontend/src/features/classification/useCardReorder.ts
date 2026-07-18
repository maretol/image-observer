// 並べ替えモードの Card DnD (#144 Phase 2, docs/spec-image-sort.md §5.2 / §8)。
// useViewerTabReorder と共通の idiom: 5px 閾値 / pushBodyStyle / pointercancel + Escape
// キャンセル / pointerId 固定 / module scope state なし。相違点:
//   - grid (2 次元・折返しあり) の挿入位置計算 (computeGridInsertIdx)
//   - 同一ディレクトリグループ内のみ (グループ外へ出たら outside = drop 無効 + 不可カーソル)
//   - Esc は enabled (モード中) の間ずっと listen し、drag 中は drag 中止のみ / drag 外は
//     モード解除 (onExitMode)。2 段解除を単一 listener に集約するのは、listener を 2 本に
//     分けると発火順の race で 1 回の Esc が両方を走らせるため (spec §8 改訂履歴)。

import { useCallback, useEffect, useRef, useState } from "react";
import { pushBodyStyle } from "../../shared/utils/bodyStyles";
import { logger } from "../../shared/utils/logger";

// group grid コンテナ / draggable Card の目印。hook が querySelectorAll で rect を集める。
export const DATA_REORDER_GROUP = "data-reorder-group";
export const DATA_REORDER_CARD = "data-reorder-card";

const DRAG_THRESHOLD_PX = 5;

export type CardReorderState = {
  srcFilename: string;
  groupKey: string;
  // グループ内 splice 位置 0..len。src 位置 / src 位置+1 は視覚 no-op スロット。
  insertIdx: number;
  // 閾値を超えるまで "armed"、超えたら "active"。インジケータ表示は active から。
  active: boolean;
  // pointer が source グループの grid 外にいる間 true (drop 無効 + 不可カーソル)。
  outside: boolean;
};

// 挿入計算に使う plain rect (DOM なしで純関数を test できるように)。
export type GridRectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// row-major (左→右、上→下) の grid で (x, y) に最も合う splice index 0..rects.length を
// 返す。y が card の行帯より上なら「その card の前」、行帯内なら横中点で前/後、行帯を
// 抜けたら次の card へ (= 行末を越えた drop は次行先頭 = 行末 append と同義)。全 card の
// 下なら末尾。
export function computeGridInsertIdx(
  rects: readonly GridRectLike[],
  x: number,
  y: number,
): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (y < r.top) return i;
    if (y < r.top + r.height && x < r.left + r.width / 2) return i;
  }
  return rects.length;
}

type Options = {
  // 並べ替えモード中のみ true。false の間は startDrag が no-op で Esc も listen しない。
  enabled: boolean;
  // drop 確定 (active + グループ内 + token 一致)。呼び出し側が reorderEntries →
  // commitReorder する。no-op スロットの弾きは reorderEntries 側 (null 返却) に任せる。
  onDrop: (srcFilename: string, groupKey: string, insertIdx: number) => void;
  // drag 外の Esc でモードを解除する。
  onExitMode: () => void;
  // drag 開始時に capture し drop 時に一致を確認する世代 token (= loadResult の object
  // identity)。watcher 差し替え / 編集 save の mtime patch で identity が変われば drop を
  // 静かに中止する (spec §8.1 の gen gate)。
  tokenRef: React.MutableRefObject<unknown>;
};

export type UseCardReorder = {
  state: CardReorderState | null;
  // Card の onPointerDown に配線。呼び出し側は reorderMode 中のみ渡す。
  startDrag: (
    srcFilename: string,
    groupKey: string,
    ev: { clientX: number; clientY: number; pointerId: number },
  ) => void;
};

export function useCardReorder(opts: Options): UseCardReorder {
  const { enabled, onDrop, onExitMode, tokenRef } = opts;
  const [state, setState] = useState<CardReorderState | null>(null);
  const stateRef = useRef<CardReorderState | null>(null);
  stateRef.current = state;
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const releaseStyleRef = useRef<(() => void) | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const capturedTokenRef = useRef<unknown>(null);
  // document リスナ (drag 開始/終了時のみ再アタッチ) が callback identity churn で
  // 作り直されないよう ref で捕捉。
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onExitModeRef = useRef(onExitMode);
  onExitModeRef.current = onExitMode;

  const endDrag = useCallback(() => {
    setState(null);
    startRef.current = null;
    pointerIdRef.current = null;
    capturedTokenRef.current = null;
    releaseStyleRef.current?.();
    releaseStyleRef.current = null;
  }, []);

  const startDrag = useCallback(
    (
      srcFilename: string,
      groupKey: string,
      ev: { clientX: number; clientY: number; pointerId: number },
    ) => {
      if (!enabled) return;
      // H-2: drag 中の 2 本目の pointerdown を guard (先勝ち)。
      if (stateRef.current) return;
      pointerIdRef.current = ev.pointerId;
      startRef.current = { x: ev.clientX, y: ev.clientY };
      capturedTokenRef.current = tokenRef.current;
      releaseStyleRef.current?.();
      releaseStyleRef.current = pushBodyStyle({
        cursor: "grabbing",
        userSelect: "none",
      });
      // insertIdx の初期値はグループ内の src 位置が理想だが、armed の間インジケータは
      // 出さないため 0 で十分 (active 化する最初の pointermove が必ず再計算する)。
      setState({
        srcFilename,
        groupKey,
        insertIdx: 0,
        active: false,
        outside: false,
      });
    },
    [enabled, tokenRef],
  );

  // enabled が落ちたら (モード解除 / resetEntriesDependentState 経由) drag も即破棄。
  useEffect(() => {
    if (!enabled && stateRef.current) endDrag();
  }, [enabled, endDrag]);

  // drag 中の document リスナ。
  useEffect(() => {
    if (!state) return;
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
      if (!movedFar) return;
      const probe = probeGroupGrid(cur.groupKey, e.clientX, e.clientY);
      const outside = probe == null;
      const insertIdx = probe ?? cur.insertIdx;
      if (
        cur.active &&
        insertIdx === cur.insertIdx &&
        outside === cur.outside
      ) {
        return;
      }
      // グループ外は「不可」をカーソルでも示す (spec §5.2)。body style は swap で更新。
      if (outside !== cur.outside) {
        releaseStyleRef.current?.();
        releaseStyleRef.current = pushBodyStyle({
          cursor: outside ? "not-allowed" : "grabbing",
          userSelect: "none",
        });
      }
      setState({ ...cur, insertIdx, active: true, outside });
    };
    const onUp = (e: PointerEvent) => {
      if (!isOurPointer(e)) return;
      const cur = stateRef.current;
      // endDrag が capturedTokenRef を null 化する前に snapshot する。
      const captured = capturedTokenRef.current;
      endDrag();
      if (!cur || !cur.active) return; // armed のみは通常クリック相当 (mode 中は無動作)
      if (cur.outside) {
        logger.debug("card-reorder", "drop outside group", {
          src: cur.srcFilename,
        });
        return;
      }
      if (captured !== tokenRef.current) {
        // drag 中に entries が差し替わった (watcher reload / 編集 save の mtime patch)。
        // 表示が変わった時点で意図した挿入位置は無効なので静かに中止 (spec §8.1)。
        logger.debug("card-reorder", "drop stale (entries replaced)", {
          src: cur.srcFilename,
        });
        return;
      }
      onDropRef.current(cur.srcFilename, cur.groupKey, cur.insertIdx);
    };
    const onCancel = (e: PointerEvent) => {
      if (!isOurPointer(e)) return;
      endDrag();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      // drag 中の unmount でも body style を復元 (H-2)。
      releaseStyleRef.current?.();
      releaseStyleRef.current = null;
    };
    // drag 開始/終了時のみ再アタッチ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(state)]);

  // Esc の 2 段解除 (モード中は常時 listen)。drag 中 → drag 中止のみ / drag 外 → モード解除。
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (stateRef.current) {
        logger.debug("card-reorder", "cancel", { reason: "escape" });
        endDrag();
        return;
      }
      onExitModeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, endDrag]);

  return { state, startDrag };
}

// source グループの grid から挿入位置を計算する。グループ grid が見つからない / pointer が
// grid の矩形外なら null (= outside)。
function probeGroupGrid(
  groupKey: string,
  x: number,
  y: number,
): number | null {
  const container = document.querySelector<HTMLElement>(
    `[${DATA_REORDER_GROUP}="${CSS.escape(groupKey)}"]`,
  );
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    return null;
  }
  const cards = Array.from(
    container.querySelectorAll<HTMLElement>(`[${DATA_REORDER_CARD}]`),
  );
  const rects: GridRectLike[] = cards.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  return computeGridInsertIdx(rects, x, y);
}
