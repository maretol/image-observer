import type { classification } from "../../../wailsjs/go/models";
import {
  SORT_MANUAL,
  SORT_MTIME_ASC,
  SORT_MTIME_DESC,
  SORT_NAME_ASC,
  SORT_NAME_DESC,
  type SortMode,
} from "./sortMode";

// 一覧タブの表示派生ソート (#144, spec-image-sort.md §3)。loadResult.entries の配列順
// (= sidecar 正本の手動順) は書き換えず、表示チェーン (filter 済み entries → group 化) の
// 手前で並べ替えた新配列を返す。manual は identity を返し、下流 memo の再計算を起こさない。
//
// fileTimes は LoadResult.FileTimes (filename → Unix 秒)。行が無い filename (stat 失敗 /
// race で消失) は 0 扱いで昇順・降順とも末尾に寄せ、同着はファイル名昇順で安定させる。
export function sortEntries(
  entries: classification.Entry[],
  mode: SortMode,
  fileTimes: Record<string, number> | undefined | null,
): classification.Entry[] {
  switch (mode) {
    case SORT_MANUAL:
      return entries;
    case SORT_NAME_ASC:
      return sortBy(entries, (a, b) => compareName(a, b));
    case SORT_NAME_DESC:
      return sortBy(entries, (a, b) => -compareName(a, b));
    case SORT_MTIME_ASC:
      return sortBy(entries, (a, b) => compareMtime(a, b, fileTimes, 1));
    case SORT_MTIME_DESC:
      return sortBy(entries, (a, b) => compareMtime(a, b, fileTimes, -1));
  }
}

function sortBy(
  entries: classification.Entry[],
  cmp: (a: classification.Entry, b: classification.Entry) => number,
): classification.Entry[] {
  // Array.prototype.sort は仕様上 stable (ES2019+) — 同着で元の並び (手動順) を保つ。
  return [...entries].sort(cmp);
}

// ファイル名比較は locale 非依存の code unit 順 (グループキー sort (groups.ts) や Go の
// sort.Strings と同系の決定的順序)。大文字小文字を区別する。
function compareName(a: classification.Entry, b: classification.Entry): number {
  return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
}

function compareMtime(
  a: classification.Entry,
  b: classification.Entry,
  fileTimes: Record<string, number> | undefined | null,
  dir: 1 | -1,
): number {
  const ta = fileTimes?.[a.filename] ?? 0;
  const tb = fileTimes?.[b.filename] ?? 0;
  // mtime 欠落 (0) は昇順・降順どちらでも末尾: 0 を「最古」でなく「不明」として扱う。
  if (ta === 0 || tb === 0) {
    if (ta === tb) return compareName(a, b);
    return ta === 0 ? 1 : -1;
  }
  if (ta !== tb) return (ta - tb) * dir;
  return compareName(a, b);
}
