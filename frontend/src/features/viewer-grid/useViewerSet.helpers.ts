// useViewerSet.ts から抽出した純ヘルパ。React state / callback に触れないので hook 本体を
// useState / useCallback の配線に集中させられる。

import {
  appendOrFocusInActive,
  findLeaf,
  splitWithNewLeaf,
  type Layout,
} from "./layout";
import { newTab } from "./useTabs";
import type { Viewer } from "./viewers";

// viewer の全 leaf の tab 数を合計。close-viewer のログ行 (データ喪失の有無) 用。
export function leafTabsCount(v: Viewer): number {
  let n = 0;
  walk(v.layout.root);
  return n;
  function walk(node: Layout["root"]) {
    if (node.kind === "leaf") {
      n += node.tabs.length;
      return;
    }
    walk(node.a);
    walk(node.b);
  }
}

// "open many as split" 用の layout 変換: active leaf が空なら append (最初の画像が余分な
// split を作らず既存の空パネルに入る)、そうでなければ右に split。MAX_PANELS チェックは
// 呼び出し側の責任 (ここに来る時点で空きは確認済み)。
export function openPathAsSplitOrAppend(
  layout: Layout,
  path: string,
): Layout {
  const leaf = findLeaf(layout.root, layout.activeId);
  if (leaf && leaf.tabs.length === 0) {
    return appendOrFocusInActive(layout, path);
  }
  const r = splitWithNewLeaf(layout, layout.activeId, "right", newTab(path));
  return r.ok ? r.layout : layout;
}
