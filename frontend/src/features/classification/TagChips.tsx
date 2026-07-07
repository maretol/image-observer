import { useMemo } from "react";
import type { classification } from "../../../wailsjs/go/models";
import { summarizeTags } from "./filters";
import { readableTextColor, tagColor } from "./colors";

export type TagChipsProps = {
  entries: classification.Entry[];
  selected: string[];
  // "未分類" chip がアクティブフィルタ (selected と排他)。#116
  untaggedActive: boolean;
  onToggle: (tag: string) => void;
  onToggleUntagged: () => void;
  onClear: () => void;
};

export function TagChips({
  entries,
  selected,
  untaggedActive,
  onToggle,
  onToggleUntagged,
  onClear,
}: TagChipsProps) {
  // 1 パスで per-tag counts と untagged 総数を得る (extractTags の 2 度実行を避ける)。
  const { sorted, untagged } = useMemo(() => {
    const { counts, untagged } = summarizeTags(entries);
    const sorted = Array.from(counts.entries()).sort((a, b) => {
      // 多用順、同数はタグ名で tie-break。
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    return { sorted, untagged };
  }, [entries]);

  const allActive = selected.length === 0 && !untaggedActive;

  return (
    <div className="cls-tagchips">
      <button
        type="button"
        className={`cls-chip cls-chip-all ${allActive ? "active" : ""}`}
        onClick={onClear}
      >
        すべて
        <span className="cls-chip-count">{entries.length}</span>
      </button>
      <button
        type="button"
        className={`cls-chip cls-chip-untagged ${untaggedActive ? "active" : ""}`}
        onClick={onToggleUntagged}
      >
        未分類
        <span className="cls-chip-count">{untagged}</span>
      </button>
      {sorted.map(([tag, count]) => {
        const bg = tagColor(tag);
        const fg = readableTextColor(bg);
        const isActive = selected.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            className={`cls-chip ${isActive ? "active" : ""}`}
            onClick={() => onToggle(tag)}
            style={{
              background: isActive ? bg : "transparent",
              color: isActive ? fg : "#ddd",
              borderColor: bg,
            }}
          >
            {tag}
            <span className="cls-chip-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
