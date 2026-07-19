import { t } from "../../../shared/messages";
import { MAX_VIEWERS_HARD } from "../../viewer-grid/viewers";
import type { Settings } from "../useSettings";
import { Field, NumberInput, Segment } from "../SettingsFields";

const WHEEL_MODES: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "zoom",
    label: t("settings.viewer.wheel.zoom.label"),
    hint: t("settings.viewer.wheel.zoom.hint"),
  },
  {
    value: "shift-zoom",
    label: t("settings.viewer.wheel.shiftZoom.label"),
    hint: t("settings.viewer.wheel.shiftZoom.hint"),
  },
];

export function ViewerSection({
  data,
  onChange,
}: {
  data: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  return (
    <>
      <Field
        label={t("settings.viewer.wheel.label")}
        hint={t("settings.viewer.wheel.fieldHint")}
      >
        <Segment
          name="wheelMode"
          options={WHEEL_MODES}
          value={data.wheelMode}
          onChange={(v) => onChange({ wheelMode: v })}
        />
      </Field>
      <Field
        label={t("settings.viewer.maxPixels.label")}
        hint={t("settings.viewer.maxPixels.hint")}
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
      <Field
        label={t("settings.viewer.maxViewers.label")}
        hint={t("settings.viewer.maxViewers.hint")}
      >
        <NumberInput
          value={data.maxViewers}
          min={1}
          max={MAX_VIEWERS_HARD}
          step={1}
          onChange={(n) => onChange({ maxViewers: n })}
        />
      </Field>
    </>
  );
}
