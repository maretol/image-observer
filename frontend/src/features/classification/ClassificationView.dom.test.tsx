import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { ClassificationView } from './ClassificationView';
import type { UseClassificationReturn } from './useClassification';
import { makeLoadResult } from '../../test/fixtures';

describe('ClassificationView smoke', () => {
  it('opens a card in viewer and exposes bulk actions', async () => {
    const user = userEvent.setup();
    const loadResult = makeLoadResult();
    const onOpenInViewer = vi.fn();
    const onOpenManyInTabs = vi.fn();
    const onOpenManyAsSplit = vi.fn();
    const clearSelected = vi.fn();

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
      clearSelected,
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

    render(
      <ClassificationView
        state={state}
        multiSelectMode="modifier"
        onOpenInViewer={onOpenInViewer}
        onOpenManyInTabs={onOpenManyInTabs}
        onOpenManyAsSplit={onOpenManyAsSplit}
      />,
    );

    await user.click(screen.getByTitle('cat-01.png'));
    expect(onOpenInViewer).toHaveBeenCalledWith('cat-01.png');

    await user.click(screen.getByRole('button', { name: 'タブで開く' }));
    expect(onOpenManyInTabs).toHaveBeenCalledWith(['cat-01.png', 'cat-02.png']);
    expect(clearSelected).toHaveBeenCalledTimes(1);
  });
});
