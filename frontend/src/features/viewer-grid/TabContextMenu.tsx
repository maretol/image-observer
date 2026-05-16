import { useEffect, useRef } from "react";

type Viewer = { id: string; name: string };

type Props = {
  leafId: string;
  tabIndex: number;
  x: number;
  y: number;
  // Multi-viewer (#11). Every viewer except the current one is rendered as a
  // top-level "{name} へ移動" menuitem (#57 — flattened from the previous
  // submenu). With only 1 viewer the entries (and the preceding divider) are
  // suppressed.
  viewers: Viewer[];
  currentViewerId: string;
  onClose: () => void;
  onCloseTab: () => void;
  onSplit: (direction: "col" | "row") => void;
  onMoveToViewer: (dstViewerId: string) => void;
};

// Approximate width used for screen-edge placement. We can't measure the menu
// precisely before first paint, so this is a conservative seed wide enough to
// cover the .ctx-item-viewer max-width (280px) + .ctx-item horizontal padding.
const APPROX_MENU_WIDTH = 320;

// Per-item / divider / chrome heights used to estimate the menu height from
// the actual item count. Keeps the bottom-edge clamp accurate up to
// MAX_VIEWERS=8 instead of falling back to a fixed seed that's too small at
// the upper end. Values track .ctx-item / .ctx-divider / .tab-context-menu
// rules in App.css (changes there should mirror here).
const CTX_ITEM_HEIGHT = 24; // padding 5+5 + line-height ≈ 14
const CTX_DIVIDER_HEIGHT = 9; // height 1 + margin 4+4
const CTX_MENU_CHROME_HEIGHT = 14; // padding 6+6 + border 1+1

export function TabContextMenu({
  x,
  y,
  viewers,
  currentViewerId,
  onClose,
  onCloseTab,
  onSplit,
  onMoveToViewer,
}: Props) {
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const otherViewers = viewers.filter((v) => v.id !== currentViewerId);
  const hasMoveItems = otherViewers.length > 0;

  useEffect(() => {
    // Defer registration so we don't catch the same click that opened the menu.
    const t = window.setTimeout(() => {
      const onDocPointerDown = (e: PointerEvent) => {
        // We listen on pointerdown rather than mousedown because ImageView's
        // pan-drag handler calls preventDefault() on pointerdown, which
        // suppresses the synthesized mousedown — clicking the image area
        // would otherwise leave this menu open (#56).
        const target = e.target as Element | null;
        if (target && target.closest(".tab-context-menu-root")) return;
        onClose();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("pointerdown", onDocPointerDown);
      document.addEventListener("keydown", onKey);
      // Move focus into the menu so keyboard users land on the first item.
      itemsRef.current[0]?.focus();
      cleanup = () => {
        document.removeEventListener("pointerdown", onDocPointerDown);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
    let cleanup: (() => void) | null = null;
    return () => {
      window.clearTimeout(t);
      if (cleanup) cleanup();
    };
  }, [onClose]);

  // Vertical arrow-key navigation between menu items. Wraps top↔bottom.
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

  // Estimate the menu height from the actual item count so the bottom-edge
  // clamp stays accurate up to MAX_VIEWERS=8. 3 fixed items (閉じる / split×2),
  // 1 divider always, + (1 divider + N viewer items) when other viewers exist.
  const itemCount = 3 + otherViewers.length;
  const dividerCount = 1 + (hasMoveItems ? 1 : 0);
  const approxHeight =
    CTX_MENU_CHROME_HEIGHT +
    itemCount * CTX_ITEM_HEIGHT +
    dividerCount * CTX_DIVIDER_HEIGHT;

  // Position clamped within viewport. Math.max(0, ...) floors the result so
  // a window narrower / shorter than the menu doesn't push it off-screen
  // into negative coordinates.
  const left = Math.max(0, Math.min(x, window.innerWidth - APPROX_MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - approxHeight));

  // Build menuitems in a single flat array so itemsRef indices stay stable
  // regardless of how many other viewers exist. Order: 閉じる → split×2 →
  // (divider) → viewer×N. Each index is captured in render (not inside the
  // ref callback) so itemsRef positions don't drift if React re-invokes the
  // ref callback during StrictMode double-invoke / unmount-null cleanup.
  let refIdx = 0;
  const closeIdx = refIdx++;
  const splitColIdx = refIdx++;
  const splitRowIdx = refIdx++;
  const assignRef = (el: HTMLButtonElement | null, i: number) => {
    itemsRef.current[i] = el;
  };

  return (
    <div
      className="tab-context-menu-root"
      style={{ position: "fixed", left, top, zIndex: 1000 }}
    >
      <div
        className="tab-context-menu"
        role="menu"
        aria-label="タブ操作メニュー"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onMenuKeyDown}
      >
        <button
          ref={(el) => assignRef(el, closeIdx)}
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={onCloseTab}
        >
          閉じる
        </button>
        <div className="ctx-divider" role="separator" />
        <button
          ref={(el) => assignRef(el, splitColIdx)}
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => onSplit("col")}
        >
          右に分割
        </button>
        <button
          ref={(el) => assignRef(el, splitRowIdx)}
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => onSplit("row")}
        >
          下に分割
        </button>
        {hasMoveItems ? (
          <>
            <div className="ctx-divider" role="separator" />
            {otherViewers.map((v) => {
              const i = refIdx++;
              const label = `${v.name} へ移動`;
              return (
                <button
                  key={v.id}
                  ref={(el) => assignRef(el, i)}
                  type="button"
                  role="menuitem"
                  className="ctx-item ctx-item-viewer"
                  title={label}
                  onClick={() => onMoveToViewer(v.id)}
                >
                  {label}
                </button>
              );
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}
