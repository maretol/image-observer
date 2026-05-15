import { useRef, useState } from "react";
import { Panel } from "./Panel";
import { GridSplitter } from "./GridSplitter";
import { TabContextMenu } from "./TabContextMenu";
import { TabDragGhost } from "./TabDragGhost";
import { useDnD, type DnDState } from "./useDnD";
import type {
  Edge,
  Layout,
  LayoutNode,
  SplitDirection,
} from "./layout";
import type { Tab } from "./useTabs";

type Props = {
  layout: Layout;
  wheelMode?: string;
  // Multi-viewer (#11): identify which viewer this grid belongs to + the
  // sibling viewers so the tab right-click menu can offer "ビューアへ移動".
  viewers: { id: string; name: string }[];
  currentViewerId: string;
  onActivatePanel: (leafId: string) => void;
  onSelectTab: (leafId: string, tabIndex: number) => void;
  onCloseTab: (leafId: string, tabIndex: number) => void;
  onUpdateTabState: (
    leafId: string,
    tabIndex: number,
    patch: Partial<Tab>,
  ) => void;
  onMoveTab: (
    srcLeafId: string,
    srcIdx: number,
    dstLeafId: string,
    dstIdx?: number,
  ) => void;
  onReorderTab: (leafId: string, srcIdx: number, dstIdx: number) => void;
  onSplitTab: (
    srcLeafId: string,
    srcIdx: number,
    dstLeafId: string,
    edge: Edge,
  ) => boolean;
  onSplitFromContext: (
    leafId: string,
    tabIdx: number,
    direction: SplitDirection,
  ) => boolean;
  onSetSplitRatio: (splitId: string, ratio: number) => void;
  onMoveTabToViewer: (
    srcLeafId: string,
    srcIdx: number,
    dstViewerId: string,
  ) => void;
};

type ContextState = {
  leafId: string;
  tabIndex: number;
  x: number;
  y: number;
};

export function ViewerGrid(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<ContextState | null>(null);

  const { dnd, startDrag } = useDnD({
    moveTab: props.onMoveTab,
    reorderTab: props.onReorderTab,
    splitTab: props.onSplitTab,
  });

  const onTabContextMenu = (
    leafId: string,
    tabIndex: number,
    e: React.MouseEvent,
  ) => {
    setCtx({ leafId, tabIndex, x: e.clientX, y: e.clientY });
  };

  return (
    <div className="viewer-grid">
      <div className="panel-tree" ref={containerRef}>
        <RenderNode
          node={props.layout.root}
          activeId={props.layout.activeId}
          wheelMode={props.wheelMode}
          containerRef={containerRef}
          dnd={dnd}
          onActivate={props.onActivatePanel}
          onSelectTab={props.onSelectTab}
          onCloseTab={props.onCloseTab}
          onUpdateTabState={props.onUpdateTabState}
          onTabContextMenu={onTabContextMenu}
          onSetSplitRatio={props.onSetSplitRatio}
          onStartDrag={startDrag}
        />
      </div>
      {ctx && (
        <TabContextMenu
          leafId={ctx.leafId}
          tabIndex={ctx.tabIndex}
          x={ctx.x}
          y={ctx.y}
          viewers={props.viewers}
          currentViewerId={props.currentViewerId}
          onClose={() => setCtx(null)}
          onCloseTab={() => {
            props.onCloseTab(ctx.leafId, ctx.tabIndex);
            setCtx(null);
          }}
          onSplit={(direction) => {
            props.onSplitFromContext(ctx.leafId, ctx.tabIndex, direction);
            setCtx(null);
          }}
          onMoveToViewer={(dstViewerId) => {
            props.onMoveTabToViewer(ctx.leafId, ctx.tabIndex, dstViewerId);
            setCtx(null);
          }}
        />
      )}
      <TabDragGhost dnd={dnd} />
    </div>
  );
}

type RenderNodeProps = {
  node: LayoutNode;
  activeId: string;
  wheelMode?: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
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
  onSetSplitRatio: (splitId: string, ratio: number) => void;
  onStartDrag: (
    leafId: string,
    tabIdx: number,
    tabPath: string,
    e: React.PointerEvent,
  ) => void;
};

function RenderNode(props: RenderNodeProps) {
  const { node, activeId, dnd } = props;
  if (node.kind === "leaf") {
    return (
      <Panel
        leaf={node}
        isActive={activeId === node.id}
        wheelMode={props.wheelMode}
        dnd={dnd}
        onActivate={props.onActivate}
        onSelectTab={props.onSelectTab}
        onCloseTab={props.onCloseTab}
        onUpdateTabState={props.onUpdateTabState}
        onTabContextMenu={props.onTabContextMenu}
        onStartDrag={props.onStartDrag}
      />
    );
  }
  // SplitNode: render two children with a draggable splitter between them.
  const isCol = node.direction === "col";
  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: isCol ? "row" : "column",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
  };
  const aStyle: React.CSSProperties = {
    flex: `${node.ratio} 1 0`,
    minWidth: 0,
    minHeight: 0,
  };
  const bStyle: React.CSSProperties = {
    flex: `${1 - node.ratio} 1 0`,
    minWidth: 0,
    minHeight: 0,
  };
  return (
    <div className={`split split-${node.direction}`} style={containerStyle}>
      <div style={aStyle}>
        <RenderNode {...props} node={node.a} />
      </div>
      <GridSplitter
        splitId={node.id}
        direction={node.direction}
        ratio={node.ratio}
        containerRef={props.containerRef}
        onChangeRatio={props.onSetSplitRatio}
      />
      <div style={bStyle}>
        <RenderNode {...props} node={node.b} />
      </div>
    </div>
  );
}
