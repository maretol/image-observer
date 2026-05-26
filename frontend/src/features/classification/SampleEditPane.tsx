import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { classification } from "../../../wailsjs/go/models";
import { extractTags, serializeTags } from "./filters";
import { computeEditDirty } from "./sampleEditDirty";
import { TagInput } from "./TagInput";

const CONF_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "none" },
  { value: "high", label: "high" },
  { value: "mid", label: "mid" },
  { value: "low", label: "low" },
];

export type SampleEditPaneProps = {
  // null while no entry is active (e.g. preview closed). The pane renders
  // a disabled placeholder so layout stays stable in the unified modal.
  entry: classification.Entry | null;
  knownTags: string[];
  // Tag <input> ref bubbled up so SampleModal can pass it to ModalShell as
  // initialFocusRef for openSource === "edit" (ModalShell otherwise focuses
  // the first focusable element, which would be a chip × button or the
  // modal close icon — bypassing the tag input even with autoFocus set).
  tagInputRef?: RefObject<HTMLInputElement | null>;
  onSave: (next: classification.Entry) => void;
  // Bubble dirty up so the parent (SampleModal) can disable prev/next
  // navigation while there are unsaved edits (spec §5.4).
  onDirtyChange?: (dirty: boolean) => void;
};

export function SampleEditPane({
  entry,
  knownTags,
  tagInputRef,
  onSave,
  onDirtyChange,
}: SampleEditPaneProps) {
  const [tags, setTags] = useState<string[]>(() =>
    entry ? extractTags(entry.folder) : [],
  );
  const [confidence, setConfidence] = useState<string>(entry?.confidence ?? "");
  const [note, setNote] = useState<string>(entry?.note ?? "");

  // Reset local form whenever the active entry changes (filename swap or
  // post-save baseline update via the parent re-supplying entry). Identity-
  // comparing by filename keeps tag/note typing from being reset by the
  // useLayoutEffect-driven referential churn upstream.
  const lastBaselineRef = useRef<{
    filename: string | null;
    folder: string;
    confidence: string;
    note: string;
  }>({ filename: null, folder: "", confidence: "", note: "" });

  useEffect(() => {
    if (!entry) {
      lastBaselineRef.current = {
        filename: null,
        folder: "",
        confidence: "",
        note: "",
      };
      setTags([]);
      setConfidence("");
      setNote("");
      return;
    }
    const last = lastBaselineRef.current;
    const baselineChanged =
      last.filename !== entry.filename ||
      last.folder !== entry.folder ||
      last.confidence !== entry.confidence ||
      last.note !== entry.note;
    if (baselineChanged) {
      lastBaselineRef.current = {
        filename: entry.filename,
        folder: entry.folder,
        confidence: entry.confidence,
        note: entry.note,
      };
      setTags(extractTags(entry.folder));
      setConfidence(entry.confidence);
      setNote(entry.note);
    }
  }, [entry]);

  // Derive dirty against the latest baseline. The pure helper round-trips
  // both sides through serializeTags(extractTags(...)) to absorb cosmetic
  // format differences only — legacy "alice,bob" (no space after comma) or
  // parens form "head (a + b)" baselines compare clean against the
  // canonical "alice, bob" save format, and duplicate-tag inputs are
  // de-duplicated before compare. Tag order itself is *not* normalized
  // (serializeTags does not sort), so a user-driven reorder still flips
  // dirty on. See sampleEditDirty.test.ts.
  const dirty = useMemo(
    () => computeEditDirty(entry, tags, confidence, note),
    [entry, tags, confidence, note],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const handleSave = useCallback(() => {
    // Gate on dirty so the Cmd/Ctrl+Enter shortcut matches the save
    // button's disabled state — without this, the shortcut would fire
    // saveEdit (and the editing.open=true → false → true blip from
    // ClassificationView.handleSave) even when there is nothing to save.
    if (!entry || !dirty) return;
    onSave(
      classification.Entry.createFrom({
        filename: entry.filename,
        folder: serializeTags(tags),
        confidence,
        note,
      }),
    );
  }, [entry, dirty, tags, confidence, note, onSave]);

  // Cmd/Ctrl+Enter to save. Bound at window so the shortcut works while
  // focus is in any of the pane's inputs (tag chip-input / note textarea /
  // confidence radios) without each one needing its own onKeyDown — the
  // listener early-returns when there is no active entry or no dirty
  // changes, so it is effectively scoped to "the unified modal with
  // unsaved edits". Esc is intentionally NOT handled here — ModalShell
  // catches Esc to close the unified modal (spec §5.3: close discards
  // unsaved with no confirm).
  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, handleSave]);

  const handleCancel = useCallback(() => {
    if (!entry) return;
    setTags(extractTags(entry.folder));
    setConfidence(entry.confidence);
    setNote(entry.note);
  }, [entry]);

  if (!entry) {
    return (
      <div className="sample-edit-pane sample-edit-pane-empty" aria-hidden="true" />
    );
  }

  return (
    <div className="sample-edit-pane" role="group" aria-label="編集">
      <div className="cls-edit-row">
        <label className="cls-edit-label">タグ</label>
        <TagInput
          ref={tagInputRef}
          tags={tags}
          knownTags={knownTags}
          onChange={setTags}
          ariaLabel="タグ"
        />
      </div>
      <div className="cls-edit-row">
        <label className="cls-edit-label">confidence</label>
        <div className="cls-edit-radios">
          {CONF_OPTIONS.map((opt) => (
            <label key={opt.value} className="cls-edit-radio">
              <input
                type="radio"
                name="cls-edit-confidence"
                value={opt.value}
                checked={confidence === opt.value}
                onChange={() => setConfidence(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
      <div className="cls-edit-row sample-edit-pane-note-row">
        <label className="cls-edit-label" htmlFor="sample-edit-pane-note">
          note
        </label>
        <textarea
          id="sample-edit-pane-note"
          className="cls-edit-textarea sample-edit-pane-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="sample-edit-pane-buttons">
        <button
          type="button"
          className="confirm-dialog-btn"
          onClick={handleCancel}
          disabled={!dirty}
          title={dirty ? "編集をキャンセルして元に戻す" : "変更なし"}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="confirm-dialog-btn confirm-dialog-btn-ok"
          onClick={handleSave}
          disabled={!dirty}
          title={dirty ? "編集を保存 (Cmd/Ctrl+Enter)" : "変更なし"}
        >
          保存
        </button>
      </div>
    </div>
  );
}
