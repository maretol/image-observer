import { forwardRef, useRef, useState, type KeyboardEvent } from "react";
import { readableTextColor, tagColor } from "./colors";

export type TagInputProps = {
  tags: string[];
  knownTags: string[];
  onChange: (next: string[]) => void;
  // datalist id; passed in so multiple TagInputs in one document don't collide.
  datalistId?: string;
  // <input> id used for <label htmlFor> association on the host side. Without
  // this, a sibling label cannot programmatically bind to the actual focusable
  // element (the chip-input wrapper is a div, not a form control), so screen
  // readers don't announce the label when focus lands on the input.
  inputId?: string;
  ariaLabel?: string;
  // Fires after the internal commit(draft) on the chip-input's blur. The
  // commit runs first (synchronously calling onChange with the final tags
  // including any just-typed draft), then this callback. SampleEditPane uses
  // it to gate auto-save (#105): if the host mirrors `onChange` into a ref,
  // it can read the post-commit tag list synchronously inside this handler
  // even though React's setState has not yet flushed (see
  // spec-edit-autosave.md §5.2). Optional so non-auto-save consumers ignore it.
  onBlur?: () => void;
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
// SampleModal forwards initialFocusRef to ModalShell as the chip-input
// <input> so openSource === "edit" lands focus there; without this, the
// shell's first-focusable fallback would target a chip × button or the
// modal close icon.
export const TagInput = forwardRef<HTMLInputElement, TagInputProps>(function TagInput(
  {
    tags,
    knownTags,
    onChange,
    datalistId = "cls-tag-input-known",
    inputId,
    ariaLabel,
    onBlur,
  },
  ref,
) {
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
    } else if (e.key === "Tab" && !e.shiftKey) {
      // draft の case-insensitive prefix で knownTags を絞り、候補が 1 件なら
      // Tab で確定。Shift+Tab (逆方向フォーカス移動) や draft が空 (trim 後) の
      // ときは横取りしない。マッチ 0 件 / 複数件のときも通常の Tab 移動を維持。
      // commit() 側が raw.trim() するのに合わせて検索クエリも trim する
      // (先頭/末尾空白付き draft でも commit と同じタグにヒットさせる)。
      const q = draft.trim().toLowerCase();
      if (q === "") return;
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
        ref={(el) => {
          inputRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        id={inputId}
        type="text"
        className="cls-tag-input-field"
        list={datalistId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Order matters: commit(draft) synchronously calls onChange with
          // the final tags so the host's onChange wrapper can mirror into a
          // ref; the host's onBlur callback (auto-save in #105) then reads
          // that ref to get post-commit tags. Swapping the order would lose
          // the just-typed draft on the auto-save IPC.
          commit(draft);
          onBlur?.();
        }}
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
});
