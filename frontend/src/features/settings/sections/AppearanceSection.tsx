import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";

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
