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
  { value: "checkbox", label: "チェックボックス", hint: "Card 左上のチェックで選択" },
  {
    value: "modifier",
    label: "修飾キー",
    hint: "Ctrl+クリックでトグル / Shift+クリックで範囲選択",
  },
  {
    value: "both",
    label: "両方",
    hint: "チェックボックス + Ctrl/Shift+クリック",
  },
];

const WHEEL_MODES: Array<{ value: string; label: string; hint: string }> = [
  { value: "zoom", label: "ホイールで拡大縮小", hint: "従来通り (推奨)" },
  {
    value: "shift-zoom",
    label: "Shift / Ctrl + ホイールで拡大縮小",
    hint: "通常のホイールは画像を上下にスクロール、横方向は trackpad 等の deltaX に追従",
  },
];

const THUMBNAIL_MODES: Array<{ value: string; label: string; hint: string }> = [
  { value: "letterbox", label: "レターボックス", hint: "縦横比を保ち余白を入れる (推奨)" },
  { value: "crop", label: "クロップ", hint: "枠いっぱいに切り出す (はみ出し部分は捨てる)" },
];

const THUMBNAIL_SIZES: Array<{ value: number; label: string }> = [
  { value: 128, label: "128px" },
  { value: 192, label: "192px" },
  { value: 256, label: "256px (既定)" },
  { value: 384, label: "384px" },
  { value: 512, label: "512px" },
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
  // App.tsx's global keydown listener already short-circuits on `settingsOpen`,
  // so no extra propagation guard is needed here.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
              <Section title="ビューア">
                <Field
                  label="マウスホイールの動作"
                  hint="Shift / Ctrl + ホイール モードでは通常スクロールが画像のパン (移動) になります。ドラッグでのパンは引き続き利用できます。"
                >
                  <div className="settings-segment">
                    {WHEEL_MODES.map((opt) => (
                      <label
                        key={opt.value}
                        className={`settings-segment-opt ${
                          data.wheelMode === opt.value
                            ? "settings-segment-opt-active"
                            : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="wheelMode"
                          value={opt.value}
                          checked={data.wheelMode === opt.value}
                          onChange={(e) =>
                            onChange({ wheelMode: e.target.value })
                          }
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </Field>
                <Field
                  label="開ける画像サイズの上限 (MP)"
                  hint="画像のピクセル数が上限を超える場合は警告して開きません。次回画像を開く操作から有効。"
                >
                  <input
                    type="number"
                    className="settings-number"
                    min={1}
                    max={4000}
                    step={50}
                    value={data.maxImagePixelsMP}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n))
                        onChange({ maxImagePixelsMP: Math.floor(n) });
                    }}
                  />
                </Field>
              </Section>
              <Section title="サムネイル">
                <Field
                  label="表示サイズ"
                  hint="新しく読み込むサムネイルから反映されます。既に読み込まれた画像はキャッシュ生存中は旧サイズのままです。"
                >
                  <select
                    className="settings-select"
                    value={data.thumbnailSize}
                    onChange={(e) =>
                      onChange({ thumbnailSize: Number(e.target.value) })
                    }
                  >
                    {THUMBNAIL_SIZES.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="アスペクト処理"
                  hint="新しく読み込むサムネイルから反映されます。"
                >
                  <div className="settings-segment">
                    {THUMBNAIL_MODES.map((opt) => (
                      <label
                        key={opt.value}
                        className={`settings-segment-opt ${
                          data.thumbnailMode === opt.value
                            ? "settings-segment-opt-active"
                            : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="thumbnailMode"
                          value={opt.value}
                          checked={data.thumbnailMode === opt.value}
                          onChange={(e) =>
                            onChange({ thumbnailMode: e.target.value })
                          }
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </Field>
                <Field
                  label="生成ワーカー数"
                  hint="0 で自動 (CPU 数 / 2、最低 1)。変更はアプリ再起動後に反映されます。"
                >
                  <input
                    type="number"
                    className="settings-number"
                    min={0}
                    max={64}
                    step={1}
                    value={data.thumbnailWorkerCount}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n))
                        onChange({ thumbnailWorkerCount: Math.floor(n) });
                    }}
                  />
                </Field>
              </Section>
              <Section title="タグ色">
                <TagColorsView colors={data.tagColors ?? {}} />
              </Section>
              <Section title="一覧タブ">
                <Field
                  label="複数選択 UI"
                  hint="チェックボックスは Card 左上のチェックで操作、修飾キーは Ctrl+クリック (トグル) と Shift+クリック (範囲選択) で操作します"
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
  {
    keys: "Shift+ホイール / Ctrl+ホイール",
    action: "ズームイン / アウト (Shift / Ctrl + ホイール モード時のみ)",
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

// TagColorsView is read-only in v1: the bundled defaults are shown alongside
// any custom entries from settings.json. The intent is "see what's active
// without cracking the JSON open"; full table editing is a follow-up issue.
// Editing today happens by editing settings.json directly and restarting (or
// pressing 既定値に戻す to clear).
function TagColorsView({ colors }: { colors: Record<string, string> }) {
  const entries = Object.entries(colors).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="settings-tag-colors">
      {entries.length === 0 ? (
        <div className="settings-field-hint">(タグ色マップが空です)</div>
      ) : (
        <ul className="settings-tag-colors-list">
          {entries.map(([name, hex]) => (
            <li key={name} className="settings-tag-colors-item">
              <span
                className="settings-tag-swatch"
                style={{ backgroundColor: hex }}
                title={hex}
              />
              <span className="settings-tag-name">{name}</span>
              <code className="settings-tag-hex">{hex}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-field-hint">
        編集は <code>settings.json</code> の <code>tagColors</code> を直接書き換えてください
        (再起動不要 / 不正な値は読み込み時に除外されます)。「既定値に戻す」で初期パレットに戻ります。
      </div>
    </div>
  );
}
