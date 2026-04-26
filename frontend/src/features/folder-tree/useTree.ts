import { useCallback, useEffect, useReducer, useRef } from "react";
import { ListDirectory, OpenFolderDialog } from "../../../wailsjs/go/main/App";
import { tree } from "../../../wailsjs/go/models";
import { useToastFn } from "../../shared/components/Toast";

export type Node = tree.Node;

export type TreeState = {
  rootPath: string | null;
  childrenByPath: Map<string, Node[]>;
  expanded: Set<string>;
  loading: Set<string>;
  errors: Map<string, string>; // not_found / other — shown inline as red text
  noPermission: Set<string>; // permission denied — shown via toast + greyed icon
};

type Action =
  | { type: "selectRoot"; path: string }
  | { type: "loadStart"; path: string }
  | { type: "loadSucceeded"; path: string; nodes: Node[] }
  | { type: "loadFailed"; path: string; message: string }
  | { type: "loadNoPermission"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string };

const initial: TreeState = {
  rootPath: null,
  childrenByPath: new Map(),
  expanded: new Set(),
  loading: new Set(),
  errors: new Map(),
  noPermission: new Set(),
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
        noPermission: new Set(),
      };

    case "loadStart": {
      const loading = new Set(state.loading);
      loading.add(action.path);
      const errors = new Map(state.errors);
      errors.delete(action.path);
      // If this path was previously marked no-perm, clear it; the retry attempt
      // may now succeed (e.g., perms changed externally).
      const noPermission = new Set(state.noPermission);
      noPermission.delete(action.path);
      return { ...state, loading, errors, noPermission };
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

    case "loadNoPermission": {
      const loading = new Set(state.loading);
      loading.delete(action.path);
      const noPermission = new Set(state.noPermission);
      noPermission.add(action.path);
      // Drop the expanded marker so the row collapses visually.
      const expanded = new Set(state.expanded);
      expanded.delete(action.path);
      return { ...state, loading, noPermission, expanded };
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

type ErrorKind = "permission" | "not_found" | "other";
function classifyListError(message: string): ErrorKind {
  if (message.startsWith("PERM:")) return "permission";
  if (message.startsWith("NOENT:")) return "not_found";
  return "other";
}

function stripPrefix(message: string): string {
  return message.replace(/^(PERM|NOENT):\s*/, "");
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
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
  const toast = useToastFn();

  const loadChildren = useCallback(
    async (path: string) => {
      dispatch({ type: "loadStart", path });
      try {
        const nodes = await ListDirectory(path);
        dispatch({ type: "loadSucceeded", path, nodes: nodes ?? [] });
      } catch (e) {
        const raw = errorMessage(e);
        const kind = classifyListError(raw);
        if (kind === "permission") {
          dispatch({ type: "loadNoPermission", path });
          toast(`このフォルダにはアクセスできません: ${basename(path)}`, "warn");
        } else {
          dispatch({ type: "loadFailed", path, message: stripPrefix(raw) });
        }
      }
    },
    [toast]
  );

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
      // Cached no-permission folders short-circuit to a toast, no API call.
      if (state.noPermission.has(path)) {
        toast(`このフォルダにはアクセスできません: ${basename(path)}`, "warn");
        return;
      }
      if (state.expanded.has(path)) {
        dispatch({ type: "collapse", path });
        return;
      }
      dispatch({ type: "expand", path });
      if (!state.childrenByPath.has(path) && !state.loading.has(path)) {
        await loadChildren(path);
      }
    },
    [
      state.expanded,
      state.childrenByPath,
      state.loading,
      state.noPermission,
      loadChildren,
      toast,
    ]
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
