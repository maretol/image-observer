// tab/leaf 消失後の activeId 解決 + activeIndex 再計算。closeTabInLeaf 等が使う。

import type { LayoutNode } from "./types";
import { enumerateLeaves } from "./tree";

// mutation 前の leaf 順・消えた active leaf の index・新 root から妥当な activeId を選ぶ:
// 新木の同 DFS index (= active パネルの位置を継いだ leaf) → その 1 つ前 → 新木の先頭 leaf。
export function pickNewActiveId(
  newRoot: LayoutNode,
  prevIndex: number,
): string {
  const leaves = enumerateLeaves(newRoot);
  if (leaves.length === 0) return newRoot.id; // root leaf
  if (prevIndex >= 0 && prevIndex < leaves.length) return leaves[prevIndex].id;
  if (prevIndex - 1 >= 0 && prevIndex - 1 < leaves.length)
    return leaves[prevIndex - 1].id;
  return leaves[0].id;
}

// Phase 3a recomputeActiveAfterClose のミラー。test のためここへ抽出。
export function recomputeActiveAfterClose(
  curActive: number,
  closedIndex: number,
  newLen: number,
): number {
  if (newLen === 0) return -1;
  if (curActive === closedIndex) return Math.min(closedIndex, newLen - 1);
  if (curActive > closedIndex) return curActive - 1;
  return curActive;
}
