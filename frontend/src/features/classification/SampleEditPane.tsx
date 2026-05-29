import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { classification } from "../../../wailsjs/go/models";
import { shouldAutoSave } from "./autoSaveTrigger";
import { extractTags, serializeTags } from "./filters";
import { computeEditDirty } from "./sampleEditDirty";
import { TagInput } from "./TagInput";

const CONF_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "none" },
  { value: "high", label: "high" },
  { value: "mid", label: "mid" },
  { value: "low", label: "low" },
];

// <label htmlFor> targets the chip-input <input> inside TagInput. The pane is
// always single-instance in the unified modal, so a stable global id is fine.
const TAG_INPUT_ID = "sample-edit-pane-tags";

// id of the confidence heading <div>. Referenced from the radio group's
// aria-labelledby so SR users hear "confidence" when entering the group
// (the heading is not a <label htmlFor> because the radios are wrapped by
// per-option <label>s — a single htmlFor cannot point at all of them).
const CONF_GROUP_LABEL_ID = "sample-edit-pane-confidence-label";

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
  // Returning a Promise lets the pane serialize in-flight saves so a rapid
  // tag-blur → note-blur chain does not stack two IPC calls with the same
  // stale loadResult.mtime (spec-edit-autosave.md §5.3). Manual-mode callers
  // may still return void; the pane wraps via Promise.resolve.
  onSave: (next: classification.Entry) => void | Promise<void>;
  // Bubble dirty up so the parent (SampleModal) can disable prev/next
  // navigation while there are unsaved edits (spec §5.4).
  onDirtyChange?: (dirty: boolean) => void;
  // #105: when true, individual input blur / radio change auto-save the
  // entry; the save & cancel buttons are hidden because there is nothing
  // explicit to do. Manual mode (false) is the pre-#105 behavior.
  autoSave: boolean;
};

