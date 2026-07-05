import { forwardRef, useRef, useState, type KeyboardEvent } from "react";
import { readableTextColor, tagColor } from "./colors";

export type TagInputProps = {
  tags: string[];
  knownTags: string[];
  onChange: (next: string[]) => void;
  // 同一 document 内の複数 TagInput が衝突しないよう渡す datalist id。
  datalistId?: string;
  // <label htmlFor> 紐付け用の <input> id。wrapper が div なのでこれが無いと label を
  // 実 focusable 要素に結び付けられず、SR が label を読み上げない。
  inputId?: string;
  ariaLabel?: string;
  // blur 時、内部 commit(draft) の *後* に発火する。commit が先に onChange を同期呼び
  // 出しするので、host が onChange を ref にミラーすれば setState flush 前でも commit
  // 後のタグ列をこのハンドラ内で同期的に読める (auto-save の gate に使う, spec-edit-autosave.md §5.2)。
  onBlur?: () => void;
};

// chip 形式の複数タグ入力。確定キーや Tab 補完の挙動は下の onKeyDown を参照。
// forwardRef で chip-input の <input> を SampleModal → ModalShell に渡すのは、
// openSource === "edit" 時にここへ focus させるため (無いと × ボタンや閉じるアイコンに当たる)。
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
      // draft の case-insensitive prefix で knownTags を絞り、候補 1 件なら Tab で確定。
      // Shift+Tab / draft 空 / マッチ 0 or 複数件のときは通常の Tab 移動を維持。
      // commit() が raw.trim() するのに合わせクエリも trim する。
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
          // 順序が重要: commit(draft) が先に onChange を同期呼び出しし、onBlur (auto-save)
          // が commit 後のタグを読む。逆順だと直前 draft が auto-save で失われる。
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
