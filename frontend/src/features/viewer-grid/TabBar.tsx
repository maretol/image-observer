import { Fragment, useEffect, useRef } from "react";
import { CloseIcon } from "../../shared/icons/CloseIcon";
import { basename } from "../../shared/utils/path";
import type { Tab } from "./useTabs";
import { DATA_TAB, DATA_TAB_BAR, type DnDState } from "./useDnD";

type Props = {
  leafId: string;
  tabs: Tab[];
  activeIndex: number;
  dnd: DnDState | null;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
  onContextMenu?: (index: number, e: React.MouseEvent) => void;
  onStartDrag: (
    leafId: string,
    tabIdx: number,
    tabPath: string,
    e: React.PointerEvent,
  ) => void;
};

export function TabBar({
  leafId,
  tabs,
  activeIndex,
  dnd,
  onSelect,
  onClose,
  onContextMenu,
  onStartDrag,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null);

  // tab bar 上の縦ホイール → 横スクロール。非 passive で attach し preventDefault してページ
  // スクロールを防ぐ。
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.shiftKey) return; // ユーザー主導の横スクロール、browser に任せる
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // タブ中クリックで閉じる。preventDefault で中クリック autoscroll を止める。
  const onTabMouseDown = (e: React.MouseEvent, index: number) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose(index);
    }
  };

  const onTabPointerDown = (e: React.PointerEvent, index: number, path: string) => {
    if (e.button !== 0) return; // 主ボタンのみ
    // browser の drag 時 text 選択を抑止。
    e.preventDefault();
    onStartDrag(leafId, index, path, e);
  };

  // tab strip の roving tabindex (Left/Right/Home/End)。focus した tab は active にもなる
  // (標準の follow-focus パターン、切替が安いので click 挙動と揃える)。
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = index > 0 ? index - 1 : tabs.length - 1;
    else if (e.key === "ArrowRight")
      next = index < tabs.length - 1 ? index + 1 : 0;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    onSelect(next);
    // aria-selected = focused tab に合わせ DOM focus を移す。
    const bar = barRef.current;
    const target = bar?.querySelector<HTMLElement>(`[${DATA_TAB}="${next}"]`);
    target?.focus();
  };

  const isInsertHere =
    dnd?.active && dnd.hit?.kind === "tab-bar" && dnd.hit.leafId === leafId;
  const insertIdx = isInsertHere
    ? (dnd!.hit as { insertIdx: number }).insertIdx
    : -1;

  return (
    <div
      className="tab-bar"
      role="tablist"
      ref={barRef}
      {...{ [DATA_TAB_BAR]: leafId }}
    >
      {tabs.map((tab, i) => (
        <Fragment key={tab.path}>
          {insertIdx === i && <span className="tab-insert-indicator" />}
          <div
            className={`tab ${i === activeIndex ? "active" : ""}`}
            role="tab"
            aria-selected={i === activeIndex}
            tabIndex={i === activeIndex ? 0 : -1}
            onClick={(e) => {
              onSelect(i);
              // onPointerDown が DnD 用に preventDefault して text 選択を抑止するが、mousedown での
              // 既定の focus 移動も止まる。この手動 focus() が無いと DOM focus は前の active tab に
              // 残り、aria-selected / tabIndex=0 だけ新 tab に移って次の矢印キーが誤爆する。
              e.currentTarget.focus();
            }}
            onMouseDown={(e) => onTabMouseDown(e, i)}
            onPointerDown={(e) => onTabPointerDown(e, i, tab.path)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
            onContextMenu={(e) => {
              if (onContextMenu) {
                e.preventDefault();
                onContextMenu(i, e);
              }
            }}
            title={tab.path}
            {...{ [DATA_TAB]: i }}
          >
            <span className="tab-name">{basename(tab.path)}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(i);
              }}
              aria-label="閉じる"
              tabIndex={-1}
            >
              <CloseIcon />
            </button>
          </div>
        </Fragment>
      ))}
      {insertIdx === tabs.length && <span className="tab-insert-indicator" />}
    </div>
  );
}
