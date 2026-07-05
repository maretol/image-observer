import { groupKeyOf } from "./groups";

export type Sibling = {
  prev: string | null;
  next: string | null;
};

// displayedOrder (表示順の filename 配列) と現在 filename から、同じディレクトリ
// グループ内の prev / next を返す (#94)。仕様: 並びは表示順に従う / ディレクトリは
// 跨がない (同じ groupKeyOf のみ) / 端で循環しない。filename が displayedOrder に
// 無い (モーダル中にフィルタで隠れた等) 場合は両方 null → 呼び出し側で両ボタン disabled。
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
