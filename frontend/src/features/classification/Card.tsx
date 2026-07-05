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
  // ビュー内に選択済み card が 1 つでもあると true。ON の間は thumb クリックが画像を
  // 開かず選択トグルになる (Finder 風の複数選択)。編集ペンボタンは対象外。
  selectionMode: boolean;
  // 常時表示チェックボックスを出すか (modes: checkbox / both)。
  showCheckbox: boolean;
  // Ctrl/Shift クリックの挙動を有効にするか (modes: modifier / both)。
  modifierEnabled: boolean;
  // thumb クリックは SampleModal (viewer ピッカー) を開く (#11)。
  onClickEdit: () => void;
  onClickPreview: () => void;
  onToggleSelect: () => void;
  onExtendSelectionTo: () => void;
  // card 上どこでも右クリック。親が (clientX, clientY) に単一 CardContextMenu を出す (#47)。
  onRequestContextMenu: (clientX: number, clientY: number) => void;
};

export function Card({
  folderPath,
  entry,
  selected,
  selectionMode,
  showCheckbox,
  modifierEnabled,
  onClickEdit,
  onClickPreview,
  onToggleSelect,
  onExtendSelectionTo,
  onRequestContextMenu,
}: CardProps) {
  const fullPath = `${folderPath}/${entry.filename}`;
  const { ref, url, state } = useGridThumbnail(fullPath);

  const tags = extractTags(entry.folder);

  // キーボード起動は shift/ctrl を持たないので onClick と別: selection-mode の thumb で
  // Space/Enter は選択トグル、それ以外は preview modal を開く。
  const activate = () => {
    if (showCheckbox && selectionMode) {
      onToggleSelect();
    } else {
      onClickPreview();
    }
  };

  return (
    <div
      className={`cls-card ${selected ? "cls-card-selected" : ""}`}
      onContextMenu={(e) => {
        // webview 既定メニューを抑止。.cls-card wrapper で捕捉するので card 上
        // どこ (thumb / filename / badge) で右クリックしてもメニューが出る (#47 §5.1)。
        e.preventDefault();
        onRequestContextMenu(e.clientX, e.clientY);
      }}
    >
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
          // 素のクリック。checkbox 表示 + 選択済みなら「選択に追加」(Finder 風)。
          // modifier モードはこの分岐を通らず常に preview modal を開く。
          if (showCheckbox && selectionMode) {
            onToggleSelect();
            return;
          }
          onClickPreview();
        }}
        onKeyDown={(e) => {
          // thumb 自身に focus があるときだけ反応 — でないと内側の checkbox / 編集
          // ボタンでの Enter/Space が bubble して二重発火する (checkbox がトグル →
          // 親が activate() で戻す)。
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
