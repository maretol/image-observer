import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";

const LOG_LEVELS: Array<{ value: string; label: string; hint: string }> = [
  { value: "debug", label: "DEBUG", hint: "詳細 (高頻度イベント含む)" },
  { value: "info", label: "INFO", hint: "標準 (推奨)" },
  { value: "warn", label: "WARN", hint: "警告以上のみ" },
  { value: "error", label: "ERROR", hint: "エラーのみ" },
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
        label="ログレベル"
        hint={`現在: ${activeLogLevelHint}。DEBUG は高頻度イベントも記録するためトラブルシュート時のみ推奨。`}
      >
        <Segment
          name="logLevel"
          options={LOG_LEVELS}
          value={data.logLevel}
          onChange={(v) => onChange({ logLevel: v })}
        />
      </Field>
      <Field label="ログファイル" hint="不具合報告時はこのファイルを共有してください">
        <code className="settings-code">{logPath || "(未初期化)"}</code>
      </Field>
    </>
  );
}
