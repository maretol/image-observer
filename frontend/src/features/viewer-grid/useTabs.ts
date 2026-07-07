// Tab の型と factory。state 管理フックは Phase 3b で useViewerGrid.ts へ移動。circular import
// なしで Tab 形を共有するため型/factory だけここに残す。

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
