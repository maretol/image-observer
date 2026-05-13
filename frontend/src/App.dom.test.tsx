// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App smoke', () => {
  it('renders the top tabs, switches panels, and opens settings', async () => {
    render(<App />);

    expect(await screen.findByRole('tab', { name: '一覧' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'ビューア' })).toBeInTheDocument();
    expect(
      await screen.findByText('分類対象のフォルダを選択してください'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'ビューア' }));
    expect(await screen.findByText('画像を選択してください')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }));
    expect(await screen.findByRole('dialog', { name: '設定' })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('閉じる'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '設定' })).not.toBeInTheDocument();
    });
  });
});
