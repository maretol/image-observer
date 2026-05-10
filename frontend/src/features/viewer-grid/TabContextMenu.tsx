import { useEffect } from "react";

type Props = {
  leafId: string;
  tabIndex: number;
  x: number;
  y: number;
  onClose: () => void;
  onCloseTab: () => void;
  onSplit: (direction: "col" | "row") => void;
};

// Minimal context menu (Phase 5): close + split right + split down.
// "別パネルへ移動" was removed in favor of DnD.
export function TabContextMenu({
  x,
  y,
  onClose,
  onCloseTab,
  onSplit,
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

  // Position clamped within viewport.
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 120);

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
      <div className="ctx-divider" />
      <button className="ctx-item" onClick={() => onSplit("col")}>
        右に分割
      </button>
      <button className="ctx-item" onClick={() => onSplit("row")}>
        下に分割
      </button>
    </div>
  );
}
