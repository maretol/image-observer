import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type CardContextMenuMode,
  SPLIT_OPEN_LIMIT,
  canBulkSplitOpen,
} from "./cardContextMenuLogic";

// *初期* 位置 seed 用の概算高さ。実際の画面端クランプは DOM commit 後 paint 前の
// useLayoutEffect で getBoundingClientRect により再計算するので、初回描画で飛ばない
// 程度に "だいたい" で足りる (TabContextMenu と同様)。
const APPROX_MENU_WIDTH = 220;
const CTX_ITEM_HEIGHT = 24;
const CTX_DIVIDER_HEIGHT = 9;
const CTX_MENU_CHROME_HEIGHT = 14;

type Viewer = { id: string; name: string };

export type CardContextMenuProps = {
  // 初期カーソル位置 (contextmenu event の clientX/Y)。
  x: number;
  y: number;
  // 親が computeCardContextMenuMode で計算 (render 無しで判定を test できるよう)。
  mode: CardContextMenuMode;
  // single モードは viewer ごとに「ビューアで開く」を出す。bulk は bulkDstViewerId が宛先 (#11)。
  viewers: Viewer[];
  activeViewerId: string;
  // 選択件数 (bulk モードのみ意味を持つ)。ラベルと split-open の gate に使う。
  selectedCount: number;
  // bulk の宛先 viewer id — toolbar の <select> 由来で、toolbar とメニューが同じ
  // viewer に開くように (spec §11-E)。
  bulkDstViewerId: string;

  // single モードのアクション。
  onOpenInViewer: (viewerId: string) => void;
  onCopy: () => void;
  // ダブり候補の確認 (#136)。null = 対象 card にダブり候補が無い (項目自体を出さない)。
  onShowDuplicates: (() => void) | null;
  onEnterSelectionMode: () => void;
  onDelete: () => void;

  // bulk アクション。宛先と選択は親が供給する (メニューは出所を知らなくてよい)。
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

// 分類 Card の右クリックメニュー。2 モード (single / bulk, spec §5.2)。chrome と
// outside-click / Esc は TabContextMenu に合わせる。createPortal で描画するのは
// .cls-view の zoom: var(--ui-scale) 祖先の外に出すため (#72)。
export function CardContextMenu({
  x,
  y,
  mode,
  viewers,
  activeViewerId,
  selectedCount,
  bulkDstViewerId,
  onOpenInViewer,
  onCopy,
  onShowDuplicates,
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
          onCopy,
          onShowDuplicates,
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
    // メニューを開いた click / contextmenu を拾わないよう登録を defer。
    const t = window.setTimeout(() => {
      const onDocPointerDown = (e: PointerEvent) => {
        // mousedown でなく pointerdown — ImageView の pan-drag が pointerdown を
        // preventDefault して合成 mousedown を抑止するので、その上のクリックでも
        // メニューを閉じられるように (#56)。
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

  // 矢印キー縦移動。disabled を除外するのは wrap 計算が引っかかって ArrowDown が
  // 止まらないようにするため。
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
    // Math.max(0, ...) で下限を切り、メニューより狭い/低い窓でも負座標に押し出されないように。
    left: Math.max(0, Math.min(x, window.innerWidth - APPROX_MENU_WIDTH)),
    top: Math.max(0, Math.min(y, window.innerHeight - approxHeight)),
  }));

  // 初回 commit 後 (paint 前) に実サイズを測って再クランプ (OS/browser/font の
  // line-height 差で画面外に出ないように)。mount のみ — 毎 render 実行は flicker する。
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

  // 各 <button> に安定した itemsRef スロットを割り当てる。slot index を render 時に
  // 確定するのは StrictMode の二重呼び出し / unmount-null cleanup で slot がずれないため。
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
  onCopy: () => void,
  onShowDuplicates: (() => void) | null,
  onEnterSelectionMode: () => void,
  onDelete: () => void,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const v of viewers) {
    // 単一ビューア時は "(現在)" を付けない (情報量ゼロなので)。
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
  // クリップボードへコピー (#127)。常に出すので viewer が無くても下の divider が有効。
  entries.push({
    kind: "item",
    key: "copy",
    label: "コピー",
    onClick: onCopy,
  });
  // ダブり候補の確認 (#136)。バッジが出ている card のみ (「この画像に対する操作」グループ)。
  if (onShowDuplicates) {
    entries.push({
      kind: "item",
      key: "show-duplicates",
      label: "ダブり候補を確認…",
      onClick: onShowDuplicates,
    });
  }
  entries.push({ kind: "divider", key: "div-after-image-actions" });
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
  // 複数ビューア時だけ "→ {name}" を出す (1 個なら宛先を誤解しようがないので不要)。
  const intoSuffix = dst && viewers.length > 1 ? ` → ${dst.name}` : "";
  const splitDisabled = !canBulkSplitOpen(selectedCount);
  // disabled <button> は focus できず title / aria-label が SR / キーボードに届かないので、
  // 上限理由を可視ラベルに埋めて disabled 状態が自己説明するようにする。title は hover 補助。
  const splitLabel = splitDisabled
    ? `${selectedCount} 件をパネル分割で開く (上限 ${SPLIT_OPEN_LIMIT} 枚)${intoSuffix}`
    : `${selectedCount} 件をパネル分割で開く${intoSuffix}`;
  const tabsLabel = `${selectedCount} 件をタブで開く${intoSuffix}`;
  // disabled 時は上限ヒントを tooltip に。有効時は full ラベルにして、省略された
  // viewer 名の末尾を hover で読めるようにする (viewer 名は最大 32 runes で ellipsis が末尾を隠す)。
  const splitTitle = splitDisabled
    ? `パネル分割で開けるのは ${SPLIT_OPEN_LIMIT} 枚までです (タブで開いてください)`
    : splitLabel;

  return [
    {
      kind: "item",
      key: "bulk-open-tabs",
      label: tabsLabel,
      title: tabsLabel,
      className: "ctx-item-viewer",
      onClick: onOpenManyInTabs,
    },
    {
      kind: "item",
      key: "bulk-open-split",
      label: splitLabel,
      title: splitTitle,
      className: "ctx-item-viewer",
      onClick: onOpenManyAsSplit,
      disabled: splitDisabled,
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
