// TopTab — the top-level tab selection ("一覧" or one of the viewers).
// Shared by App.tsx, TopTabsBar, useGlobalKeybindings, and the persistence
// glue (useSessionSave inlines the literal in its SessionInput type for type
// closure but the runtime values are the same).
export type TopTab = "list" | "viewer";
