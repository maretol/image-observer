import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Viewer = { id: string; name: string };

type Props = {
  leafId: string;
  tabIndex: number;
  x: number;
  y: number;
  // 現在以外の各 viewer を top-level の "{name} へ移動" menuitem として出す (#11, #57)。
  // viewer が 1 個なら entry (と前の divider) を抑止。
  viewers: Viewer[];
  currentViewerId: string;
  onClose: () => void;
  onCopy: () => void;
  onCloseTab: () => void;
  onSplit: (direction: "col" | "row") => void;
  onMoveToViewer: (dstViewerId: string) => void;
};

// *初期* 位置 seed 用の概算幅 / item 高さ。実際の画面端クランプは DOM commit 後 paint 前の
// useLayoutEffect で getBoundingClientRect により再計算するので、初回描画で飛ばない程度でよい。
const APPROX_MENU_WIDTH = 320;
const CTX_ITEM_HEIGHT = 24; // padding 5+5 + line-height ≈ 14
const CTX_DIVIDER_HEIGHT = 9; // height 1 + margin 4+4
const CTX_MENU_CHROME_HEIGHT = 14; // padding 6+6 + border 1+1

export function TabContextMenu({
  x,
  y,
  viewers,
  currentViewerId,
  onClose,
  onCopy,
  onCloseTab,
  onSplit,
  onMoveToViewer,
}: Props) {
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const otherViewers = viewers.filter((v) => v.id !== currentViewerId);
  const hasMoveItems = otherViewers.length > 0;

  useEffect(() => {
    // メニューを開いた click を拾わないよう登録を defer。
    const t = window.setTimeout(() => {
      const onDocPointerDown = (e: PointerEvent) => {
        // mousedown でなく pointerdown を聞く: ImageView の pan-drag が pointerdown を
        // preventDefault して合成 mousedown を抑止するので、画像領域クリックでもメニューを閉じる (#56)。
        const target = e.target as Element | null;
        if (target && target.closest(".tab-context-menu-root")) return;
        onClose();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("pointerdown", onDocPointerDown);
      document.addEventListener("keydown", onKey);
      // keyboard ユーザーが先頭 item に着くよう menu へ focus を移す。
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

  // menu item 間の矢印キー縦移動。上↔下で wrap。
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

  // item 数からの初期位置 seed。固定 4 item (コピー / 閉じる / split×2) + 常に 2 divider、
  // + 他 viewer があれば (1 divider + N viewer item)。seed のみ — 下の useLayoutEffect が実測して再クランプ。
  const itemCount = 4 + otherViewers.length;
  const dividerCount = 2 + (hasMoveItems ? 1 : 0);
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

  // 初回 commit 後 (paint 前) に実サイズを測って再クランプ (line-height 差で画面外に出ないように)。
  // 実際に overflow したときだけ調整 (カーソルとの隙間を詰めると不自然)。
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
    // mount のみ: pos / x / y は closure 捕捉。2 回目の render は viewport 内に着くので再クランプは
    // no-op、毎 render 実行は flicker する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // menuitem を単一 flat 配列で作り、他 viewer 数によらず itemsRef index を安定させる。
  // 順: コピー → 閉じる → split×2 → (divider) → viewer×N。コピーが index 0 で初期 focus。
  // 各 index を render 時に確定するのは StrictMode の二重呼び出し / unmount-null cleanup で slot が
  // ずれないため。
  let refIdx = 0;
  const copyIdx = refIdx++;
  const closeIdx = refIdx++;
  const splitColIdx = refIdx++;
  const splitRowIdx = refIdx++;
  const assignRef = (el: HTMLButtonElement | null, i: number) => {
    itemsRef.current[i] = el;
  };

  return (
    <div
      ref={rootRef}
      className="tab-context-menu-root"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 1000 }}
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
          ref={(el) => assignRef(el, copyIdx)}
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={onCopy}
        >
          コピー
        </button>
        <div className="ctx-divider" role="separator" />
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
