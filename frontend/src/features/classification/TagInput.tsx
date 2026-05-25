import { useRef, useState, type KeyboardEvent } from "react";
import { readableTextColor, tagColor } from "./colors";

export type TagInputProps = {
  tags: string[];
  knownTags: string[];
  onChange: (next: string[]) => void;
  autoFocus?: boolean;
  // datalist id; passed in so multiple TagInputs in one document don't collide.
  datalistId?: string;
  ariaLabel?: string;
};

// TagInput is a chip-style multi-tag input. Each committed tag becomes a
// removable chip; the trailing text field accepts the next tag with datalist
// autocomplete against `knownTags`. Commit on Enter / "," / "、" / half-width
// space / "　" (full-width space) / blur, and Backspace on an empty draft
// removes the last chip (standard chip-input UX).
// Tab with a draft that matches exactly one knownTag (case-insensitive prefix,
// excluding already-added tags) commits that candidate; other Tab behavior
// (no draft / 0 or >1 matches / Shift+Tab) falls through to default focus
// navigation.
export function TagInput({
  tags,
  knownTags,
  onChange,
  autoFocus,
  datalistId = "cls-tag-input-known",
  ariaLabel,
}: TagInputProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const v = raw.trim();
    setDraft("");
    if (!v) return;
    if (tags.includes(v)) return;
    onChange([...tags, v]);
  };

  const removeAt = (idx: number) => {
    onChange(tags.filter((_, i) => i !== idx));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // IME 変換中は確定/削除どちらもスキップ。日本語変換のスペース・Enter を
    // 横取りすると変換確定そのものが効かなくなるため、composition が終わるまで
    // チップ化ロジックは走らせない。React の SyntheticEvent では isComposing が
    // nativeEvent 側にしか乗らないことがあるので両方見る。
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    if (
      e.key === "Enter" ||
      e.key === "," ||
      e.key === "、" ||
      e.key === " " ||
      e.key === "　" // 全角スペース
    ) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      e.preventDefault();
      onChange(tags.slice(0, -1));
    } else if (e.key === "Tab" && !e.shiftKey && draft !== "") {
      // draft の case-insensitive prefix で knownTags を絞り、候補が 1 件なら
      // Tab で確定。Shift+Tab (逆方向フォーカス移動) や draft 空のときは横取り
      // しない。マッチ 0 件 / 複数件のときも通常の Tab 移動を維持する。
      const q = draft.toLowerCase();
      const candidates = knownTags.filter(
        (t) => !tags.includes(t) && t.toLowerCase().startsWith(q),
      );
      if (candidates.length === 1) {
        e.preventDefault();
        commit(candidates[0]);
      }
    }
  };

  return (
    <div
      className="cls-tag-input"
      onClick={() => inputRef.current?.focus()}
      role="group"
      aria-label={ariaLabel}
    >
      {tags.map((t, i) => {
        const bg = tagColor(t);
        const fg = readableTextColor(bg);
        return (
          <span
            key={`${t}-${i}`}
            className="cls-tag-input-chip"
            style={{ background: bg, color: fg }}
          >
            <span className="cls-tag-input-chip-text">{t}</span>
            <button
              type="button"
              className="cls-tag-input-chip-x"
              // mousedown で preventDefault することで、クリック時に input の
              // blur が走らないようにする。これがないと draft が残っている状態で
              // × を押すと onBlur → commit(draft) が発火し、削除と同時に意図せず
              // タグが追加される。
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                removeAt(i);
              }}
              aria-label={`${t} を削除`}
              title={`${t} を削除`}
              style={{ color: fg }}
            >
              ×
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        type="text"
        className="cls-tag-input-field"
        list={datalistId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        autoFocus={autoFocus}
        placeholder={
          tags.length === 0 ? "タグを入力 (Enter / スペース / , で確定)" : ""
        }
      />
      <datalist id={datalistId}>
        {knownTags
          .filter((t) => !tags.includes(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
    </div>
  );
}
