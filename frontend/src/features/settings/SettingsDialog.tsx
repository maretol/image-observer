import { useEffect, useRef, useState } from "react";
import { getKnownTagColors } from "../classification/colors";
import { DEFAULT_PALETTE } from "../classification/defaultPalette";
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
  { value: 256, label: "256px" },
  { value: 384, label: "384px" },
  { value: 512, label: "512px" },
];

// UI scale tiers exposed by the segment control. Any value within the Go-side
// validated range is still accepted via settings.json; the UI just surfaces
// these standard tiers. The actual numeric bounds live in `internal/settings`
// (single source of truth) so we don't duplicate them in this file.
const UI_SCALES: Array<{ value: number; label: string; hint: string }> = [
  { value: 90, label: "小", hint: "90%" },
  { value: 100, label: "標準", hint: "100%" },
  { value: 115, label: "大", hint: "115%" },
  { value: 130, label: "特大", hint: "130%" },
];

// Top-level category split (#13). v1 has only two: 設定 with sub-nav and
// ショートカット which today is just the read-only table but is carved out so
// future rebinding UI can live alongside without expanding the settings nav.
type Category = "settings" | "shortcuts";

type SectionId =
  | "logging"
  | "appearance"
  | "viewer"
  | "thumbnail"
  | "list"
  | "tag-colors";

type SectionDef = {
  id: SectionId;
  label: string;
  description: string;
  icon: React.ReactNode;
};

const SECTIONS: SectionDef[] = [
  {
    id: "logging",
    label: "ロギング",
    description: "ログレベルと、不具合報告に使うログファイルの場所。",
    icon: <NavIconLog />,
  },
  {
    id: "appearance",
    label: "外観",
    description: "アプリ全体の表示倍率 (文字 / ボタン / 入力欄を一括スケール)。",
    icon: <NavIconAppearance />,
  },
  {
    id: "viewer",
    label: "ビューア",
    description: "画像表示の操作とパフォーマンス上限。",
    icon: <NavIconViewer />,
  },
  {
    id: "thumbnail",
    label: "サムネイル",
    description: "一覧タブのサムネイル生成パラメータ。",
    icon: <NavIconThumb />,
  },
  {
    id: "list",
    label: "一覧タブ",
    description: "分類ビューでの選択操作の挙動。",
    icon: <NavIconList />,
  },
  {
    id: "tag-colors",
    label: "タグ色",
    description: "既知タグのバッジ色マッピング (settings.json で編集)。",
    icon: <NavIconPalette />,
  },
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
  const [category, setCategory] = useState<Category>("settings");
  const [activeId, setActiveId] = useState<SectionId>("logging");

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

  const activeSection = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0];

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
          {/* Plain toggle-buttons rather than role="tablist" — we don't ship
            * the full WAI-ARIA tabs contract (arrow-key nav, roving tabindex,
            * aria-controls → tabpanel). aria-pressed conveys the same
            * "currently selected category" signal without making assistive
            * tech expect tab semantics that aren't implemented.
            *
            * `role="group"` is what makes `aria-label` actually surface in
            * the accessibility tree — without an explicit role, a bare <div>
            * is "generic" and ATs drop labels on it. */}
          <div
            className="settings-category-bar"
            role="group"
            aria-label="カテゴリ"
          >
            <button
              type="button"
              aria-pressed={category === "settings"}
              className={`settings-category-tab ${
                category === "settings" ? "settings-category-tab-active" : ""
              }`}
              onClick={() => setCategory("settings")}
            >
              設定
            </button>
            <button
              type="button"
              aria-pressed={category === "shortcuts"}
              className={`settings-category-tab ${
                category === "shortcuts" ? "settings-category-tab-active" : ""
              }`}
              onClick={() => setCategory("shortcuts")}
            >
              ショートカット
            </button>
          </div>
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
          ) : category === "shortcuts" ? (
            // No side nav in this branch, so the content pane naturally fills
            // the body — `.settings-content` already has `flex: 1`.
            <div className="settings-content">
              <div className="settings-content-header">
                <h3 className="settings-content-title">ショートカット</h3>
                <p className="settings-content-description">
                  現在のキーバインド一覧 (再バインドは未対応)。
                </p>
              </div>
              <div className="settings-content-body">
                <KeybindingsTable />
              </div>
            </div>
          ) : (
            <>
              <nav className="settings-nav" aria-label="設定セクション">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`settings-nav-item ${
                      s.id === activeId ? "settings-nav-item-active" : ""
                    }`}
                    onClick={() => setActiveId(s.id)}
                    aria-current={s.id === activeId ? "page" : undefined}
                  >
                    <span className="settings-nav-icon" aria-hidden="true">
                      {s.icon}
                    </span>
                    <span className="settings-nav-label">{s.label}</span>
                  </button>
                ))}
              </nav>
              <div className="settings-content">
                <div className="settings-content-header">
                  <h3 className="settings-content-title">
                    {activeSection.label}
                  </h3>
                  <p className="settings-content-description">
                    {activeSection.description}
                  </p>
                </div>
                <div className="settings-content-body">
                  {activeId === "logging" && (
                    <LoggingSection
                      data={data}
                      logPath={logPath}
                      onChange={onChange}
                    />
                  )}
                  {activeId === "appearance" && (
                    <AppearanceSection data={data} onChange={onChange} />
                  )}
                  {activeId === "viewer" && (
                    <ViewerSection data={data} onChange={onChange} />
                  )}
                  {activeId === "thumbnail" && (
                    <ThumbnailSection data={data} onChange={onChange} />
                  )}
                  {activeId === "list" && (
                    <ListSection data={data} onChange={onChange} />
                  )}
                  {activeId === "tag-colors" && (
                    <TagColorsView colors={data.tagColors ?? {}} />
                  )}
                  {error ? <div className="settings-error">{error}</div> : null}
                </div>
              </div>
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

