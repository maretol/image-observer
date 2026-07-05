import type { classification } from "../../../wailsjs/go/models";
import { extractTags, serializeTags } from "./filters";

// in-pane フォーム (tags/confidence/note) が保存済み baseline と食い違うか。false
// negative は未保存編集が prev/next jump で消える原因になる (spec §5.4)。
//
// タグ比較は entry 側を extractTags で正規化 (旧括弧 / "alice,bob" 形式を吸収) し、
// 両側を serializeTags して canonical な "alice, bob" 形式で比べる。local tags 側を
// 再 extract しないのは、TagInput.commit が入力時に重複を弾き順序も保つため。
export function computeEditDirty(
  entry: classification.Entry | null,
  tags: string[],
  confidence: string,
  note: string,
): boolean {
  if (!entry) return false;
  const baselineFolder = serializeTags(extractTags(entry.folder));
  if (serializeTags(tags) !== baselineFolder) return true;
  if (confidence !== entry.confidence) return true;
  if (note !== entry.note) return true;
  return false;
}
