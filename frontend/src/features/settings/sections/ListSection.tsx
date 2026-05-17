import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";

const MULTI_SELECT_MODES: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  { value: "checkbox", label: "チェックボックス", hint: "Card 左上のチェックで選択" },
  {
    value: "modifier",
    label: "修飾キー",
    hint: "Ctrl+クリックでトグル / Shift+クリックで範囲選択",
  },
  {
    value: "both",
    label: "両方",
    hint: "チェックボックス + Ctrl/Shift+クリック",
  },
];

const WATCH_MODES: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  {
    value: "auto",
    label: "自動",
    hint: "外部で追加 / 削除された画像と分類データの変更を自動反映",
  },
  {
    value: "off",
    label: "オフ",
    hint: "再読み込みボタンを押した時だけ更新",
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
        label="複数選択 UI"
        hint="チェックボックスは Card 左上のチェックで操作、修飾キーは Ctrl+クリック (トグル) と Shift+クリック (範囲選択) で操作します"
      >
        <Segment
          name="multiSelectMode"
          options={MULTI_SELECT_MODES}
          value={data.multiSelectMode}
          onChange={(v) => onChange({ multiSelectMode: v })}
        />
      </Field>
      <Field
        label="フォルダ自動監視"
        hint="自動: 外部で画像が追加 / 削除されたり _classification.json が書き換えられると、一覧に約 200ms 遅延で反映されます。オフ: 自動更新を行わず、再読み込みボタンを押した時のみ最新化します"
      >
        <Segment
          name="watchMode"
          options={WATCH_MODES}
          value={data.watchMode}
          onChange={(v) => onChange({ watchMode: v })}
        />
      </Field>
    </>
  );
}
