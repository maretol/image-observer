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

// #105: edit-pane save mode. The Segment uses number-coded values because the
// underlying setting is a bool (`editAutoSave`); 1/0 just route through the
// generic Segment<T extends string | number> wrapper. boolean directly would
// require widening Segment's type parameter, which we don't want for one site.
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
