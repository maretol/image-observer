import { useCallback } from "react";
import type { TopTab } from "../../topTab";
import type { useViewerSet } from "./useViewerSet";

// useListToViewerHandlers builds the three "open from list-tab" callbacks
// (single image, bulk-as-tabs, bulk-as-split) that the ClassificationView
// reaches through. Each callback resolves the source path against the
// classification folder, dispatches to the matching useViewerSet open* method,
// activates the chosen viewer, and switches the top-tab to "viewer".
//
// Lives in viewer-grid/ (rather than classification/) because the producer is
// the viewer side — consumers (Card / SampleModal / bulk action bar) only
// supply the filename + viewerId.

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
