import { useCallback, useEffect, useRef } from "react";
import {
  LoadClassification,
  StartFolderWatch,
  StopFolderWatch,
} from "../../../wailsjs/go/main/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { WATCH_MODE_AUTO, WATCH_MODE_OFF } from "../settings/watchMode";
import type {
  ConflictPrompt,
  EditingState,
  PendingResult,
} from "./useClassification";
import { entriesEquivalent } from "./entriesEquivalent";
import {
  decideAutoMerge,
  formatChangeSummary,
  type ChangedPayload,
} from "./watcherPolicy";

// CLASSIFICATION_CHANGED_EVENT mirrors the Go-side
// `watcher.ClassificationChangedEvent`. There is no auto-generated TS
// namespace for the watcher package (Wails only emits TS for types that
// appear in binding signatures, and EventsEmit payloads do not), so the
// string literal is duplicated. A vitest assertion in
// `watcherPolicy.test.ts` pins this constant to the same literal as the
// Go-side test (`internal/watcher.TestClassificationChangedEventName`);
// renaming one without the other trips CI (AGENTS.md D-1).
export const CLASSIFICATION_CHANGED_EVENT = "classification:changed";

type Props = {
  // folderPath / watchMode are passed as values (not refs) so the watch
  // dispatch effect can react to changes. The body reads refs to avoid
  // capturing stale closure state — see dispatchWatchIntentRef below.
  folderPath: string;
  watchMode?: string;

  // shared refs (read & write)
  folderRef: React.MutableRefObject<string>;
  watchModeRef: React.MutableRefObject<string | undefined>;
  requestGenRef: React.MutableRefObject<number>;
  initialLoadInFlightRef: React.MutableRefObject<boolean>;
  loadResultRef: React.MutableRefObject<classification.LoadResult | null>;
  inFlightDeletesRef: React.MutableRefObject<Map<string, Set<string>>>;
  editingRef: React.MutableRefObject<EditingState>;
  conflictRef: React.MutableRefObject<ConflictPrompt | null>;
  mergePromptOpenRef: React.MutableRefObject<boolean>;
  pendingResultRef: React.MutableRefObject<PendingResult | null>;
  dispatchWatchIntentRef: React.MutableRefObject<() => void>;

  // setters
  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setError: (msg: string | null) => void;
  setEditing: React.Dispatch<React.SetStateAction<EditingState>>;

  // collaborators
  commitFreshResult: (
    fresh: classification.LoadResult,
    fnames: ReadonlySet<string>,
  ) => void;
  resetEntriesDependentState: () => void;
  toast: ToastFn;
};

