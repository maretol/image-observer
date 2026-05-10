import { useEffect, useRef } from "react";
import type { SplitDirection } from "./layout";
import { MIN_RATIO } from "./layout";

type Props = {
  splitId: string;
  direction: SplitDirection;
  ratio: number; // current ratio (a's share)
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
  const dragRef = useRef<{ startMouse: number; startRatio: number } | null>(
    null,
  );

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      startMouse: direction === "col" ? e.clientX : e.clientY,
      startRatio: ratio,
    };
    document.body.style.cursor =
      direction === "col" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const containerSize = direction === "col" ? rect.width : rect.height;
      if (containerSize <= 0) return;
      const currentMouse = direction === "col" ? e.clientX : e.clientY;
      const deltaPx = currentMouse - dragRef.current.startMouse;
      const deltaRatio = deltaPx / containerSize;
      // Clamp by both 100px minimum and the absolute MIN_RATIO floor.
      const minRatioByPx = MIN_PX / containerSize;
      const minR = Math.max(MIN_RATIO, minRatioByPx);
      let r = dragRef.current.startRatio + deltaRatio;
      if (r < minR) r = minR;
      if (r > 1 - minR) r = 1 - minR;
      onChangeRatio(splitId, r);
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [direction, splitId, onChangeRatio, containerRef]);

  const className =
    direction === "col" ? "grid-splitter-col" : "grid-splitter-row";
  return <div className={className} onMouseDown={onMouseDown} />;
}
