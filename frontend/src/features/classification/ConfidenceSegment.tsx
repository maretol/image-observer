import type { Confidence } from "./filters";

export type ConfidenceSegmentProps = {
  value: Confidence | "all";
  onChange: (next: Confidence | "all") => void;
};

const OPTIONS: Array<{ value: Confidence | "all"; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "high", label: "high" },
  { value: "mid", label: "mid" },
  { value: "low", label: "low" },
];

export function ConfidenceSegment({ value, onChange }: ConfidenceSegmentProps) {
  return (
    <div className="cls-segment" role="radiogroup" aria-label="信頼度">
      <span className="cls-segment-label">信頼度:</span>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`cls-segment-btn cls-segment-${opt.value} ${value === opt.value ? "active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
