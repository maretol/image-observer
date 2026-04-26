// Tab data type and factory. The state-managing hook moved to useViewerGrid.ts
// in Phase 3b. This module is kept only for the type/factory so multiple files
// can share the Tab shape without circular imports.

export type Tab = {
  path: string;
  zoom: number;
  panX: number;
  panY: number;
  initialized: boolean;
  imageWidth: number;
  imageHeight: number;
};

export const newTab = (path: string): Tab => ({
  path,
  zoom: 0,
  panX: 0,
  panY: 0,
  initialized: false,
  imageWidth: 0,
  imageHeight: 0,
});
