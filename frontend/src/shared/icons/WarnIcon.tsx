export function WarnIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2L14.5 13.5H1.5L8 2z" />
      <path d="M8 6.5v3.5" />
      <path d="M8 12.2v0.1" />
    </svg>
  );
}
