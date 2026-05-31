import { t } from "../../../shared/messages";
import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";

// UI scale tiers exposed by the segment control. Any value within the Go-side
// validated range is still accepted via settings.json; the UI just surfaces
// these standard tiers. The actual numeric bounds live in `internal/settings`
// (single source of truth) so we don't duplicate them in this file. The `hint`
// percentages are plain numbers (not localizable), so they stay as literals.
const UI_SCALES: Array<{ value: number; label: string; hint: string }> = [
  { value: 90, label: t("settings.appearance.scale.small"), hint: "90%" },
  { value: 100, label: t("settings.appearance.scale.standard"), hint: "100%" },
  { value: 115, label: t("settings.appearance.scale.large"), hint: "115%" },
  { value: 130, label: t("settings.appearance.scale.xlarge"), hint: "130%" },
];

export function AppearanceSection({
  data,
  onChange,
}: {
  data: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  // The segment shows 4 standard tiers but uiScalePercent is a free integer
  // (Go-side validated range). If settings.json holds a non-standard value
  // (e.g. 105), the segment falls back to highlighting nothing and a hint
  // shows the live value. The allowed range itself is intentionally not
  // duplicated here — the Go validator is the single source of truth so the
  // two can't drift.
  const matchedStandard = UI_SCALES.some((o) => o.value === data.uiScalePercent);
  return (
    <Field
      label={t("settings.appearance.scale.label")}
      hint={
        matchedStandard
          ? t("settings.appearance.scale.hint.matched")
          : t("settings.appearance.scale.hint.custom", {
              percent: data.uiScalePercent,
            })
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
