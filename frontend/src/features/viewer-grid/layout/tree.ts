// BSP layout の tree プリミティブ: constructor / traversal / 純粋関数更新。全て LayoutNode の純関数。

import type { LayoutNode, LeafNode, SplitNode, Layout } from "./types";
import type { Tab } from "../useTabs";
import { newNodeId } from "./types";

// ─── Constructors ────────────────────────────────────────────────────

export function emptyLeaf(): LeafNode {
  return { kind: "leaf", id: newNodeId(), tabs: [], activeIndex: -1 };
}

export function leafWithTab(tab: Tab): LeafNode {
  return { kind: "leaf", id: newNodeId(), tabs: [tab], activeIndex: 0 };
}

export function initialLayout(): Layout {
  const root = emptyLeaf();
  return { root, activeId: root.id };
}

// ─── Traversal ───────────────────────────────────────────────────────

export function findNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.kind === "leaf") return null;
  return findNode(root.a, id) ?? findNode(root.b, id);
}

export function findLeaf(root: LayoutNode, id: string): LeafNode | null {
  const n = findNode(root, id);
  return n && n.kind === "leaf" ? n : null;
}

export function findParent(root: LayoutNode, childId: string): SplitNode | null {
  if (root.kind === "leaf") return null;
  if (root.a.id === childId || root.b.id === childId) return root;
  return findParent(root.a, childId) ?? findParent(root.b, childId);
}

export function enumerateLeaves(root: LayoutNode): LeafNode[] {
  if (root.kind === "leaf") return [root];
  return [...enumerateLeaves(root.a), ...enumerateLeaves(root.b)];
}

export function countLeaves(root: LayoutNode): number {
  return enumerateLeaves(root).length;
}

// ─── Functional updates ──────────────────────────────────────────────

export function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (root.kind === "leaf") return root;
  const newA = replaceNode(root.a, targetId, replacement);
  const newB = replaceNode(root.b, targetId, replacement);
  if (newA === root.a && newB === root.b) return root;
  return { ...root, a: newA, b: newB };
}

export function updateLeaf(
  root: LayoutNode,
  id: string,
  fn: (leaf: LeafNode) => LeafNode,
): LayoutNode {
  const leaf = findLeaf(root, id);
  if (!leaf) return root;
  return replaceNode(root, id, fn(leaf));
}

export function updateSplit(
  root: LayoutNode,
  id: string,
  fn: (split: SplitNode) => SplitNode,
): LayoutNode {
  const node = findNode(root, id);
  if (!node || node.kind !== "split") return root;
  return replaceNode(root, id, fn(node));
}

// tab が 0 の leaf を、兄弟を昇格して collapse する。root leaf は残す (空 viewer は有効な状態)。
export function collapseEmptyLeaf(
  root: LayoutNode,
  leafId: string,
): LayoutNode {
  const leaf = findLeaf(root, leafId);
  if (!leaf || leaf.tabs.length !== 0) return root;
  if (root.id === leafId) return root; // root leaf は残す
  const parent = findParent(root, leafId);
  if (!parent) return root;
  const sibling = parent.a.id === leafId ? parent.b : parent.a;
  return replaceNode(root, parent.id, sibling);
}
