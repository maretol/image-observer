import { useMemo } from "react";
import { ConflictDialog } from "../../shared/components/ConflictDialog";
import { MergePromptDialog } from "../../shared/components/MergePromptDialog";
import { ClassificationHeader } from "./ClassificationHeader";
import { ConfidenceSegment } from "./ConfidenceSegment";
import { DirectoryGroup } from "./DirectoryGroup";
import { EditPopover } from "./EditPopover";
import { SearchBox } from "./SearchBox";
import { TagChips } from "./TagChips";
import { tagSummary } from "./filters";
import { groupByDirectory, groupKeyOf } from "./groups";
import type { UseClassificationReturn } from "./useClassification";

export type ClassificationViewProps = {
  state: UseClassificationReturn;
  onOpenInViewer: (filename: string) => void;
};

export function ClassificationView({
  state,
  onOpenInViewer,
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
    collapsedGroups,
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
  const totalCountByGroup = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of allEntries) {
      const k = groupKeyOf(e.filename);
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  }, [allEntries]);

  const filteredGroups = useMemo(
    () => groupByDirectory(filteredEntries),
    [filteredEntries],
  );

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
        totalCount={allEntries.length}
        filteredCount={filteredEntries.length}
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
      </div>
      {loading && allEntries.length === 0 ? (
        <div className="cls-grid-loading">読み込み中…</div>
      ) : filteredGroups.length === 0 ? (
        <div className="cls-grid-empty">該当する画像がありません</div>
      ) : (
        <div className="cls-groups">
          {filteredGroups.map((g) => (
            <DirectoryGroup
              key={g.key}
              group={g}
              totalCount={totalCountByGroup.get(g.key) ?? g.entries.length}
              collapsed={isCollapsed(g.key)}
              folderPath={folderPath}
              onToggle={toggleGroup}
              onClickThumb={onOpenInViewer}
              onClickEdit={openEdit}
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
    </div>
  );
}
