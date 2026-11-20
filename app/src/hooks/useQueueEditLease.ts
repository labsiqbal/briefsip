import { readProductStorage } from '../rename-storage.ts';
import { useEffect, useRef } from 'react';
import { usePolling } from './usePolling.ts';

type Lease = { editor: string; revision: number };
export type SavedQueueEdit = Lease & { id: string; action: 'save'; text: string; files: string[] };
export function readQueueEdit(key: string): SavedQueueEdit | null {
  const raw = readProductStorage(sessionStorage, key);
  if (!raw) return null;
  const value = JSON.parse(raw), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (!value || value.action !== 'save' || typeof value.id !== 'string' || !uuid.test(value.id)
    || typeof value.editor !== 'string' || !uuid.test(value.editor)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.text !== 'string'
    || value.text.length > 16000 || !Array.isArray(value.files) || value.files.length > 4
    || value.files.some((file: unknown) => typeof file !== 'string' || !uuid.test(file))) throw new Error('Saved edit could not be read.');
  return value;
}
type Request = <T>(path: string, data?: unknown) => Promise<T>;
export function useQueueEditLease(path: string, lease: Lease | null, request: Request, onLost: (error: string) => void, key: string) {
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
      let saved: SavedQueueEdit | null = null;
      try { saved = readQueueEdit(key); } catch { return; }
      const command = saved ?? { editor: value.editor, revision: value.revision, id: crypto.randomUUID(), action: 'cancel' };
      void fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), keepalive: true }).catch(() => {});
    };
    const reconnect = () => { release(); current.current.onLost('Edit ended after reconnecting. Open the message again.'); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) reconnect(); };
    window.addEventListener('pagehide', release); window.addEventListener('online', reconnect); window.addEventListener('pageshow', restored);
    return () => { release(); window.removeEventListener('pagehide', release); window.removeEventListener('online', reconnect); window.removeEventListener('pageshow', restored); };
  }, [path, lease?.editor, key]);
}
