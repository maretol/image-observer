import { useCallback, useMemo, useRef, useState } from "react";
import { classification } from "../../../wailsjs/go/models";
import type { imghash } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { useToastFn } from "../../shared/components/Toast";
import type { ConfirmFn } from "../viewer-grid/useViewerSet";
import { type ListTabFilter } from "./filters";
import { useClassificationDelete } from "./useClassificationDelete";
import {
  useClassificationEdit,
  type SaveContext,
} from "./useClassificationEdit";
import { useClassificationFilter } from "./useClassificationFilter";
import { useClassificationLoad } from "./useClassificationLoad";
import { useClassificationMerge } from "./useClassificationMerge";
import { useClassificationReplay } from "./useClassificationReplay";
import { useClassificationSelection } from "./useClassificationSelection";
import { useClassificationWatcher } from "./useClassificationWatcher";
import { useDirectoryGroups } from "./useDirectoryGroups";
import { useDuplicateCheck } from "./useDuplicateCheck";

// テスト / 既存呼び出し向けの re-export。正の宣言は ./useClassificationWatcher (それを
// 消費する EventsOn subscription の隣) にある。
export { CLASSIFICATION_CHANGED_EVENT } from "./useClassificationWatcher";

export type EditingState = {
  open: boolean;
  filename: string | null;
};

export type ConflictPrompt = {
  filename: string;
  draft: classification.Entry;
};

// defer 元 (editing / conflict / merge prompt) がアクティブな間に届いた watcher の
// LoadResult を、park 時の folder + request generation ごと保持する。performReplay は
// folder / capturedGen で、user が defer を解決する間に state が動いていたら pending を捨てる。
export type PendingResult = {
  fresh: classification.LoadResult;
  folder: string;
  capturedGen: number;
};

export type MergePromptState = {
  open: boolean;
  preview: classification.MergePreview | null;
  // この prompt の対象 folder。trigger 時に capture し、user が folder 選択を変えても
  // (cancel + 再オープン) state を汚さないように。
  folderPath: string;
};

export type UseClassificationReturn = {
  folderPath: string;
  loadResult: classification.LoadResult | null;
  loading: boolean;
  error: string | null;
  filter: ListTabFilter;
  filteredEntries: classification.Entry[];
  editing: EditingState;
  conflict: ConflictPrompt | null;
  mergePrompt: MergePromptState;
  collapsedGroups: string[];
  isCollapsed: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  expandAllGroups: () => void;
  collapseAllGroups: (keys: string[]) => void;
  // 複数選択 state。filename (現 folder 内の POSIX 相対) で key し、folderPath 変更で
  // 自動クリア。filter / collapse 変更をまたいで残り、絞り込んで一括で開ける。
  selectedFilenames: string[];
  isSelected: (filename: string) => boolean;
  toggleSelected: (filename: string) => void;
  // 範囲選択: anchor (直近 toggle) があれば displayedOrder 上で anchor〜filename を全選択。
  // anchor 無し / 端点が displayedOrder に無いときは単純 toggle。
  extendSelectionTo: (filename: string, displayedOrder: string[]) => void;
  clearSelected: () => void;
  openFolder: () => Promise<void>;
  reload: () => Promise<void>;
  setFilter: (patch: Partial<ListTabFilter>) => void;
  toggleTag: (tag: string) => void;
  toggleUntagged: () => void;
  clearTags: () => void;
  openEdit: (filename: string) => void;
  closeEdit: () => void;
  saveEdit: (entry: classification.Entry, ctx: SaveContext) => Promise<void>;
  resolveConflictReload: () => Promise<void>;
  resolveConflictForce: () => Promise<void>;
  resolveConflictCancel: () => void;
  resolveMergeMerge: () => Promise<void>;
  resolveMergeSkip: () => Promise<void>;
  resolveMergeCancel: () => void;
  // 1 枚をゴミ箱へ送り sidecar に反映。消えたら true (呼び出し側が該当 viewer タブも閉じる)。
  // キャンセル / sidecar 前の失敗 (ファイル無傷) は false。
  deleteOne: (filename: string) => Promise<boolean>;
  // ダブり候補ペア (dismiss 除外済み, #136)。null = 未検出 (off / 初回前 / クリア直後)。
  duplicatePairs: imghash.DuplicatePair[] | null;
  dismissDuplicatePair: (fileA: string, fileB: string) => Promise<void>;
  persistableState: {
    folderPath: string;
    filter: {
      tags: string[];
      untaggedOnly: boolean;
      confidence: string;
      query: string;
    };
    collapsedGroups: string[];
  };
};

