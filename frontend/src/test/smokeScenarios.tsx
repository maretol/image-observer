import { useMemo, useState } from 'react';
import { ClassificationView } from '../features/classification/ClassificationView';
import type { UseClassificationReturn } from '../features/classification/useClassification';
import { ViewerGrid } from '../features/viewer-grid/ViewerGrid';
import {
  closeTabInLeaf,
  moveTabIntoLeaf,
  reorderTabInLeaf,
  setActivePanel,
  setActiveTabInLeaf,
  setSplitRatio,
  splitFromContextMenu,
  splitTabIntoEdge,
  updateTabInLeaf,
  type Layout,
} from '../features/viewer-grid/layout';
import type { Tab } from '../features/viewer-grid/useTabs';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { makeLoadResult, makeSettings, makeViewerLayout } from './fixtures';

export function SmokeScenario({ scenario }: { scenario: string }) {
  if (scenario === 'classification') return <ClassificationScenario />;
  if (scenario === 'viewer') return <ViewerScenario />;
  return <SettingsScenario />;
}

function ClassificationScenario() {
  const loadResult = useMemo(() => makeLoadResult(), []);
  const state: UseClassificationReturn = {
    folderPath: loadResult.folderPath,
    loadResult,
    loading: false,
    error: null,
    filter: { tags: [], confidence: 'all', query: '' },
    filteredEntries: loadResult.entries,
    editing: { open: false, filename: null },
    conflict: null,
    mergePrompt: { open: false, preview: null, folderPath: '' },
    collapsedGroups: [],
    isCollapsed: () => false,
    toggleGroup: () => {},
    expandAllGroups: () => {},
    collapseAllGroups: () => {},
    selectedFilenames: ['cat-01.png', 'cat-02.png'],
    isSelected: (filename) => ['cat-01.png', 'cat-02.png'].includes(filename),
    toggleSelected: () => {},
    extendSelectionTo: () => {},
    clearSelected: () => {},
    openFolder: async () => {},
    reload: async () => {},
    setFilter: () => {},
    toggleTag: () => {},
    clearTags: () => {},
    openEdit: () => {},
    closeEdit: () => {},
    saveEdit: async () => {},
    resolveConflictReload: async () => {},
    resolveConflictForce: async () => {},
    resolveConflictCancel: () => {},
    resolveMergeMerge: async () => {},
    resolveMergeSkip: async () => {},
    resolveMergeCancel: () => {},
    persistableState: {
      folderPath: loadResult.folderPath,
      filter: { tags: [], confidence: 'all', query: '' },
      collapsedGroups: [],
    },
  };

  return (
    <div data-testid="smoke-root" style={{ width: 1280, minHeight: 900 }}>
      <ClassificationView
        state={state}
        multiSelectMode="both"
        onOpenInViewer={() => {}}
        onOpenManyInTabs={() => {}}
        onOpenManyAsSplit={() => {}}
      />
    </div>
  );
}

function ViewerScenario() {
  const [layout, setLayout] = useState<Layout>(() => makeViewerLayout());

  return (
    <div data-testid="smoke-root" style={{ width: 1280, height: 760 }}>
      <ViewerGrid
        layout={layout}
        wheelMode="zoom"
        onActivatePanel={(leafId) => setLayout((cur) => setActivePanel(cur, leafId))}
        onSelectTab={(leafId, tabIndex) =>
          setLayout((cur) => setActiveTabInLeaf(cur, leafId, tabIndex))
        }
        onCloseTab={(leafId, tabIndex) =>
          setLayout((cur) => closeTabInLeaf(cur, leafId, tabIndex))
        }
        onUpdateTabState={(leafId, tabIndex, patch) =>
          setLayout((cur) => updateTabInLeaf(cur, leafId, tabIndex, patch))
        }
        onMoveTab={(srcLeafId, srcIdx, dstLeafId, dstIdx) =>
          setLayout((cur) => moveTabIntoLeaf(cur, srcLeafId, srcIdx, dstLeafId, dstIdx))
        }
        onReorderTab={(leafId, srcIdx, dstIdx) =>
          setLayout((cur) => reorderTabInLeaf(cur, leafId, srcIdx, dstIdx))
        }
        onSplitTab={(srcLeafId, srcIdx, dstLeafId, edge) => {
          let ok = false;
          setLayout((cur) => {
            const result = splitTabIntoEdge(cur, srcLeafId, srcIdx, dstLeafId, edge);
            ok = result.ok;
            return result.layout;
          });
          return ok;
        }}
        onSplitFromContext={(leafId, tabIndex, direction) => {
          let ok = false;
          setLayout((cur) => {
            const result = splitFromContextMenu(cur, leafId, tabIndex, direction);
            ok = result.ok;
            return result.layout;
          });
          return ok;
        }}
        onSetSplitRatio={(splitId, ratio) =>
          setLayout((cur) => setSplitRatio(cur, splitId, ratio))
        }
      />
    </div>
  );
}

function SettingsScenario() {
  const data = makeSettings();
  return (
    <div data-testid="smoke-root" style={{ width: 1280, minHeight: 900 }}>
      <SettingsDialog
        open
        data={data}
        loading={false}
        error={null}
        logPath="/tmp/image-observer/app.log"
        onChange={(_patch: Partial<typeof data>) => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    </div>
  );
}
