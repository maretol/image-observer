import type { classification } from "../../../wailsjs/go/models";
import { EditIcon } from "../../shared/icons/EditIcon";
import { ThumbErrorIcon } from "../../shared/icons/ThumbErrorIcon";
import { extractTags } from "./filters";
import { readableTextColor, tagBadgeClass, tagColor } from "./colors";
import { useGridThumbnail } from "./useGridThumbnail";

export type CardProps = {
  folderPath: string;
  entry: classification.Entry;
  selected: boolean;
  // True when at least one card in the current view is selected. While ON,
  // a thumb click toggles selection instead of opening the image — Finder-
  // like behavior so the user can build up a multi-select without aiming at
  // the small checkbox each time. The edit-pencil button is unaffected.
  selectionMode: boolean;
  // Whether the always-visible checkbox is rendered (modes: checkbox / both).
  showCheckbox: boolean;
  // Whether Ctrl-click and Shift-click change behavior (modes: modifier / both).
  modifierEnabled: boolean;
  onClickThumb: () => void;
  onClickEdit: () => void;
  onToggleSelect: () => void;
  onExtendSelectionTo: () => void;
};

export function Card({
  folderPath,
  entry,
  selected,
  selectionMode,
  showCheckbox,
  modifierEnabled,
  onClickThumb,
  onClickEdit,
  onToggleSelect,
  onExtendSelectionTo,
}: CardProps) {
  const fullPath = `${folderPath}/${entry.filename}`;
  const { ref, url, state } = useGridThumbnail(fullPath);

  const tags = extractTags(entry.folder);

  // Primary action depends on the current mode (mirror of onClick logic, but
  // keyboard activation doesn't carry shift/ctrl meaning — Space/Enter on a
  // selection-mode thumb toggles selection, otherwise it opens the image).
  const activate = () => {
    if (showCheckbox && selectionMode) {
      onToggleSelect();
    } else {
      onClickThumb();
    }
  };

  return (
    <div className={`cls-card ${selected ? "cls-card-selected" : ""}`}>
      <div
        ref={ref}
        className="cls-card-thumb"
        role="button"
        tabIndex={0}
        aria-label={
          showCheckbox && selectionMode
            ? `${entry.filename} の選択を切替`
            : `${entry.filename} を開く`
        }
        onClick={(e) => {
          if (modifierEnabled && e.shiftKey) {
            onExtendSelectionTo();
            return;
          }
          if (modifierEnabled && (e.ctrlKey || e.metaKey)) {
            onToggleSelect();
            return;
          }
          // Plain click. With a visible checkbox + an existing selection we
          // treat clicks as "extend the selection set" (Finder-like). Modifier
          // mode skips this branch and always opens the image.
          if (showCheckbox && selectionMode) {
            onToggleSelect();
            return;
          }
          onClickThumb();
        }}
        onKeyDown={(e) => {
          // Only react when the thumb itself is focused — without this, an
          // Enter/Space on the inner checkbox or edit button bubbles up and
          // double-fires (e.g. checkbox toggles selection, parent then runs
          // activate() and toggles it back).
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        title={entry.filename}
        style={
          showCheckbox && selectionMode ? { cursor: "pointer" } : undefined
        }
      >
        {url ? (
          <img
            className="cls-card-thumb-img"
            src={url}
            alt={entry.filename}
          />
        ) : state === "error" ? (
          <span className="cls-card-thumb-error">
            <ThumbErrorIcon />
          </span>
        ) : null}
        {showCheckbox ? (
          <label
            className="cls-card-select"
            onClick={(e) => e.stopPropagation()}
            title={selected ? "選択を解除" : "選択"}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={`${entry.filename} を選択`}
            />
          </label>
        ) : null}
        <button
          type="button"
          className="cls-card-edit"
          onClick={(e) => {
            e.stopPropagation();
            onClickEdit();
          }}
          title="編集"
          aria-label="編集"
        >
          <EditIcon size={12} />
        </button>
      </div>
      <div className="cls-card-info">
        <div className="cls-card-filename" title={entry.filename}>
          {entry.filename}
        </div>
        <div className="cls-card-badges">
          {tags.length === 0 ? (
            <span
              className="cls-badge cls-badge-tag cls-badge-unclassified"
              style={{ background: "#444", color: "#ddd" }}
            >
              (未分類)
            </span>
          ) : (
            tags.map((t) => {
              const bg = tagColor(t);
              const fg = readableTextColor(bg);
              return (
                <span
                  key={t}
                  className={`cls-badge cls-badge-tag cls-badge-${tagBadgeClass(t)}`}
                  style={{ background: bg, color: fg }}
                  title={t}
                >
                  {t}
                </span>
              );
            })
          )}
          {entry.confidence ? (
            <span
              className={`cls-badge cls-badge-conf cls-badge-${entry.confidence}`}
            >
              {entry.confidence}
            </span>
          ) : null}
        </div>
        {entry.note ? <div className="cls-card-note">{entry.note}</div> : null}
      </div>
    </div>
  );
}
