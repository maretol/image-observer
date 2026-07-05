import type { classification } from "../../../wailsjs/go/models";

// 親フォルダ直下 (サブディレクトリ無し) のファイル用キー。state.json に永続化される
// ので、state schema を bump せずに変えないこと。
export const ROOT_GROUP_KEY = ".";

export const ROOT_GROUP_LABEL = "(直下)";

export type DirectoryGroup = {
  key: string; // ROOT_GROUP_KEY か相対 POSIX パス ("child1", "child1/sub")
  label: string;
  entries: classification.Entry[];
};

export function groupKeyOf(filename: string): string {
  const slash = filename.lastIndexOf("/");
  if (slash < 0) return ROOT_GROUP_KEY;
  return filename.slice(0, slash);
}

// ディレクトリキーで分割。順序は ROOT_GROUP_KEY 先頭 → 残りをキー昇順 (アコーディオン
// を安定させるため)。各グループ内は元の entry 順を保つ。
export function groupByDirectory(
  entries: classification.Entry[],
): DirectoryGroup[] {
  const buckets = new Map<string, classification.Entry[]>();
  for (const e of entries) {
    const k = groupKeyOf(e.filename);
    const arr = buckets.get(k);
    if (arr) arr.push(e);
    else buckets.set(k, [e]);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => {
    if (a === ROOT_GROUP_KEY) return -1;
    if (b === ROOT_GROUP_KEY) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys.map((key) => ({
    key,
    label: key === ROOT_GROUP_KEY ? ROOT_GROUP_LABEL : key,
    entries: buckets.get(key)!,
  }));
}
