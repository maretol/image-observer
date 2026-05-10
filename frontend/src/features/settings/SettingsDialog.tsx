import { useEffect } from "react";
import type { Settings } from "./useSettings";

export type SettingsDialogProps = {
  open: boolean;
  data: Settings | null;
  loading: boolean;
  error: string | null;
  logPath: string;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  onClose: () => void;
};

const LOG_LEVELS: Array<{ value: string; label: string; hint: string }> = [
  { value: "debug", label: "DEBUG", hint: "詳細 (高頻度イベント含む)" },
  { value: "info", label: "INFO", hint: "標準 (推奨)" },
  { value: "warn", label: "WARN", hint: "警告以上のみ" },
  { value: "error", label: "ERROR", hint: "エラーのみ" },
];

const MULTI_SELECT_MODES: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  { value: "checkbox", label: "チェックボックス", hint: "Card 左上のチェックで選択 (現状)" },
  {
    value: "modifier",
    label: "修飾キー",
    hint: "Ctrl+クリックでトグル / Shift+クリックで範囲 (将来実装)",
  },
  { value: "both", label: "両方", hint: "チェックボックス + 修飾キー (将来実装)" },
];

export function SettingsDialog({
  open,
  data,
  loading,
  error,
  logPath,
  onChange,
  onReset,
  onClose,
}: SettingsDialogProps) {
  // Esc to close — registered only when open to avoid stealing keys otherwise.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={onClose}
    >
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h2 id="settings-title" className="settings-title">
            設定
          </h2>
          <button
            type="button"
            className="settings-close"
            aria-label="閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="settings-body">
          {loading ? (
            <div className="settings-loading">読み込み中…</div>
          ) : !data ? (
            <div className="settings-error">
              設定の読み込みに失敗しました
              {error ? `: ${error}` : null}
            </div>
          ) : (
            <>
              <Section title="ロギング">
                <Field
                  label="ログレベル"
                  hint="DEBUG は高頻度イベントも記録します。トラブルシュート時のみ推奨。"
                >
                  <select
                    className="settings-select"
                    value={data.logLevel}
                    onChange={(e) => onChange({ logLevel: e.target.value })}
                  >
                    {LOG_LEVELS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label} — {opt.hint}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="ログファイル" hint="不具合報告時はこのファイルを共有してください">
                  <code className="settings-code">{logPath || "(未初期化)"}</code>
                </Field>
              </Section>
              <Section title="一覧タブ">
                <Field
                  label="複数選択 UI"
                  hint="`修飾キー` と `両方` は将来実装予定の選択肢です (現状はチェックボックスのみ動作)"
                >
                  <div className="settings-segment">
                    {MULTI_SELECT_MODES.map((opt) => (
                      <label
                        key={opt.value}
                        className={`settings-segment-opt ${
                          data.multiSelectMode === opt.value
                            ? "settings-segment-opt-active"
                            : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="multiSelectMode"
                          value={opt.value}
                          checked={data.multiSelectMode === opt.value}
                          onChange={(e) =>
                            onChange({ multiSelectMode: e.target.value })
                          }
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </Field>
              </Section>
              <Section title="キーボードショートカット">
                <KeybindingsTable />
              </Section>
              {error ? <div className="settings-error">{error}</div> : null}
            </>
          )}
        </div>
        <footer className="settings-footer">
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={onReset}
            disabled={loading || !data}
          >
            既定値に戻す
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={onClose}
          >
            閉じる
          </button>
        </footer>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{title}</h3>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">{label}</div>
      {children}
      {hint ? <div className="settings-field-hint">{hint}</div> : null}
    </div>
  );
}

// Keybindings table is read-only in v1; carve a setting key
// (`keybindings.*`) out for future Phase H rebinding.
const KEYBINDINGS: Array<{ keys: string; action: string; scope: string }> = [
  { keys: "Esc", action: "ドラッグ中の操作をキャンセル", scope: "DnD 中" },
  { keys: "Ctrl+W", action: "アクティブパネルのアクティブタブを閉じる", scope: "ビューア" },
  { keys: "Ctrl+Tab", action: "アクティブパネルの次のタブに切替", scope: "ビューア" },
  { keys: "Ctrl+Shift+Tab", action: "アクティブパネルの前のタブに切替", scope: "ビューア" },
  { keys: "Ctrl+0", action: "画像をフィット表示", scope: "ビューア" },
  { keys: "Ctrl+1", action: "画像を 100% 表示", scope: "ビューア" },
  { keys: "Ctrl++ / Ctrl+=", action: "ズームイン (中心基準)", scope: "ビューア" },
  { keys: "Ctrl+-", action: "ズームアウト (中心基準)", scope: "ビューア" },
];

function KeybindingsTable() {
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
