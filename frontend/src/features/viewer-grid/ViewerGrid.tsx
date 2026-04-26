import { useRef, useState } from "react";
import { GridToolbar } from "./GridToolbar";
import { Panel } from "./Panel";
import { GridSplitter } from "./GridSplitter";
import { TabContextMenu } from "./TabContextMenu";
import {
  MAX_ROWS,
  MAX_COLS,
  sameCoord,
  type Grid,
  type PanelCoord,
} from "./useViewerGrid";
import type { Tab } from "./useTabs";

type Props = {
  grid: Grid;
  onActivatePanel: (coord: PanelCoord) => void;
  onSelectTab: (coord: PanelCoord, tabIndex: number) => void;
  onCloseTab: (coord: PanelCoord, tabIndex: number) => void;
  onUpdateTabState: (
    coord: PanelCoord,
    tabIndex: number,
    patch: Partial<Tab>
  ) => void;
  onMoveTab: (
    srcCoord: PanelCoord,
    srcIndex: number,
    dstCoord: PanelCoord
  ) => void;
  onAddRow: () => void;
  onAddCol: () => void;
  onRemoveRow: () => void;
  onRemoveCol: () => void;
  onSetRowSizes: (sizes: number[]) => void;
  onSetColSizes: (sizes: number[]) => void;
};

type ContextState = {
  srcCoord: PanelCoord;
  tabIndex: number;
  x: number;
  y: number;
};

export function ViewerGrid(props: Props) {
  const { grid } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<ContextState | null>(null);

  const gridTemplateRows = buildTemplate(grid.rowSizes);
  const gridTemplateColumns = buildTemplate(grid.colSizes);

  const onTabContextMenu = (
    coord: PanelCoord,
    tabIndex: number,
    e: React.MouseEvent
  ) => {
    setCtx({ srcCoord: coord, tabIndex, x: e.clientX, y: e.clientY });
  };

  return (
    <div className="viewer-grid">
      <GridToolbar
        canAddRow={grid.size.rows < MAX_ROWS}
        canAddCol={grid.size.cols < MAX_COLS}
        canRemoveRow={grid.size.rows > 1}
        canRemoveCol={grid.size.cols > 1}
        onAddRow={props.onAddRow}
        onAddCol={props.onAddCol}
        onRemoveRow={props.onRemoveRow}
        onRemoveCol={props.onRemoveCol}
      />
      <div
        className="panel-grid"
        ref={containerRef}
        style={{ gridTemplateRows, gridTemplateColumns }}
      >
        {grid.panels.map((panel, idx) => {
          const row = Math.floor(idx / grid.size.cols);
          const col = idx % grid.size.cols;
          const coord = { row, col };
          return (
            <Panel
              key={`${row},${col}`}
              coord={coord}
              panel={panel}
              isActive={sameCoord(coord, grid.active)}
              style={{
                gridRow: `${row * 2 + 1} / ${row * 2 + 2}`,
                gridColumn: `${col * 2 + 1} / ${col * 2 + 2}`,
              }}
              onActivate={props.onActivatePanel}
              onSelectTab={props.onSelectTab}
              onCloseTab={props.onCloseTab}
              onUpdateTabState={props.onUpdateTabState}
              onTabContextMenu={onTabContextMenu}
            />
          );
        })}
        {grid.colSizes.slice(0, -1).map((_, i) => (
          <GridSplitter
            key={`col-sp-${i}`}
            direction="col"
            index={i}
            sizes={grid.colSizes}
            setSizes={props.onSetColSizes}
            containerRef={containerRef}
            style={{
              gridColumn: `${i * 2 + 2} / ${i * 2 + 3}`,
              gridRow: `1 / -1`,
            }}
          />
        ))}
        {grid.rowSizes.slice(0, -1).map((_, i) => (
          <GridSplitter
            key={`row-sp-${i}`}
            direction="row"
            index={i}
            sizes={grid.rowSizes}
            setSizes={props.onSetRowSizes}
            containerRef={containerRef}
            style={{
              gridRow: `${i * 2 + 2} / ${i * 2 + 3}`,
              gridColumn: `1 / -1`,
            }}
          />
        ))}
      </div>
      {ctx && (
        <TabContextMenu
          srcCoord={ctx.srcCoord}
          tabIndex={ctx.tabIndex}
          x={ctx.x}
          y={ctx.y}
          grid={grid}
          onClose={() => setCtx(null)}
          onCloseTab={() => {
            props.onCloseTab(ctx.srcCoord, ctx.tabIndex);
            setCtx(null);
          }}
          onMove={(dst) => {
            props.onMoveTab(ctx.srcCoord, ctx.tabIndex, dst);
            setCtx(null);
          }}
        />
      )}
    </div>
  );
}

function buildTemplate(sizes: number[]): string {
  // [0.4, 0.6] → "0.4fr 4px 0.6fr"
  return sizes.map((s, i) => (i === 0 ? `${s}fr` : `4px ${s}fr`)).join(" ");
}
