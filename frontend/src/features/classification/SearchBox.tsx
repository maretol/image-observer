import { useEffect, useState } from "react";
import { SearchIcon } from "../../shared/icons/SearchIcon";

export type SearchBoxProps = {
  value: string;
  onChange: (next: string) => void;
  debounceMs?: number;
};

// 入力を debounce してから onChange に渡す (keystroke ごとに grid を再フィルタしないため)。
// 見える <input> は local state で即応。
export function SearchBox({ value, onChange, debounceMs = 150 }: SearchBoxProps) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  useEffect(() => {
    if (local === value) return;
    const t = window.setTimeout(() => onChange(local), debounceMs);
    return () => window.clearTimeout(t);
    // value / onChange をあえて deps から除外: 外部からの変更は最初の useEffect 経由で
    // 戻るので、含めると余分な onChange を schedule してしまう。
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
