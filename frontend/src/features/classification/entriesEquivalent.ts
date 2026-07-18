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

// watcher の no-op gate 用の fileTimes 比較 (#144)。entries 等価 + sidecar mtime 等価でも、
// 同名上書き (再エクスポート等) はファイル mtime だけが変わるため、これも一致して初めて
// 「完全な no-op」と言える (でないと mtime ソートが手動リロードまで stale になる)。
//
// 比較は entries (fresh 側の表示 filename) に限定する — in-flight delete で cur 側にだけ
// 残る行 (entriesEquivalent の非対称 strip と同じ事情) を差分扱いしないため。行の欠落は
// undefined === undefined で「両方欠落なら等価 / 片方だけ欠落なら差分」になる。
export function fileTimesEquivalent(
  entries: classification.Entry[],
  a: Record<string, number> | undefined | null,
  b: Record<string, number> | undefined | null,
): boolean {
  for (const e of entries) {
    if (a?.[e.filename] !== b?.[e.filename]) return false;
  }
  return true;
}
