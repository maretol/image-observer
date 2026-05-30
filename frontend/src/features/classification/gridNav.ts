// Keyboard grid navigation for the classification list (#115). The list view
// renders cards as a responsive CSS grid (one grid per directory group), so
// arrow-key movement is computed from the cards' on-screen geometry rather
// than a fixed column count. The DOM glue (collecting card rects, moving
// focus) lives in ClassificationView; the geometry decision is this pure
// function so it can be unit-tested without a DOM.

export type Direction = "left" | "right" | "up" | "down";

// Minimal shape of a card's on-screen box. DOMRect (from
// getBoundingClientRect) is structurally compatible, so callers pass rects
// straight through.
export type CardRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

// arrowDirection maps a KeyboardEvent.key to a navigation direction, or null
// for any non-arrow key so callers can early-return.
export function arrowDirection(key: string): Direction | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}

// Cards whose `top` differs by no more than this many pixels are treated as
// the same visual row (absorbs sub-pixel layout differences).
const ROW_TOLERANCE = 4;

// pickGridNeighbor returns the index of the card focus should move to, or null
// when there is no neighbor in that direction.
//
// left/right move in reading (DOM) order so the focus flows across row and
// group boundaries exactly the way the cards are laid out — they need only the
// card `count` and the current index. up/down move by visual row: among the
// cards in the nearest row above/below, the one whose horizontal center is
// closest to the current card's center wins. Row membership is geometric, so
// this works regardless of the responsive column count or the fact that each
// directory group is its own grid.
//
// `rects` is therefore optional and only consulted for up/down. The caller
// skips the (reflow-inducing) getBoundingClientRect sweep on horizontal moves
// and omits it; when omitted, up/down resolve to null. When provided, rects
// must have `count` entries aligned with the same card order.
export function pickGridNeighbor(
  count: number,
  current: number,
  dir: Direction,
  rects?: readonly CardRect[],
): number | null {
  if (current < 0 || current >= count) return null;

  if (dir === "left") return current > 0 ? current - 1 : null;
  if (dir === "right") return current < count - 1 ? current + 1 : null;

  // up / down need geometry — bail if the caller didn't collect rects.
  if (!rects) return null;
  const cur = rects[current];
  const curCx = (cur.left + cur.right) / 2;

  let best: number | null = null;
  let bestRowDelta = Infinity; // vertical distance to the candidate's row
  let bestCxDelta = Infinity; // horizontal distance to the candidate's center

  for (let i = 0; i < count; i++) {
    if (i === current) continue;
    const r = rects[i];
    // Positive rowDelta = the candidate is in the requested direction.
    const rowDelta = dir === "up" ? cur.top - r.top : r.top - cur.top;
    if (rowDelta <= ROW_TOLERANCE) continue; // same row or wrong direction

    const cx = (r.left + r.right) / 2;
    const cxDelta = Math.abs(cx - curCx);

    const isNearerRow = rowDelta < bestRowDelta - ROW_TOLERANCE;
    const isSameRowCloserCx =
      Math.abs(rowDelta - bestRowDelta) <= ROW_TOLERANCE && cxDelta < bestCxDelta;
    if (isNearerRow || isSameRowCloserCx) {
      best = i;
      bestRowDelta = rowDelta;
      bestCxDelta = cxDelta;
    }
  }

  return best;
}
