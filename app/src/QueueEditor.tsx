import { readProductStorage, removeProductStorage } from './rename-storage.ts';
import { useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Attachments } from './Attachments';
import { readQueueEdit, useQueueEditLease } from './hooks/useQueueEditLease';
import { usePolling } from './hooks/usePolling';
import { Button, IconButton, Textarea } from './ui/kit';

type File = { id: string; name: string; size?: number };
type Command = { id: string; editor: string; revision: number; action: 'hold' | 'save' | 'cancel'; text?: string; files?: string[] };
type Draft = { editor: string; revision: number; text: string; files: File[] };
export function QueueEditor({ turn, path, archived, request, onChanged }: { turn: { id: string; revision: number; status: string; text: string; editing?: boolean; files: File[] }; path: string; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T>; onChanged: () => void }) {
  const endpoint = `${path}/${turn.id}/edit`;
  const key = `minarbot:queue-edit:${endpoint}`;
  const [recovery] = useState(() => { try { return { command: readQueueEdit(key), error: '' }; } catch { return { command: null, error: 'Saved edit could not be read. Check browser storage.' }; } });
  const [draft, setDraft] = useState<Draft | null>(() => recovery.command ? { ...recovery.command, files: recovery.command.files.map(id => turn.files.find(file => file.id === id) ?? { id, name: 'Attachment' }) } : null), [busy, setBusy] = useState(false), [error, setError] = useState(recovery.error);
  const pending = useRef<Command | null>(recovery.command), flight = useRef(false);
  useQueueEditLease(endpoint, draft, request, value => {
    try {
      if (readProductStorage(sessionStorage, key)) { void act('save'); return; }
    } catch { setError('Draft storage is unavailable. Copy your edit before leaving.'); return; }
    setDraft(null); pending.current = null; setError(value); onChanged();
  }, key);
  usePolling(async () => { if (pending.current === recovery.command && recovery.command) await act('save'); }, { interval: 2000, enabled: !!recovery.command }, [key]);
  function change(value: Draft) {
    setDraft(value);
    try { sessionStorage.setItem(key, JSON.stringify({ id: crypto.randomUUID(), editor: value.editor, revision: value.revision, action: 'save', text: value.text, files: value.files.map(file => file.id) })); }
    catch { setError('Draft was not saved. Copy your edit before leaving.'); }
  }
  async function act(action: Command['action']) {
    if (flight.current) return;
    const value = draft ?? { editor: crypto.randomUUID(), revision: turn.revision, text: turn.text, files: turn.files };
    let saved: Command | null = null;
    try {
      if (action === 'save') saved = readQueueEdit(key);
      if (saved && (saved.text !== value.text || JSON.stringify(saved.files) !== JSON.stringify(value.files.map(file => file.id)))) saved = null;
    }
    catch { setError('Saved edit could not be read. Copy your edit before leaving.'); return; }
    const command = pending.current ?? saved ?? { id: crypto.randomUUID(), editor: value.editor, revision: value.revision, action, ...(action === 'save' ? { text: value.text, files: value.files.map(file => file.id) } : {}) };
    pending.current = command; flight.current = true; setBusy(true); setError('');
    try {
      const result = await request<{ revision: number }>(endpoint, command);
      pending.current = null;
      if (command.action !== 'hold') removeProductStorage(sessionStorage, key);
      setDraft(command.action === 'hold' ? { ...value, revision: result.revision } : null);
      onChanged();
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status < 500) { pending.current = null; onChanged(); }
      setError(error instanceof Error ? error.message : 'Change not confirmed. Retry the change.');
    } finally { flight.current = false; setBusy(false); }
  }
  if (turn.status !== 'queued' && !draft && !pending.current && !error) return null;
  return <div className={`queue-editor${draft ? ' is-open' : ''}`}>
    {!draft && !pending.current && <IconButton label="Edit" disabled={busy || archived || !!turn.editing} onClick={() => void act('hold')}><Pencil size={14} aria-hidden /></IconButton>}
    {draft && <form className="queue-editor__form" aria-label="Edit queued message" onSubmit={event => { event.preventDefault(); void act('save'); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); void act('cancel'); } }}>
      <Textarea aria-label="Replacement message" autoFocus value={draft.text} maxLength={16000} readOnly={busy || !!pending.current} onChange={event => change({ ...draft, text: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.text.trim() || draft.files.length) void act('save'); } }} onBlur={event => { if (!event.currentTarget.form?.contains(event.relatedTarget as Node | null) && (draft.text.trim() || draft.files.length)) void act('save'); }} />
      {!!draft.files.length && <Attachments files={draft.files.map(file => ({ ...file, size: file.size ?? 0 }))} path={path.replace(/\/turns$/, '/files')} disabled={busy || !!pending.current} onRemove={id => change({ ...draft, files: draft.files.filter(file => file.id !== id) })} />}
      <div className="k-row-actions"><Button size="sm" variant="primary" type="submit" disabled={busy || !!pending.current || (!draft.text.trim() && !draft.files.length)}>Save message</Button><Button size="sm" variant="ghost" disabled={busy || !!pending.current} onClick={() => void act('cancel')}>Cancel edit</Button></div>
    </form>}
    {pending.current && !busy && <Button size="sm" variant="ghost" onClick={() => void act(pending.current!.action)}>Retry change</Button>}
    {error && <span className="message-error" role="alert">{error}</span>}
  </div>;
}
