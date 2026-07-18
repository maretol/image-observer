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
import {
  entriesEquivalent,
  fileTimesEquivalent,
} from "./entriesEquivalent";
import {
  decideAutoMerge,
  formatChangeSummary,
  type ChangedPayload,
} from "./watcherPolicy";

// Go 側 watcher.ClassificationChangedEvent のミラー。watcher パッケージには自動生成の
// TS namespace が無い (Wails は binding signature に出る型しか TS 化せず、EventsEmit の
// payload は出ない) ので文字列リテラルを複製する。watcherPolicy.test.ts の vitest 断言が
// Go 側テストと同じリテラルに pin する — 片方だけ rename すると CI が落ちる (AGENTS.md D-1)。
export const CLASSIFICATION_CHANGED_EVENT = "classification:changed";

type Props = {
  // folderPath / watchMode は値で渡す (ref でなく) ので watch dispatch effect が変化に
  // 反応できる。body 側は stale closure を避けるため ref を読む (下の dispatchWatchIntentRef)。
  folderPath: string;
  watchMode?: string;

  // 共有 ref (read & write)
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

  // setter
  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setError: (msg: string | null) => void;
  setEditing: React.Dispatch<React.SetStateAction<EditingState>>;

  // 協調先
  commitFreshResult: (
    fresh: classification.LoadResult,
    fnames: ReadonlySet<string>,
  ) => void;
  resetEntriesDependentState: () => void;
  // 同名上書き (payload.contentChanged) のダブり再判定 kick (useDuplicateCheck,
  // spec-duplicate-detection §8.1)。
  notifyDuplicateContentChanged: () => void;
  toast: ToastFn;
};

