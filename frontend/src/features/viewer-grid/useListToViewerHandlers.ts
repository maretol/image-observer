import { useCallback } from "react";
import type { TopTab } from "../../topTab";
import type { useViewerSet } from "./useViewerSet";

// ClassificationView が使う「list-tab から開く」3 callback (単一 / bulk-tabs / bulk-split)。
// consumer は filename + viewerId だけ渡すので、producer 側の viewer-grid/ に置く (classification/ でなく)。

type Opts = {
  folderPath: string;
  viewer: ReturnType<typeof useViewerSet>;
  setTopTab: (t: TopTab) => void;
};

export type UseListToViewerHandlersReturn = {
  onOpenInViewer: (viewerId: string, filename: string) => void;
  onOpenManyInTabs: (viewerId: string, filenames: string[]) => void;
  onOpenManyAsSplit: (viewerId: string, filenames: string[]) => void;
};

export function useListToViewerHandlers({
  folderPath,
  viewer,
  setTopTab,
}: Opts): UseListToViewerHandlersReturn {
  const onOpenInViewer = useCallback(
    (viewerId: string, filename: string) => {
      if (!folderPath) return;
      void viewer.openInViewer(viewerId, `${folderPath}/${filename}`);
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [folderPath, viewer, setTopTab],
  );

  const onOpenManyInTabs = useCallback(
    (viewerId: string, filenames: string[]) => {
      if (!folderPath || filenames.length === 0) return;
      const paths = filenames.map((f) => `${folderPath}/${f}`);
      void viewer.openManyInViewer(viewerId, paths);
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [folderPath, viewer, setTopTab],
  );

  const onOpenManyAsSplit = useCallback(
    (viewerId: string, filenames: string[]) => {
      if (!folderPath || filenames.length === 0) return;
      const paths = filenames.map((f) => `${folderPath}/${f}`);
      void viewer.openManyAsSplitInViewer(viewerId, paths);
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [folderPath, viewer, setTopTab],
  );

  return { onOpenInViewer, onOpenManyInTabs, onOpenManyAsSplit };
}
