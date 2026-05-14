import { useEffect, useRef } from "react";

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
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    // Defer registration so we don't catch the same click that opened the menu.
    const t = window.setTimeout(() => {
      const onDocMouseDown = () => onClose();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onKey);
      // Move focus into the menu so keyboard users land on the first item.
      itemsRef.current[0]?.focus();
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

  // Vertical arrow-key navigation between items. Wraps top↔bottom.
  const focusItem = (idx: number) => {
    const items = itemsRef.current.filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    if (items.length === 0) return;
    const wrapped = (idx + items.length) % items.length;
    items[wrapped]?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = itemsRef.current.filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    const current = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(current < 0 ? 0 : current + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(current < 0 ? items.length - 1 : current - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(items.length - 1);
    }
  };

  // Position clamped within viewport.
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 120);

  return (
    <div
      className="tab-context-menu"
      role="menu"
      aria-label="タブ操作メニュー"
      style={{ position: "fixed", left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      <button
        ref={(el) => {
          itemsRef.current[0] = el;
        }}
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={onCloseTab}
      >
        閉じる
      </button>
      <div className="ctx-divider" role="separator" />
      <button
        ref={(el) => {
          itemsRef.current[1] = el;
        }}
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => onSplit("col")}
      >
        右に分割
      </button>
      <button
        ref={(el) => {
          itemsRef.current[2] = el;
        }}
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => onSplit("row")}
      >
        下に分割
      </button>
    </div>
  );
}
