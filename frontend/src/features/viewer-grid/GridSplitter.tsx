import { useEffect, useRef } from "react";
import type { SplitDirection } from "./layout";
import { MIN_RATIO } from "./layout";
import { pushBodyStyle } from "../../shared/utils/bodyStyles";

type Props = {
  splitId: string;
  direction: SplitDirection;
  ratio: number; // 現在の ratio (a の取り分)
  containerRef: React.RefObject<HTMLDivElement | null>;
  onChangeRatio: (splitId: string, ratio: number) => void;
};

const MIN_PX = 100;

export function GridSplitter({
  splitId,
  direction,
  ratio,
  containerRef,
  onChangeRatio,
}: Props) {
  const dragRef = useRef<{
    startPointer: number;
    startRatio: number;
    pointerId: number;
    release: () => void;
  } | null>(null);

  // global pointer listener を render 越しに安定させるための ref。
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const onChangeRatioRef = useRef(onChangeRatio);
  onChangeRatioRef.current = onChangeRatio;
  const splitIdRef = useRef(splitId);
  splitIdRef.current = splitId;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 既に drag 中 (multi-touch の 2 本目等)。新 pointer を無視し、dragRef を上書きして
    // 既存 release() を orphan にしない (body cursor/userSelect の override が leak する)。
    if (dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const release = pushBodyStyle({
      cursor: direction === "col" ? "col-resize" : "row-resize",
      userSelect: "none",
    });
    dragRef.current = {
      startPointer: direction === "col" ? e.clientX : e.clientY,
      startRatio: ratio,
      pointerId: e.pointerId,
      release,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dir = directionRef.current;
      const containerSize = dir === "col" ? rect.width : rect.height;
      if (containerSize <= 0) return;
      const currentPointer = dir === "col" ? e.clientX : e.clientY;
      const deltaPx = currentPointer - drag.startPointer;
      const deltaRatio = deltaPx / containerSize;
      // 100px 最小と絶対 MIN_RATIO の両方で clamp。
      const minRatioByPx = MIN_PX / containerSize;
      const minR = Math.max(MIN_RATIO, minRatioByPx);
      let r = drag.startRatio + deltaRatio;
      if (r < minR) r = minR;
      if (r > 1 - minR) r = 1 - minR;
      onChangeRatioRef.current(splitIdRef.current, r);
    };
    const endDrag = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.release();
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      // drag 中に unmount した場合の best-effort 復元。
      dragRef.current?.release();
      dragRef.current = null;
    };
  }, [containerRef]);

  const className =
    direction === "col" ? "grid-splitter-col" : "grid-splitter-row";
  return <div className={className} onPointerDown={onPointerDown} />;
}
