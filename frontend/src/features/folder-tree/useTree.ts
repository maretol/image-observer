import { useCallback, useEffect, useReducer, useRef } from "react";
import { ListDirectory, OpenFolderDialog } from "../../../wailsjs/go/main/App";
import { tree } from "../../../wailsjs/go/models";

export type Node = tree.Node;

export type TreeState = {
  rootPath: string | null;
  childrenByPath: Map<string, Node[]>;
  expanded: Set<string>;
  loading: Set<string>;
  errors: Map<string, string>;
};

type Action =
  | { type: "selectRoot"; path: string }
  | { type: "loadStart"; path: string }
  | { type: "loadSucceeded"; path: string; nodes: Node[] }
  | { type: "loadFailed"; path: string; message: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string };

const initial: TreeState = {
  rootPath: null,
  childrenByPath: new Map(),
  expanded: new Set(),
  loading: new Set(),
  errors: new Map(),
};

function reducer(state: TreeState, action: Action): TreeState {
  switch (action.type) {
    case "selectRoot":
      return {
        rootPath: action.path,
        childrenByPath: new Map(),
        expanded: new Set([action.path]),
        loading: new Set(),
        errors: new Map(),
      };

    case "loadStart": {
      const loading = new Set(state.loading);
      loading.add(action.path);
      const errors = new Map(state.errors);
      errors.delete(action.path);
      return { ...state, loading, errors };
    }

    case "loadSucceeded": {
      const childrenByPath = new Map(state.childrenByPath);
      childrenByPath.set(action.path, action.nodes);
      const loading = new Set(state.loading);
      loading.delete(action.path);
      return { ...state, childrenByPath, loading };
    }

    case "loadFailed": {
      const loading = new Set(state.loading);
      loading.delete(action.path);
      const errors = new Map(state.errors);
      errors.set(action.path, action.message);
      return { ...state, loading, errors };
    }

    case "expand": {
      const expanded = new Set(state.expanded);
      expanded.add(action.path);
      return { ...state, expanded };
    }

    case "collapse": {
      const expanded = new Set(state.expanded);
      expanded.delete(action.path);
      return { ...state, expanded };
    }

    default:
      return state;
  }
}

type Options = { initialRootPath?: string | null };

export function useTree(opts?: Options) {
  const init: TreeState = opts?.initialRootPath
    ? {
        ...initial,
        rootPath: opts.initialRootPath,
        expanded: new Set([opts.initialRootPath]),
      }
    : initial;
  const [state, dispatch] = useReducer(reducer, init);

  const loadChildren = useCallback(async (path: string) => {
    dispatch({ type: "loadStart", path });
    try {
      const nodes = await ListDirectory(path);
      dispatch({ type: "loadSucceeded", path, nodes: nodes ?? [] });
    } catch (e) {
      dispatch({ type: "loadFailed", path, message: errorMessage(e) });
    }
  }, []);

  // If a rootPath was restored from session, load its children once on mount.
  const initialLoadedRef = useRef(false);
  useEffect(() => {
    if (initialLoadedRef.current) return;
    if (state.rootPath) {
      initialLoadedRef.current = true;
      loadChildren(state.rootPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickRoot = useCallback(async () => {
    const path = await OpenFolderDialog();
    if (!path) return;
    dispatch({ type: "selectRoot", path });
    await loadChildren(path);
  }, [loadChildren]);

  const toggle = useCallback(
    async (path: string) => {
      if (state.expanded.has(path)) {
        dispatch({ type: "collapse", path });
        return;
      }
      dispatch({ type: "expand", path });
      if (!state.childrenByPath.has(path) && !state.loading.has(path)) {
        await loadChildren(path);
      }
    },
    [state.expanded, state.childrenByPath, state.loading, loadChildren]
  );

  const retry = useCallback(
    (path: string) => {
      loadChildren(path);
    },
    [loadChildren]
  );

  return { state, pickRoot, toggle, retry };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
