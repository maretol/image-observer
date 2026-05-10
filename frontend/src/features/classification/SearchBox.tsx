import { useEffect, useState } from "react";
import { SearchIcon } from "../../shared/icons/SearchIcon";

export type SearchBoxProps = {
  value: string;
  onChange: (next: string) => void;
  debounceMs?: number;
};

// SearchBox debounces user input before forwarding to onChange so the grid
// does not re-filter on every keystroke. The visible <input> stays
// responsive (controlled by local state).
export function SearchBox({ value, onChange, debounceMs = 150 }: SearchBoxProps) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  useEffect(() => {
    if (local === value) return;
    const t = window.setTimeout(() => onChange(local), debounceMs);
    return () => window.clearTimeout(t);
    // We intentionally exclude `value` and `onChange` from deps: changes from
    // outside flow back through the first useEffect and would otherwise
    // schedule redundant onChange calls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, debounceMs]);

  return (
    <div className="cls-search">
      <span className="cls-search-icon">
        <SearchIcon size={14} />
      </span>
      <input
        className="cls-search-input"
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder="ファイル名・備考で検索"
      />
    </div>
  );
}
