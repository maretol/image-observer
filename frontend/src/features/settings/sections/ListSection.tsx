import type { Settings } from "../useSettings";
import { Field, Segment } from "../SettingsFields";
import { WATCH_MODE_AUTO, WATCH_MODE_OFF } from "../watchMode";

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
    value: WATCH_MODE_AUTO,
    label: "自動",
    hint: "外部で追加 / 削除された画像と分類データの変更を自動反映",
  },
  {
    value: WATCH_MODE_OFF,
    label: "オフ",
    hint: "再読み込みボタンを押した時だけ更新",
  },
];

// #105: edit-pane save mode. The Segment uses number-coded values because the
// underlying setting is a bool (`editAutoSave`); 1/0 just route through the
// generic Segment<T extends string | number> wrapper. boolean directly would
// require widening Segment's type parameter, which we don't want for one site.
const EDIT_AUTO_SAVE_MODES: Array<{
  value: number;
  label: string;
  hint: string;
}> = [
  {
    value: 1,
    label: "自動 (フォーカス離脱時)",
    hint: "タグ・note の入力からフォーカスが外れたとき、または confidence を変更したときに即保存",
  },
  {
    value: 0,
    label: "手動 (保存ボタン)",
    hint: "保存ボタンまたは Cmd/Ctrl+Enter で明示的に保存",
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
        hint="自動: 外部で画像が追加 / 削除されたり _classification.json が書き換えられると、短い遅延の後に一覧へ反映されます。オフ: 自動更新を行わず、再読み込みボタンを押した時のみ最新化します"
      >
        <Segment
          name="watchMode"
          options={WATCH_MODES}
          value={data.watchMode}
          onChange={(v) => onChange({ watchMode: v })}
        />
      </Field>
      <Field
        label="タグ・note の保存方法"
        hint="自動: 各入力からフォーカスが外れたとき / confidence を変更したときに保存。手動: 保存ボタンまたは Cmd/Ctrl+Enter で保存します"
      >
        <Segment
          name="editAutoSave"
          options={EDIT_AUTO_SAVE_MODES}
          value={data.editAutoSave ? 1 : 0}
          onChange={(v) => onChange({ editAutoSave: v === 1 })}
        />
      </Field>
    </>
  );
}
