import { useEffect, useRef } from "react";
import { CloseIcon } from "../icons/CloseIcon";
import type { Tab } from "../hooks/useTabs";

type Props = {
  tabs: Tab[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
  onContextMenu?: (index: number, e: React.MouseEvent) => void;
};

export function TabBar({
  tabs,
  activeIndex,
  onSelect,
  onClose,
  onContextMenu,
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

  return (
    <div className="tab-bar" ref={barRef}>
      {tabs.map((tab, i) => (
        <div
          key={tab.path}
          className={`tab ${i === activeIndex ? "active" : ""}`}
          onClick={() => onSelect(i)}
          onMouseDown={(e) => onTabMouseDown(e, i)}
          onContextMenu={(e) => {
            if (onContextMenu) {
              e.preventDefault();
              onContextMenu(i, e);
            }
          }}
          title={tab.path}
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
      ))}
    </div>
  );
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
