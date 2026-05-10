import { useEffect, useState } from "react";
import { ReadImage } from "../../../wailsjs/go/main/App";
import type { classification } from "../../../wailsjs/go/models";
import { toDataURL } from "../../shared/utils/base64";
import { extractTags } from "./filters";
import { readableTextColor, tagColor } from "./colors";

export type LightboxProps = {
  open: boolean;
  folderPath: string;
  entry: classification.Entry | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
};

export function Lightbox({
  open,
  folderPath,
  entry,
  onClose,
  onPrev,
  onNext,
}: LightboxProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !entry) {
      setSrc(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const path = `${folderPath}/${entry.filename}`;
    setSrc(null);
    setError(null);
    ReadImage(path)
      .then((res) => {
        if (cancelled) return;
        setSrc(toDataURL(res.data as unknown as string, res.mimeType));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, folderPath, entry]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onPrev, onNext]);

  if (!open || !entry) return null;

  const tags = extractTags(entry.folder);
  const primaryBg = entry.folder ? tagColor(tags[0] ?? "") : "#444";
  const primaryFg = readableTextColor(primaryBg);

  return (
    <div
      className="lightbox-overlay"
      onClick={(e) => {
        if (e.currentTarget === e.target) onClose();
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label="閉じる"
      >
        ×
      </button>
      <div
        className="lightbox-stage"
        onClick={(e) => {
          // Click on backdrop (not the image) closes; the image itself
          // is wrapped in stop-propagation to avoid stray dismiss.
          if (e.currentTarget === e.target) onClose();
        }}
      >
        {src ? (
          <img
            className="lightbox-img"
            src={src}
            alt={entry.filename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : error ? (
          <div className="lightbox-error">読み込みに失敗しました: {error}</div>
        ) : (
          <div className="lightbox-loading">読み込み中…</div>
        )}
      </div>
      <div className="lightbox-info" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-filename">{entry.filename}</div>
        <div className="lightbox-badges">
          <span
            className="cls-badge cls-badge-folder lightbox-folder"
            style={{ background: primaryBg, color: primaryFg }}
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
        {tags.length > 1 ? (
          <div className="lightbox-tags">
            <span className="lightbox-tags-label">Tags:</span>
            {tags.map((t) => {
              const bg = tagColor(t);
              const fg = readableTextColor(bg);
              return (
                <span
                  key={t}
                  className="cls-badge lightbox-subtag"
                  style={{ background: bg, color: fg }}
                >
                  {t}
                </span>
              );
            })}
          </div>
        ) : null}
        {entry.note ? <div className="lightbox-note">{entry.note}</div> : null}
      </div>
    </div>
  );
}
