// マルチビューアの純関数層 (#11)。ViewerSet は N 個の viewer を持ち、各々が独自の BSP
// Layout を持つ (spec-viewer-flexlayout.md)。ここの mutation は全て純粋 (ViewerSet を受け
// 新しいものを返す)。React 配線は useViewerSet.ts。

import {
  appendOrFocusInActive,
  collapseEmptyLeaf,
  findLeaf,
  initialLayout,
  layoutFromPersisted,
  recomputeActiveAfterClose,
  replaceNode,
  type Layout,
  type LayoutNode,
  type LeafNode,
} from "./layout";
import { newTab, type Tab } from "./useTabs";
import type { state } from "../../../wailsjs/go/models";

// ─── Constants ───────────────────────────────────────────────────────

// MAX_VIEWERS = 8 はタブ追加上限の既定値 (settings.maxViewers ロード中の fallback。Go 側
// defaultMaxViewers と対)。Ctrl+Shift+2..9 のキーバインドは上限設定に関わらず先頭 8 個のみ。
// MIN_VIEWERS / MAX_VIEWERS_HARD は settings で選べる上限の下界 / 上界 (Go 側 minMaxViewers /
// settings.MaxViewersHardCap = state.maxViewersHard と対、spec-viewer-max-count.md §7)。
// 3 定数のドリフトは viewers.test.ts の D-1 pin テストで検知。MAX_NAME_LEN は byte でなく
// rune 数 (日本語名も 32 文字使える)。DEFAULT_NAME_PREFIX が空白で終わるのは末尾に整数を足すため ("ビューア 1")。
export const MAX_VIEWERS = 8;
export const MIN_VIEWERS = 1;
export const MAX_VIEWERS_HARD = 32;
export const MAX_NAME_LEN = 32;
export const DEFAULT_NAME_PREFIX = "ビューア ";

// ─── Types ───────────────────────────────────────────────────────────

export type Viewer = {
  id: string; // 構築時に crypto.randomUUID
  name: string;
  layout: Layout;
};

export type ViewerSet = {
  viewers: Viewer[]; // 長さ 1..MAX_VIEWERS_HARD (不変条件。追加時 gate は settings.maxViewers)
  activeViewerId: string; // viewers[*].id のいずれか
};

// ─── ID generation ───────────────────────────────────────────────────