// --- per-section content components ----------------------------------------

type SectionProps = {
  data: Settings;
  onChange: (patch: Partial<Settings>) => void;
};

function LoggingSection({
  data,
  logPath,
  onChange,
}: SectionProps & { logPath: string }) {
  const activeLogLevelHint =
    LOG_LEVELS.find((o) => o.value === data.logLevel)?.hint ?? "";
  return (
    <>
      <Field
        label="ログレベル"
        hint={`現在: ${activeLogLevelHint}。DEBUG は高頻度イベントも記録するためトラブルシュート時のみ推奨。`}
      >
        <Segment
          name="logLevel"
          options={LOG_LEVELS}
          value={data.logLevel}
          onChange={(v) => onChange({ logLevel: v })}
        />
      </Field>
      <Field label="ログファイル" hint="不具合報告時はこのファイルを共有してください">
        <code className="settings-code">{logPath || "(未初期化)"}</code>
      </Field>
    </>
  );
}

function AppearanceSection({ data, onChange }: SectionProps) {
  // The segment shows 4 standard tiers but uiScalePercent is a free integer
  // (Go-side validated range). If settings.json holds a non-standard value
  // (e.g. 105), the segment falls back to highlighting nothing and a hint
  // shows the live value. The allowed range itself is intentionally not
  // duplicated here — the Go validator is the single source of truth so the
  // two can't drift.
  const matchedStandard = UI_SCALES.some((o) => o.value === data.uiScalePercent);
  return (
    <Field
      label="UI スケール"
      hint={
        matchedStandard
          ? "文字 / ボタン / 入力欄 / 画像表示を含むアプリ全体を均一に拡大縮小します。"
          : `現在 ${data.uiScalePercent}% (settings.json で個別指定中)。標準のタイル以外を使いたい場合は settings.json の uiScalePercent を編集してください (範囲外は読み込み時に既定値へ戻ります)。`
      }
    >
      <Segment
        name="uiScalePercent"
        options={UI_SCALES}
        value={data.uiScalePercent}
        onChange={(v) => onChange({ uiScalePercent: v })}
      />
    </Field>
  );
}

function ViewerSection({ data, onChange }: SectionProps) {
  return (
    <>
      <Field
        label="マウスホイールの動作"
        hint="Shift / Ctrl + ホイール モードでは通常スクロールが画像のパン (移動) になります。ドラッグでのパンは引き続き利用できます。"
      >
        <Segment
          name="wheelMode"
          options={WHEEL_MODES}
          value={data.wheelMode}
          onChange={(v) => onChange({ wheelMode: v })}
        />
      </Field>
      <Field
        label="開ける画像サイズの上限"
        hint="画像のピクセル数が上限を超える場合は警告して開きません。次回画像を開く操作から有効。"
      >
        <NumberInput
          value={data.maxImagePixelsMP}
          min={1}
          max={4000}
          step={50}
          suffix="MP"
          onChange={(n) => onChange({ maxImagePixelsMP: n })}
        />
      </Field>
    </>
  );
}

