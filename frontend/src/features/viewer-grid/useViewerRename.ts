import { useCallback, useState } from "react";
import { sanitizeName } from "./viewers";

// useViewerRename owns the inline-edit state for a viewer tab's display name.
// The actual mutation (sanitize → renameViewer in the viewer set) goes back
// through the `renameViewer` prop so this hook stays decoupled from the
// underlying ViewerSet store — useViewerSet already validates / no-ops on an
// empty sanitized name and surfaces the toast.
//
// `editingViewerId` is exposed as-is so the top-tabs bar can derive both
// `isEditing` (per-tab equality) and `anyRenaming` (`!== null`) from the same
// source.

type Opts = {
  renameViewer: (viewerId: string, name: string) => void;
};

export type UseViewerRenameReturn = {
  editingViewerId: string | null;
  startRename: (viewerId: string) => void;
  stopRename: () => void;
  commitRename: (viewerId: string, name: string) => void;
};

export function useViewerRename({ renameViewer }: Opts): UseViewerRenameReturn {
  const [editingViewerId, setEditingViewerId] = useState<string | null>(null);

  const startRename = useCallback((viewerId: string) => {
    setEditingViewerId(viewerId);
  }, []);
  const stopRename = useCallback(() => {
    setEditingViewerId(null);
  }, []);
  const commitRename = useCallback(
    (viewerId: string, name: string) => {
      const sanitized = sanitizeName(name);
      if (sanitized === null) {
        // Empty/whitespace → keep editing so the user can correct. The
        // underlying renameViewer is still called with the raw value so its
        // no-op + toast path runs.
        renameViewer(viewerId, name);
        return;
      }
      renameViewer(viewerId, sanitized);
      setEditingViewerId(null);
    },
    [renameViewer],
  );

  return { editingViewerId, startRename, stopRename, commitRename };
}
