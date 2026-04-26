import { useEffect, useState } from "react";
import { GetState } from "../../../wailsjs/go/main/App";
import { state } from "../../../wailsjs/go/models";

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
        console.warn("GetState failed, using defaults:", e);
        setInitialState(null);
        setLoaded(true);
      });
  }, []);

  return { loaded, initialState };
}
