// activeId resolution + tab activeIndex recomputation after a tab/leaf
// disappears. Used by closeTabInLeaf and related operations.

import type { LayoutNode } from "./types";
import { enumerateLeaves } from "./tree";

// Given the leaf order BEFORE the mutation, the index of the now-missing
// active leaf, and the new root, pick a sensible new activeId:
//   - leaf at the same DFS index in the new tree (= the leaf that "took the
//     active panel's place")
//   - else leaf at index -1 (the one just before)
//   - else first leaf in the new tree
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

// Mirror of Phase 3a recomputeActiveAfterClose; lifted here for tests.
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
