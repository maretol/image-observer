// 初期値のサンプル tag→color map。ロジックはこれらの名前を直接参照しない
// (colors.ts の特別扱いは "" = 未分類 のみ) ので自由に変えてよい。settings.json で上書き可。
export const DEFAULT_PALETTE: Readonly<Record<string, string>> = {
  iroha: "#1976d2",
  kaguya: "#f9a825",
  yachiyo: "#c2185b",
  roka: "#388e3c",
  mami: "#fb8c00",
  mikado: "#d32f2f",
  shugo: "#7b1fa2",
  fumei: "#757575",
};
