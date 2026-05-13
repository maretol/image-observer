import { makeImageInfo, makeImageResult, makeLoadResult, makeSettings, makeStateData, TINY_PNG_BASE64 } from './fixtures';

type MockState = {
  stateData: ReturnType<typeof makeStateData> | null;
  settingsData: ReturnType<typeof makeSettings>;
  loadResult: ReturnType<typeof makeLoadResult>;
  logPath: string;
  imageInfo: ReturnType<typeof makeImageInfo>;
  imageResult: ReturnType<typeof makeImageResult>;
  thumbnailResult: { data: string; mimeType: string };
  folderDialogPath: string;
};

declare global {
  interface Window {
    go: {
      main: {
        App: Record<string, (...args: unknown[]) => unknown>;
      };
    };
    runtime: Record<string, (...args: unknown[]) => unknown>;
  }
}

const runtimeDefaults = {
  WindowGetSize: async () => ({ w: 1280, h: 800 }),
  WindowGetPosition: async () => ({ x: 40, y: 50 }),
  EventsOnMultiple: () => () => {},
  EventsOff: () => {},
  EventsOffAll: () => {},
  EventsEmit: () => {},
  LogPrint: () => {},
  LogTrace: () => {},
  LogDebug: () => {},
  LogInfo: () => {},
  LogWarning: () => {},
  LogError: () => {},
  LogFatal: () => {},
};

let mockState = createDefaultMockState();

export function resetBrowserMocks() {
  mockState = createDefaultMockState();
  installBrowserMocks();
}

export function setBrowserMockState(patch: Partial<MockState>) {
  mockState = { ...mockState, ...patch };
  installBrowserMocks();
}

export function installBrowserMocks(opts: { eagerIntersection?: boolean } = {}) {
  const app = {
    CreateEmptyClassification: async () => undefined,
    GetImageInfo: async () => mockState.imageInfo,
    GetLogPath: async () => mockState.logPath,
    GetSettings: async () => mockState.settingsData,
    GetState: async () => mockState.stateData,
    GetThumbnail: async () => mockState.thumbnailResult,
    LoadClassification: async () => mockState.loadResult,
    LogEvent: async () => undefined,
    MergeChildSidecars: async () => mockState.loadResult,
    OpenFolderDialog: async () => mockState.folderDialogPath,
    PreviewChildSidecars: async () => null,
    ReadImage: async () => mockState.imageResult,
    ResetSettings: async () => mockState.settingsData,
    SaveClassification: async () => ({ mtime: mockState.loadResult.mtime }),
    SaveState: async () => undefined,
    UpdateClassificationEntry: async () => ({ mtime: mockState.loadResult.mtime + 1 }),
    UpdateSettings: async (next: unknown) => next,
  };

  window.go = { main: { App: app } };
  window.runtime = { ...runtimeDefaults };

  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (opts.eagerIntersection || typeof window.IntersectionObserver === 'undefined') {
    window.IntersectionObserver = class IntersectionObserver {
      root = null;
      rootMargin = '0px';
      scrollMargin = '0px';
      thresholds = [0];
      #callback: IntersectionObserverCallback;

      constructor(callback: IntersectionObserverCallback) {
        this.#callback = callback;
      }

      observe(target: Element) {
        queueMicrotask(() => {
          this.#callback(
            [
              {
                isIntersecting: true,
                target,
                boundingClientRect: target.getBoundingClientRect(),
                intersectionRatio: 1,
                intersectionRect: target.getBoundingClientRect(),
                rootBounds: null,
                time: performance.now(),
              } as IntersectionObserverEntry,
            ],
            this,
          );
        });
      }

      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  }

  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => `blob:mock-${TINY_PNG_BASE64.slice(0, 8)}`;
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    URL.revokeObjectURL = () => {};
  }
}

function createDefaultMockState(): MockState {
  return {
    stateData: makeStateData(),
    settingsData: makeSettings(),
    loadResult: makeLoadResult(),
    logPath: '/tmp/image-observer/app.log',
    imageInfo: makeImageInfo(),
    imageResult: makeImageResult(),
    thumbnailResult: { data: TINY_PNG_BASE64, mimeType: 'image/png' },
    folderDialogPath: '/mock/gallery',
  };
}
