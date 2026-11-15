import { useEffect, useRef } from 'react';
import { usePolling } from './usePolling';

type Lease = { editor: string; revision: number };
type Request = <T>(path: string, data?: unknown) => Promise<T>;
export function useQueueEditLease(path: string, lease: Lease | null, request: Request, onLost: (error: string) => void) {
  const current = useRef({ lease, onLost }); current.current = { lease, onLost };
  usePolling(async () => {
    const value = current.current.lease;
    if (!value) return;
    try { await request(path, { editor: value.editor, revision: value.revision, id: crypto.randomUUID(), action: 'renew' }); }
    catch (error) { if (current.current.lease?.editor === value.editor) current.current.onLost(error instanceof Error ? error.message : 'Edit expired. Open the message again.'); }
  }, { interval: 10000, enabled: !!lease, immediate: false }, [path, lease?.editor]);
  useEffect(() => {
    if (!lease) return;
    const release = () => {
      const value = current.current.lease;
      if (!value) return;
      current.current.lease = null;
      void fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ editor: value.editor, revision: value.revision, id: crypto.randomUUID(), action: 'cancel' }), keepalive: true }).catch(() => {});
    };
    const reconnect = () => { release(); current.current.onLost('Edit ended after reconnecting. Open the message again.'); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) reconnect(); };
    window.addEventListener('pagehide', release); window.addEventListener('online', reconnect); window.addEventListener('pageshow', restored);
    return () => { release(); window.removeEventListener('pagehide', release); window.removeEventListener('online', reconnect); window.removeEventListener('pageshow', restored); };
  }, [path, lease?.editor]);
}
