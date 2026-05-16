import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type CardContextMenuMode,
  SPLIT_OPEN_LIMIT,
  canBulkSplitOpen,
} from "./cardContextMenuLogic";

// Per-item / chrome heights used for the *initial* position seed. The actual
// viewport-edge clamp re-runs in useLayoutEffect after DOM commit but before
// paint via getBoundingClientRect(), so these only need to be "close enough"
// to avoid a visible jump on first paint (mirrors TabContextMenu).
const APPROX_MENU_WIDTH = 220;
const CTX_ITEM_HEIGHT = 24;
const CTX_DIVIDER_HEIGHT = 9;
const CTX_MENU_CHROME_HEIGHT = 14;

type Viewer = { id: string; name: string };

export type CardContextMenuProps = {
  // Initial cursor position (raw clientX/Y from the contextmenu event).
  x: number;
  y: number;
  // Mode is computed by the parent via computeCardContextMenuMode so callers
  // can unit-test the decision without rendering.
  mode: CardContextMenuMode;
  // Viewer set (#11). In single mode we render one "ビューアで開く" per viewer.
  // In bulk mode the destination is `bulkDstViewerId` instead.
  viewers: Viewer[];
  activeViewerId: string;
  // Number of selected entries (only meaningful in bulk mode). Used both for
  // the label ("3 件をタブで開く") and to gate the split-open item.
  selectedCount: number;
  // Bulk destination viewer id — sourced from the ClassificationView's bulk-
  // toolbar `<select>` so the toolbar and the menu open into the same viewer
  // (spec §11-E).
  bulkDstViewerId: string;

  // Single-mode actions.
  onOpenInViewer: (viewerId: string) => void;
  onEnterSelectionMode: () => void;
  onDelete: () => void;

  // Bulk-mode actions. Parent supplies the destination and selection so the
  // menu doesn't need to know how either is sourced.
  onOpenManyInTabs: () => void;
  onOpenManyAsSplit: () => void;
  onClearSelection: () => void;

  onClose: () => void;
};

type MenuEntry =
  | {
      kind: "item";
      key: string;
      label: ReactNode;
      onClick: () => void;
      className?: string;
      title?: string;
      disabled?: boolean;
    }
  | { kind: "divider"; key: string };

