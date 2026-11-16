import { useState } from 'react';
import { usePolling } from './usePolling';

type Request = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export function useRouteThread<T extends { agent: string; project?: string; deleted?: number }>(id: string | undefined, agent: string | undefined, request: Request) {
  const [result, setResult] = useState<{ id: string; thread?: T; missing?: boolean; error?: string } | null>(null);
  const key = `${agent}:${id}`;
  usePolling(async signal => {
    if (!id) return;
    try {
      const thread = await request<T>(`/api/threads/${id}`, undefined, signal);
      if (!signal.aborted) setResult({ id: key, ...(thread.agent === agent && !thread.deleted ? { thread } : { missing: true }) });
    } catch (error) {
      if (!signal.aborted) setResult({ id: key, ...(error && typeof error === 'object' && 'status' in error && error.status === 404 ? { missing: true } : { error: error instanceof Error ? error.message : 'Conversation could not load.' }) });
    }
  }, { interval: 5000, enabled: !!id }, [id, agent]);
  return result?.id === key ? result : null;
}
