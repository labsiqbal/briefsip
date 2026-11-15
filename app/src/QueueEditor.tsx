import { useEffect, useRef, useState } from 'react';

import { Alert, Button, Checkbox, Field, Textarea } from './ui/kit';

type Command = { id: string; editor: string; revision: number; action: 'hold' | 'save' | 'cancel'; text?: string; files?: string[] };
type Draft = { editor: string; revision: number; text: string; files: string[]; held: boolean; pending: Command | null };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function recover(key: string): Draft | null {
  const raw = sessionStorage.getItem(key); if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value.editor !== 'string' || !uuid.test(value.editor) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.text !== 'string' || value.text.length > 16000 || typeof value.held !== 'boolean' || !Array.isArray(value.files) || value.files.length > 4 || value.files.some((id: unknown) => typeof id !== 'string' || !uuid.test(id))) throw new Error('Edit draft is invalid.');
  if (value.pending && (!uuid.test(value.pending.id) || value.pending.editor !== value.editor || value.pending.revision !== value.revision || !['hold','save','cancel'].includes(value.pending.action) || (value.pending.action === 'save' && (value.pending.text !== value.text || JSON.stringify(value.pending.files) !== JSON.stringify(value.files))))) throw new Error('Edit request is invalid.');
  return value;
}
export function QueueEditor({ turn, path, archived, request, compact = false }: { compact?: boolean; turn: { id: string; revision: number; status: string; text: string; editing?: boolean; files: { id: string; name: string }[] }; path: string; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const key = `briefsip-queue-edit:${path}:${turn.id}`;
  const [initial] = useState(() => { try { return { draft: recover(key), error: '' }; } catch { return { draft: null, error: 'Saved draft could not be read. The message being edited stays held; cancel the message to release the queue.' }; } });
  const [draft, setDraft] = useState(initial.draft), [error, setError] = useState(initial.error), [busy, setBusy] = useState(false), [open, setOpen] = useState(!!initial.draft);
  const [files, setFiles] = useState(turn.files), [fileError, setFileError] = useState('');
  const [filePage, setFilePage] = useState<number | null>(null), [nextFilePage, setNextFilePage] = useState<number | null>(null), [fileRetry, setFileRetry] = useState(0), [filesLoading, setFilesLoading] = useState(false);
  const flight = useRef(false), mounted = useRef(true), textarea = useRef<HTMLTextAreaElement>(null), opener = useRef<HTMLButtonElement>(null), closing = useRef(false);
  useEffect(() => { if (!open && closing.current) { closing.current = false; (opener.current ?? document.getElementById(`turn-${turn.id}`))?.focus(); } }, [open, turn.id]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (open && draft && !draft.pending) textarea.current?.focus(); }, [open, draft?.held, !!draft?.pending]);
  useEffect(() => {
    if (!open) return; let stale = false;
    setFilesLoading(true); setFileError('');
    void request<{ id: string; name: string; seq: number }[]>(`${path.replace(/\/turns$/, '/files')}${filePage === null ? '' : `?before=${filePage}`}`).then(rows => {
      if (!stale) { setFiles(current => filePage === null ? rows : [...current, ...rows.filter(row => !current.some(file => file.id === row.id))]); setNextFilePage(rows.length === 100 ? rows.at(-1)!.seq : null); }
    }).catch(() => { if (!stale) setFileError('File list has not loaded. Selected attachments remain saved.'); }).finally(() => { if (!stale) setFilesLoading(false); });
    return () => { stale = true; };
  }, [open, path, request, filePage, fileRetry]);
  function persist(value: Draft) { sessionStorage.setItem(key, JSON.stringify(value)); setDraft(value); }
  function update(value: Partial<Draft>) {
    if (!draft || flight.current || draft.pending) return;
    try { persist({ ...draft, ...value }); setError(''); } catch { setError('Draft has not been saved. Check browser storage.'); }
  }
  async function act(action: Command['action']) {
    if (flight.current || initial.error) return;
    const value = draft ?? { editor: crypto.randomUUID(), revision: turn.revision, text: turn.text, files: turn.files.map(file => file.id), held: false, pending: null };
    const command: Command = value.pending ?? { id: crypto.randomUUID(), editor: value.editor, revision: action === 'hold' ? turn.revision : value.revision, action, ...(action === 'save' ? { text: value.text, files: value.files } : {}) };
    try { persist({ ...value, revision: command.revision, pending: command }); } catch { setError('Edit identity has not been saved. Check browser storage.'); return; }
    flight.current = true; setBusy(true); if (!open) setFilePage(null); setOpen(true); setError('');
    try {
      const result = await request<{ revision: number; editing: boolean; text: string; files: string[] }>(`${path}/${turn.id}/edit`, command);
      if (!mounted.current) return;
      if (command.action === 'hold') persist({ ...value, revision: result.revision, held: true, pending: null });
      else if (command.action === 'cancel') persist({ ...value, editor: crypto.randomUUID(), revision: result.revision, held: false, pending: null });
      else { sessionStorage.removeItem(key); setDraft(null); closing.current = true; setOpen(false); }
    } catch (error) {
      if (mounted.current) {
        if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
          try { if (command.action === 'hold') persist({ ...value, editor: crypto.randomUUID(), held: false, pending: null }); else persist({ ...value, pending: null }); } catch { /* Keep recovery identity when browser storage is unavailable. */ }
        }
        setError(error instanceof Error ? error.message : 'Changes are not confirmed yet. Try again.');
      }
    }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  if (!draft && turn.status !== 'queued' && !initial.error) return null;
  return <section aria-label="Edit queued message" className="k-stack bs-root">
    {!open && <Button size="sm" style={{ alignSelf: 'flex-start' }} ref={opener} disabled={busy || archived || !!initial.error || !!turn.editing} onClick={() => void act('hold')}>{turn.editing ? 'Message is being edited' : compact ? 'Edit' : 'Edit queued message'}</Button>}
    {open && draft && <>{!compact && <p className="k-field__hint" style={{ margin: 0 }}>{draft.held || draft.pending ? 'Messages with a confirmed hold stay held until edits are saved or canceled.' : 'This editor is not holding the message. A draft copy remains saved in the browser.'}</p>}<Field label="Replacement message"><Textarea ref={textarea} value={draft.text} maxLength={16000} readOnly={busy || !draft.held || !!draft.pending} onChange={event => update({ text: event.target.value })} /></Field>
      {fileError && <Alert tone="error">{fileError}</Alert>}<Button size="sm" style={{ alignSelf: 'flex-start' }} aria-disabled={filesLoading} onClick={() => { if (!filesLoading) { setFilePage(null); setFileRetry(value => value + 1); } }}>Reload file list</Button>
      <fieldset className="k-fieldset" disabled={busy || !draft.held || !!draft.pending}><legend className="k-field__label">Message attachments</legend>{[...turn.files, ...files.filter(file => !turn.files.some(old => old.id === file.id)), ...draft.files.filter(id => !turn.files.some(file => file.id === id) && !files.some(file => file.id === id)).map(id => ({ id, name: `Saved attachment ${id}` }))].map(file => <Checkbox key={file.id} checked={draft.files.includes(file.id)} disabled={busy || !draft.held || !!draft.pending || (!draft.files.includes(file.id) && draft.files.length >= 4)} onChange={checked => update({ files: checked ? [...draft.files, file.id] : draft.files.filter(id => id !== file.id) })} label={file.name} />)}</fieldset>
      {filesLoading && <p role="status">Loading files...</p>}{(nextFilePage !== null || filePage !== null) && <Button size="sm" style={{ alignSelf: 'flex-start' }} aria-disabled={filesLoading || nextFilePage === null} onClick={() => { if (!filesLoading && nextFilePage !== null) { setFilePage(nextFilePage); setFileRetry(value => value + 1); } }}>{nextFilePage === null ? 'All files loaded' : fileError ? 'Retry file page' : 'Older files'}</Button>}
      <div className="k-row-actions">{!draft.held && !draft.pending ? <><Button size="sm" style={{ alignSelf: 'flex-start' }} disabled={busy || archived || turn.status !== 'queued'} onClick={() => void act('hold')}>Edit again</Button><Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => { try { sessionStorage.removeItem(key); setDraft(null); closing.current = true; setOpen(false); } catch { setError('Draft could not be deleted.'); } }}>Discard draft copy</Button></> : draft.pending ? <Button size="sm" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void act(draft.pending!.action)}>Retry change</Button> : <><Button size="sm" style={{ alignSelf: 'flex-start' }} variant="primary" disabled={busy || archived || !draft.held || !draft.text.trim()} onClick={() => void act('save')}>Save message</Button><Button size="sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !draft.held} onClick={() => void act('cancel')}>Cancel edit</Button></>}</div></>}
    {draft && !busy && turn.status !== 'queued' && <Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => { try { sessionStorage.removeItem(key); setDraft(null); closing.current = true; setOpen(false); setError(''); } catch { setError('Draft could not be deleted from the browser.'); } }}>Close completed message editor</Button>}
    {error && <Alert tone="error">{error}</Alert>}
  </section>;
}
