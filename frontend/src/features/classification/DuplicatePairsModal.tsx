import type { imghash } from "../../../wailsjs/go/models";
import { ModalShell } from "../../shared/components/ModalShell";
import { ThumbErrorIcon } from "../../shared/icons/ThumbErrorIcon";
import { useGridThumbnail } from "./useGridThumbnail";

export type DuplicatePairsModalProps = {
  open: boolean;
  folderPath: string;
  // 起点 Card の filename。open=true の間は non-null (親が保証)。
  filename: string | null;
  // filename が絡む候補ペア (pairsForFile 済み)。
  pairs: imghash.DuplicatePair[];
  // 「ダブりではない」。永続化 + local 除去は親 (dismissDuplicatePair) の責任。
  onDismissPair: (fileA: string, fileB: string) => void;
  onClose: () => void;
};

function PairThumb({
  folderPath,
  filename,
}: {
  folderPath: string;
  filename: string;
}) {
  const { ref, url, state } = useGridThumbnail(`${folderPath}/${filename}`);
  return (
    <div ref={ref} className="dup-pair-thumb" title={filename}>
      {url ? (
        <img className="dup-pair-thumb-img" src={url} alt={filename} />
      ) : state === "error" ? (
        <span className="dup-pair-thumb-error">
          <ThumbErrorIcon />
        </span>
      ) : null}
    </div>
  );
}

// ダブり候補の確認モーダル (#136 §5.3)。起点 filename が絡むペアを列挙し、ペア単位で
// dismiss できる。閲覧系なので backdrop / Esc close は ModalShell 既定のまま (H-5)。
// 詳細な拡大比較は既存機能 (ビューアで両方開く) に委ねる (spec §11)。
export function DuplicatePairsModal({
  open,
  folderPath,
  filename,
  pairs,
  onDismissPair,
  onClose,
}: DuplicatePairsModalProps) {
  if (!open || filename === null) return null;
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="ダブり候補の確認"
      overlayClassName="confirm-dialog-overlay"
      dialogClassName="confirm-dialog dup-pairs-dialog"
    >
      <div className="dup-pairs-title" title={filename}>
        ダブり候補: {filename}
      </div>
      <div className="dup-pairs-list">
        {pairs.map((p) => {
          const partner = p.fileA === filename ? p.fileB : p.fileA;
          return (
            <div key={`${p.fileA}|${p.fileB}`} className="dup-pair-row">
              <PairThumb folderPath={folderPath} filename={filename} />
              <PairThumb folderPath={folderPath} filename={partner} />
              <div className="dup-pair-info">
                <div className="dup-pair-name" title={partner}>
                  {partner}
                </div>
                <div className="dup-pair-distance">距離 {p.distance}</div>
              </div>
              <button
                type="button"
                className="confirm-dialog-btn dup-pair-dismiss-btn"
                onClick={() => onDismissPair(p.fileA, p.fileB)}
                title="このペアを今後ダブり候補として表示しない"
              >
                ダブりではない
              </button>
            </div>
          );
        })}
      </div>
      <div className="confirm-dialog-buttons">
        <button type="button" className="confirm-dialog-btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ModalShell>
  );
}
