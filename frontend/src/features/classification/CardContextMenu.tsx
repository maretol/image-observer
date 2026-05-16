import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Approximate width/height used for screen-edge placement. We don't measure
// the menu post-render (only one item, so the seed values are accurate) —
// this matches the simpler-than-TabContextMenu shape required by #47 Phase 1
// (single "削除" item; no submenu).
const APPROX_MENU_WIDTH = 140;
const APPROX_MENU_HEIGHT = 40;

export type CardContextMenuProps = {
  x: number;
  y: number;
  onDelete: () => void;
  onClose: () => void;
};

// CardContextMenu — the right-click menu shown on a classification list Card.
// Single item ("削除") in Phase 1; the component is named generically so
// later additions (e.g. issue #52's "ビューア N で開く") plug in here
// without renaming or rewiring the surrounding state. Mirrors the focus /
// outside-click / Esc behavior of TabContextMenu so keyboard users get a
// consistent experience between list and viewer right-click menus.
export function CardContextMenu({
  x,
  y,
  onDelete,
  onClose,
}: CardContextMenuProps) {
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Defer registration so we don't catch the same click / contextmenu
    // event that opened the menu.
    const t = window.setTimeout(() => {
      const onDocMouseDown = (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (target && target.closest(".cls-card-context-menu-root")) return;
        onClose();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onKey);
      firstItemRef.current?.focus();
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

  // Floor with Math.max(0, ...) so a viewport narrower / shorter than the
  // menu does not push the menu off-screen into negative coordinates.
  const left = Math.max(
    0,
    Math.min(x, window.innerWidth - APPROX_MENU_WIDTH),
  );
  const top = Math.max(
    0,
    Math.min(y, window.innerHeight - APPROX_MENU_HEIGHT),
  );

  // Render into <body> via Portal so the menu sits outside the .cls-view
  // subtree. .cls-view has `zoom: var(--ui-scale)` applied (App.css §UI
  // scale), and a `position: fixed` descendant of a zoomed ancestor is
  // scaled by the same factor on Chromium/WebView2 — `left/top` set from
  // raw clientX/Y would then land at zoom×coords instead of the cursor (#72).
  // The viewer-side TabContextMenu does not need this because .panel-tree
  // is intentionally kept out of the zoomed chrome (App.css §UI scale).
  return createPortal(
    <div
      className="cls-card-context-menu-root"
      style={{ position: "fixed", left, top, zIndex: 1000 }}
    >
      {/* Reuse .tab-context-menu chrome so list + viewer right-click menus
          stay visually consistent. .cls-card-context-menu-root scopes the
          outside-click handler without duplicating the visual style. */}
      <div
        className="tab-context-menu"
        role="menu"
        aria-label="画像操作メニュー"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          ref={firstItemRef}
          type="button"
          role="menuitem"
          className="ctx-item cls-card-context-item-danger"
          onClick={onDelete}
        >
          削除
        </button>
      </div>
    </div>,
    document.body,
  );
}
