import { useEffect, useRef, useState } from "react";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">{label}</div>
      {children}
      {hint ? <div className="settings-field-hint">{hint}</div> : null}
    </div>
  );
}

// 汎用 radio グループ。onChange で opt.value を直接使うので、number 値が parseInt なしで残る。
export function Segment<T extends string | number>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="settings-segment">
      {options.map((opt) => (
        <label
          key={String(opt.value)}
          className={`settings-segment-opt ${
            value === opt.value ? "settings-segment-opt-active" : ""
          }`}
        >
          <input
            type="radio"
            name={name}
            value={String(opt.value)}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// 入力途中の値を local string state に持ち、commit (onChange) は blur / Enter 時のみ。
// でないと keystroke ごとに UpdateSettings が走り (a) 遅延応答が最新入力を上書きする race、
// (b) 編集途中の Number("") === 0 が Go の Validate に弾かれる (maxImagePixelsMP 等は下限 >0)。
// commit 時に [min, max] へ clamp するので範囲外は拒否でなく silent 修正。
export function NumberInput({
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // Esc は blur を起こす直前にこれを立て、onBlur が commit を skip するように。setText() は
  // 非同期 (React が再 render を schedule) だが blur() は同期発火するので、これが無いと onBlur が
  // revert 前の DOM 値を読んで revert でなく commit してしまう。
  const skipNextBlurRef = useRef(false);
  // 外部の value 変更 ("既定値に戻す" 等) を local buffer に同期。
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    if (skipNextBlurRef.current) {
      skipNextBlurRef.current = false;
      setText(String(value));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || raw.trim() === "") {
      // 不正/空 — 表示 text だけ revert し value は触らない。
      setText(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, Math.floor(n)));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className="settings-number-row">
      <input
        type="number"
        className="settings-number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur(); // onBlur 経由で commit
          } else if (e.key === "Escape") {
            skipNextBlurRef.current = true;
            (e.target as HTMLInputElement).blur(); // commit() が flag を見て revert
          }
        }}
      />
      {suffix ? <span className="settings-number-suffix">{suffix}</span> : null}
    </div>
  );
}
