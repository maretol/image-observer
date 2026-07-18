import type { classification } from "../../../wailsjs/go/models";
import { EditIcon } from "../../shared/icons/EditIcon";
import { ThumbErrorIcon } from "../../shared/icons/ThumbErrorIcon";
import { WarnIcon } from "../../shared/icons/WarnIcon";
import { extractTags } from "./filters";
import { readableTextColor, tagBadgeClass, tagColor } from "./colors";
import { DATA_REORDER_CARD } from "./useCardReorder";
import { useGridThumbnail } from "./useGridThumbnail";

// 並べ替えモード (#144 Phase 2) 中の Card への配線。null 以外が渡っている間、Card は
// 「drag ハンドル」としてのみ機能する: プレビュー / 選択 / 編集 / メニュー / ダブり確認は
// 全て無効 (spec-image-sort.md §5.2)。
export type CardReorderProps = {
  onStartDrag: (ev: {
    clientX: number;
    clientY: number;
    pointerId: number;
  }) => void;
  // 挿入インジケータ。grid セルを占有しないよう独立要素でなく Card 側の ::before で表現。
  indicator: "before" | "after" | null;
  // drag 中の source Card (淡色化)。
  dragSource: boolean;
};

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
  // ダブり候補 (#136)。true でサムネ左下に ⚠ バッジ。クリックで確認モーダル。
  duplicateWarn: boolean;
  onShowDuplicates: () => void;
  // 並べ替えモード中のみ非 null (#144 Phase 2)。
  reorder?: CardReorderProps | null;
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
  duplicateWarn,
  onShowDuplicates,
  reorder = null,
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

  const interactive = reorder === null;
  const reorderClasses = reorder
    ? [
        "cls-card-reorderable",
        reorder.dragSource ? "cls-card-drag-src" : "",
        reorder.indicator === "before" ? "cls-card-insert-before" : "",
        reorder.indicator === "after" ? "cls-card-insert-after" : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <div
      className={`cls-card ${selected ? "cls-card-selected" : ""} ${reorderClasses}`}
      {...(reorder ? { [DATA_REORDER_CARD]: entry.filename } : {})}
      onContextMenu={(e) => {
        // webview 既定メニューを抑止。.cls-card wrapper で捕捉するので card 上
        // どこ (thumb / filename / badge) で右クリックしてもメニューが出る (#47 §5.1)。
        // 並べ替えモード中はメニューを出さない (抑止のみ, #144 §5.2)。
        e.preventDefault();
        if (interactive) onRequestContextMenu(e.clientX, e.clientY);
      }}
      onPointerDown={
        reorder
          ? (e) => {
              // 主ボタンのみ drag 開始 (右クリック / 中クリックは無視)。マルチタッチの
              // 二重 pointerdown は hook 側の先勝ち guard が落とす (H-2)。
              if (e.button !== 0) return;
              reorder.onStartDrag({
                clientX: e.clientX,
                clientY: e.clientY,
                pointerId: e.pointerId,
              });
            }
          : undefined
      }
    >
      <div
        ref={ref}
        className="cls-card-thumb"
        // 並べ替えモード中は role/button 相当のセマンティクスを外す (クリック動作が無く、
        // キーボード並べ替えも v1 対象外のため focus 対象から除外, #144 §5.2)。
        {...(interactive
          ? {
              role: "button",
              tabIndex: 0,
              "aria-label":
                showCheckbox && selectionMode
                  ? `${entry.filename} の選択を切替`
                  : `${entry.filename} を開く`,
            }
          : {})}
        onClick={
          interactive
            ? (e) => {
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
              }
            : undefined
        }
        onKeyDown={
          interactive
            ? (e) => {
                // thumb 自身に focus があるときだけ反応 — でないと内側の checkbox / 編集
                // ボタンでの Enter/Space が bubble して二重発火する (checkbox がトグル →
                // 親が activate() で戻す)。
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
              }
            : undefined
        }
        title={entry.filename}
        style={
          interactive && showCheckbox && selectionMode
            ? { cursor: "pointer" }
            : undefined
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
        {interactive && showCheckbox ? (
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
        {interactive ? (
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
        ) : null}
        {interactive && duplicateWarn ? (
          // 警告なので hover-reveal (cls-card-edit) にせず常時表示。四隅は checkbox (左上) /
          // 編集 (右上) / .cls-card-preview 予約 (右下) が使うため左下 (#136 §5.1)。
          <button
            type="button"
            className="cls-card-dup-warn"
            onClick={(e) => {
              e.stopPropagation();
              onShowDuplicates();
            }}
            title="ダブりの可能性があります (クリックで確認)"
            aria-label="ダブりの可能性があります (クリックで確認)"
          >
            <WarnIcon size={12} />
          </button>
        ) : null}
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