export function SampleEditPane({
  entry,
  knownTags,
  tagInputRef,
  onSave,
  onDirtyChange,
  autoSave,
}: SampleEditPaneProps) {
  const [tags, setTags] = useState<string[]>(() =>
    entry ? extractTags(entry.folder) : [],
  );
  const [confidence, setConfidence] = useState<string>(entry?.confidence ?? "");
  const [note, setNote] = useState<string>(entry?.note ?? "");

  // Auto-save (§5.2): mirror local state into refs so the synchronous
  // TagInput.onBlur callback can read post-commit tags without waiting for
  // React's setState to flush. The other two fields mirror for symmetry
  // (radio change reads its own new value out-of-band, but note blur uses
  // noteRef for the same reason — onBlur fires synchronously after the
  // event-driven setNote schedules a re-render).
  const tagsRef = useRef<string[]>(tags);
  const confidenceRef = useRef<string>(confidence);
  const noteRef = useRef<string>(note);

  // Reset local form whenever the *baseline* the entry exposes changes —
  // baseline = (filename, folder, confidence, note). Storing the previous
  // baseline in `lastBaselineRef` and reset-on-mismatch absorbs the
  // referential churn from watcher-driven `loadResult` updates (a new
  // `Entry` object whose fields are unchanged) so in-pane typing isn't
  // clobbered. Any of (filename swap via prev/next, post-save baseline
  // refresh, external sidecar edit, entry → null) flips at least one
  // baseline field and triggers reset.
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
      tagsRef.current = [];
      setConfidence("");
      confidenceRef.current = "";
      setNote("");
      noteRef.current = "";
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
      const nextTags = extractTags(entry.folder);
      setTags(nextTags);
      tagsRef.current = nextTags;
      setConfidence(entry.confidence);
      confidenceRef.current = entry.confidence;
      setNote(entry.note);
      noteRef.current = entry.note;
    }
  }, [entry]);

  // Derive dirty against the latest baseline. The pure helper passes the
  // entry side through serializeTags(extractTags(entry.folder)) and the
  // local tags side through serializeTags(tags) only — so legacy
  // "alice,bob" (no space after comma) or parens form "head (a + b)"
  // baselines round-trip to the canonical "alice, bob" save format and
  // do not show up as dirty on open. The local side intentionally skips
  // extractTags (TagInput.commit already rejects duplicates on input, so
  // the state never holds them) and does not sort, so a user-driven
  // reorder still flips dirty on. See sampleEditDirty.test.ts.
  const dirty = useMemo(
    () => computeEditDirty(entry, tags, confidence, note),
    [entry, tags, confidence, note],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // In-flight save serialization (§5.3). A blur on tag immediately followed
  // by a blur on note (or radio change) would stack two saves at the same
  // loadResult.mtime, and the second IPC would land as a CONFLICT: response
  // until reload. We allow at most one in-flight; subsequent triggers
  // overwrite a 1-slot queue with the latest snapshot and replay on
  // completion. The queue is reset when the active entry switches (prev/
  // next jumps, modal close) so stale snapshots cannot land on a new entry.
  type Snapshot = {
    filename: string;
    tags: string[];
    confidence: string;
    note: string;
  };
  const saveInFlightRef = useRef(false);
  const queuedSnapshotRef = useRef<Snapshot | null>(null);

  useEffect(() => {
    // Discard any queued snapshot whenever the active entry (or its absence)
    // changes — replaying an old filename's snapshot against a new entry
    // would clobber the wrong record.
    queuedSnapshotRef.current = null;
  }, [entry?.filename]);

  const buildEntry = useCallback((snap: Snapshot): classification.Entry => {
    return classification.Entry.createFrom({
      filename: snap.filename,
      folder: serializeTags(snap.tags),
      confidence: snap.confidence,
      note: snap.note,
    });
  }, []);

  const runSave = useCallback(
    (snap: Snapshot) => {
      if (saveInFlightRef.current) {
        queuedSnapshotRef.current = snap;
        return;
      }
      saveInFlightRef.current = true;
      Promise.resolve(onSave(buildEntry(snap))).finally(() => {
        saveInFlightRef.current = false;
        const next = queuedSnapshotRef.current;
        if (next) {
          queuedSnapshotRef.current = null;
          runSave(next);
        }
      });
    },
    [buildEntry, onSave],
  );

  // performAutoSave is the gate for #105 blur / radio handlers. It reads
  // the freshest field values from refs (post-commit tags, just-set radio
  // value passed as an override) so it's race-free against React's batched
  // setState. The caller passes the field that triggered the auto-save as
  // an explicit override; the other two come from refs.
  const performAutoSave = useCallback(
    (overrides: Partial<Omit<Snapshot, "filename">>) => {
      if (!entry) return;
      const snap: Snapshot = {
        filename: entry.filename,
        tags: overrides.tags ?? tagsRef.current,
        confidence: overrides.confidence ?? confidenceRef.current,
        note: overrides.note ?? noteRef.current,
      };
      // Re-run dirty against the merged snapshot, not the stale `dirty`
      // memo (which is one render behind for radio change). Skips burning
      // IPC on refocus-without-change.
      const isDirty = computeEditDirty(
        entry,
        snap.tags,
        snap.confidence,
        snap.note,
      );
      if (!shouldAutoSave(autoSave, entry, isDirty)) return;
      runSave(snap);
    },
    [autoSave, entry, runSave],
  );

  const handleTagsChange = useCallback((next: string[]) => {
    tagsRef.current = next;
    setTags(next);
  }, []);

  const handleNoteChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      noteRef.current = v;
      setNote(v);
    },
    [],
  );

  const handleConfidenceChange = useCallback(
    (value: string) => {
      confidenceRef.current = value;
      setConfidence(value);
      // Radio has no blur — auto-save fires on the change itself. Pass the
      // new value explicitly because confidenceRef has just been written
      // but the snapshot read inside performAutoSave needs to see it.
      performAutoSave({ confidence: value });
    },
    [performAutoSave],
  );

  const handleTagInputBlur = useCallback(() => {
    // TagInput.commit ran first (chip-input onBlur ordering), so tagsRef
    // already holds the post-commit list. performAutoSave reads it.
    performAutoSave({ tags: tagsRef.current });
  }, [performAutoSave]);

  // Save-on-unmount (#105 §5.6). Auto-save mode treats modal close (Esc /
  // backdrop, where no field-level blur fires before the input unmounts)
  // as an implicit blur. Without this, a user who types into the note
  // textarea and presses Esc loses the edit silently. The cleanup also
  // runs when the active entry changes (prev/next jump), but the nav-block
  // invariant (#93 §5.4) guarantees dirty=false at nav time, so that path
  // is a no-op in practice. If a save is already in-flight, runSave's
  // 1-slot queue catches the cleanup snapshot — possibly redundant if
  // nothing was typed after the triggering blur, but always correct.
  useEffect(() => {
    return () => {
      if (!autoSave || !entry) return;
      if (
        !computeEditDirty(
          entry,
          tagsRef.current,
          confidenceRef.current,
          noteRef.current,
        )
      ) {
        return;
      }
      runSave({
        filename: entry.filename,
        tags: tagsRef.current,
        confidence: confidenceRef.current,
        note: noteRef.current,
      });
    };
  }, [autoSave, entry, runSave]);

  const handleNoteBlur = useCallback(() => {
    performAutoSave({ note: noteRef.current });
  }, [performAutoSave]);

  const handleSave = useCallback(() => {
    // Gate on dirty so the Cmd/Ctrl+Enter shortcut matches the save
    // button's disabled state — without this, the shortcut would fire
    // saveEdit (and the editing.open=true → false → true blip from
    // ClassificationView.handleSave) even when there is nothing to save.
    if (!entry || !dirty) return;
    runSave({
      filename: entry.filename,
      tags: tagsRef.current,
      confidence: confidenceRef.current,
      note: noteRef.current,
    });
  }, [entry, dirty, runSave]);

  // Cmd/Ctrl+Enter to save. Bound at window so the shortcut works while
  // focus is in any of the pane's inputs (tag chip-input / note textarea /
  // confidence radios) without each one needing its own onKeyDown. Gated
  // on `entry && dirty` *before* preventDefault so non-dirty Ctrl+Enter
  // falls through to the platform default (e.g. textarea newline) instead
  // of being silently swallowed — matches the save button's disabled
  // state. Esc is intentionally NOT handled here — ModalShell catches Esc
  // to close the unified modal (spec §5.3: close discards unsaved with no
  // confirm). The shortcut is left active in auto mode too so users who
  // built muscle memory in the old behavior still hit a save (idempotent
  // when nothing is dirty).
  useEffect(() => {
    if (!entry || !dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, dirty, handleSave]);

  const handleCancel = useCallback(() => {
    if (!entry) return;
    const baselineTags = extractTags(entry.folder);
    setTags(baselineTags);
    tagsRef.current = baselineTags;
    setConfidence(entry.confidence);
    confidenceRef.current = entry.confidence;
    setNote(entry.note);
    noteRef.current = entry.note;
  }, [entry]);

  if (!entry) {
    return (
      <div className="sample-edit-pane sample-edit-pane-empty" aria-hidden="true" />
    );
  }

  return (
    <div className="sample-edit-pane" role="group" aria-label="編集">
      <div className="cls-edit-row">
        <label className="cls-edit-label" htmlFor={TAG_INPUT_ID}>
          タグ
        </label>
        <TagInput
          ref={tagInputRef}
          tags={tags}
          knownTags={knownTags}
          onChange={handleTagsChange}
          onBlur={handleTagInputBlur}
          inputId={TAG_INPUT_ID}
          ariaLabel="タグ"
        />
      </div>
      <div className="cls-edit-row">
        <div id={CONF_GROUP_LABEL_ID} className="cls-edit-label">
          confidence
        </div>
        <div
          className="cls-edit-radios"
          role="radiogroup"
          aria-labelledby={CONF_GROUP_LABEL_ID}
        >
          {CONF_OPTIONS.map((opt) => (
            <label key={opt.value} className="cls-edit-radio">
              <input
                type="radio"
                name="cls-edit-confidence"
                value={opt.value}
                checked={confidence === opt.value}
                onChange={() => handleConfidenceChange(opt.value)}
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
          onChange={handleNoteChange}
          onBlur={handleNoteBlur}
        />
      </div>
      {autoSave ? null : (
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
      )}
    </div>
  );
}
