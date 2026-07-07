// BSP layout tree の構造検証と ratio clamp。

import type { LayoutNode } from "./types";
import { MIN_RATIO } from "./types";

// 有効なら null、無効なら説明文字列を返す。
export function validateLayout(root: LayoutNode): string | null {
  const seen = new Set<string>();
  function walk(node: LayoutNode): string | null {
    if (!node.id) return "missing id";
    if (seen.has(node.id)) return `duplicate id: ${node.id}`;
    seen.add(node.id);
    if (node.kind === "split") {
      if (node.direction !== "row" && node.direction !== "col")
        return `invalid direction: ${node.direction}`;
      if (
        typeof node.ratio !== "number" ||
        Number.isNaN(node.ratio) ||
        node.ratio <= 0 ||
        node.ratio >= 1
      )
        return `ratio out of range: ${node.ratio}`;
      if (!node.a || !node.b) return "split missing children";
      return walk(node.a) ?? walk(node.b);
    }
    // leaf
    if (!Array.isArray(node.tabs)) return "leaf missing tabs";
    if (node.tabs.length === 0) {
      if (node.activeIndex !== -1)
        return `empty leaf has activeIndex !== -1: ${node.activeIndex}`;
    } else if (node.activeIndex < 0 || node.activeIndex >= node.tabs.length) {
      return `leaf activeIndex out of range: ${node.activeIndex}`;
    }
    return null;
  }
  return walk(root);
}

export function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0.5;
  if (ratio < MIN_RATIO) return MIN_RATIO;
  if (ratio > 1 - MIN_RATIO) return 1 - MIN_RATIO;
  return ratio;
}
