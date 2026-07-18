import type { classification } from "../../../wailsjs/go/models";
import { ReloadIcon } from "../../shared/icons/ReloadIcon";
import {
  SORT_MANUAL,
  SORT_MTIME_ASC,
  SORT_MTIME_DESC,
  SORT_NAME_ASC,
  SORT_NAME_DESC,
  normalizeSortMode,
  type SortMode,
} from "./sortMode";

export type ClassificationHeaderProps = {
  folderPath: string;
  allEntries: classification.Entry[];
  filteredEntries: classification.Entry[];
  loading: boolean;
  sortMode: SortMode;
  onChangeSortMode: (mode: SortMode) => void;
  onOpenFolder: () => void;
  onReload: () => void;
};

// 並び順の表示ラベル (#144)。手動 = sidecar 配列順 (従来挙動)。
const SORT_OPTIONS: readonly { value: SortMode; label: string }[] = [
  { value: SORT_MANUAL, label: "手動" },
  { value: SORT_NAME_ASC, label: "ファイル名 ↑" },
  { value: SORT_NAME_DESC, label: "ファイル名 ↓" },
  { value: SORT_MTIME_ASC, label: "更新日時 ↑" },
  { value: SORT_MTIME_DESC, label: "更新日時 ↓" },
];

export function ClassificationHeader({
  folderPath,
  allEntries,
  filteredEntries,
  loading,
  sortMode,
  onChangeSortMode,
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
      <select
        className="cls-header-sort"
        aria-label="並び順"
        title="並び順"
        value={sortMode}
        onChange={(e) => onChangeSortMode(normalizeSortMode(e.target.value))}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
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
