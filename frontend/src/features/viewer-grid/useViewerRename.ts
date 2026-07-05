import { useCallback, useState } from "react";
import { sanitizeName } from "./viewers";

// viewer タブ表示名のインライン編集 state を持つ。実 mutation は renameViewer prop に戻すので
// ViewerSet ストアと疎結合 (useViewerSet が空名の検証 / no-op / toast を担う)。
// editingViewerId をそのまま公開し、top-tabs bar が isEditing (tab 一致) と anyRenaming (!== null)
// を同じソースから導けるように。

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
        // 空/空白 → 編集を続けさせる (ユーザーが直せるよう)。生値で renameViewer を呼び no-op + toast を走らせる。
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
