import type { classification } from "../../../wailsjs/go/models";
import { EditIcon } from "../../shared/icons/EditIcon";
import { ThumbErrorIcon } from "../../shared/icons/ThumbErrorIcon";
import { extractTags } from "./filters";
import { folderClass, readableTextColor, tagColor } from "./colors";
import { useGridThumbnail } from "./useGridThumbnail";

export type CardProps = {
  folderPath: string;
  entry: classification.Entry;
  onClickThumb: () => void;
  onClickEdit: () => void;
};

export function Card({ folderPath, entry, onClickThumb, onClickEdit }: CardProps) {
  const fullPath = `${folderPath}/${entry.filename}`;
  const { ref, url, state } = useGridThumbnail(fullPath);

  const primaryTag = extractTags(entry.folder)[0] ?? "";
  const folderBg = entry.folder ? tagColor(primaryTag) : "#444";
  const folderFg = readableTextColor(folderBg);

  return (
    <div className="cls-card">
      <div
        ref={ref}
        className="cls-card-thumb"
        onClick={onClickThumb}
        title={entry.filename}
      >
        {url ? (
          <img
            className="cls-card-thumb-img"
            src={url}
            alt={entry.filename}
            loading="lazy"
          />
        ) : state === "error" ? (
          <span className="cls-card-thumb-error">
            <ThumbErrorIcon />
          </span>
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
          <span
            className={`cls-badge cls-badge-folder cls-badge-${folderClass(entry.folder)}`}
            style={{ background: folderBg, color: folderFg }}
          >
            {entry.folder || "(未分類)"}
          </span>
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
