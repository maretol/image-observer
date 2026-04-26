export function SpinnerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" style={{ animation: "io-spin 0.8s linear infinite" }}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeOpacity="0.25" />
      <path d="M8 2 A6 6 0 0 1 14 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}
