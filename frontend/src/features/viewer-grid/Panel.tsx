import { TabBar } from "./TabBar";
import { ImageView } from "./ImageView";
import type { LeafNode } from "./layout";
import type { Tab } from "./useTabs";
import { DATA_LEAF, type DnDState } from "./useDnD";
import { DropOverlay } from "./DropOverlay";

type Props = {
  leaf: LeafNode;
  isActive: boolean;
  dnd: DnDState | null;
  onActivate: (leafId: string) => void;
  onSelectTab: (leafId: string, tabIndex: number) => void;
  onCloseTab: (leafId: string, tabIndex: number) => void;
  onUpdateTabState: (
    leafId: string,
    tabIndex: number,
    patch: Partial<Tab>,
  ) => void;
  onTabContextMenu: (
    leafId: string,
    tabIndex: number,
    e: React.MouseEvent,
  ) => void;
  onStartDrag: (
    leafId: string,
    tabIdx: number,
    tabPath: string,
    e: React.PointerEvent,
  ) => void;
};

export function Panel(props: Props) {
  const { leaf, isActive, dnd } = props;
  const activeTab =
    leaf.activeIndex >= 0 && leaf.activeIndex < leaf.tabs.length
      ? leaf.tabs[leaf.activeIndex]
      : null;

  // Right-click on the image area opens the same menu as right-click on the tab,
  // but targets the active tab of this panel.
  const onCanvasContextMenu = (e: React.MouseEvent) => {
    if (!activeTab) return;
    e.preventDefault();
    props.onTabContextMenu(leaf.id, leaf.activeIndex, e);
  };

  return (
    <div
      className={`panel ${isActive ? "active" : ""}`}
      onMouseDown={() => props.onActivate(leaf.id)}
      {...{ [DATA_LEAF]: leaf.id }}
    >
      {leaf.tabs.length > 0 && (
        <TabBar
          leafId={leaf.id}
          tabs={leaf.tabs}
          activeIndex={leaf.activeIndex}
          dnd={dnd}
          onSelect={(i) => props.onSelectTab(leaf.id, i)}
          onClose={(i) => props.onCloseTab(leaf.id, i)}
          onContextMenu={(i, e) => props.onTabContextMenu(leaf.id, i, e)}
          onStartDrag={props.onStartDrag}
        />
      )}
      <div className="panel-canvas" onContextMenu={onCanvasContextMenu}>
        {activeTab ? (
          <ImageView
            key={activeTab.path}
            tab={activeTab}
            tabIndex={leaf.activeIndex}
            isActivePanel={isActive}
            onUpdateTabState={(tabIndex, patch) =>
              props.onUpdateTabState(leaf.id, tabIndex, patch)
            }
          />
        ) : (
          <div className="panel-empty">画像を選択してください</div>
        )}
        <DropOverlay leafId={leaf.id} dnd={dnd} />
      </div>
    </div>
  );
}
