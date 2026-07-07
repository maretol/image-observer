import type { imghash } from "../../../wailsjs/go/models";

// DuplicateReport.pairs から表示状態を導く純関数群 (#136, spec-duplicate-detection.md §5)。
// hook / view から分離して vitest 対象にする。

// ⚠ バッジを出す filename 集合 (dismiss されていないペアのいずれかに含まれる)。
export function duplicateFileSet(
  pairs: readonly imghash.DuplicatePair[],
): Set<string> {
  const out = new Set<string>();
  for (const p of pairs) {
    out.add(p.fileA);
    out.add(p.fileB);
  }
  return out;
}

// 起点 filename が絡むペアだけ返す (確認モーダルの行, §5.3)。順序は report の決定順を保持。
export function pairsForFile(
  pairs: readonly imghash.DuplicatePair[],
  filename: string,
): imghash.DuplicatePair[] {
  return pairs.filter((p) => p.fileA === filename || p.fileB === filename);
}

// dismiss 成功後の local 除去 (§8.1 dismiss 行)。無順序一致 (report は fileA < fileB 正規化
// 済みだが、呼び出し側の引数順に依存しない)。
export function removePair(
  pairs: readonly imghash.DuplicatePair[],
  fileA: string,
  fileB: string,
): imghash.DuplicatePair[] {
  return pairs.filter(
    (p) =>
      !(
        (p.fileA === fileA && p.fileB === fileB) ||
        (p.fileA === fileB && p.fileB === fileA)
      ),
  );
}