function ThumbnailSection({ data, onChange }: SectionProps) {
  return (
    <>
      <Field
        label="表示サイズ"
        hint="新しく読み込むサムネイルから反映されます。既に読み込まれた画像はキャッシュ生存中は旧サイズのまま (256px が既定)。"
      >
        <Segment
          name="thumbnailSize"
          options={THUMBNAIL_SIZES}
          value={data.thumbnailSize}
          onChange={(v) => onChange({ thumbnailSize: v })}
        />
      </Field>
      <Field
        label="アスペクト処理"
        hint="新しく読み込むサムネイルから反映されます。"
      >
        <Segment
          name="thumbnailMode"
          options={THUMBNAIL_MODES}
          value={data.thumbnailMode}
          onChange={(v) => onChange({ thumbnailMode: v })}
        />
      </Field>
      <Field
        label="生成ワーカー数"
        hint="0 で自動 (CPU 数 / 2、最低 1)。変更はアプリ再起動後に反映されます。"
      >
        <NumberInput
          value={data.thumbnailWorkerCount}
          min={0}
          max={64}
          step={1}
          suffix={data.thumbnailWorkerCount === 0 ? "(自動)" : "本"}
          onChange={(n) => onChange({ thumbnailWorkerCount: n })}
        />
      </Field>
    </>
  );
}

function ListSection({ data, onChange }: SectionProps) {
  return (
    <Field
      label="複数選択 UI"
      hint="チェックボックスは Card 左上のチェックで操作、修飾キーは Ctrl+クリック (トグル) と Shift+クリック (範囲選択) で操作します"
    >
      <Segment
        name="multiSelectMode"
        options={MULTI_SELECT_MODES}
        value={data.multiSelectMode}
        onChange={(v) => onChange({ multiSelectMode: v })}
      />
    </Field>
  );
}

// --- shared field / input components ---------------------------------------

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

// Segment is a generic radio-button group. Pass `value` and onChange typed to
// the option value type (string | number). Uses opt.value directly in onChange
// so number values survive without parseInt parsing on the event.
function Segment<T extends string | number>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="settings-segment">
      {options.map((opt) => (
        <label
          key={String(opt.value)}
          className={`settings-segment-opt ${
            value === opt.value ? "settings-segment-opt-active" : ""
          }`}
        >
          <input
            type="radio"
            name={name}
            value={String(opt.value)}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// NumberInput keeps the in-progress value in local string state and only
// commits (calls onChange) on blur or Enter. Without this, every keystroke
// would fire UpdateSettings — which (a) races so a delayed response can
// overwrite the latest user input, and (b) sends `Number("") === 0` mid-edit
// which Go's Validate rejects (clamped fields like maxImagePixelsMP have a
// >0 lower bound). On commit the value is clamped to [min, max] so out-of-
// range entries are silently corrected rather than rejected.
function NumberInput({
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // Esc sets this immediately before triggering blur so the resulting onBlur
  // skips its commit. Without it, setText() is asynchronous (React schedules
  // the re-render) but blur() fires synchronously, so onBlur reads the
  // unreverted DOM value and commits the user's edit instead of reverting.
  const skipNextBlurRef = useRef(false);
  // Sync external value changes (e.g. "既定値に戻す") into the local buffer.
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    if (skipNextBlurRef.current) {
      skipNextBlurRef.current = false;
      setText(String(value));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || raw.trim() === "") {
      // Bad / empty — revert the visible text but leave value untouched.
      setText(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, Math.floor(n)));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className="settings-number-row">
      <input
        type="number"
        className="settings-number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur(); // triggers commit via onBlur
          } else if (e.key === "Escape") {
            skipNextBlurRef.current = true;
            (e.target as HTMLInputElement).blur(); // commit() sees the flag and reverts
          }
        }}
      />
      {suffix ? <span className="settings-number-suffix">{suffix}</span> : null}
    </div>
  );
}

// --- tag colors view (read-only) -------------------------------------------