// fsnotify auto-merge 経路 (#19): watcher-event handler / Start 後の silent recheck /
// Start/Stop IPC dispatcher / それらを駆動する 2 effect を持つ。race 変数マトリクスは
// AGENTS.md §H-8 / docs/spec-folder-watch.md。このファイルの inline guard はそのルールの
// load-bearing な写しなので、§H-8 の該当項目を確認せず guard を消さないこと。
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
    notifyDuplicateContentChanged,
    toast,
  } = props;

  // ─── fsnotify auto-merge (#19) ─────────────────────────────────────
  //
  // handleWatcherPayload は flush された "classification:changed" event ごとに走る
  // (internal/watcher + docs/spec-folder-watch.md)。判定 state を ref 経由で読むので、
  // identity が毎 render 変わっても EventsOn を re-bind せずに済む (下の handlerRef 経由)。
  const handleWatcherPayload = useCallback(
    async (payload: ChangedPayload) => {
      if (watchModeRef.current === WATCH_MODE_OFF) {
        // 監視無効化。StopFolderWatch() は既に JS へ dispatch 済みの event を戻せないので、
        // off 切替の瞬間に in-flight な payload が opt-out 後に auto-merge しないよう handler
        // 境界で drop する。
        return;
      }
      if (payload.folder !== folderRef.current) {
        // まだ tear down されていない watcher の残り、または flush 途中の folder 切替。静かに drop。
        return;
      }
      if (payload.contentChanged) {
        // 同名上書き (集合不変・内容変化) のダブり再判定はここで kick する (spec-duplicate-detection
        // §8.1)。下の再 Load 側は fileTimes 相違で表示 (mtime ソート) には追従する (#144) が、
        // ダブり検出の kick effect は filename 集合 key を deps にしており再発火しないのと、
        // mtime を保存したまま上書きするツール (timestamp 保持コピー) では fileTimes 差分も
        // 出ないため、この明示 kick は引き続き必要。
        notifyDuplicateContentChanged();
      }
      const myGen = ++requestGenRef.current;

      let fresh: classification.LoadResult | null = null;
      try {
        fresh = await LoadClassification(folderRef.current);
      } catch (e) {
        // 失敗が stale request のもの (新 payload が既に in-flight、または folder 切替) なら
        // この catch を抑止。guard が無いと遅く失敗する古い Load が表示済みの新結果を消す。
        if (myGen !== requestGenRef.current) return;
        if (folderRef.current !== payload.folder) return;
        // watchMode 再チェック: 上の entry-gate は await の前に走った。await 中に off に
        // されたら、opt-out した監視に対して失敗を出すことになる。
        if (watchModeRef.current === WATCH_MODE_OFF) return;
        // manual-reload の error 経路に合わせ、削除/読めない folder を stale grid のまま
        // 放置せずユーザーに出す。表示中の結果も落とす (残すとディスクに無い entry を操作させる)。
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // loadResult と一緒に entries 依存 state をクリア (loadInternal の catch と同じ)。
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        logger.warn("classification", "auto-merge load failed", { err: msg });
        return;
      }
      // 同じ理由で success 結果も discard。
      if (myGen !== requestGenRef.current) return;
      if (folderRef.current !== payload.folder) return;
      // catch と同じ off-during-await ガード。await 中に off にされたら、commit すると
      // opt-out 後に auto-merge してしまう。
      if (watchModeRef.current === WATCH_MODE_OFF) return;
      // 成功 Load (silent self-echo 含む) は folder が読める確認なので、前の失敗 reload の
      // 残り error をクリア (回復後も出し続けないように)。
      setError(null);

      // self-echo / no-op 検出。自分の Save/Delete IPC も watcher event を起こし、それに
      // "外部で更新されました" を出すのはノイズ (spec §5.4)。entries 内容が表示中と一致するとき:
      //   - sidecar mtime も fileTimes も同じ → 完全に silent (真の no-op / self-echo)
      //   - どちらか相違 → silent 更新 (sidecar mtime は次の save の conflict チェック用、
      //     fileTimes は同名上書きを mtime ソートへ反映するため, #144 spec-image-sort §8.1)
      //
      // entriesEquivalent は in-flight delete を除いた後で両側を比較する — local loadResult は
      // まだ削除依頼した entry を持つ (setLoadResult patch は sidecar-save 後) が fresh re-Load は
      // 既に欠く。差分がその in-flight delete だけなら self-echo とみなし toast を skip。
      const cur = loadResultRef.current;
      // in-flight delete filename を payload.folder に scope し、別 folder の stale delete が
      // この folder の差分を抑止しないように。非対称 strip: cur 側だけ filename を隠し、fresh は
      // 触らない (IPC 窓中の外部再作成を差分として surface するため)。
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
      if (
        entriesUnchanged &&
        cur != null &&
        cur.mtime === fresh.mtime &&
        fileTimesEquivalent(fresh.entries, cur.fileTimes, fresh.fileTimes)
      ) {
        return;
      }
      if (entriesUnchanged) {
        setLoadResult(fresh);
        return;
      }

      // formatChangeSummary は常に非空文字列を返す (counter 無しの anyChange payload も
      // 汎用通知に値する, watcherPolicy.ts)。
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
          // fresh を folder + 現 generation *ごと* park し、deferral-close replay が folder 切替や
          // 別 commit 着地時に discard できるように。
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
      notifyDuplicateContentChanged,
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

  // 初期 / 復元の LoadClassification と StartFolderWatch が live になるまでの隙間を埋める:
  // その窓の間に folder に落ちたファイルは cached entries にも fsnotify stream にも無い。
  // re-Load (loading flicker なし / 成功 toast なし / 差分 silent) し、通常 watcher payload と
  // 同じ defer / mode / generation 論理に通して editing-open 等を尊重する。
  const silentRecheckAfterStart = useCallback(
    (folder: string) => {
      // loadInternal の await 中は defer。でないと初期 load と race する (silent recheck は
      // snapshot だけで bump しないので同一 generation) — silent recheck が新 snapshot を先に
      // commit し、その後古い初期 load 結果が着いて上書きする。初期 load 完了を待てば、その後の
      // read は必ず newer (happened-after) なので同一 gen で両方 commit しても last-write-wins が
      // 正当。setTimeout で event loop に譲り初期 load の finally を先に走らせる。
      if (initialLoadInFlightRef.current) {
        setTimeout(() => silentRecheckAfterStart(folder), 50);
        return;
      }
      // 現 generation を bump せず snapshot する。同時に満たす 2 要件:
      //   1) silent recheck は in-flight の初期 load 経路 (openFolder / mount auto-load) を
      //      supersede してはならない。bump すると進行中の loadInternal が自分を stale と見て
      //      null を返し、openFolder の postLoadFlow (sidecar 作成 / 子 sidecar merge prompt) が
      //      silent に skip してしまう。
      //   2) silent recheck は await 中に着いた newer commit を巻き戻してはならない。snapshot +
      //      commit 時チェックで対応: 待つ間に他が gen を bump すれば myGen !== current で return。
      const myGen = requestGenRef.current;
      void LoadClassification(folder)
        .then((fresh) => {
          if (myGen !== requestGenRef.current) return;
          // stale guard は handleWatcherPayload と同じ。
          if (folderRef.current !== folder) return;
          if (watchModeRef.current !== WATCH_MODE_AUTO) return;
          const cur = loadResultRef.current;
          // handleWatcherPayload 参照: per-folder set + 非対称 strip (別 folder の in-flight
          // delete がこの差分を抑止せず、delete IPC と race する外部再作成も差分として検出)。
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
          // handleWatcherPayload と同じ 3 条件 gate (fileTimes 相違 = 同名上書きは
          // silent commit へ, #144)。
          if (
            entriesUnchanged &&
            cur != null &&
            cur.mtime === fresh.mtime &&
            fileTimesEquivalent(fresh.entries, cur.fileTimes, fresh.fileTimes)
          ) {
            return;
          }
          // ここに来た = silent recheck が re-Load 成功を観測。前の失敗 initial / manual reload の
          // stale error をクリア (回復後も残すと watcher handler / performReplay 成功経路と同じ UI artifact)。
          setError(null);
          if (entriesUnchanged) {
            setLoadResult(fresh);
            return;
          }
          // 初期 Load と watcher Start の間に本物の差分があった。toast なし (silent — user は
          // 頼んでおらず厳密には「外部変更」でもない) だが、開いている editing / conflict / merge
          // prompt が結果を潰されず park するよう decideAutoMerge に通す。
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
              // capturedGen ごと park し、別 commit が着いたら replay が discard できるように。
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
          // silent recheck は失敗時も silent — 本当に問題があれば次の manual reload の error で見える。
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

  // ライフサイクルは 2 effect に分割し、folder 高速切替時の Start/Stop IPC race を避ける:
  //
  //   1. Folder-watch effect (live 経路は Start のみ): Go 側 Manager.Start は再入可能で、
  //      前の watch を atomic に tear down する。この effect の cleanup で StopFolderWatch を
  //      呼ばないことで IPC を Start("A") → Start("B") に保つ (Go が mu で直列化)。Stop+Start
  //      混在は Go goroutine 間で reorder し得て誤った watch が残る。ここで明示 Stop するのは
  //      watchMode が "off" になるか folderPath が空になるときだけ。
  //   2. Event-subscription effect: hook 生存中 mount したまま、最新 handler を ref 経由で読み
  //      state 変更で re-subscribe しない。cleanup は unsub() だけで StopFolderWatch を呼ばない —
  //      StrictMode の dev 二重 mount が cleanup → re-setup を走らせ、ここの Stop が次 mount の
  //      Start の後に Go に着き得るため。実アプリ終了時の teardown は main.go の OnShutdown →
  //      app.shutdown → Manager.Stop が行う。
  //
  // dispatchWatchIntent は Start/Stop IPC の単一入口。Wails は各 Bind 呼び出しを別 goroutine に
  // 投げるので、JS 側の呼び出し順は Go の mu lock で保たれない — JS の Start("A") → Start("B") が
  // Start("B") → Start("A") と着地して Go が誤った folder を watch し得る。この reorder から回復する
  // ため、IPC 完了ごとに現在の intent (ref は render 時同期) を再評価し、乖離していれば re-dispatch する。
  // 到着順によらず最新 intent に収束する:
  //   - 同一 root + live goroutine の Start: Manager.Start が no-op に短絡 (walk なし)。
  //   - Stop: 冪等。
  // なので re-dispatch は常に安全 — 最悪でも重複 IPC。
  //
  // ref 自体は orchestrator が持つ (load hook が .current で manual reload 後の reconcile に読む)。
  // 下の代入は毎 render で .current を最新 closure に差し替える — ref は render-immutable でないので安全。
  dispatchWatchIntentRef.current = () => {
    const folder = folderRef.current;
    const mode = watchModeRef.current;
    if (mode == null) {
      // settings 未着なので何もしない。今 Start すると off を永続化した user に一瞬 watcher が
      // 走る。watchMode が hydrate すれば effect が再発火する。
      return;
    }
    if (!folder || mode === WATCH_MODE_OFF) {
      // park 済み auto-merge 結果をまず drop — off 切替後に replay すると opt-out した user を驚かせる。
      pendingResultRef.current = null;
      void StopFolderWatch()
        .then(() => {
          // Stop 完了後、intent が auto / folder に戻っているかもしれない。この Stop が later
          // Start の後に Go に着いても最新 intent が尊重されるよう再チェック + re-dispatch。
          if (
            folderRef.current &&
            watchModeRef.current === WATCH_MODE_AUTO
          ) {
            dispatchWatchIntentRef.current();
          }
        })
        .catch((e) => {
          // unhandled rejection が bubble しないよう log に飲み込む。
          logger.warn("watcher", "stop failed", { err: errorMessage(e) });
          // error 時も同じ intent-reconcile。
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
          // intent が Go に伝えたものと一致。初期 LoadClassification ↔ watch-live の隙間を
          // silent recheck で埋める。
          silentRecheckAfterStart(folder);
          return;
        }
        // await 中に intent が動いた。re-dispatch で reconcile。
        dispatchWatchIntentRef.current();
      })
      .catch((e) => {
        const curFolder = folderRef.current;
        const curMode = watchModeRef.current;
        if (curFolder === folder && curMode === WATCH_MODE_AUTO) {
          // 現 intent が今 Start に失敗したものと一致 — 失敗をユーザーに出す。
          const msg = errorMessage(e);
          toast(
            "自動監視を開始できませんでした (再読み込みボタンで手動更新してください)",
            "warn",
          );
          logger.warn("watcher", "start failed", { folder, err: msg });
          return;
        }
        // intent が動き、かつ Start 失敗。Manager.Start は新 root を Add する前に前の watch を
        // tear down するので、stale 失敗 = Go は今 watch を全く持たない — 最新 intent を
        // (再)確立するため re-dispatch する。
        dispatchWatchIntentRef.current();
      });
  };

  useEffect(() => {
    dispatchWatchIntentRef.current();
    // folderPath / watchMode は deps だが body は ref (render 時同期) を読み dispatcher を
    // closure-free に保つ。toast / silentRecheckAfterStart は stable なので deps 省略は意図的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPath, watchMode]);

  // 最新 handler を ref に保ち、下の EventsOn subscription が一度 bind したら state 由来の
  // identity 変化で re-bind せずに済むように。
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
      // ここで明示 StopFolderWatch しない。StrictMode の dev 二重 mount は cleanup → re-setup を
      // 走らせ、ここの Stop が次 mount の StartFolderWatch と race して Go に *後* から着き、dev が
      // silent に unmonitored になり得る。実アプリ終了時は main.go の OnShutdown → app.shutdown →
      // Manager.Stop が tear down するので goroutine は leak しない。
    };
  }, []);
}
