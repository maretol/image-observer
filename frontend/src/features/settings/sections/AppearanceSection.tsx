import { t } from "../../../shared/messages";
import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";

// segment が公開する UI スケール tier。Go 検証範囲内の任意値は settings.json で受け付ける;
// UI は標準 tier だけ出す。数値境界は internal/settings が正 (ここに複製しない)。
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
  // segment は 4 tier を出すが uiScalePercent は自由整数 (Go 検証範囲)。非標準値 (105 等) なら
  // 何もハイライトせず hint に live 値を出す。許容範囲は Go validator が正でここに複製しない。
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
