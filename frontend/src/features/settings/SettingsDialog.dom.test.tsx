import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from './SettingsDialog';
import { makeSettings } from '../../test/fixtures';

describe('SettingsDialog smoke', () => {
  it('switches category and section content', async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog
        open
        data={makeSettings()}
        loading={false}
        error={null}
        logPath="/tmp/image-observer/app.log"
        onChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('ログレベル')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'タグ色' }));
    expect(screen.getByText('既知タグのバッジ色')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'ショートカット' }));
    expect(screen.getByText('現在のキーバインド一覧')).toBeInTheDocument();
  });
});