// TagColorsView is read-only in v1. It always displays the effective merged
// palette (DEFAULT_PALETTE + settings.tagColors overrides) via
// getKnownTagColors(), so "what's shown here" matches "what tagColor()
// actually renders" — including for tags the user has not overridden. Each
// row carries an "上書き" pill when its color is actually different from the
// seed default (or it's a tag name that isn't in DEFAULT_PALETTE at all).
//
// Note on "is override": we compare values against DEFAULT_PALETTE rather
// than checking `name in colors`, because Go-side DefaultSettings() /
// applyFieldDefaults populate `colors` with the full seed palette by default
// — so a key-presence check would label every row as an override after a
// fresh load or `既定値に戻す`. Value comparison is robust to that and also
// correctly leaves "user set X to the same color as default" as non-override.
//
// `colors` is the raw settings payload, used here only to decide which rows
// to badge as overrides and to drive the summary hint.
//
// Editing today happens by editing settings.json directly and restarting the
// app (useSettings calls GetSettings only on mount). Full in-app editing is
// a follow-up issue.
function TagColorsView({ colors }: { colors: Record<string, string> }) {
  const effective = getKnownTagColors();
  const entries = Object.entries(effective).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const overrideCount = entries.reduce(
    (n, [name, hex]) => (isOverrideValue(name, hex, colors) ? n + 1 : n),
    0,
  );
  return (
    <div className="settings-tag-colors">
      <div className="settings-field-hint">
        {overrideCount > 0
          ? `現在のパレット (${overrideCount} 件の上書きを適用済み)。`
          : "既定パレット使用中 (settings.json の tagColors に既定と異なる値の指定はありません)。"}
      </div>
      {entries.length > 0 ? (
        <ul className="settings-tag-colors-list">
          {entries.map(([name, hex]) => {
            const isOverride = isOverrideValue(name, hex, colors);
            return (
              <li key={name} className="settings-tag-colors-item">
                <span
                  className="settings-tag-swatch"
                  style={{ backgroundColor: hex }}
                  title={hex}
                />
                <span className="settings-tag-name">{name}</span>
                <code className="settings-tag-hex">{hex}</code>
                {isOverride ? (
                  <span
                    className="settings-tag-override-pill"
                    title="settings.json の tagColors で既定とは違う色に上書きされています"
                  >
                    上書き
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="settings-field-hint">
        編集は <code>settings.json</code> の <code>tagColors</code> を直接書き換えてください
        (アプリ再起動後に反映 / 不正な値は読み込み時に除外されます)。指定したタグだけが既定パレットに重ね書きされ、未指定のタグは既定色のまま残ります。「既定値に戻す」で全上書きをクリアします。
      </div>
    </div>
  );
}

// isOverrideValue: true when settings.tagColors has `name` with a value
// different from the seed default. Names not in DEFAULT_PALETTE are always
// considered overrides (the user added a brand-new tag). Names whose stored
// value happens to equal the seed are NOT marked as overrides — that lets
// the pill mean "this row diverges from the bundled defaults", which is the
// signal the user actually wants when scanning the table.
function isOverrideValue(
  name: string,
  effectiveHex: string,
  colors: Record<string, string>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(colors, name)) return false;
  const seed = DEFAULT_PALETTE[name];
  return seed === undefined || seed !== effectiveHex;
}

// --- keybindings table -----------------------------------------------------

// Keybindings table is read-only in v1; carve a setting key
// (`keybindings.*`) out for future Phase H rebinding.
const KEYBINDINGS: Array<{ keys: string; action: string; scope: string }> = [
  { keys: "Esc", action: "ドラッグ中の操作をキャンセル", scope: "DnD 中" },
  { keys: "Ctrl+Shift+1", action: "一覧タブに切替", scope: "全体" },
  { keys: "Ctrl+Shift+2", action: "ビューアタブに切替", scope: "全体" },
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

// --- inline nav icons (kept local; not reused outside SettingsDialog) ------

function NavIconLog() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2.5h7l3 3V13a.5.5 0 0 1-.5.5h-9.5A.5.5 0 0 1 2.5 13V3a.5.5 0 0 1 .5-.5z" />
      <path d="M9.5 2.5V6h3" />
      <path d="M5 8h6M5 10.5h6M5 5.5h2" />
    </svg>
  );
}

function NavIconViewer() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <circle cx="6" cy="7" r="1.2" />
      <path d="m2.5 11 3-3 2 2 3-4 5 6" />
    </svg>
  );
}

function NavIconThumb() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.5" width="5" height="5" rx="0.5" />
      <rect x="9" y="2.5" width="5" height="5" rx="0.5" />
      <rect x="2" y="9" width="5" height="5" rx="0.5" />
      <rect x="9" y="9" width="5" height="5" rx="0.5" />
    </svg>
  );
}

function NavIconList() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h8M5 8h8M5 12h8" />
      <circle cx="2.5" cy="4" r="0.6" fill="currentColor" />
      <circle cx="2.5" cy="8" r="0.6" fill="currentColor" />
      <circle cx="2.5" cy="12" r="0.6" fill="currentColor" />
    </svg>
  );
}

function NavIconPalette() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2a6 6 0 1 0 0 12c.8 0 1.4-.6 1.4-1.4 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.7.6-1.2 1.3-1.2H12a3 3 0 0 0 3-3A6 6 0 0 0 8 2z" />
      <circle cx="5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="4.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="5.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function NavIconAppearance() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 13V5h2.5l2 8M4 9h4.5" />
      <path d="M10.5 13l2.5-6 2.5 6M11.5 11h3" />
    </svg>
  );
}
