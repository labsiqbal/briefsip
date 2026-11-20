import { useEffect } from 'react';

export function useEmptyQueueRecovery(path: string, empty: boolean, request: <T>(path: string) => Promise<T>) {
  useEffect(() => {
    if (!empty) return;
    const endpoint = path.replace(/\/turns$/, '/queue'), key = `minarbot-queue-order:${endpoint}`;
    let active = true;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) void request<{ turns: unknown[]; more: boolean }>(endpoint).then(result => {
        if (active && !result.turns.length && !result.more) {
          try { if (sessionStorage.getItem(key) === saved) sessionStorage.removeItem(key); } catch { return; }
        }
      }).catch(() => {});
    } catch { return; }
    return () => { active = false; };
  }, [path, empty, request]);
}
