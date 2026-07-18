import type { classification } from "../../../wailsjs/go/models";
import { groupKeyOf } from "./groups";

// 手動並び替えの配列計算 (#144 Phase 2)。entries (loadResult.entries = sidecar 正本の
// 手動順) から srcFilename を同一ディレクトリグループ内の insertIdx (グループ内 splice
// 位置 0..グループ長) へ移す新配列を返す。非破壊。
//
// null を返すケース (caller は保存せず中止):
//   - srcFilename が entries に無い (drag 中の watcher 差し替え等。gen gate の二重防御)
//   - srcFilename のグループが groupKey と不一致 (グループ跨ぎ drop の防御)
//   - 移動しても順序が変わらない no-op (insertIdx が src の現位置 / 現位置+1)
export function reorderEntries(
  entries: classification.Entry[],
  srcFilename: string,
  groupKey: string,
  insertIdx: number,
): classification.Entry[] | null {
  if (groupKeyOf(srcFilename) !== groupKey) return null;

  // グループ内 entry の「全体配列上の index」を順序どおり集める。
  const memberIdxs: number[] = [];
  let srcPosInGroup = -1;
  for (let i = 0; i < entries.length; i++) {
    if (groupKeyOf(entries[i].filename) !== groupKey) continue;
    if (entries[i].filename === srcFilename) srcPosInGroup = memberIdxs.length;
    memberIdxs.push(i);
  }
  if (srcPosInGroup < 0) return null;
  if (insertIdx < 0 || insertIdx > memberIdxs.length) return null;
  // splice 位置として src の現位置と現位置+1 は共に視覚 no-op (useViewerTabReorder と同じ)。
  if (insertIdx === srcPosInGroup || insertIdx === srcPosInGroup + 1) {
    return null;
  }

  // 挿入先の「全体配列上の位置」を決める: insertIdx 番目のグループ member の直前、
  // 末尾 (insertIdx === グループ長) なら最終 member の直後。グループ外の entry の
  // 相対位置は動かさない (src を抜いて挿し直すだけ)。
  const srcGlobalIdx = memberIdxs[srcPosInGroup];
  const anchorGlobalIdx =
    insertIdx < memberIdxs.length
      ? memberIdxs[insertIdx]
      : memberIdxs[memberIdxs.length - 1] + 1;

  const src = entries[srcGlobalIdx];
  const without = entries.filter((_, i) => i !== srcGlobalIdx);
  // src を抜いた分、src より後ろの挿入先は 1 つ前へずれる。
  const insertAt =
    anchorGlobalIdx > srcGlobalIdx ? anchorGlobalIdx - 1 : anchorGlobalIdx;
  without.splice(insertAt, 0, src);
  return without;
}
