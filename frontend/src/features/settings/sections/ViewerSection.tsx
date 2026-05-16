import type { Settings } from "../useSettings";
import { Field, NumberInput, Segment } from "../SettingsFields";

const WHEEL_MODES: Array<{ value: string; label: string; hint: string }> = [
  { value: "zoom", label: "ホイールで拡大縮小", hint: "従来通り (推奨)" },
  {
    value: "shift-zoom",
    label: "Shift / Ctrl + ホイールで拡大縮小",
    hint: "通常のホイールは画像を上下にスクロール、横方向は trackpad 等の deltaX に追従",
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
        label="マウスホイールの動作"
        hint="どちらのモードでも、ホイールでズーム / パンするのは画像領域だけです。タブバー上では常にタブ列の横スクロールに使われ、ズームしません。Shift / Ctrl + ホイール モードでは画像領域の通常スクロールがパン (移動) になります。ドラッグでのパンは引き続き利用できます。"
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
