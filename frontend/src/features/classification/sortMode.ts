// Go 側 internal/state.SortManual / SortNameAsc / SortNameDesc / SortMtimeAsc /
// SortMtimeDesc のミラー (#144)。両側は test 対の pin 断言だけで同期される
// (Go の validateState はこのモジュールを読まない) ので、片側だけ rename すると
// 永続化した値が validateState に manual へ戻されるのでなく CI が落ちる (AGENTS.md D-1)。
export const SORT_MANUAL = "manual" as const;
export const SORT_NAME_ASC = "nameAsc" as const;
export const SORT_NAME_DESC = "nameDesc" as const;
export const SORT_MTIME_ASC = "mtimeAsc" as const;
export const SORT_MTIME_DESC = "mtimeDesc" as const;

export type SortMode =
  | typeof SORT_MANUAL
  | typeof SORT_NAME_ASC
  | typeof SORT_NAME_DESC
  | typeof SORT_MTIME_ASC
  | typeof SORT_MTIME_DESC;

export const SORT_MODE_VALUES: readonly SortMode[] = [
  SORT_MANUAL,
  SORT_NAME_ASC,
  SORT_NAME_DESC,
  SORT_MTIME_ASC,
  SORT_MTIME_DESC,
];

// state.json 由来の生値を SortMode に正規化する。Go の validateState が同じ clamp を
// 掛けるので通常ここは素通しだが、GetState 失敗 fallback (initialList = null) や
// 将来値との遭遇でも UI 側が不正値のまま描画しないよう二重防御する。
export function normalizeSortMode(raw: string | undefined | null): SortMode {
  return (SORT_MODE_VALUES as readonly string[]).includes(raw ?? "")
    ? (raw as SortMode)
    : SORT_MANUAL;
}