// CardContextMenu — right-click menu on a classification list Card.
// Two modes (spec §5.2):
//   single: "ビューア「{name}」で開く" × N + 「選択モードに切り替え」+ 「削除」
//   bulk:   「N 件をタブで開く / パネル分割で開く / 選択解除」
// Chrome and outside-click / Esc behavior mirror TabContextMenu so list and
// viewer right-click menus stay consistent. Render via createPortal so the
// menu sits outside .cls-view's `zoom: var(--ui-scale)` ancestor (#72).
export function CardContextMenu({
  x,
  y,
  mode,
  viewers,
  activeViewerId,
  selectedCount,
  bulkDstViewerId,
  onOpenInViewer,
  onEnterSelectionMode,
  onDelete,
  onOpenManyInTabs,
  onOpenManyAsSplit,
  onClearSelection,
  onClose,
}: CardContextMenuProps) {
  const entries: MenuEntry[] =
    mode === "single"
      ? buildSingleEntries(
          viewers,
          activeViewerId,
          onOpenInViewer,
          onEnterSelectionMode,
          onDelete,
        )
      : buildBulkEntries(
          selectedCount,
          bulkDstViewerId,
          viewers,
          onOpenManyInTabs,
          onOpenManyAsSplit,
          onClearSelection,
        );

  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    // Defer registration so we don't catch the same click / contextmenu
    // event that opened the menu.
    const t = window.setTimeout(() => {
      const onDocPointerDown = (e: PointerEvent) => {
        // pointerdown (not mousedown) so a click landing on ImageView's
        // pan-drag handler — which preventDefault()s pointerdown and
        // suppresses the synthesized mousedown — still closes this menu
        // (#56, same fix used by TabContextMenu).
        const target = e.target as Element | null;
        if (target && target.closest(".cls-card-context-menu-root")) return;
        onClose();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("pointerdown", onDocPointerDown);
      document.addEventListener("keydown", onKey);
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

  // Vertical arrow-key navigation (mirrors TabContextMenu). Disabled items
  // are filtered out — focus() no-ops on disabled buttons anyway, but the
  // wrap math has to skip them so ArrowDown doesn't get stuck.
  const focusItem = (idx: number) => {
    const items = itemsRef.current.filter(
      (el): el is HTMLButtonElement => el !== null && !el.disabled,
    );
    if (items.length === 0) return;
    const wrapped = (idx + items.length) % items.length;
    items[wrapped]?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = itemsRef.current.filter(
      (el): el is HTMLButtonElement => el !== null && !el.disabled,
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

  const itemCount = entries.filter((e) => e.kind === "item").length;
  const dividerCount = entries.filter((e) => e.kind === "divider").length;
  const approxHeight =
    CTX_MENU_CHROME_HEIGHT +
    itemCount * CTX_ITEM_HEIGHT +
    dividerCount * CTX_DIVIDER_HEIGHT;

  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
    // Math.max(0, ...) floors the result so a window narrower / shorter than
    // the menu doesn't push it off-screen into negative coordinates.
    left: Math.max(0, Math.min(x, window.innerWidth - APPROX_MENU_WIDTH)),
    top: Math.max(0, Math.min(y, window.innerHeight - approxHeight)),
  }));

  // After first DOM commit (before paint), measure the actual rendered size
  // and re-clamp so OS / browser / font differences in line-height can't
  // push the menu off-screen. Mount-only — re-running on every render would
  // flicker.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let newLeft = pos.left;
    let newTop = pos.top;
    if (rect.right > window.innerWidth) {
      newLeft = Math.max(0, window.innerWidth - rect.width);
    }
    if (rect.bottom > window.innerHeight) {
      newTop = Math.max(0, window.innerHeight - rect.height);
    }
    if (newLeft !== pos.left || newTop !== pos.top) {
      setPos({ left: newLeft, top: newTop });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Walk entries once, assigning a stable itemsRef slot to each <button>.
  // The slot index is captured at render time (not in the ref callback) so
  // StrictMode double-invoke / unmount-null cleanup can't drift the slots.
  let buttonIdx = 0;

  return createPortal(
    <div
      ref={rootRef}
      className="cls-card-context-menu-root"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 1000 }}
    >
      <div
        className="tab-context-menu"
        role="menu"
        aria-label={
          mode === "bulk" ? "選択画像操作メニュー" : "画像操作メニュー"
        }
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onMenuKeyDown}
      >
        {entries.map((entry) => {
          if (entry.kind === "divider") {
            return (
              <div
                key={entry.key}
                className="ctx-divider"
                role="separator"
              />
            );
          }
          const i = buttonIdx++;
          return (
            <button
              key={entry.key}
              ref={(el) => {
                itemsRef.current[i] = el;
              }}
              type="button"
              role="menuitem"
              className={`ctx-item${entry.className ? ` ${entry.className}` : ""}`}
              title={entry.title}
              disabled={entry.disabled}
              onClick={entry.onClick}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

function buildSingleEntries(
  viewers: Viewer[],
  activeViewerId: string,
  onOpenInViewer: (viewerId: string) => void,
  onEnterSelectionMode: () => void,
  onDelete: () => void,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const v of viewers) {
    // Single-viewer mode: no "(現在)" — the suffix would carry zero info.
    const suffix =
      viewers.length > 1 && v.id === activeViewerId ? " (現在)" : "";
    const label = `ビューア「${v.name}」で開く${suffix}`;
    entries.push({
      kind: "item",
      key: `open-in-viewer:${v.id}`,
      label,
      title: label,
      className: "ctx-item-viewer",
      onClick: () => onOpenInViewer(v.id),
    });
  }
  if (viewers.length > 0) {
    entries.push({ kind: "divider", key: "div-after-viewers" });
  }
  entries.push({
    kind: "item",
    key: "enter-selection-mode",
    label: "選択モードに切り替え",
    onClick: onEnterSelectionMode,
  });
  entries.push({ kind: "divider", key: "div-before-delete" });
  entries.push({
    kind: "item",
    key: "delete",
    label: "削除",
    className: "cls-card-context-item-danger",
    onClick: onDelete,
  });
  return entries;
}

function buildBulkEntries(
  selectedCount: number,
  bulkDstViewerId: string,
  viewers: Viewer[],
  onOpenManyInTabs: () => void,
  onOpenManyAsSplit: () => void,
  onClearSelection: () => void,
): MenuEntry[] {
  const dst = viewers.find((v) => v.id === bulkDstViewerId);
  // Show "→ {name}" only when the user can plausibly mistake which viewer
  // would receive the action (= 複数ビューア時)。1 個しかないなら表記不要。
  const intoSuffix = dst && viewers.length > 1 ? ` → ${dst.name}` : "";
  const splitDisabled = !canBulkSplitOpen(selectedCount);
  // Disabled <button>s can't receive focus, so a `title` / `aria-label` would
  // be unreachable for keyboard / screen-reader users (Copilot review #58
  // thread #2). Embed the limit reason directly into the visible label so the
  // disabled state explains itself. `title` is kept as supplementary text for
  // pointer users with extended hover.
  const splitLabel = splitDisabled
    ? `${selectedCount} 件をパネル分割で開く (上限 ${SPLIT_OPEN_LIMIT} 枚)${intoSuffix}`
    : `${selectedCount} 件をパネル分割で開く${intoSuffix}`;
  const splitTitle = splitDisabled
    ? `パネル分割で開けるのは ${SPLIT_OPEN_LIMIT} 枚までです (タブで開いてください)`
    : "選択した画像をそれぞれ別パネルに開く";

  return [
    {
      kind: "item",
      key: "bulk-open-tabs",
      label: `${selectedCount} 件をタブで開く${intoSuffix}`,
      onClick: onOpenManyInTabs,
    },
    {
      kind: "item",
      key: "bulk-open-split",
      label: splitLabel,
      onClick: onOpenManyAsSplit,
      disabled: splitDisabled,
      title: splitTitle,
    },
    { kind: "divider", key: "div-before-clear" },
    {
      kind: "item",
      key: "clear-selection",
      label: "選択解除",
      onClick: onClearSelection,
    },
  ];
}
