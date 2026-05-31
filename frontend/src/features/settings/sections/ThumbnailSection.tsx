import { t } from "../../../shared/messages";
import type { Settings } from "../useSettings";
import { Field, NumberInput, Segment } from "../SettingsFields";

const THUMBNAIL_MODES: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "letterbox",
    label: t("settings.thumbnail.mode.letterbox.label"),
    hint: t("settings.thumbnail.mode.letterbox.hint"),
  },
  {
    value: "crop",
    label: t("settings.thumbnail.mode.crop.label"),
    hint: t("settings.thumbnail.mode.crop.hint"),
  },
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
        label={t("settings.thumbnail.size.label")}
        hint={t("settings.thumbnail.size.hint")}
      >
        <Segment
          name="thumbnailSize"
          options={THUMBNAIL_SIZES}
          value={data.thumbnailSize}
          onChange={(v) => onChange({ thumbnailSize: v })}
        />
      </Field>
      <Field
        label={t("settings.thumbnail.mode.label")}
        hint={t("settings.thumbnail.mode.hint")}
      >
        <Segment
          name="thumbnailMode"
          options={THUMBNAIL_MODES}
          value={data.thumbnailMode}
          onChange={(v) => onChange({ thumbnailMode: v })}
        />
      </Field>
      <Field
        label={t("settings.thumbnail.worker.label")}
        hint={t("settings.thumbnail.worker.hint")}
      >
        <NumberInput
          value={data.thumbnailWorkerCount}
          min={0}
          max={64}
          step={1}
          suffix={
            data.thumbnailWorkerCount === 0
              ? t("settings.thumbnail.worker.suffixAuto")
              : t("settings.thumbnail.worker.suffixManual")
          }
          onChange={(n) => onChange({ thumbnailWorkerCount: n })}
        />
      </Field>
    </>
  );
}
