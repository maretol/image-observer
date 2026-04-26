import { useCallback, useState } from "react";
import { newTab, type Tab } from "./useTabs";

// Future: replace with values from a Settings module (Phase H).
// Keeping these as a single point of mutation lets us swap to user-configurable
// values without touching the rest of the grid logic.
export const MAX_ROWS = 2;
export const MAX_COLS = 3;

export type PanelCoord = { row: number; col: number };

export type Panel = {
  tabs: Tab[];
  activeIndex: number; // -1 if no tabs
};

export type GridSize = { rows: number; cols: number };

export type Grid = {
  size: GridSize;
  panels: Panel[]; // length = rows * cols, indexed by row * cols + col
  rowSizes: number[]; // ratios summing to 1.0
  colSizes: number[]; // ratios summing to 1.0
  active: PanelCoord;
};

const emptyPanel = (): Panel => ({ tabs: [], activeIndex: -1 });
const equalSizes = (n: number): number[] =>
  Array.from({ length: n }, () => 1 / n);

export const panelIndex = (size: GridSize, c: PanelCoord): number =>
  c.row * size.cols + c.col;
export const panelAt = (grid: Grid, c: PanelCoord): Panel =>
  grid.panels[panelIndex(grid.size, c)];
export const sameCoord = (a: PanelCoord, b: PanelCoord): boolean =>
  a.row === b.row && a.col === b.col;

const initialGrid: Grid = {
  size: { rows: 1, cols: 1 },
  panels: [emptyPanel()],
  rowSizes: [1],
  colSizes: [1],
  active: { row: 0, col: 0 },
};

function recomputeActiveAfterClose(
  curActive: number,
  closedIndex: number,
  newLen: number
): number {
  if (newLen === 0) return -1;
  if (curActive === closedIndex) return Math.min(closedIndex, newLen - 1);
  if (curActive > closedIndex) return curActive - 1;
  return curActive;
}

function updatePanelInGrid(
  g: Grid,
  coord: PanelCoord,
  fn: (p: Panel) => Panel
): Grid {
  const idx = panelIndex(g.size, coord);
  return { ...g, panels: g.panels.map((p, i) => (i === idx ? fn(p) : p)) };
}

function countTabsInRow(g: Grid, row: number): number {
  let n = 0;
  for (let c = 0; c < g.size.cols; c++)
    n += g.panels[row * g.size.cols + c].tabs.length;
  return n;
}

function countTabsInCol(g: Grid, col: number): number {
  let n = 0;
  for (let r = 0; r < g.size.rows; r++)
    n += g.panels[r * g.size.cols + col].tabs.length;
  return n;
}

