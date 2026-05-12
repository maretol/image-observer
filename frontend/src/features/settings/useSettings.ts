import { useCallback, useEffect, useState } from "react";
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

// Loads settings on mount and exposes optimistic-but-Go-confirmed update /
// reset operations. The dialog and any feature that needs settings consumes
// this hook.
export function useSettings(): UseSettingsReturn {
  const [data, setData] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    GetSettings()
      .then((s) => {
        if (cancelled) return;
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

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      if (!data) return;
      const next = { ...data, ...patch } as Settings;
      try {
        const saved = await UpdateSettings(next);
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
    },
    [data],
  );

  const reset = useCallback(async () => {
    try {
      const saved = await ResetSettings();
      setData(saved);
      setError(null);
      logger.info("settings", "reset to defaults");
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg);
      logger.warn("settings", "reset failed", { err: msg });
    }
  }, []);

  return { data, loading, error, update, reset };
}
