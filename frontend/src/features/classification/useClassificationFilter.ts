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

// useClassificationFilter owns the list-tab filter state (tag set / confidence
// bucket / free-text query) and the memoized `filteredEntries`. It does not
// touch any of the orchestrator's shared refs because filter changes are
// purely client-side — no IPC, no race window — and recompute is driven only
// by loadResult identity + filter identity.
export function useClassificationFilter(opts: Opts): UseClassificationFilterReturn {
  // untaggedOnly and tags are mutually exclusive (#116). A persisted or
  // hand-edited session could restore both set; normalize at hydration so the
  // untagged mode wins and the tag set is dropped — otherwise the UI would show
  // both the "未分類" chip and tag chips active at once (storage form → display
  // form, AGENTS.md E-1).
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

  // Selecting a real tag leaves the untagged-only mode (they are mutually
  // exclusive — see ListTabFilter doc / spec-untagged-filter.md §4.4).
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

  // Toggling the "未分類" chip flips untaggedOnly; turning it on clears any
  // selected tags so the two never co-exist.
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
