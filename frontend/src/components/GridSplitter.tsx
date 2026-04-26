import { useEffect, useRef } from "react";

type Props = {
  direction: "row" | "col";
  index: number; // splits between sizes[index] and sizes[index+1]
  sizes: number[];
  setSizes: (sizes: number[]) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  style?: React.CSSProperties;
};

const MIN_PX = 100;

export function GridSplitter({
  direction,
  index,
  sizes,
  setSizes,
  containerRef,
  style,
}: Props) {
  const dragRef = useRef<{ startMouse: number; startSizes: number[] } | null>(
    null
  );

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      startMouse: direction === "col" ? e.clientX : e.clientY,
      startSizes: [...sizes],
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
      const minRatio = MIN_PX / containerSize;

      const start = dragRef.current.startSizes;
      const sum = start[index] + start[index + 1];
      let a = start[index] + deltaRatio;
      let b = start[index + 1] - deltaRatio;
      if (a < minRatio) {
        a = minRatio;
        b = sum - minRatio;
      }
      if (b < minRatio) {
        b = minRatio;
        a = sum - minRatio;
      }

      const newSizes = [...start];
      newSizes[index] = a;
      newSizes[index + 1] = b;
      setSizes(newSizes);
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
  }, [direction, index, setSizes, containerRef]);

  const className =
    direction === "col" ? "grid-splitter-col" : "grid-splitter-row";
  return <div className={className} style={style} onMouseDown={onMouseDown} />;
}
