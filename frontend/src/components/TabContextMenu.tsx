import { useEffect } from "react";
import type { Grid, PanelCoord } from "../hooks/useViewerGrid";

type Props = {
  srcCoord: PanelCoord;
  tabIndex: number;
  x: number;
  y: number;
  grid: Grid;
  onClose: () => void;
  onMove: (dst: PanelCoord) => void;
  onCloseTab: () => void;
};

export function TabContextMenu({
  srcCoord,
  tabIndex: _tabIndex,
  x,
  y,
  grid,
  onClose,
  onMove,
  onCloseTab,
}: Props) {
  useEffect(() => {
    // Defer registration so we don't catch the same click that opened the menu.
    const t = window.setTimeout(() => {
      const onDocMouseDown = () => onClose();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onKey);
      cleanup = () => {
        document.removeEventListener("mousedown", onDocMouseDown);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
    let cleanup: (() => void) | null = null;
    return () => {
      window.clearTimeout(t);
      if (cleanup) cleanup();
    };
  }, [onClose]);

  // Build list of other panels in row-major order
  const others: PanelCoord[] = [];
  for (let r = 0; r < grid.size.rows; r++) {
    for (let c = 0; c < grid.size.cols; c++) {
      if (r === srcCoord.row && c === srcCoord.col) continue;
      others.push({ row: r, col: c });
    }
  }

  // Position clamped within viewport
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 40 - others.length * 24 - 40);

  return (
    <div
      className="tab-context-menu"
      style={{ position: "fixed", left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="ctx-item" onClick={onCloseTab}>
        閉じる
      </button>
      {others.length > 0 && (
        <>
          <div className="ctx-divider" />
          <div className="ctx-label">別パネルへ移動</div>
          {others.map((c) => (
            <button
              key={`${c.row},${c.col}`}
              className="ctx-item ctx-item-move"
              onClick={() => onMove(c)}
            >
              行{c.row + 1} 列{c.col + 1}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
