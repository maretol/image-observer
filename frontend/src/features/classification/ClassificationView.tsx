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
import type { UseClassificationReturn } from "./useClassification";

export type ClassificationViewProps = {
  state: UseClassificationReturn;
  // "checkbox" (default) | "modifier" | "both" — see settings.SettingsData.
  // Falls back to "checkbox" while settings load.
  multiSelectMode?: string;
  // #105: drives SampleEditPane save mode. Optional because settings load
  // is async — `undefined` (still loading) is treated the same as `true`
  // (auto), matching the persisted default so users don't see manual-mode
  // chrome flash during the first paint.
  editAutoSave?: boolean;
  // Owned by the parent so the scroll position survives ClassificationView
  // unmount when the top tab switches away from "list". Folder changes reset
  // it to 0 (handled below). Not persisted to settings/state.json.
  scrollTopRef: MutableRefObject<number>;
  // Multi-viewer (#11): the parent passes the current viewer set + active
  // viewer id so the SampleModal viewer-picker and bulk-actions dropdown can
  // render their options. The open callbacks now take a destination viewer id.
  viewers: { id: string; name: string }[];
  activeViewerId: string;
  onOpenInViewer: (viewerId: string, filename: string) => void;
  onOpenManyInTabs: (viewerId: string, filenames: string[]) => void;
  onOpenManyAsSplit: (viewerId: string, filenames: string[]) => void;
  // Called with the deleted file's absolute path after deleteOne() succeeds
  // so the parent can close any viewer tabs still referencing it (#47).
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
  } = state;

  const allEntries = loadResult?.entries ?? [];

  const knownTags = useMemo(() => {
    return Array.from(tagSummary(allEntries).keys()).sort();
  }, [allEntries]);

  // Total counts per group (before filtering) — needed so collapsed group
  // headers can show e.g. "5 / 12" even when filter has hidden some entries.
  // allGroupKeys derives the full ordered list of directory keys from the
  // unfiltered entries, used by the "すべて折りたたむ" button.
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

  const filteredGroups = useMemo(
    () => groupByDirectory(filteredEntries),
    [filteredEntries],
  );

  // Flat order of currently visible cards for Shift+click range selection.
  // Folds the groups in display order; collapsed groups are still included
  // (range can span across collapsed sections, matching Finder behavior).
  const displayedOrder = useMemo(
    () => filteredGroups.flatMap((g) => g.entries.map((e) => e.filename)),
    [filteredGroups],
  );

  const showCheckbox =
    multiSelectMode === "checkbox" || multiSelectMode === "both";
  const modifierEnabled =
    multiSelectMode === "modifier" || multiSelectMode === "both";

  // Scroll position survival (#40).
  // The `.cls-groups` element can disappear and reappear during a single
  // ClassificationView lifetime (filter clears all entries → comes back), and
  // the ClassificationView itself unmounts when the top tab switches to
  // "viewer". The parent-owned `scrollTopRef` outlives both. A ref callback
  // on the scroll container handles the "remount" cases by restoring on
  // attach; `onScroll` writes back. Folder changes reset to top.
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

  // Arrow-key grid navigation (#115). When a card thumb (or a control inside
  // it) is focused, ←/→ move through cards in reading (DOM) order — flowing
  // across row and directory-group boundaries — and ↑/↓ move by visual row,
  // picking the card whose horizontal center is nearest. pickGridNeighbor owns
  // the (testable) decision; collapsed groups render no cards so they're
  // skipped automatically. Enter/Space activation already lives on the Card
  // thumb itself, so we only move focus here. The handler is bound on the
  // scroll container and reacts to the keydown bubbling up from the focused
  // element.
  const onGroupsKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const dir = arrowDirection(e.key);
      if (!dir) return;
      const container = groupsElRef.current;
      if (!container) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      // Resolve the card thumb from the focused element. Focus may sit on a
      // control *inside* the thumb — the selection checkbox and the edit
      // button both live within .cls-card-thumb — so match the nearest
      // ancestor instead of requiring the thumb itself to be the active
      // element. Returns null for focus outside any card (filter inputs live
      // outside .cls-groups), leaving arrows to their default behavior.
      const thumb = active.closest<HTMLElement>(".cls-card-thumb");
      if (!thumb) return;
      const cards = Array.from(
        container.querySelectorAll<HTMLElement>(".cls-card-thumb"),
      );
      const current = cards.indexOf(thumb);
      if (current < 0) return;
      // Pass a lazy getRect accessor: ←/→ never call it, and ↑/↓ measure only
      // the cards near the cursor (pickGridNeighbor early-exits at the adjacent
      // row), so key-repeat stays off the O(n) getBoundingClientRect sweep.
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
  // Reset on folder change. Initialized with the current folderPath so the
  // first mount after a tab switch (folderPath unchanged) does NOT reset and
  // the restore-on-attach path above wins.
  const lastFolderRef = useRef(folderPath);
  useLayoutEffect(() => {
    if (lastFolderRef.current === folderPath) return;
    lastFolderRef.current = folderPath;
    scrollTopRef.current = 0;
    if (groupsElRef.current) groupsElRef.current.scrollTop = 0;
  }, [folderPath, scrollTopRef]);

  // Sample modal (#9, unified preview+edit since #93). Filename only —
  // paired with folderPath in render to build the IPC path. Folder change
  // dismisses an open preview because the captured filename no longer
  // belongs to the current view. Not persisted.
  //
  // `previewOpenSource` records *how* the modal was opened so the unified
  // modal can route initial focus: "preview" leaves focus on the preview
  // side (Card thumb click / keyboard activation), "edit" autofocuses the
  // tag input (Card pencil button / context-menu 編集). See spec §5.2.
  const [previewFilename, setPreviewFilename] = useState<string | null>(null);
  const [previewOpenSource, setPreviewOpenSource] =
    useState<SampleModalOpenSource>("preview");
  // The unified modal also drives `useClassification.editing` so the
  // existing replay-defer machinery in useClassificationReplay (watcher
  // events arriving while editing.open=true get parked and replayed when
  // the modal closes) keeps working. Both preview and edit triggers open
  // the same modal and set editing.open=true — the underlying semantics
  // ("an entry is being inspected, hold external merges briefly") apply
  // equally to both starting points.
  //
  // saveEdit success path clears editing.open=false (legacy EditPopover
  // semantics — popover closed on save). The unified modal stays open
  // after save per spec §5.3, so handleSave re-flags editing.open=true
  // below to keep defer effective while the user keeps viewing the
  // entry.
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

  // saveEdit clears editing.open=false on success (legacy EditPopover
  // semantics). For the unified modal we want editing.open to track the
  // modal's open-state so subsequent watcher events keep getting deferred
  // while the user is still viewing the entry. The one-frame
  // true → false → true transition at save intentionally fires
  // useClassificationReplay's performReplay() exactly once — saved =
  // editing confirmed, so draining any deferred watcher results into the
  // refreshed baseline is the correct moment. Conflict / error paths in
  // saveEdit leave editing untouched, in which case re-calling openEdit
  // with the same filename is a no-op same-value setState.
  //
  // previewFilenameRef provides the *current* (not closure-captured)
  // filename at await completion. Without the ref, "保存クリック → 即
  // Esc/×/backdrop で閉じる" の操作で handleSave のクロージャが閉じる前の
  // previewFilename を保持したまま openEdit を呼んでしまい、モーダルが
  // 閉じた後に editing.open=true が復活して watcher replay の defer が
  // 解除されない。render-time assignment は AGENTS.md H-8 の
  // "state ref の同期タイミング" に従う。
  const previewFilenameRef = useRef<string | null>(null);
  previewFilenameRef.current = previewFilename;
  // handleSave forwards the SaveContext from SampleEditPane straight through to
  // saveEdit (#110 C). The folder-switch race the old folderPathRef band-aid
  // guarded (PR #109 round 6) now lives inside saveEdit: SampleEditPane captures
  // the folder at the snapshot's origin (render-synced folderPropRef, which
  // stays OLD once a folder switch unmounts the pane), so a stale save-on-unmount
  // cleanup carries ctx.folder = OLD and saveEdit's pre-IPC gate skips it. No
  // stale-closure comparison here anymore.
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

  // Edit pane resolves the active entry from previewFilename against the
  // current loadResult — the unified SampleModal (#93) owns the open
  // filename directly instead of going through useClassification.editing,
  // so the lookup happens here and the entry is passed in as a prop.
  const previewEntry = useMemo(() => {
    if (previewFilename === null) return null;
    return allEntries.find((e) => e.filename === previewFilename) ?? null;
  }, [previewFilename, allEntries]);

  // Sample modal prev/next navigation (#94). Derived from `displayedOrder`
  // (already collapsed-aware: Shift+click range selection also includes
  // collapsed groups). pickSibling enforces the "no directory cross / no
  // end-loop" contract; null means the respective direction is at an edge
  // and the SampleModal renders the button as disabled. When displayedOrder
  // updates mid-preview (filter / watcher) the memo recomputes — if the
  // currently previewed file is filtered out both directions become null
  // and the nav buttons disable, leaving the user with Esc / close.
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

  // Right-click context menu state (#47). One menu instance at a time. The
  // Card emits position via onRequestContextMenu; CardContextMenu owns its
  // outside-click / Esc lifecycle and calls onClose to clear this state.
  // Folder change dismisses an open menu because the captured filename no
  // longer belongs to the current view.
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

  // Bulk-actions destination viewer (#11). Per spec §5.6.2 the default is
  // always "the most recently active viewer" — so we always sync to
  // activeViewerId whenever the parent reports a change, overriding any
  // explicit user pick. This keeps "open" intuitive after the user switches
  // viewers in the viewer tab and returns. Defensive: fall back to active if
  // the currently picked viewer was closed. Declared *before* the
  // context-menu callbacks because their dep arrays read this value (and
  // dep arrays are evaluated at useCallback() call time — so a later const
  // declaration would be in the temporal dead zone; same pattern as #27's
  // selectAnchorRef relocation, per AGENTS.md A-3).
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
    // Close the menu BEFORE awaiting confirm so the ConfirmDialog modal isn't
    // visually behind the menu, and so a stray outside-click closing the menu
    // mid-confirm can't race with the delete flow.
    setCardCtxMenu(null);
    void (async () => {
      const ok = await deleteOne(filename);
      if (ok) onAfterDelete(`${folderPath}/${filename}`);
    })();
  }, [cardCtxMenu, deleteOne, folderPath, onAfterDelete]);

  // Single-mode "コピー" — copy the right-clicked card's full-resolution image
  // to the clipboard (#127). Build the absolute path the same way the delete
  // flow does, close the menu, then fire from this user gesture.
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

  // Single-mode "ビューア「{name}」で開く" — close menu first, then open.
  // Closing before the async open avoids a stale menu sitting on top of the
  // viewer tab after the top tab switches.
  const onContextMenuOpenInViewer = useCallback(
    (viewerId: string) => {
      if (!cardCtxMenu) return;
      const filename = cardCtxMenu.filename;
      setCardCtxMenu(null);
      onOpenInViewer(viewerId, filename);
    },
    [cardCtxMenu, onOpenInViewer],
  );

  // Single-mode "選択モードに切り替え" — add the right-clicked card to the
  // selection set so the bulk-toolbar appears. We use toggleSelected (which
  // adds when absent, removes when present). The "already-selected" branch
  // would actually deselect the card, but spec §11-D guarantees the single
  // menu is only shown when the card is NOT in selection, so that branch is
  // unreachable from here.
  const onContextMenuEnterSelectionMode = useCallback(() => {
    if (!cardCtxMenu) return;
    const filename = cardCtxMenu.filename;
    setCardCtxMenu(null);
    toggleSelected(filename);
  }, [cardCtxMenu, toggleSelected]);

  // Bulk-mode actions — close menu first, then dispatch. Match the bulk-
  // toolbar buttons: we call clearSelected synchronously right after firing
  // onOpenMany* (not "on completion" — the open IPC runs out-of-band). The
  // toolbar makes the same deliberate UX choice: once the user has invoked
  // the action they typically want a clean slate.
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
      {cardCtxMenu ? (
        <CardContextMenu
          // Re-mount on filename / x / y change so the menu's useState
          // position seed is re-evaluated (Copilot review #58 thread #1).
          // Without a fresh mount the menu would keep its first cursor
          // position even if the parent opens it again at new coords.
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
