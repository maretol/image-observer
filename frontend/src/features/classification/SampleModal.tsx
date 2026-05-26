import { useEffect, useMemo, useRef, useState } from "react";
import { GetThumbnail } from "../../../wailsjs/go/main/App";
import type { classification } from "../../../wailsjs/go/models";
import { ModalShell } from "../../shared/components/ModalShell";
import { CloseIcon } from "../../shared/icons/CloseIcon";
import { toBytes } from "../../shared/utils/base64";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { SampleEditPane } from "./SampleEditPane";

// Preview thumb dimension. Bigger than the list-card thumbnail (typically
// 256px) so the modal looks crisp on a 1080p screen, but small enough that
// the Go-side cached preview decodes in well under a frame. Letterbox mode
// preserves aspect ratio so the modal can size to the natural shape of the
// image without forcing a square crop. Cached separately from the list size
// in Go's per-size thumb cache; first preview on a path triggers a fresh
// resize, subsequent previews are instant.
const PREVIEW_SIZE = 1024;
const PREVIEW_MODE = "letterbox";

// Tooltip used on prev/next while editing pane has unsaved changes (#93,
// spec §5.4). Surfaced via `title` only — `aria-label` stays on the
// operation name ("前の画像 (←)") so screen readers always announce what
// the button does. The unsaved state itself is conveyed by the dirty
// badge in the header (aria-label "未保存の変更があります").
const NAV_BLOCKED_TOOLTIP =
  "未保存の変更があります。保存またはキャンセルしてください";

export type SampleModalOpenSource = "preview" | "edit";

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
  // Prev / next navigation (#94). null = end of list within the current
  // directory group (ディレクトリ跨ぎ / 端ループは禁止)。Both null hides the
  // nav controls entirely; otherwise the respective button renders disabled.
  // While the edit pane has unsaved changes (#93, spec §5.4) the modal also
  // disables nav internally with NAV_BLOCKED_TOOLTIP — the original
  // direction availability is still respected, dirty just adds an extra
  // block on top.
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  // Edit pane (#93). Unified modal now hosts tag/confidence/note editing
  // alongside the preview. entry is null while no entry resolves for the
  // current preview filename (e.g. mid filter race) — the pane renders an
  // empty placeholder in that case. openSource controls initial focus
  // routing: "preview" leaves focus on the preview side, "edit" autofocuses
  // the tag input.
  entry: classification.Entry | null;
  knownTags: string[];
  openSource: SampleModalOpenSource;
  onSave: (next: classification.Entry) => void;
};

