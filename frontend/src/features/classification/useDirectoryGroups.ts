import { useCallback, useMemo, useState } from "react";

// フォルダごとの accordion 折りたたみ state。collapsed キーを Set (render の O(1) 照合)
// と array (永続化) の両方で公開する。
export function useDirectoryGroups(initialCollapsed: string[] = []) {
  const [collapsedList, setCollapsedList] =
    useState<string[]>(initialCollapsed);

  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);

  const toggle = useCallback((key: string) => {
    setCollapsedList((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
    );
  }, []);

  const expandAll = useCallback(() => setCollapsedList([]), []);

  // hook は表示中のグループを知らないので、表示中の全キーを呼び出し側が渡す。
  const collapseAll = useCallback((keys: string[]) => {
    setCollapsedList(Array.from(new Set(keys)));
  }, []);

  const isCollapsed = useCallback(
    (key: string) => collapsed.has(key),
    [collapsed],
  );

  return {
    collapsedList,
    isCollapsed,
    toggle,
    expandAll,
    collapseAll,
  };
}
