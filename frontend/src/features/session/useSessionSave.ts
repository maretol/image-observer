import { useEffect, useRef } from "react";
import { SaveState } from "../../../wailsjs/go/main/App";
import { useDebounce } from "../../shared/utils/debounce";
import type { Grid } from "../viewer-grid/useViewerGrid";

export type ListPersist = {
  folderPath: string;
  filter: {
    tags: string[];
    confidence: string; // "all" | "high" | "mid" | "low"
    query: string;
  };
};

export type SessionInput = {
  window: { width: number; height: number; x: number; y: number };
  grid: Grid;
  topTab: "list" | "viewer";
  list: ListPersist;
};

const SAVE_DEBOUNCE_MS = 500;
const STATE_SCHEMA_VERSION = 2;

export function useSessionSave(input: SessionInput) {
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
    version: STATE_SCHEMA_VERSION,
    // v1 leftovers; kept in payload to satisfy the Go struct shape but unused.
    rootPath: "",
    leftPaneWidth: 280,
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
    topTab: input.topTab,
    list: {
      folderPath: input.list.folderPath,
      filter: {
        tags: input.list.filter.tags,
        confidence: input.list.filter.confidence,
        query: input.list.filter.query,
      },
    },
  };
}
