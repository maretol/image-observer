// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsDialog } from './SettingsDialog';
import { makeSettings } from '../../test/fixtures';

describe('SettingsDialog smoke', () => {
  it('switches category and section content', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'タグ色' }));
    expect(screen.getByText('既知タグのバッジ色マッピング (settings.json で編集)。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ショートカット' }));
    expect(screen.getByText('現在のキーバインド一覧 (再バインドは未対応)。')).toBeInTheDocument();
  });
});
