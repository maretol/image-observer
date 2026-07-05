import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/messages";
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

// トップレベルのカテゴリ分割 (#13)。v1 は 2 つ: sub-nav 付きの 設定 と、今は read-only テーブル
// だけの ショートカット (将来の rebinding UI を settings nav を広げず同居させるため分離)。
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
    label: t("settings.section.logging.label"),
    description: t("settings.section.logging.desc"),
    icon: <NavIconLog />,
  },
  {
    id: "appearance",
    label: t("settings.section.appearance.label"),
    description: t("settings.section.appearance.desc"),
    icon: <NavIconAppearance />,
  },
  {
    id: "viewer",
    label: t("settings.section.viewer.label"),
    description: t("settings.section.viewer.desc"),
    icon: <NavIconViewer />,
  },
  {
    id: "thumbnail",
    label: t("settings.section.thumbnail.label"),
    description: t("settings.section.thumbnail.desc"),
    icon: <NavIconThumb />,
  },
  {
    id: "list",
    label: t("settings.section.list.label"),
    description: t("settings.section.list.desc"),
    icon: <NavIconList />,
  },
  {
    id: "tag-colors",
    label: t("settings.section.tagColors.label"),
    description: t("settings.section.tagColors.desc"),
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
  // dialog 内で始まった pointerdown (input の text 選択 drag が backdrop 上で release 等) では
  // backdrop close を抑止 (ModalShell と同パターン, #96)。
  const downOnBackdropRef = useRef(false);

  // Esc で閉じる — open のときだけ登録 (でないとキーを奪う)。App.tsx の global keydown は既に
  // settingsOpen で短絡するので、ここに追加の伝播 guard は不要。
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
            {t("settings.title")}
          </h2>
          {/* role="tablist" でなく素の toggle button — 完全な WAI-ARIA tabs 契約 (arrow nav /
            * roving tabindex / aria-controls) は実装しないため。aria-pressed で同じ「選択中
            * カテゴリ」を伝える。role="group" が aria-label を a11y tree に出す (role なしの
            * <div> は generic 扱いで label が落ちる)。 */}
          <div
            className="settings-category-bar"
            role="group"
            aria-label={t("settings.category.aria")}
          >
            <button
              type="button"
              aria-pressed={category === "settings"}
              className={`settings-category-tab ${
                category === "settings" ? "settings-category-tab-active" : ""
              }`}
              onClick={() => setCategory("settings")}
            >
              {t("settings.category.settings")}
            </button>
            <button
              type="button"
              aria-pressed={category === "shortcuts"}
              className={`settings-category-tab ${
                category === "shortcuts" ? "settings-category-tab-active" : ""
              }`}
              onClick={() => setCategory("shortcuts")}
            >
              {t("settings.category.shortcuts")}
            </button>
          </div>
          <button
            type="button"
            className="settings-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="settings-body">
          {loading ? (
            <div className="settings-loading">{t("common.loading")}</div>
          ) : !data ? (
            <div className="settings-error">
              {t("settings.loadError")}
              {error ? `: ${error}` : null}
            </div>
          ) : category === "shortcuts" ? (
            // この分岐は side nav なしなので content pane が body を埋める (.settings-content は flex: 1)。
            <div className="settings-content">
              <div className="settings-content-header">
                <h3 className="settings-content-title">
                  {t("settings.shortcuts.title")}
                </h3>
                <p className="settings-content-description">
                  {t("settings.shortcuts.description")}
                </p>
              </div>
              <div className="settings-content-body">
                <KeybindingsTable />
              </div>
            </div>
          ) : (
            <>
              <nav className="settings-nav" aria-label={t("settings.nav.aria")}>
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
            {t("settings.reset")}
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}
