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
    untaggedOnly: boolean; // タグ無しの entry のみ表示 (#116)
    confidence: string; // "all" | "high" | "mid" | "low"
    query: string;
  };
  collapsedGroups: string[];
};

export type SessionInput = {
  // maximized は restore geometry と一緒に運ぶ。非 Windows は useWindowGeometryPolling が
  // freeze-while-maximized ルール (#86) で供給、Windows は Go が所有し (issue #129) ここでは
  // ロード値で固定 (spec-window-placement §8)。
  window: {
    width: number;
    height: number;
    x: number;
    y: number;
    maximized: boolean;
  };
  // 各 viewer が独立 BSP layout を持つ (#11)。layout をまとめて直列化し再起動で内容と
  // active 選択を復元する。
  viewers: Viewer[];
  activeViewerId: string;
  topTab: "list" | "viewer";
  list: ListPersist;
};

const SAVE_DEBOUNCE_MS = 500;
const STATE_SCHEMA_VERSION = 6;

export function useSessionSave(input: SessionInput) {
  // JSON.stringify を通すことで、object identity churn を無視して実際に変わったときだけ
  // debounce が発火する。debounce は state 全体の JSON で動くが、数十 KB 規模なので問題ない。
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
        untaggedOnly: input.list.filter.untaggedOnly,
        confidence: input.list.filter.confidence,
        query: input.list.filter.query,
      },
      collapsedGroups: input.list.collapsedGroups,
    },
  };
}
