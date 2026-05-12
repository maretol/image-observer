import { useEffect, useState } from "react";
import { GetState } from "../../../wailsjs/go/main/App";
import { state } from "../../../wailsjs/go/models";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";

export function useSessionLoad() {
  const [loaded, setLoaded] = useState(false);
  const [initialState, setInitialState] = useState<state.StateData | null>(null);

  useEffect(() => {
    GetState()
      .then((s) => {
        setInitialState(s);
        setLoaded(true);
      })
      .catch((e) => {
        logger.warn("state", "load failed (using defaults)", {
          err: errorMessage(e),
        });
        setInitialState(null);
        setLoaded(true);
      });
  }, []);

  return { loaded, initialState };
}
