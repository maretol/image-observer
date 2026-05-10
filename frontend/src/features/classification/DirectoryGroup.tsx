import { ChevronIcon } from "../../shared/icons/ChevronIcon";
import { Card } from "./Card";
import type { DirectoryGroup as DirectoryGroupModel } from "./groups";
import type { classification } from "../../../wailsjs/go/models";

export type DirectoryGroupProps = {
  group: DirectoryGroupModel;
  totalCount: number; // number of entries in this group BEFORE filtering
  collapsed: boolean;
  folderPath: string;
  isSelected: (filename: string) => boolean;
  onToggle: (key: string) => void;
  onClickThumb: (filename: string) => void;
  onClickEdit: (filename: string) => void;
  onToggleSelect: (filename: string) => void;
};

export function DirectoryGroup({
  group,
  totalCount,
  collapsed,
  folderPath,
  isSelected,
  onToggle,
  onClickThumb,
  onClickEdit,
  onToggleSelect,
}: DirectoryGroupProps) {
  const filteredCount = group.entries.length;
  return (
    <section className="cls-group">
      <button
        type="button"
        className="cls-group-header"
        onClick={() => onToggle(group.key)}
        aria-expanded={!collapsed}
      >
        <span className="cls-group-chevron" aria-hidden="true">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="cls-group-label">{group.label}</span>
        <span className="cls-group-count">
          {filteredCount} / {totalCount}
        </span>
      </button>
      {!collapsed ? (
        <div className="cls-group-grid">
          {group.entries.map((entry: classification.Entry) => (
            <Card
              key={entry.filename}
              folderPath={folderPath}
              entry={entry}
              selected={isSelected(entry.filename)}
              onClickThumb={() => onClickThumb(entry.filename)}
              onClickEdit={() => onClickEdit(entry.filename)}
              onToggleSelect={() => onToggleSelect(entry.filename)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
