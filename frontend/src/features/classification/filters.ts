import type { classification } from "../../../wailsjs/go/models";

export type Confidence = "high" | "mid" | "low" | "";

export type ListTabFilter = {
  tags: string[]; // OR 結合。空 = タグ絞り込みなし
  // tags と UI 上は排他だが、両方来ても well-defined になるよう applyFilter では
  // untaggedOnly を優先する。
  untaggedOnly: boolean;
  confidence: Confidence | "all";
  query: string;
};

// on-disk の `folder` 文字列を重複除去したタグ配列にする。2 形式を受ける:
//   - 旧括弧形式: "head (sub + sub + ...)"  (Phase 4 v1.0〜)
//   - 直リスト形式: "tag1, tag2, tag3"       (Phase 4 v1.5〜, #8)
// リスト形式の区切りは半角/全角コンマ "、" 両方。
export function extractTags(folder: string): string[] {
  if (!folder) return [];
  const parens = folder.match(/^([^(]+?)\s*\(([^)]*)\)\s*$/);
  if (parens) {
    const head = parens[1].trim();
    const inner = parens[2]
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set([head, ...inner].filter(Boolean)));
  }
  const list = folder
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(list));
}

// タグ配列を on-disk `folder` に戻す。区切りは canonical な ", " (Phase 4 v1.5)。
// 空入力 → "" (未分類が正しく round-trip するため)。
export function serializeTags(tags: string[]): string {
  return tags
    .map((t) => t.trim())
    .filter(Boolean)
    .join(", ");
}

export type TagSummary = {
  counts: Map<string, number>;
  untagged: number;
};

// per-tag counts と untagged 総数を 1 パスで作る (extractTags を entry ごとに 2 度
// 走らせないため)。
export function summarizeTags(entries: classification.Entry[]): TagSummary {
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const e of entries) {
    const tags = extractTags(e.folder);
    if (tags.length === 0) {
      untagged++;
      continue;
    }
    for (const t of tags) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return { counts, untagged };
}

// counts だけ要る呼び出し向けの summarizeTags 薄ラッパ。
export function tagSummary(
  entries: classification.Entry[],
): Map<string, number> {
  return summarizeTags(entries).counts;
}

// "未分類" chip の件数バッジ用 (#116)。
export function untaggedCount(entries: classification.Entry[]): number {
  return summarizeTags(entries).untagged;
}

// filter にマッチする entry を返す。tags は OR、query は filename/note の
// 部分一致 (大小無視)、有効な条件同士は AND。untaggedOnly は tags に優先。
export function applyFilter(
  entries: classification.Entry[],
  f: ListTabFilter,
): classification.Entry[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.untaggedOnly) {
      if (extractTags(e.folder).length > 0) return false;
    } else if (f.tags.length > 0) {
      const tags = extractTags(e.folder);
      if (!f.tags.some((t) => tags.includes(t))) return false;
    }
    if (f.confidence !== "all" && e.confidence !== f.confidence) return false;
    if (
      q &&
      !e.filename.toLowerCase().includes(q) &&
      !e.note.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
}
