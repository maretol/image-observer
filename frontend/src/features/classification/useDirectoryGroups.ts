import { useCallback, useMemo, useState } from "react";

// Hook that owns the per-folder accordion-collapse state. The set of
// collapsed group keys is exposed both as a Set (for O(1) lookup during
// render) and as an array (for state persistence).
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

  const isCollapsed = useCallback(
    (key: string) => collapsed.has(key),
    [collapsed],
  );

  return {
    collapsedList,
    isCollapsed,
    toggle,
    expandAll,
  };
}
