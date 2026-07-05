// 分類一覧のキーボードグリッド移動 (#115)。responsive な CSS グリッドで列数が固定
// でないため、矢印移動は固定列数ではなく card の画面上ジオメトリから計算する。
// DOM glue は ClassificationView、ジオメトリ判定は DOM 無しで unit-test できるよう
// この純粋関数に置く。

export type Direction = "left" | "right" | "up" | "down";

// card の画面上 box の最小形。DOMRect (getBoundingClientRect) と構造互換なので、
// getRect は getBoundingClientRect() の結果をそのまま返せる。
export type CardRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

// 矢印キー以外は null (呼び出し側が early-return できるよう)。
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

// top の差がこれ以下なら同じ視覚行とみなす (sub-pixel の揺れを吸収)。
const ROW_TOLERANCE = 4;

// focus 移動先の index、その方向に隣がなければ null。left/right は reading (DOM)
// 順なので count と現在 index だけで足りる。up/down は視覚行で動き、隣接行の中で
// 水平中心が現在 card に最も近いものを選ぶ。
//
// getRect(i) は LAZY 呼び出し — up/down が実際に見る card だけで、グリッド全体は
// 見ない。key-repeat を O(n) の forced-reflow に乗せないため (getRect は
// getBoundingClientRect を読む)。
//
// up/down は「DOM 順 == 視覚順」= card の top が index に対して単調非減少、に依存
// する。.cls-groups が per-group の .cls-group-grid を縦積みする間は成り立つ。
// grid が order や grid-auto-flow: dense を採ると、この前提と early-exit scan は壊れる。
export function pickGridNeighbor(
  count: number,
  current: number,
  dir: Direction,
  getRect?: (index: number) => CardRect,
): number | null {
  if (current < 0 || current >= count) return null;

  if (dir === "left") return current > 0 ? current - 1 : null;
  if (dir === "right") return current < count - 1 ? current + 1 : null;

  // up/down はジオメトリが要る — accessor 無しなら諦める。
  if (!getRect) return null;
  const cur = getRect(current);
  const curCx = (cur.left + cur.right) / 2;
  const step = dir === "up" ? -1 : 1;

  // Phase 1: current の行 (top が tolerance 内) を抜けて隣接行の最初の card まで
  // 外側へ walk。top が単調なので、行が変わる最初の card がそのまま隣接行。
  let i = current + step;
  while (i >= 0 && i < count) {
    const t = getRect(i).top;
    const rowDelta = dir === "up" ? cur.top - t : t - cur.top;
    if (rowDelta > ROW_TOLERANCE) break; // 隣接行に到達
    i += step;
  }
  if (i < 0 || i >= count) return null; // その方向に行がない

  // Phase 2: 隣接行だけを scan し、水平中心が最も近いものを保つ。
  const rowTop = getRect(i).top;
  let best = i;
  let bestCxDelta = Infinity;
  while (i >= 0 && i < count) {
    const r = getRect(i);
    if (Math.abs(r.top - rowTop) > ROW_TOLERANCE) break; // 隣接行を抜けた
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
