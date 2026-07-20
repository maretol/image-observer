import { useCallback, useEffect, useRef, useState } from "react";
import {
  GetSettings,
  ResetSettings,
  UpdateSettings,
} from "../../../wailsjs/go/main/App";
import { settings } from "../../../wailsjs/go/models";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";

export type Settings = settings.SettingsData;

export type UseSettingsReturn = {
  data: Settings | null;
  loading: boolean;
  error: string | null;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
};

// mount 時に settings をロードし、Go 確認付きの update / reset を公開する。
//
// 同期モデル (spec-viewer-max-count.md §13.2): update / reset は queueRef の promise chain で
// 直列化し、merge 元は render 時の closure でなく dataRef.current (= 直前の save 結果) を実行時に
// 読む。閉じ込めた data snapshot から next を作ると、IPC round-trip 中の 2 発目が先の変更を
// 含まない payload を送り、後着応答が先の保存を silent に上書きする (lost update)。
export function useSettings(): UseSettingsReturn {
  const [data, setData] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<Settings | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    GetSettings()
      .then((s) => {
        if (cancelled) return;
        dataRef.current = s;
        setData(s);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = errorMessage(e);
        setError(msg);
        setLoading(false);
        logger.error("settings", "load failed", { err: msg });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // run は内部で catch するので chain は途切れない (前の update の失敗が後続を殺さない)。
  const enqueue = useCallback((run: () => Promise<void>): Promise<void> => {
    const p = queueRef.current.then(run);
    queueRef.current = p;
    return p;
  }, []);

  const update = useCallback(
    (patch: Partial<Settings>) =>
      enqueue(async () => {
        const base = dataRef.current;
        if (!base) return;
        const next = { ...base, ...patch } as Settings;
        try {
          const saved = await UpdateSettings(next);
          dataRef.current = saved;
          setData(saved);
          setError(null);
          logger.info("settings", "updated", {
            logLevel: saved.logLevel,
            multiSelectMode: saved.multiSelectMode,
          });
        } catch (e) {
          const msg = errorMessage(e);
          setError(msg);
          logger.warn("settings", "update failed", { err: msg });
        }
      }),
    [enqueue],
  );

  const reset = useCallback(
    () =>
      enqueue(async () => {
        try {
          const saved = await ResetSettings();
          dataRef.current = saved;
          setData(saved);
          setError(null);
          logger.info("settings", "reset to defaults");
        } catch (e) {
          const msg = errorMessage(e);
          setError(msg);
          logger.warn("settings", "reset failed", { err: msg });
        }
      }),
    [enqueue],
  );

  return { data, loading, error, update, reset };
}
