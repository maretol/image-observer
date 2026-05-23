import { useEffect, useRef } from "react";
import { SaveState } from "../../../wailsjs/go/main/App";
import { state } from "../../../wailsjs/go/models";
import { useDebounce } from "../../shared/utils/debounce";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { serializeLayout } from "../viewer-grid/layout";
import type { Viewer } from "../viewer-grid/viewers";

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
  // `maximized` rides alongside the restore geometry (see WindowState doc on
  // the Go side / App.tsx polling effect for the freeze-while-maximized rule).
  window: {
    width: number;
    height: number;
    x: number;
    y: number;
    maximized: boolean;
  };
  // Viewer set (#11). Each viewer holds an independent BSP layout; persistence
  // serializes the layouts together so re-launch restores both content and
  // active selection.
  viewers: Viewer[];
  activeViewerId: string;
  topTab: "list" | "viewer";
  list: ListPersist;
};

const SAVE_DEBOUNCE_MS = 500;
const STATE_SCHEMA_VERSION = 6;

export function useSessionSave(input: SessionInput) {
  // The serialized form goes through JSON.stringify so the debounce only
  // fires when something actually changed (ignoring object identity churn).
  // Layouts serialize per-viewer so a structural change in viewer 2 doesn't
  // require touching viewer 1's payload — but the debounce still operates
  // on the whole-state JSON, which is fine for the tens-of-KB scale we have.
  const serialized = JSON.stringify({
    window: input.window,
    viewers: input.viewers.map((v) => ({
      id: v.id,
      name: v.name,
      layout: serializeLayout(v.layout),
    })),
    activeViewerId: input.activeViewerId,
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
      viewers: { id: string; name: string; layout: ReturnType<typeof serializeLayout> }[];
      activeViewerId: string;
      topTab: SessionInput["topTab"];
      list: ListPersist;
    };
    try {
      parsed = JSON.parse(debouncedJson);
    } catch {
      return;
    }
    const data = state.StateData.createFrom(buildStateData(parsed));
    SaveState(data).catch((e) => {
      logger.warn("state", "save failed", { err: errorMessage(e) });
    });
  }, [debouncedJson]);
}

function buildStateData(input: {
  window: SessionInput["window"];
  viewers: { id: string; name: string; layout: ReturnType<typeof serializeLayout> }[];
  activeViewerId: string;
  topTab: SessionInput["topTab"];
  list: ListPersist;
}) {
  return {
    version: STATE_SCHEMA_VERSION,
    window: input.window,
    viewers: input.viewers.map((v) => ({
      id: v.id,
      name: v.name,
      layout: v.layout,
    })),
    activeViewerId: input.activeViewerId,
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