export function SampleModal({
  open,
  imagePath,
  filename,
  onClose,
  viewers,
  activeViewerId,
  onOpenInViewer,
  onPrev,
  onNext,
  entry,
  knownTags,
  openSource,
  onSave,
}: SampleModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">(
    "idle",
  );
  // Bubble dirty state up from SampleEditPane so prev/next can be blocked
  // while there are unsaved edits (#93 spec §5.4).
  const [editDirty, setEditDirty] = useState(false);

  // Initial-focus routing for ModalShell. ModalShell's default behavior is
  // to focus the first focusable descendant on open, which would land on
  // the close icon and override any child `autoFocus`. We explicitly hand
  // it a ref so spec §5.2 is honored:
  //   openSource === "edit"    → tag input (editing pane)
  //   openSource === "preview" → close button (preview side; Tab from here
  //                              flows into prev/next → edit pane)
  const tagInputRef = useRef<HTMLInputElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useMemo(
    () => (openSource === "edit" ? tagInputRef : closeBtnRef),
    [openSource],
  );

  // Reset dirty when the modal closes or the active *filename* changes
  // (prev/next swap, entry becoming null, etc.). We deliberately key on
  // `entry?.filename` rather than `entry` itself: watcher-driven reloads
  // hand us a new entry object whose baseline (folder / confidence /
  // note) is unchanged, and SampleEditPane preserves the user's in-pane
  // edits in that case (its `lastBaselineRef` short-circuits the reset).
  // Resetting parent's editDirty on every ref churn would desync from
  // child — SampleEditPane's onDirtyChange only re-fires when `dirty`
  // changes, so a ref-only update would leave editDirty stuck at false
  // while the pane still has unsaved tags/confidence/note. The save path
  // (same filename, new baseline) is covered by SampleEditPane's
  // baselineChanged branch instead: tags etc. get reset, dirty memo
  // flips true→false, and onDirtyChange(false) drains editDirty.
  useEffect(() => {
    setEditDirty(false);
  }, [open, entry?.filename]);

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

  // Effective nav callbacks after applying the dirty block (#93 §5.4).
  // null = direction unavailable (edge of group) OR blocked by dirty edits.
  // We keep the original null distinct from the dirty block in title text
  // so the user knows which case they're in.
  const prevBlocked = editDirty && onPrev !== null;
  const nextBlocked = editDirty && onNext !== null;
  const effectivePrev = prevBlocked ? null : onPrev;
  const effectiveNext = nextBlocked ? null : onNext;

  // Keyboard navigation (#94). ←/→ jump to prev/next within the current
  // directory group. ModalShell handles Esc and Tab focus trap, so we only
  // claim arrow keys here — no conflict. document-level listener mirrors how
  // ModalShell wires its own keys. Suppressed while the focus is in an
  // editable element so typing arrows inside the note textarea / tag input
  // doesn't bounce the preview. The TagInput chip × buttons are <button>s
  // (not INPUT/TEXTAREA/contentEditable), so an INPUT/TEXTAREA-only guard
  // would still bounce the preview when focus sits on a chip ×; the
  // `.cls-tag-input` ancestor check covers the whole chip-input widget
  // (input field + chip × buttons) uniformly.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest(".cls-tag-input"))
      ) {
        return;
      }
      if (e.key === "ArrowLeft" && effectivePrev) {
        e.preventDefault();
        effectivePrev();
      } else if (e.key === "ArrowRight" && effectiveNext) {
        e.preventDefault();
        effectiveNext();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, effectivePrev, effectiveNext]);

  // Render the nav row only when at least one direction is *available* in
  // the underlying group. The dirty block doesn't hide the buttons (they
  // render disabled with an explanatory tooltip instead), only single-entry
  // groups do.
  const navAvailable = onPrev !== null || onNext !== null;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      initialFocusRef={initialFocusRef}
      ariaLabel={
        filename ? `${filename} のプレビューと編集` : "画像プレビューと編集"
      }
      overlayClassName="sample-modal-overlay"
      dialogClassName="sample-modal"
    >
      <div className="sample-modal-header">
        <div className="sample-modal-title" title={filename ?? undefined}>
          {filename ?? ""}
          {editDirty ? (
            <span
              className="sample-modal-dirty-badge"
              title="未保存の変更があります"
              aria-label="未保存の変更があります"
            >
              ●
            </span>
          ) : null}
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          className="sample-modal-close"
          onClick={onClose}
          title="閉じる (Esc)"
          aria-label="プレビューを閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="sample-modal-content">
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
          {navAvailable ? (
            <>
              <button
                type="button"
                className="sample-modal-nav sample-modal-nav-prev"
                onClick={() => effectivePrev?.()}
                disabled={effectivePrev === null}
                aria-label="前の画像 (←)"
                title={prevBlocked ? NAV_BLOCKED_TOOLTIP : "前の画像 (←)"}
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M10 4l-4 4 4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="sample-modal-nav sample-modal-nav-next"
                onClick={() => effectiveNext?.()}
                disabled={effectiveNext === null}
                aria-label="次の画像 (→)"
                title={nextBlocked ? NAV_BLOCKED_TOOLTIP : "次の画像 (→)"}
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M6 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </>
          ) : null}
        </div>
        <SampleEditPane
          entry={entry}
          knownTags={knownTags}
          tagInputRef={tagInputRef}
          onSave={onSave}
          onDirtyChange={setEditDirty}
        />
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