type Opts = {
  initialList?: wstate.ListTabState | null;
  confirm: ConfirmFn;
  // WATCH_MODE_AUTO / WATCH_MODE_OFF リテラル (watchMode.ts、Go 側 internal/settings.WatchMode*
  // に AGENTS.md D-1 drift テストで pin)。型が string なのは Wails 生成の
  // SettingsData.watchMode が string だから (Go の Validate が load 時に 2 値のどちらかを保証)。
  //
  // settings ロード中は undefined で、watch effect はその間あえて待つ — off を永続化した
  // ユーザーに Start が一瞬走ったり、直後に Start したい settings ロードと Stop が race する。
  watchMode?: string;
  // DUPLICATE_DETECT_AUTO / _OFF リテラル (duplicateDetect.ts、Go 側と D-1 pin, #136)。
  // watchMode と同じくロード中 undefined は kick を待つ。threshold は Go が settings から
  // 読むが、変更時の再判定トリガとして渡す (spec-duplicate-detection.md §8.1)。
  duplicateDetectMode?: string;
  duplicateThreshold?: number;
};

// list-tab feature のオーケストレータ。共有 state + ref を先頭で宣言し、以下の子フックを
// 合成する (各フックには必要な ref / setter だけ渡す):
//
//   useClassificationFilter    — filter state + filteredEntries (独立)
//   useClassificationSelection — 複数選択 set + range anchor (独立)
//   useClassificationLoad      — load IPC wrapper + folder picker + reload
//   useClassificationWatcher   — fsnotify event handler + Start/Stop dispatch
//   useClassificationReplay    — defer-close → performReplay
//   useClassificationEdit      — save + conflict 解決
//   useClassificationMerge     — 子 sidecar prompt 解決
//   useClassificationDelete    — 1 枚削除 + sidecar 反映
//
// race 正当性は下で宣言する共有 ref に依る (変数マトリクスは AGENTS.md §H-8 /
// docs/spec-folder-watch.md §15)。ref を子フックに畳み込まないこと: generation token /
// folder check パターンは全 async 経路で単一の共有 instance に依存する。
export function useClassification(opts: Opts): UseClassificationReturn {
  const initFolderPath = opts.initialList?.folderPath ?? "";

  const [folderPath, setFolderPath] = useState<string>(initFolderPath);
  const [loadResult, setLoadResult] =
    useState<classification.LoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    filter,
    filteredEntries,
    setFilter,
    toggleTag,
    toggleUntagged,
    clearTags,
  } = useClassificationFilter({
    initial: opts.initialList?.filter ?? null,
    loadResult,
  });
  const [editing, setEditing] = useState<EditingState>({
    open: false,
    filename: null,
  });
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [mergePrompt, setMergePrompt] = useState<MergePromptState>({
    open: false,
    preview: null,
    folderPath: "",
  });
  const {
    selectedFilenames,
    isSelected,
    toggleSelected,
    extendSelectionTo,
    clearSelected,
    setSelected,
    resetForFolderSwitch: resetSelectionForFolderSwitch,
  } = useClassificationSelection();
  const groups = useDirectoryGroups(opts.initialList?.collapsedGroups ?? []);

  const toast = useToastFn();
  // opts.watchMode は直接使う (watchModeRef 同期 + useClassificationWatcher の prop) — local に
  // 分解しても reader なしで opts を shadow するだけ。
  const { confirm } = opts;

  // watcher の event handler が読む ref。単一の EventsOn callback (hook 生存中 1 度だけ登録) が
  // 毎 state 変更で新 closure を要らずに最新値を見られるよう state からミラーする。
  //
  // folderRef / watchModeRef は useEffect でなく render 中に同期する。そうしないと、state/prop
  // 変更と post-render effect の間に届いた watcher event が stale 値ですり抜ける。典型例:
  // folder B を選び setFolderPath(B) したが post-commit effect まで folderRef.current は A の
  // まま → folder A の in-flight event が "payload.folder === folderRef.current" を通って別
  // リストに auto-merge される。render 中の ref mutation は許される (ref は React state ではない)。
  const folderRef = useRef(folderPath);
  folderRef.current = folderPath;
  const watchModeRef = useRef<string | undefined>(opts.watchMode);
  watchModeRef.current = opts.watchMode;

  // editingRef / conflictRef / mergePromptOpenRef も render 中に同期する (上と同じ理由):
  // setEditing({ open: true }) と post-render effect の間に届いた watcher event が ref を
  // "closed" のまま見て即 commit し、defer 論理を bypass する。最悪の sub-case は editing-open:
  // handler が loadResult.mtime を fresh 値に patch し、次の saveEdit が外部編集前 draft を読んで
  // いるのに mtime conflict チェックを通ってしまう。
  const editingRef = useRef<EditingState>(editing);
  editingRef.current = editing;
  const conflictRef = useRef<ConflictPrompt | null>(conflict);
  conflictRef.current = conflict;
  const mergePromptOpenRef = useRef(mergePrompt.open);
  mergePromptOpenRef.current = mergePrompt.open;

  // defer state (conflict / mergePrompt / 対象維持の editing-open) 中に届いた LoadClassification
  // 結果を park する。下の deferral-close effect が解決後に commit。folder は park 時に capture し、
  // deferred 中の folder 切替で replay が stale 結果を捨てる (別 folder の entries を貼らない)。
  // capturedGen は park 時の requestGenRef — 解決中に他 (manual reload / mutation / 別 event) が
  // gen を bump したら replay はこの pending を捨て、mtime 等価 entries 相違 commit が新 state を
  // 巻き戻さないようにする。
  const pendingResultRef = useRef<PendingResult | null>(null);

  // ダブり検出 (#136)。kick / gate / report は子フックが持つ (同期モデルは
  // docs/spec-duplicate-detection.md §8)。resetDuplicates は下の resetEntriesDependentState に
  // 参加する — duplicatePairs も entries 依存 state (filename を指す) のため。
  const { duplicatePairs, dismissDuplicatePair, resetDuplicates } =
    useDuplicateCheck({
      folderPath,
      folderRef,
      loadResult,
      duplicateDetectMode: opts.duplicateDetectMode,
      duplicateThreshold: opts.duplicateThreshold,
      toast,
    });

  // entries リストに意味が結びつく state (編集中ファイル / conflict draft / merge prompt /
  // park 済み auto-merge 結果 / filename-keyed 選択) を全クリアする。error 経路で
  // setLoadResult(null) と一緒に呼び、operate 対象の entries が消えたとき依存 state が残らないように:
  //   - editing.open=true (entry=null の SampleModal) は見た目無害だが、次の watcher event を
  //     defer させ、同名 filename が再出現すると modal を再表示する。
  //   - conflict / mergePrompt は stale な folder / draft を持ち次 render で誤誘導する。
  //   - pendingResultRef が空の loadResult に replay する。
  //   - filename-keyed 選択が entries 無しで無意味になる。
  // loadResult を null にする 3 箇所 (loadInternal / handleWatcherPayload / performReplay reload) に配線。
  const resetEntriesDependentState = useCallback(() => {
    setEditing({ open: false, filename: null });
    setConflict(null);
    setMergePrompt({ open: false, preview: null, folderPath: "" });
    pendingResultRef.current = null;
    resetSelectionForFolderSwitch();
    // duplicatePairs も filename-keyed (#136)。残すと旧 folder のバッジが新 folder の同名
    // ファイルに誤表示される (PR #75 Round 13/14 と同型)。
    resetDuplicates();
  }, [resetSelectionForFolderSwitch, resetDuplicates]);

  // 非同期 Load による setLoadResult / setError commit を gate し、out-of-order 完了が
  // 新結果を巻き戻さないようにする。bump 箇所:
  //   - loadInternal (manual reload / openFolder / mount auto-load / conflict/merge 解決 /
  //     delete-conflict retry)
  //   - handleWatcherPayload (各 watcher event)
  //   - performReplay の reload 分岐
  //   - saveEdit / resolveConflictForce と、useClassificationMerge / useClassificationDelete の
  //     ディスク書き込み後 (書き込み前に始まった in-flight Load を stale 破棄)
  // 各 commit 経路は state を触る前に myGen === current を確認する。単一の共有 generation が
  // 無いと、どれかの stale Load が他を潰す。
  const requestGenRef = useRef(0);

  // loadInternal (loading: true にする経路) *だけ* が bump する。loadInternal の finally の
  // spinner 解放は requestGenRef でなくこの token を見る — でないと manual Load の await 中に
  // 届いた watcher event が共有 generation を bump し、manual Load の stale-check が
  // setLoading(false) を skip して spinner が固まる (watcher 経路は loading を触らないので)。
  const loadingTokenRef = useRef(0);

  // loadInternal が LoadClassification を await 中 true。silentRecheckAfterStart はこれを見て
  // 初期 load の commit が着くまで自分の read を defer する — でないと同一 generation の 2 つの
  // Load が両方 commit し、実際にどちらが新しいかによらず後着が勝つ。別フラグで tie を切る。
  const initialLoadInFlightRef = useRef(false);

  // ここ (useClassificationLoad より上) で宣言するのは、reload() が ref 経由で読んで手動
  // 再読み時に watcher reconcile を蹴れるように。実装は useClassificationWatcher が毎 render
  // 代入する — ref は render-immutable でないので .current の関数 identity を毎 render 差し替えても
  // consumer (全て呼び出し時に .current を deref) を壊さない。
  const dispatchWatchIntentRef = useRef<() => void>(() => {});

  const { openFolder, reload, loadInternal } = useClassificationLoad({
    initFolderPath,
    folderRef,
    requestGenRef,
    loadingTokenRef,
    initialLoadInFlightRef,
    dispatchWatchIntentRef,
    setFolderPath,
    setLoadResult,
    setLoading,
    setError,
    setMergePrompt,
    resetEntriesDependentState,
    confirm,
    toast,
  });

  // loadResult のミラー。watcher handler が loadResult に直接依存 (毎 render で
  // handleWatcherPayload identity が変わる) せずに、届いた re-Load を表示中と比較できるように。
  // render 時同期なのは self-echo チェックで読むため — setLoadResult(patch) と post-render effect の
  // 間に watcher event が来ると、patch 前 entries と比較して、直近 save の watcher echo を外部変更と
  // 誤判定し "外部変更" toast / 不要 commit が出る。
  const loadResultRef = useRef<classification.LoadResult | null>(loadResult);
  loadResultRef.current = loadResult;

  // Delete IPC は飛んだが sidecar save / local patch がまだの filename を追う。watcher は
  // Remove event をほぼ即座に (SaveClassification 往復の前に) 出すので、debounce flush が
  // handler に着き LoadClassification が走る頃には fresh entries は既にそのファイルを欠く
  // (Service.Load の orphan-filter が落とす) 一方、local loadResult はまだ持つ。filter しないと
  // entriesEquivalent の self-echo チェックが外し、自分の削除に "外部で更新されました" toast を出す。
  //
  // strip は **stale な cur 側だけ** に適用し fresh には適用しない。delete IPC 往復中に外部が
  // 同名ファイルを再作成したら fresh.entries は正当に新 entry を持つので、fresh も strip すると
  // 再作成を握り潰す。非対称 strip で self-echo (cur strip vs 既にファイルを失った fresh = 等価 =
  // toast なし) を保ちつつ再作成は surface する。
  //
  // folder ごとに scope (Map<folder, Set<filename>>) するのは、folder A の in-flight delete が、
  // IPC 確定前に folder を切り替えたとき folder B の同名ファイル差分を抑止しないように。scope が
  // 無いと別 folder の in-flight set で cur を strip し、新 folder の cur から同名 entry を落として
  // entriesEquivalent が誤って "変更なし" と報告し、次 event までリストが stale になる。
  const inFlightDeletesRef = useRef<Map<string, Set<string>>>(new Map());

  // loadResult を watcher の snapshot に差し替え、ディスクに無くなった選択 filename を落とす
  // (でないと bulk toolbar / "open many" が stale path を viewer に渡す)。
  const commitFreshResult = useCallback(
    (fresh: classification.LoadResult, fnames: ReadonlySet<string>) => {
      setLoadResult(fresh);
      setSelected((cur) => {
        if (cur.size === 0) return cur;
        let changed = false;
        const next = new Set<string>();
        for (const f of cur) {
          if (fnames.has(f)) next.add(f);
          else changed = true;
        }
        return changed ? next : cur;
      });
    },
    [],
  );

  useClassificationWatcher({
    folderPath,
    watchMode: opts.watchMode,
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
  });

  useClassificationReplay({
    editing,
    conflict,
    mergePrompt,
    folderRef,
    watchModeRef,
    requestGenRef,
    loadResultRef,
    editingRef,
    conflictRef,
    mergePromptOpenRef,
    pendingResultRef,
    setLoadResult,
    setError,
    setEditing,
    commitFreshResult,
    resetEntriesDependentState,
    toast,
  });

  const {
    openEdit,
    closeEdit,
    saveEdit,
    resolveConflictReload,
    resolveConflictForce,
    resolveConflictCancel,
  } = useClassificationEdit({
    conflict,
    loadResultRef,
    folderRef,
    requestGenRef,
    setLoadResult,
    setEditing,
    setConflict,
    reload,
    toast,
  });

  const { resolveMergeMerge, resolveMergeSkip, resolveMergeCancel } =
    useClassificationMerge({
      mergePrompt,
      folderRef,
      requestGenRef,
      setMergePrompt,
      loadInternal,
      toast,
    });

  const { deleteOne } = useClassificationDelete({
    loadResult,
    folderRef,
    requestGenRef,
    inFlightDeletesRef,
    setLoadResult,
    setSelected,
    loadInternal,
    confirm,
    toast,
  });

  const persistableState = useMemo(
    () => ({
      folderPath,
      filter: {
        tags: filter.tags,
        untaggedOnly: filter.untaggedOnly,
        confidence: filter.confidence,
        query: filter.query,
      },
      collapsedGroups: groups.collapsedList,
    }),
    [folderPath, filter, groups.collapsedList],
  );

  // 中身が実際に変わらない限り consumer (App.tsx / ClassificationView) が同じ identity を
  // 見るよう return を安定化。
  return useMemo(
    () => ({
      folderPath,
      loadResult,
      loading,
      error,
      filter,
      filteredEntries,
      editing,
      conflict,
      mergePrompt,
      collapsedGroups: groups.collapsedList,
      isCollapsed: groups.isCollapsed,
      toggleGroup: groups.toggle,
      expandAllGroups: groups.expandAll,
      collapseAllGroups: groups.collapseAll,
      selectedFilenames,
      isSelected,
      toggleSelected,
      extendSelectionTo,
      clearSelected,
      openFolder,
      reload,
      setFilter,
      toggleTag,
      toggleUntagged,
      clearTags,
      openEdit,
      closeEdit,
      saveEdit,
      resolveConflictReload,
      resolveConflictForce,
      resolveConflictCancel,
      resolveMergeMerge,
      resolveMergeSkip,
      resolveMergeCancel,
      deleteOne,
      duplicatePairs,
      dismissDuplicatePair,
      persistableState,
    }),
    [
      folderPath,
      loadResult,
      loading,
      error,
      filter,
      filteredEntries,
      editing,
      conflict,
      mergePrompt,
      groups.collapsedList,
      groups.isCollapsed,
      groups.toggle,
      groups.expandAll,
      groups.collapseAll,
      selectedFilenames,
      isSelected,
      toggleSelected,
      extendSelectionTo,
      clearSelected,
      openFolder,
      reload,
      setFilter,
      toggleTag,
      toggleUntagged,
      clearTags,
      openEdit,
      closeEdit,
      saveEdit,
      resolveConflictReload,
      resolveConflictForce,
      resolveConflictCancel,
      resolveMergeMerge,
      resolveMergeSkip,
      resolveMergeCancel,
      deleteOne,
      duplicatePairs,
      dismissDuplicatePair,
      persistableState,
    ],
  );
}

