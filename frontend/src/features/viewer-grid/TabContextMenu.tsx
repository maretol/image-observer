import { useEffect, useRef, useState } from "react";

type Viewer = { id: string; name: string };

type Props = {
  leafId: string;
  tabIndex: number;
  x: number;
  y: number;
  // Multi-viewer (#11). When viewers.length >= 2 the menu shows a
  // "ビューアへ移動 ▶" entry whose submenu lists every other viewer. With
  // only 1 viewer the entry (and its preceding divider) is hidden.
  viewers: Viewer[];
  currentViewerId: string;
  onClose: () => void;
  onCloseTab: () => void;
  onSplit: (direction: "col" | "row") => void;
  onMoveToViewer: (dstViewerId: string) => void;
};

// SUBMENU_HOVER_DELAY_MS: how long the parent "ビューアへ移動 ▶" item must be
// hovered before the submenu opens. Mirrors the close-on-leave delay so quick
// pointer flicks across items don't pop the submenu open mid-traversal.
const SUBMENU_HOVER_DELAY_MS = 150;

// Approximate widths used for screen-edge placement. We measure precisely
// with bounding rects after first paint, but the initial style needs a
// reasonable seed so the menu doesn't flash off-screen.
const APPROX_PARENT_WIDTH = 200;
const APPROX_SUBMENU_WIDTH = 240;
const APPROX_PARENT_HEIGHT = 200;

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
  // submenuOpen tracks the "ビューアへ移動 ▶" inline-popup. We keep a separate
  // ref to the parent menuitem so Esc/← can return focus there.
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const parentMoveRef = useRef<HTMLButtonElement | null>(null);
  const submenuOpenTimerRef = useRef<number | null>(null);
  const submenuCloseTimerRef = useRef<number | null>(null);

  const otherViewers = viewers.filter((v) => v.id !== currentViewerId);
  const hasMoveSubmenu = otherViewers.length > 0;

  useEffect(() => {
    // Defer registration so we don't catch the same click that opened the menu.
    const t = window.setTimeout(() => {
      const onDocMouseDown = (e: MouseEvent) => {
        // Submenu lives inside our DOM tree (rendered as a sibling within
        // tab-context-menu wrapper), so a mousedown anywhere outside that
        // wrapper closes the entire menu.
        const target = e.target as Element | null;
        if (target && target.closest(".tab-context-menu-root")) return;
        onClose();
      };
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
      if (submenuOpenTimerRef.current) window.clearTimeout(submenuOpenTimerRef.current);
      if (submenuCloseTimerRef.current) window.clearTimeout(submenuCloseTimerRef.current);
      if (cleanup) cleanup();
    };
  }, [onClose]);

  // Vertical arrow-key navigation between top-level items. Wraps top↔bottom.
  // Submenu navigation is owned by MoveToViewerSubmenu.
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

  // Position clamped within viewport. Submenu placement is computed inside
  // MoveToViewerSubmenu so it can read the parent menuitem's bounding rect.
  const left = Math.min(x, window.innerWidth - APPROX_PARENT_WIDTH);
  const top = Math.min(y, window.innerHeight - APPROX_PARENT_HEIGHT);

  const openSubmenu = () => {
    if (submenuCloseTimerRef.current) {
      window.clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
    if (submenuOpen) return;
    submenuOpenTimerRef.current = window.setTimeout(() => {
      setSubmenuOpen(true);
    }, SUBMENU_HOVER_DELAY_MS);
  };
  const cancelOpenSubmenu = () => {
    if (submenuOpenTimerRef.current) {
      window.clearTimeout(submenuOpenTimerRef.current);
      submenuOpenTimerRef.current = null;
    }
  };
  const scheduleCloseSubmenu = () => {
    if (submenuCloseTimerRef.current) {
      window.clearTimeout(submenuCloseTimerRef.current);
    }
    submenuCloseTimerRef.current = window.setTimeout(() => {
      setSubmenuOpen(false);
    }, SUBMENU_HOVER_DELAY_MS);
  };
  const cancelCloseSubmenu = () => {
    if (submenuCloseTimerRef.current) {
      window.clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  };

  return (
    <div
      className="tab-context-menu-root"
      style={{ position: "fixed", left, top, zIndex: 1000 }}
      // Rooted wrapper so the click-outside listener can scope its target
      // check via .closest(".tab-context-menu-root").
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
        {hasMoveSubmenu ? (
          <>
            <div className="ctx-divider" role="separator" />
            <button
              ref={(el) => {
                itemsRef.current[3] = el;
                parentMoveRef.current = el;
              }}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={submenuOpen}
              className="ctx-item ctx-item-submenu-parent"
              onClick={() => {
                cancelOpenSubmenu();
                setSubmenuOpen((v) => !v);
              }}
              onMouseEnter={openSubmenu}
              onMouseLeave={() => {
                cancelOpenSubmenu();
                scheduleCloseSubmenu();
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  setSubmenuOpen(true);
                }
              }}
            >
              <span>ビューアへ移動</span>
              <span className="ctx-submenu-arrow" aria-hidden="true">
                ▶
              </span>
            </button>
          </>
        ) : null}
      </div>
      {hasMoveSubmenu && submenuOpen ? (
        <MoveToViewerSubmenu
          viewers={otherViewers}
          parentRef={parentMoveRef}
          onPick={(id) => {
            onMoveToViewer(id);
            onClose();
          }}
          onClose={() => {
            setSubmenuOpen(false);
            parentMoveRef.current?.focus();
          }}
          onMouseEnter={cancelCloseSubmenu}
          onMouseLeave={scheduleCloseSubmenu}
        />
      ) : null}
    </div>
  );
}

// MoveToViewerSubmenu renders the "ビューアへ移動" submenu adjacent to its
// parent menuitem. It owns its own ↑/↓ navigation and ←/Esc → close +
// refocus the parent. Position is computed against the parent's bounding
// rect; if the right side would clip the viewport, the submenu flips to the
// parent's left.
function MoveToViewerSubmenu({
  viewers,
  parentRef,
  onPick,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  viewers: Viewer[];
  parentRef: React.RefObject<HTMLButtonElement | null>;
  onPick: (id: string) => void;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Compute submenu position once on mount. The first render returns null
  // (pos === null) until this effect resolves, so we cannot focus here —
  // itemsRef is empty at that point.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const wantRight = r.right - 4;
    const fitsRight =
      wantRight + APPROX_SUBMENU_WIDTH <= window.innerWidth;
    const left = fitsRight
      ? wantRight
      : Math.max(0, r.left - APPROX_SUBMENU_WIDTH + 4);
    const top = Math.min(r.top, window.innerHeight - APPROX_PARENT_HEIGHT);
    setPos({ left, top });
  }, [parentRef]);

  // Focus the first menu item AFTER pos is set and the items have actually
  // mounted. Splitting this from the position effect avoids the race where
  // focus() runs against an empty itemsRef (return null on first render).
  useEffect(() => {
    if (pos) itemsRef.current[0]?.focus();
  }, [pos]);

  const focusItem = (idx: number) => {
    const items = itemsRef.current.filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    if (items.length === 0) return;
    const wrapped = (idx + items.length) % items.length;
    items[wrapped]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = itemsRef.current.filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    const current = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      focusItem(current < 0 ? 0 : current + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      focusItem(current < 0 ? items.length - 1 : current - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      focusItem(items.length - 1);
    } else if (e.key === "ArrowLeft" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  if (!pos) return null;

  return (
    <div
      className="tab-context-menu tab-context-submenu"
      role="menu"
      aria-label="ビューアへ移動 サブメニュー"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 1001 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={onKeyDown}
    >
      {viewers.map((v, i) => (
        <button
          key={v.id}
          ref={(el) => {
            itemsRef.current[i] = el;
          }}
          type="button"
          role="menuitem"
          className="ctx-item ctx-item-viewer"
          title={v.name}
          aria-label={`ビューア「${v.name}」へ移動`}
          onClick={() => onPick(v.id)}
        >
          {v.name}
        </button>
      ))}
    </div>
  );
}
