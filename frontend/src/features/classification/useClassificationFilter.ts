import { useCallback, useMemo, useState } from "react";
import { classification } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { applyFilter, type Confidence, type ListTabFilter } from "./filters";

export type UseClassificationFilterReturn = {
  filter: ListTabFilter;
  filteredEntries: classification.Entry[];
  setFilter: (patch: Partial<ListTabFilter>) => void;
  toggleTag: (tag: string) => void;
  toggleUntagged: () => void;
  clearTags: () => void;
};

type Opts = {
  initial?: wstate.ListTabState["filter"] | null;
  loadResult: classification.LoadResult | null;
};

// list-tab の filter state (tag / confidence / query) と memoized filteredEntries を
// 持つ。filter 変更は client-side のみ (IPC / race 窓なし) なので shared ref に触らない。
export function useClassificationFilter(opts: Opts): UseClassificationFilterReturn {
  // untaggedOnly と tags は排他 (#116)。永続 / 手編集 session は両方 set で復元され
  // うるので hydration で untagged を優先し tags を落とす (storage 形 → 表示形, AGENTS.md E-1)。
  const initialUntaggedOnly = opts.initial?.untaggedOnly ?? false;
  const initial: ListTabFilter = {
    tags: initialUntaggedOnly ? [] : (opts.initial?.tags ?? []),
    untaggedOnly: initialUntaggedOnly,
    confidence: normalizeConfidence(opts.initial?.confidence ?? "all"),
    query: opts.initial?.query ?? "",
  };

  const [filter, setFilterState] = useState<ListTabFilter>(initial);

  const setFilter = useCallback((patch: Partial<ListTabFilter>) => {
    setFilterState((cur) => ({ ...cur, ...patch }));
  }, []);

  // 実タグ選択で untagged-only を抜ける (排他, spec-untagged-filter.md §4.4)。
  const toggleTag = useCallback((tag: string) => {
    setFilterState((cur) => {
      const has = cur.tags.includes(tag);
      return {
        ...cur,
        untaggedOnly: false,
        tags: has ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag],
      };
    });
  }, []);

  // on にするとき tags をクリアして両者が共存しないようにする。
  const toggleUntagged = useCallback(() => {
    setFilterState((cur) =>
      cur.untaggedOnly
        ? { ...cur, untaggedOnly: false }
        : { ...cur, untaggedOnly: true, tags: [] },
    );
  }, []);

  const clearTags = useCallback(() => {
    setFilterState((cur) => ({ ...cur, tags: [], untaggedOnly: false }));
  }, []);

  const filteredEntries = useMemo(
    () => (opts.loadResult ? applyFilter(opts.loadResult.entries, filter) : []),
    [opts.loadResult, filter],
  );

  return {
    filter,
    filteredEntries,
    setFilter,
    toggleTag,
    toggleUntagged,
    clearTags,
  };
}

// session 復元の confidence 文字列を型付き bucket に矯正 (不明は "all")。唯一の利用者が
// この hook の初期 state なので filters.ts でなくここに置く。
function normalizeConfidence(c: string): Confidence | "all" {
  switch (c) {
    case "high":
    case "mid":
    case "low":
    case "":
      return c as Confidence;
    case "all":
    default:
      return "all";
  }
}
