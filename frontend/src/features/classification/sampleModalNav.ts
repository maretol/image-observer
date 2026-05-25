import { groupKeyOf } from "./groups";

export type Sibling = {
  prev: string | null;
  next: string | null;
};

// pickSibling は displayedOrder (filteredGroups 由来の表示順 filename 配列) と
// 現在 SampleModal が表示している filename から、同じディレクトリグループ内での
// prev / next filename を返す純関数 (#94)。
//
// 仕様 (issue #94):
// - 並び順は一覧の表示順 (= displayedOrder) に従う
// - ディレクトリは跨がない (= 同じ groupKeyOf() の filename のみ対象)
// - 端で循環しない (先頭の prev / 末尾の next は null)
//
// displayedOrder に filename が含まれない (例: モーダル open 中にフィルタで
// 隠された) 場合は両方 null を返し、呼び出し側で両ボタン disabled に倒す。
export function pickSibling(
  displayedOrder: readonly string[],
  filename: string,
): Sibling {
  const idx = displayedOrder.indexOf(filename);
  if (idx < 0) return { prev: null, next: null };
  const myKey = groupKeyOf(filename);
  const prevCandidate = idx > 0 ? displayedOrder[idx - 1] : null;
  const nextCandidate =
    idx < displayedOrder.length - 1 ? displayedOrder[idx + 1] : null;
  return {
    prev:
      prevCandidate !== null && groupKeyOf(prevCandidate) === myKey
        ? prevCandidate
        : null,
    next:
      nextCandidate !== null && groupKeyOf(nextCandidate) === myKey
        ? nextCandidate
        : null,
  };
}