export function newViewerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // globalThis.crypto 無しのテスト環境は非 RFC だが十分ユニークな id に fallback。
  return `vt-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

// ─── Constructors ────────────────────────────────────────────────────

export function newViewer(name: string): Viewer {
  return { id: newViewerId(), name, layout: initialLayout() };
}

export function initialViewerSet(): ViewerSet {
  const v = newViewer(`${DEFAULT_NAME_PREFIX}1`);
  return { viewers: [v], activeViewerId: v.id };
}

// 永続 state から ViewerSet を復元。viewers が空/欠落なら単一 viewer に fallback。Go 側
// validateState が 1+ viewer 不変条件を保証するが、初回起動 (save 前) 用にここでも guard。
export function hydrateInitialViewerSet(
  initialState: state.StateData | null,
): ViewerSet {
  if (!initialState?.viewers || initialState.viewers.length === 0) {
    return initialViewerSet();
  }
  const viewers: Viewer[] = initialState.viewers.map((v) => ({
    id: v.id,
    name: v.name,
    layout: layoutFromPersisted(v.layout),
  }));
  const activeViewerId =
    initialState.activeViewerId &&
    viewers.some((v) => v.id === initialState.activeViewerId)
      ? initialState.activeViewerId
      : viewers[0].id;
  return { viewers, activeViewerId };
}

// viewer の BSP layout 全体の tab 数合計。close-confirm で喪失量を伝えるのに使う。
export function countLeafTabs(v: Viewer): number {
  let n = 0;
  walk(v.layout.root);
  return n;
  function walk(node: LayoutNode) {
    if (node.kind === "leaf") {
      n += node.tabs.length;
      return;
    }
    walk(node.a);
    walk(node.b);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function findViewer(set: ViewerSet, id: string): Viewer | null {
  return set.viewers.find((v) => v.id === id) ?? null;
}

export function activeViewer(set: ViewerSet): Viewer {
  // 不変条件が 1+ viewer と有効な activeViewerId を保証。viewers[0] は最終防御 (呼び出し側が null を受けないため)。
  return findViewer(set, set.activeViewerId) ?? set.viewers[0];
}

// `${DEFAULT_NAME_PREFIX}<数字>` にマッチする名前で未使用の最小正整数 N を選ぶ。
// ユーザーのカスタム名は無視 (自動採番の枠を占めない)。
export function suggestViewerName(existingNames: string[]): string {
  const pattern = new RegExp(
    `^${DEFAULT_NAME_PREFIX.replace(/\s/g, "\\s")}(\\d+)$`,
  );
  const used = new Set<number>();
  for (const name of existingNames) {
    const m = name.match(pattern);
    if (!m) continue;
    used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `${DEFAULT_NAME_PREFIX}${n}`;
}

// trim + 制御文字除去 + MAX_NAME_LEN で rune 切り詰め。結果が空なら null (呼び出し側が拒否/fallback を決める)。
export function sanitizeName(raw: string): string | null {
  const trimmed = raw.trim();
  // ASCII 制御 + DEL を除去 — viewer 名は 1 行。
  // eslint-disable-next-line no-control-regex
  const cleaned = trimmed.replace(/[\x00-\x1f\x7f]/g, "");
  if (cleaned === "") return null;
  const runes = Array.from(cleaned);
  if (runes.length > MAX_NAME_LEN) return runes.slice(0, MAX_NAME_LEN).join("");
  return cleaned;
}

// ─── Mutations (pure) ────────────────────────────────────────────────

// 新 viewer を作り (suggestViewerName で自動命名) active を切り替える。max (settings.maxViewers、
// 未指定は既定 MAX_VIEWERS) 到達時は同じ set を返す — 上限の通知 (toast/log) は呼び出し側の責任。
// 既に max を超えている set (上限を下げた後) への add も拒否のみで、既存 viewer は削らない。
export function addViewer(set: ViewerSet, max: number = MAX_VIEWERS): ViewerSet {
  if (set.viewers.length >= max) return set;
  const name = suggestViewerName(set.viewers.map((v) => v.name));
  const v = newViewer(name);
  return {
    viewers: [...set.viewers, v],
    activeViewerId: v.id,
  };
}

// viewer を除去し activeViewerId を再解決: 新配列の同 index (= 次の viewer) → 1 つ前 → 先頭。
// 最後の 1 個は閉じない。
export function closeViewer(set: ViewerSet, id: string): ViewerSet {
  if (set.viewers.length <= 1) return set;
  const idx = set.viewers.findIndex((v) => v.id === id);
  if (idx < 0) return set;

  const next = [...set.viewers.slice(0, idx), ...set.viewers.slice(idx + 1)];
  let activeId = set.activeViewerId;
  if (set.activeViewerId === id) {
    if (idx < next.length) {
      activeId = next[idx].id;
    } else if (idx - 1 >= 0 && idx - 1 < next.length) {
      activeId = next[idx - 1].id;
    } else {
      activeId = next[0].id;
    }
  }
  return { viewers: next, activeViewerId: activeId };
}

// sanitizeName を適用。trim 後空なら no-op (呼び出し側が検証 feedback)。activeViewerId は不変。
export function renameViewer(
  set: ViewerSet,
  id: string,
  newName: string,
): ViewerSet {
  const sanitized = sanitizeName(newName);
  if (sanitized === null) return set;
  const idx = set.viewers.findIndex((v) => v.id === id);
  if (idx < 0) return set;
  if (set.viewers[idx].name === sanitized) return set;
  const next = set.viewers.map((v, i) =>
    i === idx ? { ...v, name: sanitized } : v,
  );
  return { ...set, viewers: next };
}

export function setActiveViewer(set: ViewerSet, id: string): ViewerSet {
  if (set.activeViewerId === id) return set;
  if (!set.viewers.some((v) => v.id === id)) return set;
  return { ...set, activeViewerId: id };
}

// viewer を配列内で並べ替える。toIdx は splice 前の **挿入位置** (0..len) なので、
// toIdx === fromIdx と toIdx === fromIdx + 1 は共に no-op (視覚位置不変)。activeViewerId は不変。
// 範囲外 fromIdx は no-op、toIdx は [0, len] に clamp。
export function moveViewer(
  set: ViewerSet,
  fromIdx: number,
  toIdx: number,
): ViewerSet {
  const len = set.viewers.length;
  if (fromIdx < 0 || fromIdx >= len) return set;
  const dst = Math.max(0, Math.min(toIdx, len));
  if (dst === fromIdx || dst === fromIdx + 1) return set;
  const next = set.viewers.slice();
  const [picked] = next.splice(fromIdx, 1);
  // splice 除去後、fromIdx より後ろの index は 1 左シフト。視覚的な「dst の前に挿入」は
  // 除去後配列で dst > fromIdx ? dst - 1 : dst になる。
  const insertAt = dst > fromIdx ? dst - 1 : dst;
  next.splice(insertAt, 0, picked);
  return { ...set, viewers: next };
}

// 1 viewer の Layout を差し替える。useViewerSet が layout/ の mutation を 1 viewer ずつ
// 適用する汎用 bridge。
export function updateViewerLayout(
  set: ViewerSet,
  id: string,
  next: Layout,
): ViewerSet {
  const idx = set.viewers.findIndex((v) => v.id === id);
  if (idx < 0) return set;
  if (set.viewers[idx].layout === next) return set;
  const viewers = set.viewers.map((v, i) =>
    i === idx ? { ...v, layout: next } : v,
  );
  return { ...set, viewers };
}

// ─── Cross-viewer tab move (§4.6 of spec) ────────────────────────────

// src viewer の指定 leaf の 1 tab を dst viewer の現アクティブ leaf へ移植する。zoom/pan 等の
// Tab 状態は参照渡しで保たれる。挙動:
//   - src/dst 両方が必要。同一 viewer 移動は no-op (in-viewer helper を使う)。
//   - dst leaf は path で dedupe: 既存なら既存 tab へ focus し src の tab は除去される。
//   - 移動で src leaf が空になると collapse (兄弟昇格) しうる。
//   - activeViewerId は変えない — ユーザーは src で作業を続ける。
// 移動後の toast + logging は呼び出し側 (useViewerSet) の責任。
export function moveTabAcrossViewers(
  set: ViewerSet,
  srcViewerId: string,
  srcLeafId: string,
  srcIdx: number,
  dstViewerId: string,
): ViewerSet {
  if (srcViewerId === dstViewerId) return set;
  const srcViewer = findViewer(set, srcViewerId);
  const dstViewer = findViewer(set, dstViewerId);
  if (!srcViewer || !dstViewer) return set;

  const srcLeaf = findLeaf(srcViewer.layout.root, srcLeafId);
  if (!srcLeaf) return set;
  if (srcIdx < 0 || srcIdx >= srcLeaf.tabs.length) return set;
  const tab: Tab = srcLeaf.tabs[srcIdx];

  const dstLeaf = findLeaf(dstViewer.layout.root, dstViewer.layout.activeId);
  if (!dstLeaf) return set;

  // 新 dst leaf: path dedupe か append。
  let nextDstLeaf: LeafNode;
  const existing = dstLeaf.tabs.findIndex((t) => t.path === tab.path);
  if (existing >= 0) {
    nextDstLeaf = { ...dstLeaf, activeIndex: existing };
  } else {
    const newTabs = [...dstLeaf.tabs, tab];
    nextDstLeaf = {
      ...dstLeaf,
      tabs: newTabs,
      activeIndex: newTabs.length - 1,
    };
  }
  const dstRoot = replaceNode(dstViewer.layout.root, dstLeaf.id, nextDstLeaf);
  const nextDstLayout: Layout = { root: dstRoot, activeId: dstLeaf.id };

  // 新 src leaf: tab 除去、空なら collapse。
  const srcTabs = srcLeaf.tabs.filter((_, i) => i !== srcIdx);
  const nextSrcLeaf: LeafNode = {
    ...srcLeaf,
    tabs: srcTabs,
    activeIndex: recomputeActiveAfterClose(
      srcLeaf.activeIndex,
      srcIdx,
      srcTabs.length,
    ),
  };
  let srcRoot = replaceNode(srcViewer.layout.root, srcLeaf.id, nextSrcLeaf);
  if (nextSrcLeaf.tabs.length === 0) {
    srcRoot = collapseEmptyLeaf(srcRoot, nextSrcLeaf.id);
  }
  // src の activeId 解決: 空になった leaf を指しており collapse/merge されたら先頭 leaf に fallback。
  let srcActiveId = srcViewer.layout.activeId;
  if (
    nextSrcLeaf.tabs.length === 0 &&
    srcViewer.layout.activeId === srcLeaf.id &&
    !findLeaf(srcRoot, srcLeaf.id)
  ) {
    // collapse で消えた leaf は findLeaf が null を返す。先頭 leaf を選ぶ。
    const firstLeaf = pickFirstLeafId(srcRoot);
    if (firstLeaf) srcActiveId = firstLeaf;
  }
  const nextSrcLayout: Layout = { root: srcRoot, activeId: srcActiveId };

  // 両 viewer を 1 パスで patch。
  const viewers = set.viewers.map((v) => {
    if (v.id === srcViewerId) return { ...v, layout: nextSrcLayout };
    if (v.id === dstViewerId) return { ...v, layout: nextDstLayout };
    return v;
  });
  return { ...set, viewers };
}

// collapse 後の activeId fallback 用 local helper。enumerateLeaves の import を避ける
// (先頭 1 個で足りるのに全 leaf list を確保するため)。
function pickFirstLeafId(node: LayoutNode): string | null {
  if (node.kind === "leaf") return node.id;
  return pickFirstLeafId(node.a) ?? pickFirstLeafId(node.b);
}

// ─── Open-in-specific-viewer thin wrappers ───────────────────────────

// appendOrFocusInActive と合成し既存の単一 viewer open 経路をそのまま再利用する。
// pre-flight チェック (寸法 / error toast) は呼び出し側 (useViewerSet) がラップする。

export function openPathInViewer(
  set: ViewerSet,
  viewerId: string,
  path: string,
): ViewerSet {
  const v = findViewer(set, viewerId);
  if (!v) return set;
  const next = appendOrFocusInActive(v.layout, path);
  return updateViewerLayout(set, viewerId, next);
}

// bulk open-as-split フロー (splitWithNewLeaf に渡す fresh Tab が要る) 用に useViewerSet が
// Tab を作れるよう export。
export function makeNewTab(path: string): Tab {
  return newTab(path);
}
