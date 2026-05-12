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

  // Vertical wheel → horizontal scroll on the tab bar.
  // Attached as non-passive so we can preventDefault and avoid the page scrolling.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.shiftKey) return; // user-initiated horizontal scroll, leave to browser
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Middle-click on a tab closes it. preventDefault stops middle-click autoscroll.
  const onTabMouseDown = (e: React.MouseEvent, index: number) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose(index);
    }
  };

  const onTabPointerDown = (e: React.PointerEvent, index: number, path: string) => {
    if (e.button !== 0) return; // only primary
    // Suppress the browser's default text-selection-on-drag.
    e.preventDefault();
    onStartDrag(leafId, index, path, e);
  };

  const isInsertHere =
    dnd?.active && dnd.hit?.kind === "tab-bar" && dnd.hit.leafId === leafId;
  const insertIdx = isInsertHere
    ? (dnd!.hit as { insertIdx: number }).insertIdx
    : -1;

  return (
    <div
      className="tab-bar"
      ref={barRef}
      {...{ [DATA_TAB_BAR]: leafId }}
    >
      {tabs.map((tab, i) => (
        <Fragment key={tab.path}>
          {insertIdx === i && <span className="tab-insert-indicator" />}
          <div
            className={`tab ${i === activeIndex ? "active" : ""}`}
            onClick={() => onSelect(i)}
            onMouseDown={(e) => onTabMouseDown(e, i)}
            onPointerDown={(e) => onTabPointerDown(e, i, tab.path)}
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
