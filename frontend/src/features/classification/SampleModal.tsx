import { useEffect, useState } from "react";
import { GetThumbnail } from "../../../wailsjs/go/main/App";
import { ModalShell } from "../../shared/components/ModalShell";
import { CloseIcon } from "../../shared/icons/CloseIcon";
import { toBytes } from "../../shared/utils/base64";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";

// Preview thumb dimension. Bigger than the list-card thumbnail (typically
// 256px) so the modal looks crisp on a 1080p screen, but small enough that
// the Go-side cached preview decodes in well under a frame. Letterbox mode
// preserves aspect ratio so the modal can size to the natural shape of the
// image without forcing a square crop. Cached separately from the list size
// in Go's per-size thumb cache; first preview on a path triggers a fresh
// resize, subsequent previews are instant.
const PREVIEW_SIZE = 1024;
const PREVIEW_MODE = "letterbox";

type SampleModalProps = {
  open: boolean;
  // POSIX path the modal should show. null while closed.
  imagePath: string | null;
  // Display name shown in the header. Caller supplies it so we don't have
  // to parse paths here — `filename` may contain subdirectory separators
  // (e.g. `child/foo.png` for recursively-scanned sidecars) and the caller
  // has already decided how it wants to label that.
  filename: string | null;
  onClose: () => void;
  // Multi-viewer (#11): the modal renders a viewer-selector in its footer.
  // Caller passes the current viewer set (id + name) and which one is active
  // (used for highlighting the default choice). On click, the modal calls
  // onOpenInViewer(viewerId) with the chosen target.
  viewers: { id: string; name: string }[];
  activeViewerId: string;
  onOpenInViewer: (viewerId: string) => void;
};

export function SampleModal({
  open,
  imagePath,
  filename,
  onClose,
  viewers,
  activeViewerId,
  onOpenInViewer,
}: SampleModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">(
    "idle",
  );

  useEffect(() => {
    if (!open || !imagePath) {
      setUrl(null);
      setState("idle");
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setUrl(null);
    setState("loading");
    GetThumbnail(imagePath, PREVIEW_SIZE, PREVIEW_MODE)
      .then((res) => {
        if (cancelled) return;
        const bytes = toBytes(res.data);
        const blob = new Blob([bytes], { type: res.mimeType });
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
        setState("ok");
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = errorMessage(e);
        logger.warn("classification", "sample modal load failed", {
          path: imagePath,
          err: msg,
        });
        setState("error");
      });
    return () => {
      cancelled = true;
      // Revoke immediately on close / path change. Unlike useGridThumbnail
      // we have only one consumer and no risk of a parallel <img> still
      // fetching; the modal's <img> is torn down synchronously.
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [open, imagePath]);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel={filename ? `${filename} のプレビュー` : "画像プレビュー"}
      overlayClassName="sample-modal-overlay"
      dialogClassName="sample-modal"
    >
      <div className="sample-modal-header">
        <div className="sample-modal-title" title={filename ?? undefined}>
          {filename ?? ""}
        </div>
        <button
          type="button"
          className="sample-modal-close"
          onClick={onClose}
          title="閉じる (Esc)"
          aria-label="プレビューを閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="sample-modal-body">
        {state === "loading" ? (
          <div className="sample-modal-loading">読み込み中…</div>
        ) : state === "error" ? (
          <div className="sample-modal-error">画像を読み込めませんでした</div>
        ) : url ? (
          <img
            className="sample-modal-img"
            src={url}
            alt={filename ?? ""}
            draggable={false}
          />
        ) : null}
      </div>
      <div
        className="sample-modal-footer"
        role={viewers.length > 1 ? "group" : undefined}
        aria-label={viewers.length > 1 ? "ビューアを選んで開く" : undefined}
      >
        {viewers.length === 0 ? null : viewers.length === 1 ? (
          // Single-viewer fast path: keep the original "ビューアで開く"
          // wording so the simple-case UX is unchanged.
          <button
            type="button"
            className="sample-modal-open-viewer"
            onClick={() => onOpenInViewer(viewers[0].id)}
            autoFocus
          >
            ビューア「{viewers[0].name}」で開く
          </button>
        ) : (
          viewers.map((v) => {
            const isActive = v.id === activeViewerId;
            return (
              <button
                key={v.id}
                type="button"
                className={
                  isActive
                    ? "sample-modal-open-viewer sample-modal-open-viewer-active"
                    : "sample-modal-open-viewer"
                }
                onClick={() => onOpenInViewer(v.id)}
                title={v.name}
                aria-label={`ビューア「${v.name}」で開く${isActive ? " (現在アクティブ)" : ""}`}
                autoFocus={isActive}
              >
                {isActive ? "✓ " : ""}
                {v.name}
              </button>
            );
          })
        )}
      </div>
    </ModalShell>
  );
}
