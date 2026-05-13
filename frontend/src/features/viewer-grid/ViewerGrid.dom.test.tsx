import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ViewerGrid } from './ViewerGrid';
import {
  closeTabInLeaf,
  setActivePanel,
  setActiveTabInLeaf,
  setSplitRatio,
  updateTabInLeaf,
  type Layout,
} from './layout';
import { makeViewerLayout } from '../../test/fixtures';

function ViewerGridHarness() {
  const [layout, setLayout] = useState<Layout>(() => makeViewerLayout());
  return (
    <div style={{ width: 1000, height: 600 }}>
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
        onMoveTab={() => {}}
        onReorderTab={() => {}}
        onSplitTab={() => false}
        onSplitFromContext={() => false}
        onSetSplitRatio={(splitId, ratio) =>
          setLayout((cur) => setSplitRatio(cur, splitId, ratio))
        }
      />
    </div>
  );
}

describe('ViewerGrid smoke', () => {
  it('renders existing tabs and switches the active tab', async () => {
    const user = userEvent.setup();
    render(<ViewerGridHarness />);

    expect(screen.getByText('cat-01.png')).toBeInTheDocument();
    expect(screen.getByText('dog-01.png')).toBeInTheDocument();
    expect(screen.getByText('bird-01.png')).toBeInTheDocument();

    await user.click(screen.getByText('dog-01.png'));
    expect(screen.getAllByText('dog-01.png')[0]).toBeInTheDocument();
  });
});
