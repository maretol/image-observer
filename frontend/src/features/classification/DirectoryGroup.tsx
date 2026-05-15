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
  selectionMode: boolean;
  showCheckbox: boolean;
  modifierEnabled: boolean;
  onToggle: (key: string) => void;
  // Multi-viewer (#11): Card thumb clicks now route to onClickPreview (single
  // path); the previous onClickThumb prop has been removed.
  onClickEdit: (filename: string) => void;
  onClickPreview: (filename: string) => void;
  onToggleSelect: (filename: string) => void;
  onExtendSelectionTo: (filename: string) => void;
};

export function DirectoryGroup({
  group,
  totalCount,
  collapsed,
  folderPath,
  isSelected,
  selectionMode,
  showCheckbox,
  modifierEnabled,
  onToggle,
  onClickEdit,
  onClickPreview,
  onToggleSelect,
  onExtendSelectionTo,
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
              selectionMode={selectionMode}
              showCheckbox={showCheckbox}
              modifierEnabled={modifierEnabled}
              onClickEdit={() => onClickEdit(entry.filename)}
              onClickPreview={() => onClickPreview(entry.filename)}
              onToggleSelect={() => onToggleSelect(entry.filename)}
              onExtendSelectionTo={() => onExtendSelectionTo(entry.filename)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
