import { ChevronIcon } from "../../shared/icons/ChevronIcon";
import { Card } from "./Card";
import type { DirectoryGroup as DirectoryGroupModel } from "./groups";
import type { classification } from "../../../wailsjs/go/models";

export type DirectoryGroupProps = {
  group: DirectoryGroupModel;
  totalCount: number; // フィルタ前のこのグループの entry 数
  collapsed: boolean;
  folderPath: string;
  isSelected: (filename: string) => boolean;
  selectionMode: boolean;
  showCheckbox: boolean;
  modifierEnabled: boolean;
  onToggle: (key: string) => void;
  onClickEdit: (filename: string) => void;
  onClickPreview: (filename: string) => void;
  onToggleSelect: (filename: string) => void;
  onExtendSelectionTo: (filename: string) => void;
  // Card 右クリック → ClassificationView が (x, y) に CardContextMenu を出す (#47 §5.1)。
  onRequestCardContextMenu: (filename: string, x: number, y: number) => void;
  // ダブり候補 filename の集合 (#136)。含まれる Card に ⚠ バッジ。
  duplicateSet: ReadonlySet<string>;
  onShowDuplicates: (filename: string) => void;
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
  onRequestCardContextMenu,
  duplicateSet,
  onShowDuplicates,
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
              onRequestContextMenu={(x, y) =>
                onRequestCardContextMenu(entry.filename, x, y)
              }
              duplicateWarn={duplicateSet.has(entry.filename)}
              onShowDuplicates={() => onShowDuplicates(entry.filename)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
