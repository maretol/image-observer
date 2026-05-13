import { classification, imgread, settings, state } from '../../wailsjs/go/models';
import { newTab, type Tab } from '../features/viewer-grid/useTabs';
import type { Layout } from '../features/viewer-grid/layout';

export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p2n4bkAAAAASUVORK5CYII=';

export function makeSettings(overrides: Partial<settings.SettingsData> = {}) {
  return settings.SettingsData.createFrom({
    version: 1,
    logLevel: 'info',
    multiSelectMode: 'checkbox',
    wheelMode: 'zoom',
    maxImagePixelsMP: 200,
    thumbnailSize: 256,
    thumbnailMode: 'letterbox',
    thumbnailWorkerCount: 4,
    tagColors: {
      cat: '#4f46e5',
      dog: '#0f766e',
      bird: '#b45309',
    },
    uiScalePercent: 100,
    ...overrides,
  });
}

export function makeEntry(overrides: Partial<classification.Entry> = {}) {
  return classification.Entry.createFrom({
    filename: 'cat-01.png',
    folder: 'cat, indoor',
    confidence: 'high',
    note: '窓辺',
    ...overrides,
  });
}

export function makeLoadResult(
  overrides: Partial<classification.LoadResult> = {},
) {
  const entries = overrides.entries ?? [
    makeEntry({ filename: 'cat-01.png', folder: 'cat, indoor', confidence: 'high' }),
    makeEntry({ filename: 'cat-02.png', folder: 'cat', confidence: 'mid' }),
    makeEntry({ filename: 'dogs/dog-01.png', folder: 'dog', confidence: 'high' }),
    makeEntry({ filename: 'birds/bird-01.png', folder: 'bird', confidence: 'low' }),
  ];
  return classification.LoadResult.createFrom({
    folderPath: '/mock/gallery',
    entries,
    orphans: [],
    hasSidecar: true,
    source: '_classification.json',
    mtime: 123,
    ...overrides,
  });
}

export function makeStateData(overrides: Partial<state.StateData> = {}) {
  return state.StateData.createFrom({
    version: 5,
    window: { width: 1280, height: 800, x: 40, y: 50 },
    layout: {
      root: { kind: 'leaf', id: 'leaf-root', tabs: [], activeIndex: -1 },
      activeId: 'leaf-root',
    },
    topTab: 'list',
    list: {
      folderPath: '',
      filter: { tags: [], confidence: 'all', query: '' },
      collapsedGroups: [],
    },
    ...overrides,
  });
}

export function makeImageResult(overrides: Partial<imgread.Result> = {}) {
  return imgread.Result.createFrom({
    data: TINY_PNG_BASE64,
    mimeType: 'image/png',
    width: 640,
    height: 360,
    ...overrides,
  });
}

export function makeImageInfo(overrides: Partial<imgread.Info> = {}) {
  return imgread.Info.createFrom({
    width: 640,
    height: 360,
    mimeType: 'image/png',
    ...overrides,
  });
}

export function makeViewerLayout(): Layout {
  const tabA = withImageMeta(newTab('/mock/gallery/cat-01.png'));
  const tabB = withImageMeta(newTab('/mock/gallery/dog-01.png'));
  const tabC = withImageMeta(newTab('/mock/gallery/bird-01.png'));
  return {
    activeId: 'leaf-a',
    root: {
      kind: 'split',
      id: 'split-root',
      direction: 'col',
      ratio: 0.64,
      a: {
        kind: 'leaf',
        id: 'leaf-a',
        tabs: [tabA, tabB],
        activeIndex: 0,
      },
      b: {
        kind: 'leaf',
        id: 'leaf-b',
        tabs: [tabC],
        activeIndex: 0,
      },
    },
  };
}

function withImageMeta(tab: Tab): Tab {
  return {
    ...tab,
    initialized: true,
    imageWidth: 640,
    imageHeight: 360,
    zoom: 1,
    panX: 0,
    panY: 0,
  };
}
