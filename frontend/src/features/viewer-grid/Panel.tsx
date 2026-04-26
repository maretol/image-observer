import { TabBar } from "./TabBar";
import { ImageView } from "./ImageView";
import type { Panel as PanelData, PanelCoord } from "./useViewerGrid";
import type { Tab } from "./useTabs";

type Props = {
  coord: PanelCoord;
  panel: PanelData;
  isActive: boolean;
  style?: React.CSSProperties;
  onActivate: (coord: PanelCoord) => void;
  onSelectTab: (coord: PanelCoord, tabIndex: number) => void;
  onCloseTab: (coord: PanelCoord, tabIndex: number) => void;
  onUpdateTabState: (
    coord: PanelCoord,
    tabIndex: number,
    patch: Partial<Tab>
  ) => void;
  onTabContextMenu: (
    coord: PanelCoord,
    tabIndex: number,
    e: React.MouseEvent
  ) => void;
};

export function Panel(props: Props) {
  const { coord, panel, isActive, style } = props;
  const activeTab =
    panel.activeIndex >= 0 && panel.activeIndex < panel.tabs.length
      ? panel.tabs[panel.activeIndex]
      : null;

  // Right-click on the image area opens the same menu as right-click on the tab,
  // but targets the active tab of this panel.
  const onCanvasContextMenu = (e: React.MouseEvent) => {
    if (!activeTab) return;
    e.preventDefault();
    props.onTabContextMenu(coord, panel.activeIndex, e);
  };

  return (
    <div
      className={`panel ${isActive ? "active" : ""}`}
      style={style}
      onMouseDown={() => props.onActivate(coord)}
    >
      {panel.tabs.length > 0 && (
        <TabBar
          tabs={panel.tabs}
          activeIndex={panel.activeIndex}
          onSelect={(i) => props.onSelectTab(coord, i)}
          onClose={(i) => props.onCloseTab(coord, i)}
          onContextMenu={(i, e) => props.onTabContextMenu(coord, i, e)}
        />
      )}
      <div className="panel-canvas" onContextMenu={onCanvasContextMenu}>
        {activeTab ? (
          <ImageView
            key={activeTab.path}
            tab={activeTab}
            tabIndex={panel.activeIndex}
            onUpdateTabState={(tabIndex, patch) =>
              props.onUpdateTabState(coord, tabIndex, patch)
            }
          />
        ) : (
          <div className="panel-empty">画像を選択してください</div>
        )}
      </div>
    </div>
  );
}
