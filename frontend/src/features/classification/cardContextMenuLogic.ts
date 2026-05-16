// Pure-function helpers for the Card right-click context menu (#58).
// Kept separate from CardContextMenu.tsx so vitest can exercise the mode
// decision without spinning up jsdom + React render.

export type CardContextMenuMode = "single" | "bulk";

// Visual sanity ceiling for the "split-open" path. 8 panels in a row already
// gets cramped on a 1080p display; beyond that we suggest "tabs" instead.
// Shared with ClassificationView's bulk-toolbar so the disabled-threshold
// stays in lockstep (spec §11-E).
export const SPLIT_OPEN_LIMIT = 8;

// computeCardContextMenuMode decides whether the right-click menu shown on
// `filename` should present single-item actions or bulk-selection actions.
//
// Spec §11-D: right-clicking a card that is NOT in the current selection
// does NOT mutate the selection — we just fall back to single mode. This
// avoids the Finder-style "selection collapses to 1" behavior that can
// surprise users mid-multi-select.
export function computeCardContextMenuMode(
  selectedFilenames: readonly string[],
  filename: string,
): CardContextMenuMode {
  if (selectedFilenames.length === 0) return "single";
  return selectedFilenames.includes(filename) ? "bulk" : "single";
}

// canBulkSplitOpen — true when "N 件をパネル分割で開く" should be enabled in
// bulk mode. Mirrors the existing bulk-toolbar check so the menu and the
// toolbar stay consistent.
export function canBulkSplitOpen(selectedCount: number): boolean {
  return selectedCount > 0 && selectedCount <= SPLIT_OPEN_LIMIT;
}
