// Loads something from the API for a screen. `key` names what is loaded (the URL, normally):
// when it changes, a new load starts and `result` is null until its answer arrives. A reload
// keeps showing the previous answer until the new one replaces it (no flash of skeleton after
// a payment), and `reloading` tells the screen a request is in flight. A null key loads nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult } from './api.ts';

export function useLoad<T>(
  key: string | null,
  load: () => Promise<ApiResult<T>>,
) {
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState<{
    key: string;
    attempt: number;
    result: ApiResult<T>;
  } | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  useEffect(() => {
    if (key === null) return;
    let live = true;
    void loader.current().then((result) => {
      if (live) setDone({ key, attempt, result });
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  const current = key !== null && done?.key === key ? done : null;
  return {
    result: current?.result ?? null,
    reloading: key !== null && current?.attempt !== attempt,
    reload,
  };
}