// useClassificationWatcher owns the fsnotify auto-merge path (#19): the
// watcher-event handler, the post-Start silent recheck, the Start/Stop IPC
// dispatcher, and the two effects that drive them. See AGENTS.md §H-8 and
// docs/spec-folder-watch.md for the full race-variable matrix; the inline
// guards in this file are load-bearing copies of those rules. Do not
// remove a guard without checking the corresponding entry in §H-8.
export function useClassificationWatcher(props: Props): void {
  const {
    folderPath,
    watchMode,
    folderRef,
    watchModeRef,
    requestGenRef,
    initialLoadInFlightRef,
    loadResultRef,
    inFlightDeletesRef,
    editingRef,
    conflictRef,
    mergePromptOpenRef,
    pendingResultRef,
    dispatchWatchIntentRef,
    setLoadResult,
    setError,
    setEditing,
    commitFreshResult,
    resetEntriesDependentState,
    toast,
  } = props;

  // ─── fsnotify auto-merge (#19) ─────────────────────────────────────
  //
  // handleWatcherPayload runs on every flushed "classification:changed"
  // event from the Go watcher (see internal/watcher + docs/spec-folder-watch.md).
  // It reads decision-relevant state via refs so its identity can change on
  // each render without us needing to re-bind the EventsOn listener (see
  // the mount-once subscription effect below + handlerRef indirection).
  const handleWatcherPayload = useCallback(
    async (payload: ChangedPayload) => {
      if (watchModeRef.current === WATCH_MODE_OFF) {
        // The user disabled monitoring; StopFolderWatch() can't recall
        // events that were already dispatched into JS land. Drop them at
        // the handler boundary so a payload in flight at the moment of
        // off-switch doesn't auto-merge after the user opted out
        // (PR #75 review thread#3).
        return;
      }
      if (payload.folder !== folderRef.current) {
        // Stale residual from a watcher that hadn't been torn down yet, or
        // the user switched folders mid-flush. Drop quietly.
        return;
      }
      const myGen = ++requestGenRef.current;

      let fresh: classification.LoadResult | null = null;
      try {
        fresh = await LoadClassification(folderRef.current);
      } catch (e) {
        // Suppress this catch if the failure belongs to a stale request
        // (newer payload already in flight, or folder switched out from
        // under us). Without these guards a slow-failing older Load could
        // wipe a successfully-displayed newer result (PR #75 review).
        if (myGen !== requestGenRef.current) return;
        if (folderRef.current !== payload.folder) return;
        // Also re-check watchMode: the entry-gate above ran before the
        // await; if the user flipped to off while we were awaiting,
        // surfacing the failure (with toast / setError) would be acting
        // on monitoring the user opted out of (PR #75 8th, thread A).
        if (watchModeRef.current === WATCH_MODE_OFF) return;
        // Mirror the manual-reload error path so a deleted / unreadable
        // folder surfaces to the user instead of silently leaving a stale
        // grid. Also drop the on-screen result — leaving it in place
        // after a load failure invites the user to act on entries that
        // no longer exist on disk.
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // Clear entries-dependent state alongside loadResult — same rule
        // as loadInternal's catch (PR #75 13th, thread A).
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        logger.warn("classification", "auto-merge load failed", { err: msg });
        return;
      }
      // Discard the success result for the same reasons.
      if (myGen !== requestGenRef.current) return;
      if (folderRef.current !== payload.folder) return;
      // Same off-during-await guard as the catch above — the entry-gate
      // ran before LoadClassification. If watchMode flipped to off while
      // awaiting, committing the result would auto-merge after the user
      // opted out (PR #75 8th, thread A).
      if (watchModeRef.current === WATCH_MODE_OFF) return;
      // Successful Load (including silent self-echo paths) is a
      // confirmation that the folder is readable; clear any leftover
      // error from a previous failed reload so the UI doesn't keep
      // showing it after we've recovered (PR #75 review suppressed-c).
      setError(null);

      // Self-echo / no-op detection. Our own Save/Delete IPCs cause watcher
      // events too, and surfacing "外部で更新されました" for them is just
      // noise (PR #75 review thread #3, spec §5.4). When entries content
      // matches what we already display:
      //   - mtime also equal → fully silent (true no-op or self-echo)
      //   - mtime differs    → silent update so the user's next save still
      //     uses the freshest expectedMtime in the conflict check
      //
      // entriesEquivalent compares both sides AFTER filtering out
      // in-flight deletes — the local loadResult still has the entry the
      // user just asked us to delete (our setLoadResult patch happens
      // post-sidecar-save), while the fresh re-Load already lacks it. If
      // the only difference is one of those in-flight deletes, treat as
      // self-echo and skip the toast (PR #75 9th, thread J).
      const cur = loadResultRef.current;
      // Scope in-flight delete filenames to payload.folder so a stale
      // delete pending on a different folder can't suppress this folder's
      // diff (PR #75 21st, thread A). Asymmetric strip: only the stale-cur
      // side has the filename hidden, fresh is left untouched so an external
      // re-creation during the IPC window still surfaces as a diff (PR #75
      // 25th, thread D).
      const inFlightDeletes =
        inFlightDeletesRef.current.get(payload.folder) ?? null;
      const stripInFlight = (
        entries: classification.Entry[],
      ): classification.Entry[] =>
        !inFlightDeletes || inFlightDeletes.size === 0
          ? entries
          : entries.filter((e) => !inFlightDeletes.has(e.filename));
      const entriesUnchanged =
        cur != null &&
        entriesEquivalent(stripInFlight(cur.entries), fresh.entries);
      if (entriesUnchanged && cur != null && cur.mtime === fresh.mtime) {
        return;
      }
      if (entriesUnchanged) {
        setLoadResult(fresh);
        return;
      }

      // formatChangeSummary always returns a non-empty string (PR #75
      // review: counter-less anyChange payloads still warrant a generic
      // notification, see watcherPolicy.ts).
      toast(formatChangeSummary(payload), "info");

      const fnames = new Set(fresh.entries.map((e) => e.filename));
      const action = decideAutoMerge({
        editingOpen: editingRef.current.open,
        editingFilename: editingRef.current.filename,
        conflictOpen: conflictRef.current !== null,
        mergePromptOpen: mergePromptOpenRef.current,
        freshFilenames: fnames,
      });
      switch (action.kind) {
        case "defer":
          // Park the fresh result *with* its folder + current generation
          // so the deferral-close replay can discard it if the user
          // switched folders or another commit landed meanwhile
          // (PR #75 11th, suppressed-A).
          pendingResultRef.current = {
            fresh,
            folder: payload.folder,
            capturedGen: requestGenRef.current,
          };
          return;
        case "commit-editing-removed":
          toast(`${action.filename} は外部で削除されました`, "warn");
          setEditing({ open: false, filename: null });
          commitFreshResult(fresh, fnames);
          return;
        case "commit":
          commitFreshResult(fresh, fnames);
          return;
      }
    },
    [
      commitFreshResult,
      conflictRef,
      editingRef,
      folderRef,
      inFlightDeletesRef,
      loadResultRef,
      mergePromptOpenRef,
      pendingResultRef,
      requestGenRef,
      resetEntriesDependentState,
      setEditing,
      setError,
      setLoadResult,
      toast,
      watchModeRef,
    ],
  );

  // silentRecheckAfterStart bridges the gap between the initial / restore
  // LoadClassification and StartFolderWatch actually being live: files
  // dropped into the folder during that window aren't in the cached entries
  // nor the fsnotify stream. We re-Load (no loading flag flicker, no toast
  // on success / silent on diff) and route the result through the same
  // defer / mode / generation logic as a regular watcher payload so
  // editing-open et al. are still honored (PR #75 9th, thread I).
  const silentRecheckAfterStart = useCallback(
    (folder: string) => {
      // Defer while any loadInternal is awaiting. Without this we can
      // race the initial load (same generation since silent recheck only
      // snapshots, not bumps) — silent recheck commits its fresher
      // snapshot first, then the older initial-load result lands and
      // overwrites it (PR #75 12th, thread C). Waiting for the initial
      // load to complete guarantees our subsequent read is strictly
      // newer than its read (it happened-after), so even if we both
      // commit at the same gen, last-write-wins is correctness-preserving.
      // setTimeout yields to the event loop so the initial load's finally
      // (which clears the flag + commits its result) fires first.
      if (initialLoadInFlightRef.current) {
        setTimeout(() => silentRecheckAfterStart(folder), 50);
        return;
      }
      // Snapshot the current generation WITHOUT bumping (PR #75 11th,
      // thread A). Two requirements to satisfy at once:
      //   1) silent recheck must NOT supersede in-flight initial-load
      //      paths (openFolder / auto-load on mount). If we bumped, the
      //      ongoing `loadInternal` would see itself as stale and return
      //      null, and openFolder's `postLoadFlow` (sidecar-create
      //      prompt / child-sidecar merge prompt) would silently skip —
      //      a real regression triggered by the Round 10 suppressed-A
      //      fix that incorrectly bumped here.
      //   2) silent recheck must NOT roll back a newer commit that
      //      landed during our await. Snapshot + check at commit time
      //      handles this: if anything else bumps the gen while we wait,
      //      our myGen !== requestGenRef.current branches return.
      // Snapshot satisfies both.
      const myGen = requestGenRef.current;
      void LoadClassification(folder)
        .then((fresh) => {
          if (myGen !== requestGenRef.current) return;
          // Stale guards mirror handleWatcherPayload.
          if (folderRef.current !== folder) return;
          if (watchModeRef.current !== WATCH_MODE_AUTO) return;
          const cur = loadResultRef.current;
          // See handleWatcherPayload: per-folder set, so a delete still in
          // flight on a different folder can't suppress this one's diff
          // (PR #75 21st, thread A).
          // Asymmetric strip — only cur side is filtered, so an external
          // re-creation racing our delete IPC is still detected as a diff
          // (PR #75 25th, thread D; same reasoning as handleWatcherPayload).
          const inFlightDeletes =
            inFlightDeletesRef.current.get(folder) ?? null;
          const stripInFlight = (
            entries: classification.Entry[],
          ): classification.Entry[] =>
            !inFlightDeletes || inFlightDeletes.size === 0
              ? entries
              : entries.filter((e) => !inFlightDeletes.has(e.filename));
          const entriesUnchanged =
            cur != null &&
            entriesEquivalent(stripInFlight(cur.entries), fresh.entries);
          if (entriesUnchanged && cur != null && cur.mtime === fresh.mtime) {
            return;
          }
          // Reaching here means silent recheck observed a successful re-Load.
          // Clear any stale error from a prior failed initial / manual reload
          // — leaving it visible after recovery is the same UI artifact the
          // watcher handler / performReplay success paths already clear
          // (PR #75 16th, thread D).
          setError(null);
          if (entriesUnchanged) {
            setLoadResult(fresh);
            return;
          }
          // A genuine diff existed between initial Load and watcher Start.
          // No toast (silent — the user didn't ask, and it isn't strictly
          // an "external change" event), but go through decideAutoMerge so
          // an open editing popover / conflict / merge prompt parks the
          // result instead of being clobbered.
          const fnames = new Set(fresh.entries.map((e) => e.filename));
          const action = decideAutoMerge({
            editingOpen: editingRef.current.open,
            editingFilename: editingRef.current.filename,
            conflictOpen: conflictRef.current !== null,
            mergePromptOpen: mergePromptOpenRef.current,
            freshFilenames: fnames,
          });
          switch (action.kind) {
            case "defer":
              // Park with capturedGen so the replay can discard if another
              // commit lands (PR #75 11th, suppressed-A).
              pendingResultRef.current = {
                fresh,
                folder,
                capturedGen: requestGenRef.current,
              };
              return;
            case "commit-editing-removed":
              toast(`${action.filename} は外部で削除されました`, "warn");
              setEditing({ open: false, filename: null });
              commitFreshResult(fresh, fnames);
              return;
            case "commit":
              commitFreshResult(fresh, fnames);
              return;
          }
        })
        .catch((e) => {
          // Silent recheck stays silent on failure too — the user will
          // see the next manual reload's error if there's a real problem.
          if (myGen !== requestGenRef.current) return;
          logger.warn("watcher", "post-start silent recheck failed", {
            folder,
            err: errorMessage(e),
          });
        });
    },
    [
      commitFreshResult,
      conflictRef,
      editingRef,
      folderRef,
      inFlightDeletesRef,
      initialLoadInFlightRef,
      loadResultRef,
      mergePromptOpenRef,
      pendingResultRef,
      requestGenRef,
      setEditing,
      setError,
      setLoadResult,
      toast,
      watchModeRef,
    ],
  );

  // Lifecycle is split into two effects to avoid a Start/Stop IPC race when
  // the user switches folders rapidly:
  //
  //   1. Folder-watch effect (Start-only on the live path): Go-side
  //      Manager.Start is itself re-entrant and tears down any previous
  //      watch atomically. By NOT calling StopFolderWatch from this
  //      effect's cleanup we keep the IPC sequence as Start("A") →
  //      Start("B"), which Go serializes via mu. A mixed Stop+Start
  //      sequence could re-order across Go goroutines and leave the wrong
  //      watch running. The only explicit Stop here is when watchMode
  //      flips to "off" or folderPath clears — both legitimate user-driven
  //      transitions, not effect-cleanup-driven.
  //   2. Event-subscription effect: stays mounted for the hook's lifetime,
  //      reads the freshest handler through a ref so it never has to
  //      re-subscribe on state changes. The cleanup only `unsub()`s the
  //      listener — it deliberately does NOT call StopFolderWatch because
  //      React.StrictMode's dev double-mount runs cleanup → re-setup, and
  //      a Stop fired here could land in Go after the next mount's Start.
  //      The final teardown on real app shutdown is handled by main.go's
  //      OnShutdown → app.shutdown → Manager.Stop instead.
  // dispatchWatchIntent is the single entry point for any Start/Stop IPC.
  // Wails dispatches each Bind call into its own Go goroutine, so JS-side
  // call ordering is NOT preserved at Go's mu lock — Start("A") → Start("B")
  // from JS can land as Start("B") then Start("A"), leaving Go watching the
  // wrong folder. To recover from any such reordering we re-evaluate the
  // current intent (refs are synced render-time) after EVERY IPC completion
  // and re-dispatch if it diverges. This converges to the latest intent
  // regardless of arrival order:
  //   - Start on same root + live goroutine: Go-side Manager.Start
  //     short-circuits to no-op (no walk).
  //   - Stop: idempotent.
  // so re-dispatching is always safe — at worst a duplicate IPC.
  //
  // Past variants this resolves (one per round, PR #75):
  //   - Round 7 thread C: Start success-side stale check
  //   - Round 10 suppressed-B: Start failure left Go without any watch
  //     because Manager.Start tears down old root BEFORE Add'ing new
  //   - Round 10 suppressed-C: mode-switch Stop completing after a
  //     later Start arrived stopped the wrong watcher
  //   - Round 10 suppressed-D: stale-start correction Stop completing
  //     out of order with same effect
  //
  // The ref itself is owned by the orchestrator (so the load hook can read
  // it via .current to reconcile after manual reload). The assignment
  // below replaces .current every render with the freshest closure — refs
  // aren't part of React's render-immutable state model, so re-binding the
  // function each render is safe and intentional.
  dispatchWatchIntentRef.current = () => {
    const folder = folderRef.current;
    const mode = watchModeRef.current;
    if (mode == null) {
      // Settings haven't arrived yet; do nothing. Starting now would
      // briefly run a watcher for a user who has explicitly persisted
      // watchMode = "off". The effect re-fires once watchMode hydrates.
      return;
    }
    if (!folder || mode === WATCH_MODE_OFF) {
      // Drop any parked auto-merge result first — replaying it after
      // off-switch would surprise a user who opted out (suppressed-g).
      pendingResultRef.current = null;
      void StopFolderWatch()
        .then(() => {
          // After Stop completes, intent may have moved back to auto /
          // a folder. Re-check and re-dispatch so the latest intent is
          // honored even if this Stop landed at Go after a later Start
          // (PR #75 10th, suppressed-C / -D).
          if (
            folderRef.current &&
            watchModeRef.current === WATCH_MODE_AUTO
          ) {
            dispatchWatchIntentRef.current();
          }
        })
        .catch((e) => {
          // Swallow into the log so an unhandled rejection doesn't
          // bubble up (PR #75 review suppressed-f).
          logger.warn("watcher", "stop failed", { err: errorMessage(e) });
          // Same intent-reconcile pass on error.
          if (
            folderRef.current &&
            watchModeRef.current === WATCH_MODE_AUTO
          ) {
            dispatchWatchIntentRef.current();
          }
        });
      return;
    }
    // mode === auto && folder !== ""
    void StartFolderWatch(folder)
      .then(() => {
        const curFolder = folderRef.current;
        const curMode = watchModeRef.current;
        if (curMode === WATCH_MODE_AUTO && curFolder === folder) {
          // Intent matches what we just told Go. Bridge the initial
          // LoadClassification ↔ watch-live gap with a silent recheck
          // (PR #75 9th, thread I).
          silentRecheckAfterStart(folder);
          return;
        }
        // Intent moved while we were awaiting. Reconcile by re-dispatching.
        dispatchWatchIntentRef.current();
      })
      .catch((e) => {
        const curFolder = folderRef.current;
        const curMode = watchModeRef.current;
        if (curFolder === folder && curMode === WATCH_MODE_AUTO) {
          // Current intent matches the one we just failed to start —
          // surface the failure to the user.
          const msg = errorMessage(e);
          toast(
            "自動監視を開始できませんでした (再読み込みボタンで手動更新してください)",
            "warn",
          );
          logger.warn("watcher", "start failed", { folder, err: msg });
          return;
        }
        // Intent moved AND our Start failed. Manager.Start tears down
        // any prior watch BEFORE Add'ing the new root, so a stale failure
        // means Go currently has no watch at all — we must re-dispatch
        // to (re-)establish the latest intent (PR #75 10th, suppressed-B).
        dispatchWatchIntentRef.current();
      });
  };

  useEffect(() => {
    dispatchWatchIntentRef.current();
    // folderPath / watchMode are dependencies but the body reads from refs
    // (which are render-time synced) to keep the dispatcher itself
    // closure-free. toast / silentRecheckAfterStart are stable useCallbacks
    // so omitting them from deps is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPath, watchMode]);

  // Keep a ref to the latest handler so the EventsOn subscription below can
  // bind once and never need to re-bind on state-derived identity changes.
  const handlerRef = useRef(handleWatcherPayload);
  useEffect(() => {
    handlerRef.current = handleWatcherPayload;
  }, [handleWatcherPayload]);

  useEffect(() => {
    const unsub = EventsOn(
      CLASSIFICATION_CHANGED_EVENT,
      (payload: ChangedPayload) => {
        void handlerRef.current(payload);
      },
    );
    return () => {
      unsub();
      // No explicit StopFolderWatch here. React.StrictMode runs cleanup
      // → re-setup on the dev double-mount; queuing a Stop here would
      // race with the next mount's StartFolderWatch and could land in
      // Go *after* the new Start, leaving dev silently unmonitored
      // (PR #75 review). For real app shutdown the watcher is torn down
      // by main.go's OnShutdown calling app.shutdown → Manager.Stop,
      // so the Go goroutine doesn't leak either way.
    };
  }, []);
}
