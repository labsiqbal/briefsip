import { useEffect, useState } from 'react';

export function useSetupData<T>(request: <U>(path: string) => Promise<U>, path: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setError(false);
    setBusy(true);
    void request<T>(path).then(result => {
      if (active) setData(result);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [enabled, path, request, revision]);

  return { data, setData, error, busy, reload: () => setRevision(value => value + 1) };
}
