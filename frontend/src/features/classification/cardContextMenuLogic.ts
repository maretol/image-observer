// Card 右クリックメニューの純粋ヘルパ (#58)。DOM 無しで vitest にかけられるよう分離。

export type CardContextMenuMode = "single" | "bulk";

// "split-open" の上限。1080p で 8 枚横並びが限界、超えたら "tabs" を勧める。
// ClassificationView の bulk-toolbar と揃える (spec §11-E)。
export const SPLIT_OPEN_LIMIT = 8;

// spec §11-D: 選択外の card を右クリックしても選択を変えず single に落ちる
// (Finder 的な「選択が 1 個に collapse」を避けるため)。
export function computeCardContextMenuMode(
  selectedFilenames: readonly string[],
  filename: string,
): CardContextMenuMode {
  if (selectedFilenames.length === 0) return "single";
  return selectedFilenames.includes(filename) ? "bulk" : "single";
}

// bulk モードで "N 件をパネル分割で開く" を有効にするか。toolbar 側と揃える。
export function canBulkSplitOpen(selectedCount: number): boolean {
  return selectedCount > 0 && selectedCount <= SPLIT_OPEN_LIMIT;
}
