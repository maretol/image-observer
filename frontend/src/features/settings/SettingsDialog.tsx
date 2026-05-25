import { useEffect, useRef, useState } from "react";
import { KeybindingsTable } from "./KeybindingsTable";
import {
  NavIconAppearance,
  NavIconList,
  NavIconLog,
  NavIconPalette,
  NavIconThumb,
  NavIconViewer,
} from "./SettingsNavIcons";
import { TagColorsView } from "./TagColorsView";
import { AppearanceSection } from "./sections/AppearanceSection";
import { ListSection } from "./sections/ListSection";
import { LoggingSection } from "./sections/LoggingSection";
import { ThumbnailSection } from "./sections/ThumbnailSection";
import { ViewerSection } from "./sections/ViewerSection";
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
  // Suppress backdrop close when a pointerdown started inside the dialog
  // (e.g. text selection drag in an input released over the backdrop). See
  // ModalShell for the same pattern (#96).
  const downOnBackdropRef = useRef(false);

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
      onPointerDown={(e) => {
        downOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const startedHere = downOnBackdropRef.current;
        downOnBackdropRef.current = false;
        if (e.target !== e.currentTarget) return;
        if (!startedHere) return;
        onClose();
      }}
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
