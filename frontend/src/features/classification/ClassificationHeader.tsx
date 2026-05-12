import type { classification } from "../../../wailsjs/go/models";
import { ReloadIcon } from "../../shared/icons/ReloadIcon";

export type ClassificationHeaderProps = {
  folderPath: string;
  allEntries: classification.Entry[];
  filteredEntries: classification.Entry[];
  loading: boolean;
  onOpenFolder: () => void;
  onReload: () => void;
};

export function ClassificationHeader({
  folderPath,
  allEntries,
  filteredEntries,
  loading,
  onOpenFolder,
  onReload,
}: ClassificationHeaderProps) {
  return (
    <div className="cls-header">
      <button
        type="button"
        className="folder-pick-button"
        onClick={onOpenFolder}
        disabled={loading}
      >
        フォルダを開く
      </button>
      <div className="cls-header-path" title={folderPath}>
        {folderPath || "(未選択)"}
      </div>
      <div className="cls-header-count">
        {folderPath ? `${filteredEntries.length} / ${allEntries.length}` : ""}
      </div>
      <button
        type="button"
        className="cls-header-reload"
        onClick={onReload}
        disabled={!folderPath || loading}
        title="再読み込み"
        aria-label="再読み込み"
      >
        <ReloadIcon size={14} />
      </button>
    </div>
  );
}
