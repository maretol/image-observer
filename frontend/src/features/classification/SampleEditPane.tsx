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
import {
  baselineOf,
  computeBaselineSync,
  EMPTY_BASELINE,
  type Baseline,
  type Touched,
} from "./sampleEditBaselineSync";
import { computeEditDirty } from "./sampleEditDirty";
import { useAutoSaveQueue, type Snapshot } from "./useAutoSaveQueue";
import type { SaveContext } from "./useClassificationEdit";
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
  // Current folder (#110 C). Render-synced into folderPropRef and read by the
  // save wrapper at dispatch time so each save carries SaveContext.folder = the
  // folder the edit belongs to. A folder switch unmounts the pane (so this prop
  // stops updating, staying OLD), which is exactly what lets a save-on-unmount
  // cleanup stamp the OLD folder and have saveEdit skip it (spec §6.2 / §4.2).
  folder: string;
  // Returning a Promise lets the pane serialize in-flight saves so a rapid
  // tag-blur → note-blur chain does not stack two IPC calls with the same
  // stale loadResult.mtime (spec-edit-autosave.md §5.3). ctx carries the folder
  // the save was captured for (#110 C). Manual-mode callers may still return
  // void; the pane wraps via Promise.resolve.
  onSave: (
    next: classification.Entry,
    ctx: SaveContext,
  ) => void | Promise<void>;
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
  folder,
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

  // Prop refs synced at render time (AGENTS.md H-8 "state ref の同期タイミング").
  // The in-flight queue's finally callback (§5.3) and the save-on-unmount
  // cleanup (§5.6) both fire *outside* the React render that triggered them,
  // so reading these props from useEffect-bound dependencies would let the
  // queue's recursive dequeue and the unmount cleanup hold a *stale* onSave
  // (= old `saveEdit` closure → old `loadResult.mtime` → CONFLICT on the
  // second IPC). Mirroring at render time guarantees that by the time these
  // callbacks fire, refs already reflect the latest props.
  const onSaveRef = useRef(onSave);
  const autoSaveRef = useRef(autoSave);
  const entryRef = useRef(entry);
  // folderPropRef (#110 C): the save wrapper reads this at dispatch time to
  // stamp SaveContext.folder. Synced at render time like the others — a folder
  // switch unmounts the pane, so this ref stops updating and stays on the OLD
  // folder, which is what makes a stale cleanup save carry the OLD folder.
  const folderPropRef = useRef(folder);
  onSaveRef.current = onSave;
  autoSaveRef.current = autoSave;
  entryRef.current = entry;
  folderPropRef.current = folder;

  // Reset local form whenever the *baseline* the entry exposes changes —
  // baseline = (filename, folder, confidence, note). Storing the previous
  // baseline in `lastBaselineRef` and reset-on-mismatch absorbs the
  // referential churn from watcher-driven `loadResult` updates (a new
  // `Entry` object whose fields are unchanged) so in-pane typing isn't
  // clobbered. Any of (filename swap via prev/next, post-save baseline
  // refresh, external sidecar edit, entry → null) flips at least one
  // baseline field and triggers reset.
  const lastBaselineRef = useRef<Baseline>(EMPTY_BASELINE);

  // Per-field "touched since last baseline observation" flags. Set true in
  // the input handlers; cleared in the baseline reset useEffect (both
  // branches). Read by the per-field sync to suppress overwriting a field
  // the user touched during an in-flight save, even if their final value
  // happens to equal the *previous* baseline (Copilot review #109 round 5).
  // Example: tags=[] in baseline, user types "abc" and blurs → save IPC
  // in-flight → user clears tags back to [] before the save returns → save
  // success arrives with entry.folder="abc" → without touched tracking the
  // equality check (local [] == old baseline []) would resync local to
  // ["abc"], silently discarding the user's revert. The flag distinguishes
  // "never touched" from "touched then reverted".
  const touchedAfterBaselineRef = useRef<Touched>({
    tags: false,
    confidence: false,
    note: false,
  });

  useEffect(() => {
    if (!entry) {
      lastBaselineRef.current = EMPTY_BASELINE;
      setTags([]);
      tagsRef.current = [];
      setConfidence("");
      confidenceRef.current = "";
      setNote("");
      noteRef.current = "";
      touchedAfterBaselineRef.current = {
        tags: false,
        confidence: false,
        note: false,
      };
      return;
    }
    // entry present: resetAll (different filename = prev/next nav to another
    // entry) vs per-field sync (same entry, baseline patched by a partial
    // auto-save success or external sidecar edit). computeBaselineSync encodes
    // the round 2 (partial save must not clobber an untouched field that
    // genuinely differs) and round 5 (touched-then-reverted stays local) rules.
    const action = computeBaselineSync(
      lastBaselineRef.current,
      entry,
      {
        tags: tagsRef.current,
        confidence: confidenceRef.current,
        note: noteRef.current,
      },
      touchedAfterBaselineRef.current,
    );
    if (action.kind === "resetAll" || action.syncTags) {
      const nextTags = extractTags(entry.folder);
      setTags(nextTags);
      tagsRef.current = nextTags;
    }
    if (action.kind === "resetAll" || action.syncConfidence) {
      setConfidence(entry.confidence);
      confidenceRef.current = entry.confidence;
    }
    if (action.kind === "resetAll" || action.syncNote) {
      setNote(entry.note);
      noteRef.current = entry.note;
    }
    // Always advance the baseline pointer (even for fields kept local) so the
    // next diff is against the latest entry, and reset touched — the touched
    // window is scoped between two consecutive baseline observations.
    lastBaselineRef.current = baselineOf(entry);
    touchedAfterBaselineRef.current = {
      tags: false,
      confidence: false,
      note: false,
    };
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

  // In-flight save serialization (§5.3) lives in useAutoSaveQueue (#110 B).
  // buildEntry below stays here because it shapes the Entry payload; the queue
  // only ever sees opaque Snapshots.
  const buildEntry = useCallback((snap: Snapshot): classification.Entry => {
    return classification.Entry.createFrom({
      filename: snap.filename,
      folder: serializeTags(snap.tags),
      confidence: snap.confidence,
      note: snap.note,
    });
  }, []);

  // save wrapper passed to useAutoSaveQueue. Read onSave through the ref at
  // call time (render-time synced above) so the queue's recursive dequeue
  // picks up the *latest* handleSave — and the saveEdit it closes over, and
  // that saveEdit's latest loadResult.mtime. Capturing onSave statically would
  // freeze the mtime and the queued second save would always send a stale
  // mtime → CONFLICT from Go's expectedMtime check (PR #109 round 1/2).
  const save = useCallback(
    (snap: Snapshot) =>
      Promise.resolve(
        onSaveRef.current(buildEntry(snap), { folder: folderPropRef.current }),
      ),
    [buildEntry],
  );

  const { runSave, resetQueue } = useAutoSaveQueue({ save });

  useEffect(() => {
    // Discard any queued snapshot whenever the active entry (or its absence)
    // changes — replaying an old filename's snapshot against a new entry would
    // clobber the wrong record. The in-flight save itself is for the OLD
    // filename and is allowed to complete on the OLD folder (saveEdit's
    // folderRef check inside useClassificationEdit gates the state commit).
    resetQueue();
  }, [entry?.filename, resetQueue]);

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
    touchedAfterBaselineRef.current.tags = true;
    setTags(next);
  }, []);

  const handleNoteChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      noteRef.current = v;
      touchedAfterBaselineRef.current.note = true;
      setNote(v);
    },
    [],
  );

  const handleConfidenceChange = useCallback(
    (value: string) => {
      confidenceRef.current = value;
      touchedAfterBaselineRef.current.confidence = true;
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
  // as an implicit blur for any field that hadn't been blurred before
  // close. The cleanup intentionally fires *only at unmount* (deps left
  // empty + refs read at fire time): an earlier `[autoSave, entry, runSave]`
  // dependency set would also fire on every `entry` reference change — and
  // a successful save creates a new entry object via setLoadResult, so the
  // cleanup would replay against the stale-closure baseline and double-save
  // the user's edits (Copilot review thread #3). Refs read at fire time
  // give us the latest entry / autoSave; the dirty check is against the
  // latest baseline so a just-saved entry sees refs == baseline → false →
  // no spurious save. runSave (from useAutoSaveQueue) closes over the queue's
  // refs — created per pane instance — so it stays callable after unmount and
  // the cleanup save still drains (parent ClassificationView stays mounted).
  // The eslint hook-deps rule would push autoSave / entry / runSave back
  // into deps; the empty-deps shape is intentional and a lint suppression
  // would be appropriate if a linter were configured.
  useEffect(() => {
    return () => {
      if (!autoSaveRef.current) return;
      const cur = entryRef.current;
      if (!cur) return;
      if (
        !computeEditDirty(
          cur,
          tagsRef.current,
          confidenceRef.current,
          noteRef.current,
        )
      ) {
        return;
      }
      runSave({
        filename: cur.filename,
        tags: tagsRef.current,
        confidence: confidenceRef.current,
        note: noteRef.current,
      });
    };
    // Deps intentionally empty: see comment above. autoSave / entry / runSave
    // are accessed via refs synced at render time so the cleanup always reads
    // the latest values without re-firing on each prop churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Local now equals baseline — clear touched flags so a subsequent
    // external baseline patch can re-sync (otherwise the touched-from-
    // before-cancel flag would suppress the next per-field sync).
    touchedAfterBaselineRef.current = {
      tags: false,
      confidence: false,
      note: false,
    };
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