export function useViewerGrid(opts?: { initialGrid?: Grid }) {
  const [grid, setGrid] = useState<Grid>(opts?.initialGrid ?? initialGrid);

  const setActivePanel = useCallback((coord: PanelCoord) => {
    setGrid((g) => (sameCoord(g.active, coord) ? g : { ...g, active: coord }));
  }, []);

  const setActiveTab = useCallback((coord: PanelCoord, tabIndex: number) => {
    setGrid((g) =>
      updatePanelInGrid(g, coord, (p) => ({ ...p, activeIndex: tabIndex }))
    );
  }, []);

  const closeTab = useCallback((coord: PanelCoord, tabIndex: number) => {
    setGrid((g) =>
      updatePanelInGrid(g, coord, (p) => {
        const newTabs = p.tabs.filter((_, i) => i !== tabIndex);
        return {
          tabs: newTabs,
          activeIndex: recomputeActiveAfterClose(
            p.activeIndex,
            tabIndex,
            newTabs.length
          ),
        };
      })
    );
  }, []);

  const updateTabState = useCallback(
    (coord: PanelCoord, tabIndex: number, patch: Partial<Tab>) => {
      setGrid((g) =>
        updatePanelInGrid(g, coord, (p) => ({
          ...p,
          tabs: p.tabs.map((t, i) => (i === tabIndex ? { ...t, ...patch } : t)),
        }))
      );
    },
    []
  );

  const openInActive = useCallback((path: string) => {
    setGrid((g) => {
      const cur = panelAt(g, g.active);
      const existing = cur.tabs.findIndex((t) => t.path === path);
      if (existing >= 0) {
        return updatePanelInGrid(g, g.active, (p) => ({
          ...p,
          activeIndex: existing,
        }));
      }
      return updatePanelInGrid(g, g.active, (p) => {
        const newTabs = [...p.tabs, newTab(path)];
        return { tabs: newTabs, activeIndex: newTabs.length - 1 };
      });
    });
  }, []);

  const moveTab = useCallback(
    (srcCoord: PanelCoord, srcIndex: number, dstCoord: PanelCoord) => {
      if (sameCoord(srcCoord, dstCoord)) return;
      setGrid((g) => {
        const src = panelAt(g, srcCoord);
        const dst = panelAt(g, dstCoord);
        const tab = src.tabs[srcIndex];
        if (!tab) return g;

        const existing = dst.tabs.findIndex((t) => t.path === tab.path);
        let newDstTabs: Tab[];
        let newDstActive: number;
        if (existing >= 0) {
          newDstTabs = dst.tabs;
          newDstActive = existing;
        } else {
          newDstTabs = [...dst.tabs, tab];
          newDstActive = newDstTabs.length - 1;
        }

        const newSrcTabs = src.tabs.filter((_, i) => i !== srcIndex);
        const newSrcActive = recomputeActiveAfterClose(
          src.activeIndex,
          srcIndex,
          newSrcTabs.length
        );

        const srcIdx = panelIndex(g.size, srcCoord);
        const dstIdx = panelIndex(g.size, dstCoord);
        const newPanels = g.panels.map((p, i) => {
          if (i === srcIdx)
            return { tabs: newSrcTabs, activeIndex: newSrcActive };
          if (i === dstIdx)
            return { tabs: newDstTabs, activeIndex: newDstActive };
          return p;
        });
        return { ...g, panels: newPanels, active: dstCoord };
      });
    },
    []
  );

  const addRow = useCallback(() => {
    setGrid((g) => {
      if (g.size.rows >= MAX_ROWS) return g;
      const newRows = g.size.rows + 1;
      const newPanels = [...g.panels];
      for (let c = 0; c < g.size.cols; c++) newPanels.push(emptyPanel());
      return {
        size: { rows: newRows, cols: g.size.cols },
        panels: newPanels,
        rowSizes: equalSizes(newRows),
        colSizes: g.colSizes,
        active: g.active,
      };
    });
  }, []);

  const addCol = useCallback(() => {
    setGrid((g) => {
      if (g.size.cols >= MAX_COLS) return g;
      const newCols = g.size.cols + 1;
      const newPanels: Panel[] = [];
      for (let r = 0; r < g.size.rows; r++) {
        for (let c = 0; c < g.size.cols; c++) {
          newPanels.push(g.panels[r * g.size.cols + c]);
        }
        newPanels.push(emptyPanel());
      }
      return {
        size: { rows: g.size.rows, cols: newCols },
        panels: newPanels,
        rowSizes: g.rowSizes,
        colSizes: equalSizes(newCols),
        active: g.active,
      };
    });
  }, []);

  const removeRow = useCallback(() => {
    setGrid((g) => {
      if (g.size.rows <= 1) return g;
      const lastRow = g.size.rows - 1;
      const tabCount = countTabsInRow(g, lastRow);
      if (tabCount > 0) {
        if (
          !window.confirm(`${tabCount} 個のタブが閉じられます。続行しますか?`)
        )
          return g;
      }
      const newRows = g.size.rows - 1;
      const newPanels = g.panels.slice(0, newRows * g.size.cols);
      const newActive: PanelCoord =
        g.active.row >= newRows ? { row: 0, col: 0 } : g.active;
      return {
        size: { rows: newRows, cols: g.size.cols },
        panels: newPanels,
        rowSizes: equalSizes(newRows),
        colSizes: g.colSizes,
        active: newActive,
      };
    });
  }, []);

  const removeCol = useCallback(() => {
    setGrid((g) => {
      if (g.size.cols <= 1) return g;
      const lastCol = g.size.cols - 1;
      const tabCount = countTabsInCol(g, lastCol);
      if (tabCount > 0) {
        if (
          !window.confirm(`${tabCount} 個のタブが閉じられます。続行しますか?`)
        )
          return g;
      }
      const newCols = g.size.cols - 1;
      const newPanels: Panel[] = [];
      for (let r = 0; r < g.size.rows; r++) {
        for (let c = 0; c < newCols; c++) {
          newPanels.push(g.panels[r * g.size.cols + c]);
        }
      }
      const newActive: PanelCoord =
        g.active.col >= newCols ? { row: 0, col: 0 } : g.active;
      return {
        size: { rows: g.size.rows, cols: newCols },
        panels: newPanels,
        rowSizes: g.rowSizes,
        colSizes: equalSizes(newCols),
        active: newActive,
      };
    });
  }, []);

  const setRowSizes = useCallback((sizes: number[]) => {
    setGrid((g) => ({ ...g, rowSizes: sizes }));
  }, []);

  const setColSizes = useCallback((sizes: number[]) => {
    setGrid((g) => ({ ...g, colSizes: sizes }));
  }, []);

  return {
    grid,
    openInActive,
    setActivePanel,
    setActiveTab,
    closeTab,
    updateTabState,
    moveTab,
    addRow,
    addCol,
    removeRow,
    removeCol,
    setRowSizes,
    setColSizes,
  };
}
