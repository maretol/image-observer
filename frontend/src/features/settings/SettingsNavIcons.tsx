// settings side nav 用のインライン SVG アイコン。SettingsDialog 外で再利用しないので shared/icons に置かない。

export function NavIconLog() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2.5h7l3 3V13a.5.5 0 0 1-.5.5h-9.5A.5.5 0 0 1 2.5 13V3a.5.5 0 0 1 .5-.5z" />
      <path d="M9.5 2.5V6h3" />
      <path d="M5 8h6M5 10.5h6M5 5.5h2" />
    </svg>
  );
}

export function NavIconViewer() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <circle cx="6" cy="7" r="1.2" />
      <path d="m2.5 11 3-3 2 2 3-4 5 6" />
    </svg>
  );
}

export function NavIconThumb() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.5" width="5" height="5" rx="0.5" />
      <rect x="9" y="2.5" width="5" height="5" rx="0.5" />
      <rect x="2" y="9" width="5" height="5" rx="0.5" />
      <rect x="9" y="9" width="5" height="5" rx="0.5" />
    </svg>
  );
}

export function NavIconList() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h8M5 8h8M5 12h8" />
      <circle cx="2.5" cy="4" r="0.6" fill="currentColor" />
      <circle cx="2.5" cy="8" r="0.6" fill="currentColor" />
      <circle cx="2.5" cy="12" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function NavIconPalette() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2a6 6 0 1 0 0 12c.8 0 1.4-.6 1.4-1.4 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.7.6-1.2 1.3-1.2H12a3 3 0 0 0 3-3A6 6 0 0 0 8 2z" />
      <circle cx="5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="4.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="5.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function NavIconAppearance() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 13V5h2.5l2 8M4 9h4.5" />
      <path d="M10.5 13l2.5-6 2.5 6M11.5 11h3" />
    </svg>
  );
}
