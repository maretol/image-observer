import { useEffect, useRef } from "react";
import { SaveState } from "../../../wailsjs/go/main/App";
import { useDebounce } from "../../shared/utils/debounce";
import type { Grid } from "../viewer-grid/useViewerGrid";

export type SessionInput = {
  rootPath: string | null;
  leftPaneWidth: number;
  window: { width: number; height: number; x: number; y: number };
  grid: Grid;
};

const SAVE_DEBOUNCE_MS = 500;

export function useSessionSave(input: SessionInput) {
  // Serialize so the debounce only fires when the data actually changes.
  // The savings are tiny for our state size; this is simpler than per-field deps.
  const serialized = JSON.stringify(input);
  const debouncedJson = useDebounce(serialized, SAVE_DEBOUNCE_MS);
  const skipFirstRef = useRef(true);

  useEffect(() => {
    if (skipFirstRef.current) {
      skipFirstRef.current = false;
      return;
    }
    let parsed: SessionInput;
    try {
      parsed = JSON.parse(debouncedJson);
    } catch {
      return;
    }
    const data = buildStateData(parsed);
    SaveState(data as any).catch((e) => {
      console.warn("SaveState failed:", e);
    });
  }, [debouncedJson]);
}

function buildStateData(input: SessionInput) {
  return {
    version: 1,
    rootPath: input.rootPath ?? "",
    leftPaneWidth: input.leftPaneWidth,
    window: input.window,
    grid: {
      rows: input.grid.size.rows,
      cols: input.grid.size.cols,
      rowSizes: input.grid.rowSizes,
      colSizes: input.grid.colSizes,
      active: input.grid.active,
      panels: input.grid.panels.map((p) => ({
        tabs: p.tabs.map((t) => ({
          path: t.path,
          zoom: t.zoom,
          panX: t.panX,
          panY: t.panY,
        })),
        activeIndex: p.activeIndex,
      })),
    },
  };
}
