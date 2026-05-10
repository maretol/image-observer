import { useMemo } from "react";
import type { classification } from "../../../wailsjs/go/models";
import { tagSummary } from "./filters";
import { readableTextColor, tagColor } from "./colors";

export type TagChipsProps = {
  entries: classification.Entry[];
  selected: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
};

export function TagChips({
  entries,
  selected,
  onToggle,
  onClear,
}: TagChipsProps) {
  const sorted = useMemo(() => {
    const summary = tagSummary(entries);
    return Array.from(summary.entries()).sort((a, b) => {
      // Most-used first; tie-break by tag name.
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  }, [entries]);

  return (
    <div className="cls-tagchips">
      <button
        type="button"
        className={`cls-chip cls-chip-all ${selected.length === 0 ? "active" : ""}`}
        onClick={onClear}
      >
        すべて
        <span className="cls-chip-count">{entries.length}</span>
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
