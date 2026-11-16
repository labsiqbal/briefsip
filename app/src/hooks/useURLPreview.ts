import { useEffect, useState } from 'react';

export function useURLPreview(path: string) {
  const local = new URL(path).origin === window.location.origin;
  const [status, setStatus] = useState(local ? 'loading' : 'ready');
  useEffect(() => {
    if (!local) return;
    const controller = new AbortController();
    void fetch(path, { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) setStatus(response.ok ? 'ready' : 'missing');
      void response.body?.cancel();
    }).catch(() => { if (!controller.signal.aborted) setStatus('missing'); });
    return () => controller.abort();
  }, [path, local]);
  return status;
}
