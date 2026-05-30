// Keyboard grid navigation for the classification list (#115). The list view
// renders cards as a responsive CSS grid (one grid per directory group), so
// arrow-key movement is computed from the cards' on-screen geometry rather
// than a fixed column count. The DOM glue (collecting card rects, moving
// focus) lives in ClassificationView; the geometry decision is this pure
// function so it can be unit-tested without a DOM.

export type Direction = "left" | "right" | "up" | "down";

// Minimal shape of a card's on-screen box. DOMRect (from
// getBoundingClientRect) is structurally compatible, so a getRect accessor can
// return getBoundingClientRect() results directly.
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
// left/right move in reading (DOM) order, so they need only `count` and the
// current index. up/down move by visual row: pick the card in the adjacent row
// whose horizontal center is closest to the current card's.
//
// `getRect(i)` returns card i's box and is called LAZILY — only for the cards
// up/down actually examines, never the whole grid. Horizontal moves never call
// it; when it is omitted, up/down resolve to null. The caller's getRect reads
// getBoundingClientRect, so limiting the calls keeps key-repeat off the O(n)
// forced-reflow path the full sweep would cost (Copilot review #117 round 3).
//
// up/down rely on cards being in DOM (reading) order == visual order — i.e. a
// card's `top` is monotonic non-decreasing in index. That holds while the list
// is a vertical stack of `grid-auto-flow: row` grids (.cls-groups is a flex
// column of per-group .cls-group-grid). If the grid ever adopts `order` or
// `grid-auto-flow: dense`, this assumption — and the early-exit scan — break.
export function pickGridNeighbor(
  count: number,
  current: number,
  dir: Direction,
  getRect?: (index: number) => CardRect,
): number | null {
  if (current < 0 || current >= count) return null;

  if (dir === "left") return current > 0 ? current - 1 : null;
  if (dir === "right") return current < count - 1 ? current + 1 : null;

  // up / down need geometry — bail if the caller didn't provide an accessor.
  if (!getRect) return null;
  const cur = getRect(current);
  const curCx = (cur.left + cur.right) / 2;
  const step = dir === "up" ? -1 : 1;

  // Phase 1: walk outward from `current` past the rest of its row (tops within
  // tolerance) to the first card of the adjacent row. Because `top` is
  // monotonic in index, the first card whose row differs IS the adjacent row.
  let i = current + step;
  while (i >= 0 && i < count) {
    const t = getRect(i).top;
    const rowDelta = dir === "up" ? cur.top - t : t - cur.top;
    if (rowDelta > ROW_TOLERANCE) break; // reached the adjacent row
    i += step;
  }
  if (i < 0 || i >= count) return null; // no row in that direction

  // Phase 2: scan just the adjacent row (tops within tolerance of its first
  // card) and keep the nearest horizontal center.
  const rowTop = getRect(i).top;
  let best = i;
  let bestCxDelta = Infinity;
  while (i >= 0 && i < count) {
    const r = getRect(i);
    if (Math.abs(r.top - rowTop) > ROW_TOLERANCE) break; // past the adjacent row
    const cx = (r.left + r.right) / 2;
    const cxDelta = Math.abs(cx - curCx);
    if (cxDelta < bestCxDelta) {
      best = i;
      bestCxDelta = cxDelta;
    }
    i += step;
  }
  return best;
}
