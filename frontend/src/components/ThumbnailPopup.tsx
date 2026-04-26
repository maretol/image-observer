import { SpinnerIcon } from "../icons/SpinnerIcon";
import { ThumbErrorIcon } from "../icons/ThumbErrorIcon";
import type { CacheEntry } from "../hooks/useThumbnail";

type Props = {
  visible: boolean;
  anchor: DOMRect | null;
  entry: CacheEntry | undefined;
  size: number;
};

const PADDING = 4;
const MARGIN = 8;

export function ThumbnailPopup({ visible, anchor, entry, size }: Props) {
  if (!visible || !anchor || !entry) return null;

  const popupW = size + PADDING * 2;
  const popupH = size + PADDING * 2;

  let left = anchor.right + MARGIN;
  if (left + popupW > window.innerWidth - 8) {
    left = anchor.left - popupW - MARGIN;
  }
  if (left < 8) left = 8;

  let top = anchor.top - 4;
  if (top + popupH > window.innerHeight - 8) {
    top = window.innerHeight - 8 - popupH;
  }
  if (top < 8) top = 8;

  return (
    <div
      className="thumb-popup"
      style={{
        position: "fixed",
        left,
        top,
        width: popupW,
        height: popupH,
      }}
    >
      {entry.status === "loading" && (
        <div className="thumb-popup-center">
          <SpinnerIcon />
        </div>
      )}
      {entry.status === "ok" && (
        <img
          className="thumb-popup-img"
          src={entry.src}
          alt=""
          style={{ maxWidth: size, maxHeight: size }}
        />
      )}
      {entry.status === "error" && (
        <div className="thumb-popup-center">
          <ThumbErrorIcon />
          <div className="thumb-popup-error-msg">{entry.message}</div>
        </div>
      )}
    </div>
  );
}
