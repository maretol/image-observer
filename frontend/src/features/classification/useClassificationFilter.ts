import { useCallback, useMemo, useState } from "react";
import { classification } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { applyFilter, type Confidence, type ListTabFilter } from "./filters";

export type UseClassificationFilterReturn = {
  filter: ListTabFilter;
  filteredEntries: classification.Entry[];
  setFilter: (patch: Partial<ListTabFilter>) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
};

type Opts = {
  initial?: wstate.ListTabState["filter"] | null;
  loadResult: classification.LoadResult | null;
};

// useClassificationFilter owns the list-tab filter state (tag set / confidence
// bucket / free-text query) and the memoized `filteredEntries`. It does not
// touch any of the orchestrator's shared refs because filter changes are
// purely client-side — no IPC, no race window — and recompute is driven only
// by loadResult identity + filter identity.
export function useClassificationFilter(opts: Opts): UseClassificationFilterReturn {
  const initial: ListTabFilter = {
    tags: opts.initial?.tags ?? [],
    confidence: normalizeConfidence(opts.initial?.confidence ?? "all"),
    query: opts.initial?.query ?? "",
  };

  const [filter, setFilterState] = useState<ListTabFilter>(initial);

  const setFilter = useCallback((patch: Partial<ListTabFilter>) => {
    setFilterState((cur) => ({ ...cur, ...patch }));
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setFilterState((cur) => {
      const has = cur.tags.includes(tag);
      return {
        ...cur,
        tags: has ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag],
      };
    });
  }, []);

  const clearTags = useCallback(() => {
    setFilterState((cur) => ({ ...cur, tags: [] }));
  }, []);

  const filteredEntries = useMemo(
    () => (opts.loadResult ? applyFilter(opts.loadResult.entries, filter) : []),
    [opts.loadResult, filter],
  );

  return { filter, filteredEntries, setFilter, toggleTag, clearTags };
}

// normalizeConfidence is filter-local: it coerces the session-restored
// confidence string to one of the typed buckets, falling back to "all" on
// unknown values. Lives here (not in filters.ts) because the only consumer
// is this hook's initial state.
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
