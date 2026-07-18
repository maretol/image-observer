import {
  type MutableRefObject,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { classification } from "../../../wailsjs/go/models";
import { ConflictDialog } from "../../shared/components/ConflictDialog";
import { MergePromptDialog } from "../../shared/components/MergePromptDialog";
import { useToastFn } from "../../shared/components/Toast";
import { copyImageToClipboard } from "../../shared/utils/clipboard";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { CardContextMenu } from "./CardContextMenu";
import { ClassificationHeader } from "./ClassificationHeader";
import { ConfidenceSegment } from "./ConfidenceSegment";
import { DirectoryGroup } from "./DirectoryGroup";
import { DuplicatePairsModal } from "./DuplicatePairsModal";
import { duplicateFileSet, pairsForFile } from "./duplicateBadge";
import { SampleModal, type SampleModalOpenSource } from "./SampleModal";
import { SearchBox } from "./SearchBox";
import type { SaveContext } from "./useClassificationEdit";
import { TagChips } from "./TagChips";
import {
  SPLIT_OPEN_LIMIT,
  computeCardContextMenuMode,
} from "./cardContextMenuLogic";
import { tagSummary } from "./filters";
import { arrowDirection, pickGridNeighbor } from "./gridNav";
import { groupByDirectory, groupKeyOf } from "./groups";
import { pickSibling } from "./sampleModalNav";
import { sortEntries } from "./sort";
import type { UseClassificationReturn } from "./useClassification";

export type ClassificationViewProps = {
  state: UseClassificationReturn;
  // "checkbox" (既定) | "modifier" | "both" (settings.SettingsData)。ロード中は "checkbox"。
  multiSelectMode?: string;
  // SampleEditPane の save モード (#105)。undefined (ロード中) は true (auto) 扱い —
  // 初回描画で manual モードの chrome が一瞬出ないよう永続化 default に合わせる。
  editAutoSave?: boolean;
  // トップタブが "list" から離れて ClassificationView が unmount してもスクロール位置が
  // 残るよう親が持つ。folder 変更で 0 にリセット。state.json には永続化しない。
  scrollTopRef: MutableRefObject<number>;
  // SampleModal の viewer ピッカーと bulk ドロップダウン用に親が viewer set + active id を渡す (#11)。
  viewers: { id: string; name: string }[];
  activeViewerId: string;
  onOpenInViewer: (viewerId: string, filename: string) => void;
  onOpenManyInTabs: (viewerId: string, filenames: string[]) => void;
  onOpenManyAsSplit: (viewerId: string, filenames: string[]) => void;
  // deleteOne() 成功後に削除ファイルの絶対 path で呼ぶ (親が参照中の viewer タブを閉じる, #47)。
  onAfterDelete: (absPath: string) => void;
};

export function ClassificationView({
  state,
  multiSelectMode = "checkbox",
  editAutoSave = true,
  scrollTopRef,
  viewers,
  activeViewerId,
  onOpenInViewer,
  onOpenManyInTabs,
  onOpenManyAsSplit,
  onAfterDelete,
}: ClassificationViewProps) {
  const {
    folderPath,
    loadResult,
    loading,
    filter,
    filteredEntries,
    conflict,
    mergePrompt,
    isCollapsed,
    toggleGroup,
    expandAllGroups,
    collapseAllGroups,
    collapsedGroups,
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
    sortMode,
    setSortMode,
  } = state;

  const allEntries = loadResult?.entries ?? [];

  const knownTags = useMemo(() => {
    return Array.from(tagSummary(allEntries).keys()).sort();
  }, [allEntries]);

  // フィルタ前のグループ別合計数 — 折りたたみ見出しで "5 / 12" を出すため。allGroupKeys は
  // 未フィルタから全ディレクトリキーの順序リストを作り "すべて折りたたむ" が使う。
  const { totalCountByGroup, allGroupKeys } = useMemo(() => {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    for (const e of allEntries) {
      const k = groupKeyOf(e.filename);
      if (!counts.has(k)) keys.push(k);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return { totalCountByGroup: counts, allGroupKeys: keys };
  }, [allEntries]);

  // 表示派生ソート (#144)。loadResult.entries (sidecar 正本の手動順) は不変のまま、
  // filter 済み配列だけを並べ替える (filter は順序保存の述語なので、entries → filter →
  // sort は spec-image-sort.md §3 の sort → filter と同値)。下流の displayedOrder /
  // gridNav / SampleModal prev·next は全て filteredGroups 派生なので自動追従。
  const sortedEntries = useMemo(
    () => sortEntries(filteredEntries, sortMode, loadResult?.fileTimes),
    [filteredEntries, sortMode, loadResult?.fileTimes],
  );

  const filteredGroups = useMemo(
    () => groupByDirectory(sortedEntries),
    [sortedEntries],
  );

  // Shift+click 範囲選択用の可視 card フラット順。折りたたみグループも含む (範囲が
  // 折りたたみ節をまたげる Finder 挙動)。
  const displayedOrder = useMemo(
    () => filteredGroups.flatMap((g) => g.entries.map((e) => e.filename)),
    [filteredGroups],
  );

  const showCheckbox =
    multiSelectMode === "checkbox" || multiSelectMode === "both";
  const modifierEnabled =
    multiSelectMode === "modifier" || multiSelectMode === "both";

  // スクロール位置の保持 (#40)。.cls-groups は 1 lifetime 中に消えて再出現し得る (filter で
  // 全 entries が消える→戻る) し、ClassificationView 自体もタブ切替で unmount する。親の
  // scrollTopRef は両方より長命。ref callback が attach 時に復元し onScroll が書き戻す。
  const groupsElRef = useRef<HTMLDivElement | null>(null);
  const groupsRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      groupsElRef.current = el;
      if (el) el.scrollTop = scrollTopRef.current;
    },
    [scrollTopRef],
  );
  const onGroupsScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      scrollTopRef.current = e.currentTarget.scrollTop;
    },
    [scrollTopRef],
  );

  // 矢印キーのグリッド移動 (#115)。card thumb (内の control) に focus 中、←/→ は reading (DOM)
  // 順、↑/↓ は視覚行で水平中心が最も近い card へ。判定は pickGridNeighbor。ここでは focus 移動
  // だけ (Enter/Space の起動は Card thumb 側)。
  const onGroupsKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const dir = arrowDirection(e.key);
      if (!dir) return;
      const container = groupsElRef.current;
      if (!container) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      // focus 要素から card thumb を解決。focus は thumb *内* の control (checkbox / 編集ボタン) に
      // あり得るので、thumb 自身でなく最寄り祖先で match。card 外 (filter 入力等) では null を返し
      // 矢印を既定挙動に任せる。
      const thumb = active.closest<HTMLElement>(".cls-card-thumb");
      if (!thumb) return;
      const cards = Array.from(
        container.querySelectorAll<HTMLElement>(".cls-card-thumb"),
      );
      const current = cards.indexOf(thumb);
      if (current < 0) return;
      // lazy な getRect を渡す: ←/→ は呼ばず、↑/↓ もカーソル近傍の card だけ測るので
      // (pickGridNeighbor が隣接行で early-exit)、key-repeat が O(n) の sweep に乗らない。
      const next = pickGridNeighbor(cards.length, current, dir, (i) =>
        cards[i].getBoundingClientRect(),
      );
      if (next === null) return;
      e.preventDefault();
      cards[next].focus({ preventScroll: true });
      cards[next].scrollIntoView({ block: "nearest" });
    },
    [],
  );
  // folder 変更時に reset。現 folderPath で初期化し、タブ切替後の初回 mount (folderPath 不変)
  // では reset せず上の attach 復元を勝たせる。
  const lastFolderRef = useRef(folderPath);
  useLayoutEffect(() => {
    if (lastFolderRef.current === folderPath) return;
    lastFolderRef.current = folderPath;
    scrollTopRef.current = 0;
    if (groupsElRef.current) groupsElRef.current.scrollTop = 0;
  }, [folderPath, scrollTopRef]);

  // Sample modal (#9, #93 で preview+edit 統合)。filename のみ保持し render で folderPath と
  // 組んで IPC path を作る。folder 変更で開いた preview を閉じる。
  //
  // previewOpenSource は modal の開き方を記録し初期 focus を振り分ける: "preview" は preview 側、
  // "edit" は tag 入力 (spec §5.2)。
  const [previewFilename, setPreviewFilename] = useState<string | null>(null);
  const [previewOpenSource, setPreviewOpenSource] =
    useState<SampleModalOpenSource>("preview");
  // 統合 modal は useClassification.editing も駆動し、useClassificationReplay の replay-defer
  // (editing.open=true 中に届いた watcher event を park し modal close で replay) を生かす。
  // preview / edit どちらも同じ modal を開き editing.open=true にする — 「entry を見ている間、
  // 外部 merge を少し保留する」意味は両方に等しく効く。
  //
  // saveEdit 成功は editing.open=false にする (旧 EditPopover の名残)。統合 modal は save 後も
  // 開いたまま (spec §5.3) なので、下の handleSave が editing.open=true を張り直し、閲覧中も
  // defer を効かせる。
  const openPreview = useCallback(
    (filename: string) => {
      setPreviewFilename(filename);
      setPreviewOpenSource("preview");
      openEdit(filename);
    },
    [openEdit],
  );
  const openEditModal = useCallback(
    (filename: string) => {
      setPreviewFilename(filename);
      setPreviewOpenSource("edit");
      openEdit(filename);
    },
    [openEdit],
  );
  const closePreview = useCallback(() => {
    setPreviewFilename(null);
    closeEdit();
  }, [closeEdit]);
  useLayoutEffect(() => {
    setPreviewFilename(null);
    closeEdit();
  }, [folderPath, closeEdit]);

  // saveEdit 成功時に editing.open=false になる (旧 EditPopover の名残)。統合 modal では
  // editing.open が modal の開閉に追従してほしい (閲覧中も後続 watcher event を defer させるため)。
  // save 時の 1 フレームの true → false → true 遷移は performReplay() をちょうど 1 回発火させる —
  // 保存 = 編集確定なので、保留 watcher 結果を更新後 baseline に流し込む正しい瞬間。saveEdit の
  // conflict / error 経路は editing を触らないので、同じ filename で openEdit を呼んでも同値 setState の no-op。
  //
  // previewFilenameRef は await 完了時の *現在の* (closure キャプチャでない) filename を渡す。
  // ref が無いと「保存クリック → 即 Esc/×/backdrop で閉じる」で handleSave の closure が閉じる前の
  // previewFilename を保持したまま openEdit を呼び、modal を閉じた後に editing.open=true が復活して
  // watcher replay の defer が解除されない。render 時代入は AGENTS.md H-8 に従う。
  const previewFilenameRef = useRef<string | null>(null);
  previewFilenameRef.current = previewFilename;
  // SampleEditPane の SaveContext をそのまま saveEdit へ渡す (#110 C)。旧 folderPathRef が
  // 守っていた folder 切替 race は今 saveEdit 内: SampleEditPane が snapshot 起点で folder を
  // capture する (render 同期 folderPropRef、pane unmount で旧 folder のまま) ので、stale な
  // save-on-unmount cleanup は ctx.folder=旧 を運び saveEdit の IPC 前 gate が skip する。
  const handleSave = useCallback(
    async (entry: classification.Entry, ctx: SaveContext) => {
      await saveEdit(entry, ctx);
      const current = previewFilenameRef.current;
      if (current !== null) {
        openEdit(current);
      }
    },
    [saveEdit, openEdit],
  );

  // 現在の loadResult から previewFilename の entry を解決する — 統合 SampleModal (#93) が
  // 開いている filename を直接持つので、ここで引いて prop で渡す。
  const previewEntry = useMemo(() => {
    if (previewFilename === null) return null;
    return allEntries.find((e) => e.filename === previewFilename) ?? null;
  }, [previewFilename, allEntries]);

  // Sample modal の prev/next (#94)。displayedOrder から導出。pickSibling が「ディレクトリ
  // 跨ぎ / 端ループ禁止」を課し、null はその方向が端でボタンが disabled。preview 中に
  // displayedOrder が変わり (filter / watcher) 対象がフィルタ外になると両方向 null になる。
  const previewSibling = useMemo(() => {
    if (previewFilename === null) return { prev: null, next: null };
    return pickSibling(displayedOrder, previewFilename);
  }, [displayedOrder, previewFilename]);
  const onPrevPreview = useMemo<(() => void) | null>(
    () =>
      previewSibling.prev === null
        ? null
        : () => setPreviewFilename(previewSibling.prev),
    [previewSibling.prev],
  );
  const onNextPreview = useMemo<(() => void) | null>(
    () =>
      previewSibling.next === null
        ? null
        : () => setPreviewFilename(previewSibling.next),
    [previewSibling.next],
  );

  // 右クリックメニュー state (#47)。同時に 1 つ。Card が位置を onRequestContextMenu で出し、
  // CardContextMenu が outside-click / Esc の lifecycle を持ち onClose で state をクリア。
  // folder 変更で開いたメニューを閉じる。
  const [cardCtxMenu, setCardCtxMenu] = useState<{
    filename: string;
    x: number;
    y: number;
  } | null>(null);
  useLayoutEffect(() => {
    setCardCtxMenu(null);
  }, [folderPath]);

  const onRequestCardContextMenu = useCallback(
    (filename: string, x: number, y: number) => {
      setCardCtxMenu({ filename, x, y });
    },
    [],
  );

  // ダブり候補 (#136)。バッジ対象集合と確認モーダルの起点 filename。folder 変更で閉じるのは
  // 他のモーダル / メニューと同じ。dismiss で pairs が減り起点のペアが尽きたら自動で閉じる
  // (spec §5.3)。
  const duplicateSet = useMemo(
    () => duplicateFileSet(duplicatePairs ?? []),
    [duplicatePairs],
  );
  const [dupModalFilename, setDupModalFilename] = useState<string | null>(
    null,
  );
  useLayoutEffect(() => {
    setDupModalFilename(null);
  }, [folderPath]);
  const dupModalPairs = useMemo(
    () =>
      dupModalFilename === null
        ? []
        : pairsForFile(duplicatePairs ?? [], dupModalFilename),
    [duplicatePairs, dupModalFilename],
  );
  useEffect(() => {
    if (dupModalFilename !== null && dupModalPairs.length === 0) {
      setDupModalFilename(null);
    }
  }, [dupModalFilename, dupModalPairs]);

  const onShowDuplicates = useCallback((filename: string) => {
    setDupModalFilename(filename);
  }, []);

  // ctx メニュー経由 — 先にメニューを閉じてから開く (他の項目と同じ流儀)。
  const onContextMenuShowDuplicates = useCallback(() => {
    if (!cardCtxMenu) return;
    const filename = cardCtxMenu.filename;
    setCardCtxMenu(null);
    setDupModalFilename(filename);
  }, [cardCtxMenu]);

  // bulk アクションの宛先 viewer (#11)。spec §5.6.2 で既定は常に「直近アクティブな viewer」なので、
  // 親の変更報告のたび activeViewerId に同期し明示選択も上書きする。閉じられた viewer が選択中なら
  // active に fallback。context-menu callback の dep 配列がこの値を読むので *前* に宣言する
  // (dep 配列は useCallback() 呼び出し時に評価され、後の const 宣言は TDZ になる、AGENTS.md A-3)。
  const [bulkDstViewerId, setBulkDstViewerId] = useState(activeViewerId);
  useEffect(() => {
    setBulkDstViewerId(activeViewerId);
  }, [activeViewerId]);
  useEffect(() => {
    if (!viewers.some((v) => v.id === bulkDstViewerId)) {
      setBulkDstViewerId(activeViewerId);
    }
  }, [viewers, activeViewerId, bulkDstViewerId]);

  const toast = useToastFn();

  const onContextMenuDelete = useCallback(() => {
    if (!cardCtxMenu) return;
    const filename = cardCtxMenu.filename;
    // confirm を await する前にメニューを閉じる (ConfirmDialog がメニューの裏に隠れず、confirm 中の
    // outside-click が delete flow と race しないように)。
    setCardCtxMenu(null);
    void (async () => {
      const ok = await deleteOne(filename);
      if (ok) onAfterDelete(`${folderPath}/${filename}`);
    })();
  }, [cardCtxMenu, deleteOne, folderPath, onAfterDelete]);

  // single モードの "コピー" (#127)。絶対 path を delete flow と同様に作り、メニューを閉じてから
  // このユーザー操作で発火する。
  const onContextMenuCopy = useCallback(() => {
    if (!cardCtxMenu) return;
    const absPath = `${folderPath}/${cardCtxMenu.filename}`;
    setCardCtxMenu(null);
    void copyImageToClipboard(absPath)
      .then(() => toast("画像をクリップボードにコピーしました", "info"))
      .catch((e) => {
        logger.error("clipboard", "copy failed", {
          path: absPath,
          err: errorMessage(e),
        });
        toast("クリップボードへのコピーに失敗しました (詳細はログ)", "error");
      });
  }, [cardCtxMenu, folderPath, toast]);

  // single モードの「ビューアで開く」— 先にメニューを閉じてから開く (タブ切替後に stale な
  // メニューが viewer タブ上に残らないように)。
  const onContextMenuOpenInViewer = useCallback(
    (viewerId: string) => {
      if (!cardCtxMenu) return;
      const filename = cardCtxMenu.filename;
      setCardCtxMenu(null);
      onOpenInViewer(viewerId, filename);
    },
    [cardCtxMenu, onOpenInViewer],
  );

  // single モードの「選択モードに切り替え」— 右クリック card を選択に加え bulk-toolbar を出す。
  // toggleSelected を使う (無ければ追加/あれば削除)。spec §11-D で single メニューは card が未選択の
  // ときだけ出るので、削除側の分岐はここから到達しない。
  const onContextMenuEnterSelectionMode = useCallback(() => {
    if (!cardCtxMenu) return;
    const filename = cardCtxMenu.filename;
    setCardCtxMenu(null);
    toggleSelected(filename);
  }, [cardCtxMenu, toggleSelected]);

  // bulk アクション — 先にメニューを閉じて dispatch。bulk-toolbar と同じく onOpenMany* 発火直後に
  // clearSelected を同期で呼ぶ (完了時でなく — open IPC は out-of-band)。操作後は clean slate が自然。
  const onContextMenuOpenManyInTabs = useCallback(() => {
    if (!cardCtxMenu) return;
    setCardCtxMenu(null);
    onOpenManyInTabs(bulkDstViewerId, selectedFilenames);
    clearSelected();
  }, [
    cardCtxMenu,
    onOpenManyInTabs,
    bulkDstViewerId,
    selectedFilenames,
    clearSelected,
  ]);

  const onContextMenuOpenManyAsSplit = useCallback(() => {
    if (!cardCtxMenu) return;
    setCardCtxMenu(null);
    onOpenManyAsSplit(bulkDstViewerId, selectedFilenames);
    clearSelected();
  }, [
    cardCtxMenu,
    onOpenManyAsSplit,
    bulkDstViewerId,
    selectedFilenames,
    clearSelected,
  ]);

  const onContextMenuClearSelection = useCallback(() => {
    setCardCtxMenu(null);
    clearSelected();
  }, [clearSelected]);

  if (!folderPath) {
    return (
      <div className="cls-empty-state">
        <div className="cls-empty-state-text">
          分類対象のフォルダを選択してください
        </div>
        <button
          type="button"
          className="cls-empty-state-btn"
          onClick={openFolder}
          disabled={loading}
        >
          フォルダを開く
        </button>
      </div>
    );
  }

  return (
    <div className="cls-view">
      <ClassificationHeader
        folderPath={folderPath}
        allEntries={allEntries}
        filteredEntries={filteredEntries}
        loading={loading}
        sortMode={sortMode}
        onChangeSortMode={setSortMode}
        onOpenFolder={openFolder}
        onReload={reload}
      />
      <TagChips
        entries={allEntries}
        selected={filter.tags}
        untaggedActive={filter.untaggedOnly}
        onToggle={toggleTag}
        onToggleUntagged={toggleUntagged}
        onClear={clearTags}
      />
      <div className="cls-subtoolbar">
        <ConfidenceSegment
          value={filter.confidence}
          onChange={(c) => setFilter({ confidence: c })}
        />
        <SearchBox
          value={filter.query}
          onChange={(q) => setFilter({ query: q })}
        />
        {collapsedGroups.length > 0 ? (
          <button
            type="button"
            className="cls-expand-all-btn"
            onClick={expandAllGroups}
            title="折りたたまれているグループをすべて展開"
          >
            すべて展開
          </button>
        ) : null}
        {allGroupKeys.some((k) => !isCollapsed(k)) ? (
          <button
            type="button"
            className="cls-expand-all-btn"
            onClick={() => collapseAllGroups(allGroupKeys)}
            title="すべてのグループを折りたたむ"
          >
            すべて折りたたむ
          </button>
        ) : null}
      </div>
      {selectedFilenames.length > 0 ? (
        <div className="cls-bulk-toolbar" role="region" aria-label="選択操作">
          <span className="cls-bulk-count">
            {selectedFilenames.length} 件選択中
          </span>
          {viewers.length > 1 ? (
            <label className="cls-bulk-viewer">
              <span className="cls-bulk-viewer-label">開く先</span>
              <select
                className="cls-bulk-viewer-select"
                value={bulkDstViewerId}
                onChange={(e) => setBulkDstViewerId(e.target.value)}
                aria-label="開く先のビューア"
              >
                {viewers.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.id === activeViewerId ? " (現在)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="cls-bulk-btn"
            onClick={() => {
              onOpenManyInTabs(bulkDstViewerId, selectedFilenames);
              clearSelected();
            }}
          >
            タブで開く
          </button>
          <button
            type="button"
            className="cls-bulk-btn"
            onClick={() => {
              onOpenManyAsSplit(bulkDstViewerId, selectedFilenames);
              clearSelected();
            }}
            disabled={selectedFilenames.length > SPLIT_OPEN_LIMIT}
            title={
              selectedFilenames.length > SPLIT_OPEN_LIMIT
                ? `パネル分割で開けるのは ${SPLIT_OPEN_LIMIT} 枚までです (タブで開いてください)`
                : "選択した画像をそれぞれ別パネルに開く"
            }
          >
            パネル分割で開く
          </button>
          <button
            type="button"
            className="cls-bulk-clear"
            onClick={clearSelected}
          >
            選択解除
          </button>
        </div>
      ) : null}
      {loading && allEntries.length === 0 ? (
        <div className="cls-grid-loading">読み込み中…</div>
      ) : filteredGroups.length === 0 ? (
        <div className="cls-grid-empty">該当する画像がありません</div>
      ) : (
        <div
          className="cls-groups"
          ref={groupsRefCallback}
          onScroll={onGroupsScroll}
          onKeyDown={onGroupsKeyDown}
        >
          {filteredGroups.map((g) => (
            <DirectoryGroup
              key={g.key}
              group={g}
              totalCount={totalCountByGroup.get(g.key) ?? g.entries.length}
              collapsed={isCollapsed(g.key)}
              folderPath={folderPath}
              isSelected={isSelected}
              selectionMode={selectedFilenames.length > 0}
              showCheckbox={showCheckbox}
              modifierEnabled={modifierEnabled}
              onToggle={toggleGroup}
              onClickEdit={openEditModal}
              onClickPreview={openPreview}
              onToggleSelect={toggleSelected}
              onExtendSelectionTo={(filename) =>
                extendSelectionTo(filename, displayedOrder)
              }
              onRequestCardContextMenu={onRequestCardContextMenu}
              duplicateSet={duplicateSet}
              onShowDuplicates={onShowDuplicates}
            />
          ))}
        </div>
      )}
      <ConflictDialog
        open={conflict !== null}
        onReload={resolveConflictReload}
        onForce={resolveConflictForce}
        onCancel={resolveConflictCancel}
      />
      <MergePromptDialog
        open={mergePrompt.open}
        preview={mergePrompt.preview}
        onMerge={resolveMergeMerge}
        onSkip={resolveMergeSkip}
        onCancel={resolveMergeCancel}
      />
      <SampleModal
        open={previewFilename !== null}
        imagePath={
          previewFilename ? `${folderPath}/${previewFilename}` : null
        }
        filename={previewFilename}
        onClose={closePreview}
        viewers={viewers}
        activeViewerId={activeViewerId}
        onOpenInViewer={(viewerId) => {
          if (previewFilename) onOpenInViewer(viewerId, previewFilename);
          closePreview();
        }}
        onPrev={onPrevPreview}
        onNext={onNextPreview}
        entry={previewEntry}
        knownTags={knownTags}
        openSource={previewOpenSource}
        folder={folderPath}
        onSave={handleSave}
        autoSave={editAutoSave}
      />
      <DuplicatePairsModal
        open={dupModalFilename !== null}
        folderPath={folderPath}
        filename={dupModalFilename}
        pairs={dupModalPairs}
        onDismissPair={(fileA, fileB) => {
          void dismissDuplicatePair(fileA, fileB);
        }}
        onClose={() => setDupModalFilename(null)}
      />
      {cardCtxMenu ? (
        <CardContextMenu
          // filename / x / y 変更で re-mount し、メニューの useState 位置 seed を再評価する。
          // fresh mount しないと新座標で開き直しても最初のカーソル位置を保ってしまう。
          key={`${cardCtxMenu.filename}|${cardCtxMenu.x},${cardCtxMenu.y}`}
          x={cardCtxMenu.x}
          y={cardCtxMenu.y}
          mode={computeCardContextMenuMode(
            selectedFilenames,
            cardCtxMenu.filename,
          )}
          viewers={viewers}
          activeViewerId={activeViewerId}
          selectedCount={selectedFilenames.length}
          bulkDstViewerId={bulkDstViewerId}
          onOpenInViewer={onContextMenuOpenInViewer}
          onCopy={onContextMenuCopy}
          onShowDuplicates={
            duplicateSet.has(cardCtxMenu.filename)
              ? onContextMenuShowDuplicates
              : null
          }
          onEnterSelectionMode={onContextMenuEnterSelectionMode}
          onDelete={onContextMenuDelete}
          onOpenManyInTabs={onContextMenuOpenManyInTabs}
          onOpenManyAsSplit={onContextMenuOpenManyAsSplit}
          onClearSelection={onContextMenuClearSelection}
          onClose={() => setCardCtxMenu(null)}
        />
      ) : null}
    </div>
  );
}
