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
import { ConflictDialog } from "../../shared/components/ConflictDialog";
import { MergePromptDialog } from "../../shared/components/MergePromptDialog";
import { ClassificationHeader } from "./ClassificationHeader";
import { ConfidenceSegment } from "./ConfidenceSegment";
import { DirectoryGroup } from "./DirectoryGroup";
import { EditPopover } from "./EditPopover";
import { SampleModal } from "./SampleModal";
import { SearchBox } from "./SearchBox";
import { TagChips } from "./TagChips";
import { tagSummary } from "./filters";
import { groupByDirectory, groupKeyOf } from "./groups";
import type { UseClassificationReturn } from "./useClassification";

export type ClassificationViewProps = {
  state: UseClassificationReturn;
  // "checkbox" (default) | "modifier" | "both" — see settings.SettingsData.
  // Falls back to "checkbox" while settings load.
  multiSelectMode?: string;
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
};

// Visual sanity ceiling for the "split-open" path. 8 panels in a row already
// gets cramped on a 1080p display; beyond that we suggest "tabs" instead.
const SPLIT_OPEN_LIMIT = 8;

export function ClassificationView({
  state,
  multiSelectMode = "checkbox",
  scrollTopRef,
  viewers,
  activeViewerId,
  onOpenInViewer,
  onOpenManyInTabs,
  onOpenManyAsSplit,
}: ClassificationViewProps) {
  const {
    folderPath,
    loadResult,
    loading,
    filter,
    filteredEntries,
    editing,
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
  } = state;

  const allEntries = loadResult?.entries ?? [];

  const editingEntry = useMemo(() => {
    if (!editing.open || !editing.filename) return null;
    return allEntries.find((e) => e.filename === editing.filename) ?? null;
  }, [editing, allEntries]);

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

  // Sample modal (#9). Filename only — paired with folderPath in render to
  // build the IPC path. Folder change dismisses an open preview because the
  // captured filename no longer belongs to the current view. Not persisted.
  const [previewFilename, setPreviewFilename] = useState<string | null>(null);
  const openPreview = useCallback((filename: string) => {
    setPreviewFilename(filename);
  }, []);
  const closePreview = useCallback(() => {
    setPreviewFilename(null);
  }, []);
  useLayoutEffect(() => {
    setPreviewFilename(null);
  }, [folderPath]);

  // Bulk-actions destination viewer (#11). Per spec §5.6.2 the default is
  // always "the most recently active viewer" — so we always sync to
  // activeViewerId whenever the parent reports a change, overriding any
  // explicit user pick. This keeps "open" intuitive after the user switches
  // viewers in the viewer tab and returns. Defensive: fall back to active if
  // the currently picked viewer was closed.
  const [bulkDstViewerId, setBulkDstViewerId] = useState(activeViewerId);
  useEffect(() => {
    setBulkDstViewerId(activeViewerId);
  }, [activeViewerId]);
  useEffect(() => {
    if (!viewers.some((v) => v.id === bulkDstViewerId)) {
      setBulkDstViewerId(activeViewerId);
    }
  }, [viewers, activeViewerId, bulkDstViewerId]);

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
        onToggle={toggleTag}
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
              onClickEdit={openEdit}
              onClickPreview={openPreview}
              onToggleSelect={toggleSelected}
              onExtendSelectionTo={(filename) =>
                extendSelectionTo(filename, displayedOrder)
              }
            />
          ))}
        </div>
      )}
      <EditPopover
        open={editing.open}
        entry={editingEntry}
        knownTags={knownTags}
        onSave={saveEdit}
        onCancel={closeEdit}
      />
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
      />
    </div>
  );
}
