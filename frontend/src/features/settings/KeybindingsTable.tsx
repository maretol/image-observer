// v1 では read-only。将来の Phase H rebinding 用に keybindings.* の設定キーを分離しておく。
const KEYBINDINGS: Array<{ keys: string; action: string; scope: string }> = [
  { keys: "Esc", action: "ドラッグ中の操作をキャンセル", scope: "DnD 中" },
  { keys: "Ctrl+Shift+1", action: "一覧タブに切替", scope: "全体" },
  {
    keys: "Ctrl+Shift+2 〜 9",
    action: "N 番目 (1〜8) のビューアタブに切替",
    scope: "全体",
  },
  {
    keys: "ダブルクリック (タブ名)",
    action: "ビューア名を編集 (Enter で確定 / Esc で破棄)",
    scope: "全体",
  },
  { keys: "Ctrl+W", action: "アクティブパネルのアクティブタブを閉じる", scope: "ビューア" },
  { keys: "Ctrl+Tab", action: "アクティブパネルの次のタブに切替", scope: "ビューア" },
  { keys: "Ctrl+Shift+Tab", action: "アクティブパネルの前のタブに切替", scope: "ビューア" },
  { keys: "Ctrl+0", action: "画像をフィット表示", scope: "ビューア" },
  { keys: "Ctrl+1", action: "画像を 100% 表示", scope: "ビューア" },
  { keys: "Ctrl++ / Ctrl+=", action: "ズームイン (中心基準)", scope: "ビューア" },
  { keys: "Ctrl+-", action: "ズームアウト (中心基準)", scope: "ビューア" },
  {
    keys: "Shift+ホイール / Ctrl+ホイール",
    action: "ズームイン / アウト (画像領域のみ。Shift / Ctrl + ホイール モード時)",
    scope: "ビューア",
  },
  {
    keys: "Ctrl+クリック",
    action: "Card の選択トグル (修飾キー / 両方モード)",
    scope: "一覧",
  },
  {
    keys: "Shift+クリック",
    action: "アンカーから現在位置まで範囲選択 (修飾キー / 両方モード)",
    scope: "一覧",
  },
  {
    keys: "← / → / ↑ / ↓",
    action: "カードを移動 (カードにフォーカス時)",
    scope: "一覧",
  },
  {
    keys: "t / c / n",
    action: "プレビューでタグ / confidence / note 編集にフォーカス",
    scope: "一覧 (プレビュー)",
  },
];

export function KeybindingsTable() {
  return (
    <table className="settings-kb-table">
      <thead>
        <tr>
          <th>キー</th>
          <th>動作</th>
          <th>スコープ</th>
        </tr>
      </thead>
      <tbody>
        {KEYBINDINGS.map((kb) => (
          <tr key={kb.keys}>
            <td>
              <kbd>{kb.keys}</kbd>
            </td>
            <td>{kb.action}</td>
            <td>{kb.scope}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
