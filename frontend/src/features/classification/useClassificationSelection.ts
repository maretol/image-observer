import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type UseClassificationSelectionReturn = {
  selected: Set<string>;
  selectedFilenames: string[];
  isSelected: (filename: string) => boolean;
  toggleSelected: (filename: string) => void;
  extendSelectionTo: (filename: string, displayedOrder: string[]) => void;
  clearSelected: () => void;
  // orchestrator 用の escape hatch: watcher commit での prune / deleteOne での
  // 単一除去 / folder 切替時の全クリア。selection を loadResult / folder の変更に
  // 結びつけるのは orchestrator 側なので hook 内からはモデル化できないため。
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  resetForFolderSwitch: () => void;
};

// multi-select set (Set<filename>) と shift-range anchor を持つ。shared-ref-free。
export function useClassificationSelection(): UseClassificationSelectionReturn {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Shift+click 範囲選択の anchor。toggle ごとに set し、shift-extend をまたいで
  // 残る (範囲を調整できるよう)。
  const [selectAnchor, setSelectAnchor] = useState<string | null>(null);

  // anchor を ref にミラーして extendSelectionTo の identity を安定させる (毎 anchor
  // 変更で callback が作り直され下流の memo 化 component に新 prop identity が流れるのを防ぐ)。
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
      // anchor 無し / 端点欠け → 単純 toggle に落とす。
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
      // anchor は据え置き (別端点へ re-shift できるよう)。
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
