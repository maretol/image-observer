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

// Segment is a generic radio-button group. Pass `value` and onChange typed to
// the option value type (string | number). Uses opt.value directly in onChange
// so number values survive without parseInt parsing on the event.
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

// NumberInput keeps the in-progress value in local string state and only
// commits (calls onChange) on blur or Enter. Without this, every keystroke
// would fire UpdateSettings — which (a) races so a delayed response can
// overwrite the latest user input, and (b) sends `Number("") === 0` mid-edit
// which Go's Validate rejects (clamped fields like maxImagePixelsMP have a
// >0 lower bound). On commit the value is clamped to [min, max] so out-of-
// range entries are silently corrected rather than rejected.
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
  // Esc sets this immediately before triggering blur so the resulting onBlur
  // skips its commit. Without it, setText() is asynchronous (React schedules
  // the re-render) but blur() fires synchronously, so onBlur reads the
  // unreverted DOM value and commits the user's edit instead of reverting.
  const skipNextBlurRef = useRef(false);
  // Sync external value changes (e.g. "既定値に戻す") into the local buffer.
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
      // Bad / empty — revert the visible text but leave value untouched.
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
            (e.target as HTMLInputElement).blur(); // triggers commit via onBlur
          } else if (e.key === "Escape") {
            skipNextBlurRef.current = true;
            (e.target as HTMLInputElement).blur(); // commit() sees the flag and reverts
          }
        }}
      />
      {suffix ? <span className="settings-number-suffix">{suffix}</span> : null}
    </div>
  );
}
