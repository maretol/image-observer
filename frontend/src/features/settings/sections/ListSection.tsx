import { t } from "../../../shared/messages";
import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";
import { WATCH_MODE_AUTO, WATCH_MODE_OFF } from "../watchMode";

const MULTI_SELECT_MODES: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  {
    value: "checkbox",
    label: t("settings.list.multiSelect.checkbox.label"),
    hint: t("settings.list.multiSelect.checkbox.hint"),
  },
  {
    value: "modifier",
    label: t("settings.list.multiSelect.modifier.label"),
    hint: t("settings.list.multiSelect.modifier.hint"),
  },
  {
    value: "both",
    label: t("settings.list.multiSelect.both.label"),
    hint: t("settings.list.multiSelect.both.hint"),
  },
];

const WATCH_MODES: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  {
    value: WATCH_MODE_AUTO,
    label: t("settings.list.watch.auto.label"),
    hint: t("settings.list.watch.auto.hint"),
  },
  {
    value: WATCH_MODE_OFF,
    label: t("settings.list.watch.off.label"),
    hint: t("settings.list.watch.off.hint"),
  },
];

// edit-pane save モード (#105)。設定は bool (editAutoSave) だが、汎用 Segment<string|number> に
// 通すため 1/0 で符号化する (boolean 直だと 1 箇所のために Segment の型 param を広げる必要がある)。
const EDIT_AUTO_SAVE_MODES: Array<{
  value: number;
  label: string;
  hint: string;
}> = [
  {
    value: 1,
    label: t("settings.list.autoSave.auto.label"),
    hint: t("settings.list.autoSave.auto.hint"),
  },
  {
    value: 0,
    label: t("settings.list.autoSave.manual.label"),
    hint: t("settings.list.autoSave.manual.hint"),
  },
];

export function ListSection({
  data,
  onChange,
}: {
  data: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  return (
    <>
      <Field
        label={t("settings.list.multiSelect.label")}
        hint={t("settings.list.multiSelect.fieldHint")}
      >
        <Segment
          name="multiSelectMode"
          options={MULTI_SELECT_MODES}
          value={data.multiSelectMode}
          onChange={(v) => onChange({ multiSelectMode: v })}
        />
      </Field>
      <Field
        label={t("settings.list.watch.label")}
        hint={t("settings.list.watch.fieldHint")}
      >
        <Segment
          name="watchMode"
          options={WATCH_MODES}
          value={data.watchMode}
          onChange={(v) => onChange({ watchMode: v })}
        />
      </Field>
      <Field
        label={t("settings.list.autoSave.label")}
        hint={t("settings.list.autoSave.fieldHint")}
      >
        <Segment
          name="editAutoSave"
          options={EDIT_AUTO_SAVE_MODES}
          value={data.editAutoSave ? 1 : 0}
          onChange={(v) => onChange({ editAutoSave: v === 1 })}
        />
      </Field>
    </>
  );
}
