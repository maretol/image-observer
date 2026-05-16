import type { Settings } from "../useSettings";
import { Field, NumberInput, Segment } from "../SettingsFields";

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

export function ThumbnailSection({
  data,
  onChange,
}: {
  data: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
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
