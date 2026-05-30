import { useCallback, useRef } from "react";

// Snapshot is the committed form payload an auto-save targets. Extracted from
// SampleEditPane (#110 B) together with the in-flight serialization queue so
// the queue's stale-closure / double-save races (which took PR #109 several
// rounds) can be pinned with renderHook instead of relying solely on review.
export type Snapshot = {
  filename: string;
  tags: string[];
  confidence: string;
  note: string;
};

// Snapshot equality used by runSave to short-circuit redundant queue entries
// when the same content is already in-flight or queued. Without this, a × /
// backdrop click whose first effect is the input's blur (which fires the
// in-flight save) followed by the unmount cleanup would re-queue the same
// snapshot and double-save the user's edits on flush — wasting an IPC and
// bumping mtime / waking the watcher for no gain (PR #109 round 3).
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.filename !== b.filename) return false;
  if (a.confidence !== b.confidence) return false;
  if (a.note !== b.note) return false;
  if (a.tags.length !== b.tags.length) return false;
  for (let i = 0; i < a.tags.length; i++) {
    if (a.tags[i] !== b.tags[i]) return false;
  }
  return true;
}

// Default macrotask scheduler for the dequeue. Module-scoped so the hook's
// runSave stays referentially stable (a per-render arrow would churn the
// useCallback deps and break the recursive self-call). Tests inject a manual
// scheduler to flush the dequeue deterministically without real timers.
const defaultScheduleDequeue = (cb: () => void): void => {
  setTimeout(cb, 0);
};

export type UseAutoSaveQueueArgs = {
  // The actual save. SampleEditPane passes a stable wrapper that reads
  // onSaveRef.current(buildEntry(snap)) at call time, so the recursive dequeue
  // below picks up the *latest* handleSave (and the saveEdit it closes over,
  // and that saveEdit's latest loadResult.mtime). Capturing onSave statically
  // would freeze the mtime and the queued second save would always send a
  // stale mtime → CONFLICT from Go's expectedMtime check (PR #109 round 1/2).
  save: (snap: Snapshot) => void | Promise<void>;
  // Macrotask scheduler for the dequeue (default setTimeout(…, 0)). Injectable
  // so tests can flush the replay step deterministically.
  scheduleDequeue?: (cb: () => void) => void;
};

export type UseAutoSaveQueueReturn = {
  // Enqueue a save. At most one runs at a time; while one is in flight the
  // latest *distinct* snapshot is held in a 1-slot queue and replayed on
  // completion (3 rapid blurs ⇒ at most 2 IPCs: in-flight + queued).
  runSave: (snap: Snapshot) => void;
  // Drop the queued snapshot — call when the active entry switches so a stale
  // snapshot cannot land on a new entry. The in-flight save is intentionally
  // left to complete; useClassificationEdit.saveEdit's folder check gates its
  // state commit against the OLD folder.
  resetQueue: () => void;
};

// useAutoSaveQueue owns the in-flight save serialization (#105 §5.3, extracted
// in #110 B). A blur on tag immediately followed by a blur on note (or a radio
// change) would otherwise stack two saves at the same loadResult.mtime, and the
// second IPC would land as CONFLICT until reload. We allow at most one
// in-flight; subsequent triggers overwrite a 1-slot queue with the latest
// snapshot and replay on completion.
export function useAutoSaveQueue({
  save,
  scheduleDequeue = defaultScheduleDequeue,
}: UseAutoSaveQueueArgs): UseAutoSaveQueueReturn {
  const saveInFlightRef = useRef(false);
  const inFlightSnapshotRef = useRef<Snapshot | null>(null);
  const queuedSnapshotRef = useRef<Snapshot | null>(null);

  const runSave = useCallback(
    (snap: Snapshot) => {
      if (saveInFlightRef.current) {
        // Skip if the same content is already in flight: the existing IPC
        // covers this exact state, queuing a duplicate would just re-fire the
        // same write on flush (PR #109 round 3).
        if (
          inFlightSnapshotRef.current &&
          snapshotsEqual(snap, inFlightSnapshotRef.current)
        ) {
          return;
        }
        // Skip if the queued slot already holds the same snapshot —
        // overwriting with an identical value is a no-op but keeps the
        // queue-handling logic symmetric with the in-flight check.
        if (
          queuedSnapshotRef.current &&
          snapshotsEqual(snap, queuedSnapshotRef.current)
        ) {
          return;
        }
        queuedSnapshotRef.current = snap;
        return;
      }
      saveInFlightRef.current = true;
      inFlightSnapshotRef.current = snap;
      Promise.resolve(save(snap)).finally(() => {
        saveInFlightRef.current = false;
        inFlightSnapshotRef.current = null;
        if (!queuedSnapshotRef.current) return;
        // Defer the dequeue to a macrotask so React first commits any setState
        // side-effects of the in-flight save (parent setLoadResult → new mtime
        // → the save wrapper reads the latest saveEdit). Without this hop, the
        // recursive runSave would still see the pre-commit onSave and race the
        // same mtime conflict we just solved upstream (PR #109 round 1).
        scheduleDequeue(() => {
          const next = queuedSnapshotRef.current;
          if (!next) return;
          queuedSnapshotRef.current = null;
          runSave(next);
        });
      });
    },
    [save, scheduleDequeue],
  );

  const resetQueue = useCallback(() => {
    queuedSnapshotRef.current = null;
  }, []);

  return { runSave, resetQueue };
}
