import { t } from "../../../shared/messages";
import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";

const LOG_LEVELS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "debug",
    label: t("settings.logging.logLevel.debug.label"),
    hint: t("settings.logging.logLevel.debug.hint"),
  },
  {
    value: "info",
    label: t("settings.logging.logLevel.info.label"),
    hint: t("settings.logging.logLevel.info.hint"),
  },
  {
    value: "warn",
    label: t("settings.logging.logLevel.warn.label"),
    hint: t("settings.logging.logLevel.warn.hint"),
  },
  {
    value: "error",
    label: t("settings.logging.logLevel.error.label"),
    hint: t("settings.logging.logLevel.error.hint"),
  },
];

export function LoggingSection({
  data,
  logPath,
  onChange,
}: {
  data: Settings;
  logPath: string;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const activeLogLevelHint =
    LOG_LEVELS.find((o) => o.value === data.logLevel)?.hint ?? "";
  return (
    <>
      <Field
        label={t("settings.logging.level.label")}
        hint={t("settings.logging.level.hint", { hint: activeLogLevelHint })}
      >
        <Segment
          name="logLevel"
          options={LOG_LEVELS}
          value={data.logLevel}
          onChange={(v) => onChange({ logLevel: v })}
        />
      </Field>
      <Field
        label={t("settings.logging.file.label")}
        hint={t("settings.logging.file.hint")}
      >
        <code className="settings-code">
          {logPath || t("settings.logging.file.uninitialized")}
        </code>
      </Field>
    </>
  );
}
