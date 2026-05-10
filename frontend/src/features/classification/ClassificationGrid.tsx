import type { classification } from "../../../wailsjs/go/models";
import { Card } from "./Card";

export type ClassificationGridProps = {
  folderPath: string;
  entries: classification.Entry[];
  onClickThumb: (filename: string) => void;
  onClickEdit: (filename: string) => void;
};

export function ClassificationGrid({
  folderPath,
  entries,
  onClickThumb,
  onClickEdit,
}: ClassificationGridProps) {
  if (entries.length === 0) {
    return (
      <div className="cls-grid-empty">
        該当する画像がありません
      </div>
    );
  }
  return (
    <div className="cls-grid">
      {entries.map((entry) => (
        <Card
          key={entry.filename}
          folderPath={folderPath}
          entry={entry}
          onClickThumb={() => onClickThumb(entry.filename)}
          onClickEdit={() => onClickEdit(entry.filename)}
        />
      ))}
    </div>
  );
}
