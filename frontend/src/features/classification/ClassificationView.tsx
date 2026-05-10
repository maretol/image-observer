import { useMemo } from "react";
import { ConflictDialog } from "../../shared/components/ConflictDialog";
import { ClassificationGrid } from "./ClassificationGrid";
import { ClassificationHeader } from "./ClassificationHeader";
import { ConfidenceSegment } from "./ConfidenceSegment";
import { EditPopover } from "./EditPopover";
import { Lightbox } from "./Lightbox";
import { SearchBox } from "./SearchBox";
import { TagChips } from "./TagChips";
import { tagSummary } from "./filters";
import type { UseClassificationReturn } from "./useClassification";

export type ClassificationViewProps = {
  state: UseClassificationReturn;
};

export function ClassificationView({ state }: ClassificationViewProps) {
  const {
    folderPath,
    loadResult,
    loading,
    filter,
    filteredEntries,
    lightbox,
    editing,
    conflict,
    openFolder,
    reload,
    setFilter,
    toggleTag,
    clearTags,
    openLightbox,
    closeLightbox,
    nextLightbox,
    prevLightbox,
    openEdit,
    closeEdit,
    saveEdit,
    resolveConflictReload,
    resolveConflictForce,
    resolveConflictCancel,
  } = state;

  const allEntries = loadResult?.entries ?? [];

  const editingEntry = useMemo(() => {
    if (!editing.open || !editing.filename) return null;
    return allEntries.find((e) => e.filename === editing.filename) ?? null;
  }, [editing, allEntries]);

  const lightboxEntry = useMemo(() => {
    if (!lightbox.open || !lightbox.filename) return null;
    return (
      filteredEntries.find((e) => e.filename === lightbox.filename) ?? null
    );
  }, [lightbox, filteredEntries]);

  const knownTags = useMemo(() => {
    return Array.from(tagSummary(allEntries).keys()).sort();
  }, [allEntries]);

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
      </div>
      {loading && allEntries.length === 0 ? (
        <div className="cls-grid-loading">読み込み中…</div>
      ) : (
        <ClassificationGrid
          folderPath={folderPath}
          entries={filteredEntries}
          onClickThumb={openLightbox}
          onClickEdit={openEdit}
        />
      )}
      <Lightbox
        open={lightbox.open}
        folderPath={folderPath}
        entry={lightboxEntry}
        onClose={closeLightbox}
        onPrev={prevLightbox}
        onNext={nextLightbox}
      />
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
    </div>
  );
}
