import { useEffect, useRef } from "react";
import { SaveState } from "../../../wailsjs/go/main/App";
import { useDebounce } from "../../shared/utils/debounce";
import { logger } from "../../shared/utils/logger";
import { serializeLayout, type Layout } from "../viewer-grid/layout";

export type ListPersist = {
  folderPath: string;
  filter: {
    tags: string[];
    confidence: string; // "all" | "high" | "mid" | "low"
    query: string;
  };
  collapsedGroups: string[];
};

export type SessionInput = {
  window: { width: number; height: number; x: number; y: number };
  layout: Layout;
  topTab: "list" | "viewer";
  list: ListPersist;
};

const SAVE_DEBOUNCE_MS = 500;
const STATE_SCHEMA_VERSION = 4;

export function useSessionSave(input: SessionInput) {
  const serialized = JSON.stringify({
    window: input.window,
    layout: serializeLayout(input.layout),
    topTab: input.topTab,
    list: input.list,
  });
  const debouncedJson = useDebounce(serialized, SAVE_DEBOUNCE_MS);
  const skipFirstRef = useRef(true);

  useEffect(() => {
    if (skipFirstRef.current) {
      skipFirstRef.current = false;
      return;
    }
    let parsed: {
      window: SessionInput["window"];
      layout: ReturnType<typeof serializeLayout>;
      topTab: SessionInput["topTab"];
      list: ListPersist;
    };
    try {
      parsed = JSON.parse(debouncedJson);
    } catch {
      return;
    }
    const data = buildStateData(parsed);
    SaveState(data as any).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("SaveState failed:", e);
      logger.warn("state", "save failed", { err: msg });
    });
  }, [debouncedJson]);
}

function buildStateData(input: {
  window: SessionInput["window"];
  layout: ReturnType<typeof serializeLayout>;
  topTab: SessionInput["topTab"];
  list: ListPersist;
}) {
  return {
    version: STATE_SCHEMA_VERSION,
    // v1 leftovers; kept in payload to satisfy the Go struct shape but unused.
    rootPath: "",
    leftPaneWidth: 280,
    window: input.window,
    layout: input.layout,
    topTab: input.topTab,
    list: {
      folderPath: input.list.folderPath,
      filter: {
        tags: input.list.filter.tags,
        confidence: input.list.filter.confidence,
        query: input.list.filter.query,
      },
      collapsedGroups: input.list.collapsedGroups,
    },
  };
}
