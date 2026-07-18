import type { ListTabFilter } from "./filters";
import { SORT_MANUAL, type SortMode } from "./sortMode";

// 並べ替えモード (#144 Phase 2) の入口判定。手動ソート かつ フィルタ非適用のときのみ
// 入れる (spec-image-sort.md D5)。フィルタ適用中の DnD は隠れ entry を跨ぐ移動が意図
// しない大移動になるため入口から塞ぐ。ボタンの disabled 表示と onClick 時の再評価の
// 両方 (二重防御) で同じこの関数を使う。
export function canEnterReorderMode(
  sortMode: SortMode,
  filter: ListTabFilter,
): boolean {
  return (
    sortMode === SORT_MANUAL &&
    filter.tags.length === 0 &&
    !filter.untaggedOnly &&
    filter.confidence === "all" &&
    filter.query === ""
  );
}
