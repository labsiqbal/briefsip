import { useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Attachments } from './Attachments';
import { useQueueEditLease } from './hooks/useQueueEditLease';
import { Button, IconButton, Textarea } from './ui/kit';

type File = { id: string; name: string; size?: number };
type Command = { id: string; editor: string; revision: number; action: 'hold' | 'save' | 'cancel'; text?: string; files?: string[] };
type Draft = { editor: string; revision: number; text: string; files: File[] };
export function QueueEditor({ turn, path, archived, request, onChanged }: { turn: { id: string; revision: number; status: string; text: string; editing?: boolean; files: File[] }; path: string; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T>; onChanged: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<Command | null>(null), flight = useRef(false);
  const endpoint = `${path}/${turn.id}/edit`;
  useQueueEditLease(endpoint, draft, request, value => { setDraft(null); pending.current = null; setError(value); onChanged(); });
  async function act(action: Command['action']) {
    if (flight.current) return;
    const value = draft ?? { editor: crypto.randomUUID(), revision: turn.revision, text: turn.text, files: turn.files };
    const command = pending.current ?? { id: crypto.randomUUID(), editor: value.editor, revision: value.revision, action, ...(action === 'save' ? { text: value.text, files: value.files.map(file => file.id) } : {}) };
    pending.current = command; flight.current = true; setBusy(true); setError('');
    try {
      const result = await request<{ revision: number }>(endpoint, command);
      pending.current = null;
      setDraft(command.action === 'hold' ? { ...value, revision: result.revision } : null);
      onChanged();
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status < 500) { pending.current = null; setDraft(null); onChanged(); }
      setError(error instanceof Error ? error.message : 'Change not confirmed. Retry the change.');
    } finally { flight.current = false; setBusy(false); }
  }
  if (turn.status !== 'queued' && !draft && !pending.current && !error) return null;
  return <div className={`queue-editor${draft ? ' is-open' : ''}`}>
    {!draft && !pending.current && <IconButton label="Edit" disabled={busy || archived || !!turn.editing} onClick={() => void act('hold')}><Pencil size={14} aria-hidden /></IconButton>}
    {draft && <form className="queue-editor__form" aria-label="Edit queued message" onSubmit={event => { event.preventDefault(); void act('save'); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); void act('cancel'); } }}>
      <Textarea aria-label="Replacement message" autoFocus value={draft.text} maxLength={16000} readOnly={busy || !!pending.current} onChange={event => setDraft({ ...draft, text: event.target.value })} />
      {!!draft.files.length && <Attachments files={draft.files.map(file => ({ ...file, size: file.size ?? 0 }))} path={path.replace(/\/turns$/, '/files')} disabled={busy || !!pending.current} onRemove={id => setDraft({ ...draft, files: draft.files.filter(file => file.id !== id) })} />}
      <div className="k-row-actions"><Button size="sm" variant="primary" type="submit" disabled={busy || !!pending.current || (!draft.text.trim() && !draft.files.length)}>Save message</Button><Button size="sm" variant="ghost" disabled={busy || !!pending.current} onClick={() => void act('cancel')}>Cancel edit</Button></div>
    </form>}
    {pending.current && !busy && <Button size="sm" variant="ghost" onClick={() => void act(pending.current!.action)}>Retry change</Button>}
    {error && <span className="message-error" role="alert">{error}</span>}
  </div>;
}
