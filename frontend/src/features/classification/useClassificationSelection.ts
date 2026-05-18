import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type UseClassificationSelectionReturn = {
  selected: Set<string>;
  selectedFilenames: string[];
  isSelected: (filename: string) => boolean;
  toggleSelected: (filename: string) => void;
  extendSelectionTo: (filename: string, displayedOrder: string[]) => void;
  clearSelected: () => void;
  // setSelected / resetForFolderSwitch are escape hatches the orchestrator
  // needs so it can:
  //   - prune the selection set inside commitFreshResult when the watcher
  //     supplies a fresh entries snapshot (drop filenames that vanished),
  //   - remove a single filename inside deleteOne (the user just trashed it),
  //   - clear selection + anchor as part of resetEntriesDependentState (folder
  //     switch / load failure / similar entries-dependent invalidations).
  // The hook can't model these from the inside because they tie selection
  // state to loadResult / folder mutations that live in the orchestrator.
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  resetForFolderSwitch: () => void;
};

// useClassificationSelection owns the multi-select set (`Set<filename>`) and
// the shift-range anchor. The hook is shared-ref-free; the only cross-state
// coupling is that the orchestrator drives reset on folder switch and prune
// on watcher commits via the escape hatches above.
export function useClassificationSelection(): UseClassificationSelectionReturn {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Anchor for Shift+click range selection. Set on every toggle (single or
  // ctrl); persists across shift-extends so the user can adjust the range.
  const [selectAnchor, setSelectAnchor] = useState<string | null>(null);

  // Mirror anchor into a ref so extendSelectionTo's identity stays stable
  // (otherwise every anchor change would re-create the callback and force
  // a fresh prop-identity into downstream memoized components).
  const selectAnchorRef = useRef<string | null>(selectAnchor);
  useEffect(() => {
    selectAnchorRef.current = selectAnchor;
  }, [selectAnchor]);

  const isSelected = useCallback(
    (filename: string) => selected.has(filename),
    [selected],
  );

  const toggleSelected = useCallback((filename: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
    setSelectAnchor(filename);
  }, []);

  const extendSelectionTo = useCallback(
    (filename: string, displayedOrder: string[]) => {
      const anchor = selectAnchorRef.current;
      // No anchor / either endpoint missing → degrade to a plain toggle.
      const startIdx = anchor != null ? displayedOrder.indexOf(anchor) : -1;
      const endIdx = displayedOrder.indexOf(filename);
      if (startIdx < 0 || endIdx < 0) {
        setSelected((cur) => {
          const next = new Set(cur);
          if (next.has(filename)) next.delete(filename);
          else next.add(filename);
          return next;
        });
        setSelectAnchor(filename);
        return;
      }
      const [lo, hi] =
        startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      const range = displayedOrder.slice(lo, hi + 1);
      setSelected((cur) => {
        const next = new Set(cur);
        for (const f of range) next.add(f);
        return next;
      });
      // Anchor stays put so the user can re-shift to a different end-point.
    },
    [],
  );

  const clearSelected = useCallback(() => {
    setSelected((cur) => (cur.size === 0 ? cur : new Set()));
    setSelectAnchor(null);
  }, []);

  const resetForFolderSwitch = useCallback(() => {
    setSelected((cur) => (cur.size === 0 ? cur : new Set()));
    setSelectAnchor(null);
  }, []);

  const selectedFilenames = useMemo(
    () => Array.from(selected).sort(),
    [selected],
  );

  return {
    selected,
    selectedFilenames,
    isSelected,
    toggleSelected,
    extendSelectionTo,
    clearSelected,
    setSelected,
    resetForFolderSwitch,
  };
}
