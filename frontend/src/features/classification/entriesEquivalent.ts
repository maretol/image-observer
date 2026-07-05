import { classification } from "../../../wailsjs/go/models";

// watcher の auto-merge が「再 Load 結果が表示中と同じ」を検出し、自分の Save/Delete
// echo で toast を出さないため。順序比較が安全なのは Service.Load が安定順
// (sidecar 順 → alphabetical) を返すから。
export function entriesEquivalent(
  a: classification.Entry[],
  b: classification.Entry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.filename !== y.filename ||
      x.folder !== y.folder ||
      x.confidence !== y.confidence ||
      x.note !== y.note
    ) {
      return false;
    }
  }
  return true;
}
