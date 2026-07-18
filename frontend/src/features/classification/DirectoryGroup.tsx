import { ChevronIcon } from "../../shared/icons/ChevronIcon";
import { Card, type CardReorderProps } from "./Card";
import type { DirectoryGroup as DirectoryGroupModel } from "./groups";
import type { classification } from "../../../wailsjs/go/models";
import {
  DATA_REORDER_GROUP,
  type CardReorderState,
} from "./useCardReorder";

// 並べ替えモード (#144 Phase 2) の配線。null なら通常表示。
export type GroupReorderProps = {
  state: CardReorderState | null;
  onStartDrag: (
    filename: string,
    groupKey: string,
    ev: { clientX: number; clientY: number; pointerId: number },
  ) => void;
};

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
  // 並べ替えモード中のみ非 null (#144 Phase 2)。グループ折りたたみは mode 中も許可 (§5.2)。
  reorder?: GroupReorderProps | null;
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
  reorder = null,
}: DirectoryGroupProps) {
  const filteredCount = group.entries.length;
  // このグループで active な drag のみインジケータ / source 淡色化を出す。
  const dragHere =
    reorder?.state != null &&
    reorder.state.active &&
    !reorder.state.outside &&
    reorder.state.groupKey === group.key
      ? reorder.state
      : null;
  const cardReorderFor = (
    filename: string,
    idx: number,
  ): CardReorderProps | null => {
    if (!reorder) return null;
    return {
      onStartDrag: (ev) => reorder.onStartDrag(filename, group.key, ev),
      indicator:
        dragHere == null
          ? null
          : dragHere.insertIdx === idx
            ? "before"
            : idx === group.entries.length - 1 &&
                dragHere.insertIdx === group.entries.length
              ? "after"
              : null,
      dragSource: reorder.state?.srcFilename === filename,
    };
  };
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
        <div
          className="cls-group-grid"
          {...(reorder ? { [DATA_REORDER_GROUP]: group.key } : {})}
        >
          {group.entries.map((entry: classification.Entry, idx: number) => (
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
              reorder={cardReorderFor(entry.filename, idx)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
