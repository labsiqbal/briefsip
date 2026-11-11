import { useEffect, useRef, useState } from 'react';

type Command = { id: string; editor: string; revision: number; action: 'hold' | 'save' | 'cancel'; text?: string; files?: string[] };
type Draft = { editor: string; revision: number; text: string; files: string[]; held: boolean; pending: Command | null };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function recover(key: string): Draft | null {
  const raw = sessionStorage.getItem(key); if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value.editor !== 'string' || !uuid.test(value.editor) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.text !== 'string' || value.text.length > 16000 || typeof value.held !== 'boolean' || !Array.isArray(value.files) || value.files.length > 4 || value.files.some((id: unknown) => typeof id !== 'string' || !uuid.test(id))) throw new Error('Draft edit tidak valid.');
  if (value.pending && (!uuid.test(value.pending.id) || value.pending.editor !== value.editor || value.pending.revision !== value.revision || !['hold','save','cancel'].includes(value.pending.action) || (value.pending.action === 'save' && (value.pending.text !== value.text || JSON.stringify(value.pending.files) !== JSON.stringify(value.files))))) throw new Error('Permintaan edit tidak valid.');
  return value;
}
export function QueueEditor({ turn, path, archived, request }: { turn: { id: string; revision: number; status: string; text: string; editing?: boolean; files: { id: string; name: string }[] }; path: string; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const key = `briefsip-queue-edit:${path}:${turn.id}`;
  const [initial] = useState(() => { try { return { draft: recover(key), error: '' }; } catch { return { draft: null, error: 'Draft tersimpan tidak dapat dibaca. Pesan yang sedang diedit tetap ditahan; batalkan pesan untuk melepaskan antrean.' }; } });
  const [draft, setDraft] = useState(initial.draft), [error, setError] = useState(initial.error), [busy, setBusy] = useState(false), [open, setOpen] = useState(!!initial.draft);
  const [files, setFiles] = useState(turn.files), [fileError, setFileError] = useState('');
  const flight = useRef(false), mounted = useRef(true), textarea = useRef<HTMLTextAreaElement>(null), opener = useRef<HTMLButtonElement>(null), closing = useRef(false);
  useEffect(() => { if (!open && closing.current) { closing.current = false; (opener.current ?? document.getElementById(`turn-${turn.id}`))?.focus(); } }, [open, turn.id]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (open && draft && !draft.pending) textarea.current?.focus(); }, [open, draft?.held, !!draft?.pending]);
  useEffect(() => {
    if (!open) return; let stale = false;
    void request<{ id: string; name: string }[]>(path.replace(/\/turns$/, '/files')).then(rows => { if (!stale) { setFiles(rows); setFileError(''); } }).catch(() => { if (!stale) setFileError('Daftar file belum dimuat. Lampiran lama tetap tersimpan.'); });
    return () => { stale = true; };
  }, [open, path, request]);
  function persist(value: Draft) { sessionStorage.setItem(key, JSON.stringify(value)); setDraft(value); }
  function update(value: Partial<Draft>) {
    if (!draft || flight.current || draft.pending) return;
    try { persist({ ...draft, ...value }); setError(''); } catch { setError('Draft belum tersimpan. Periksa penyimpanan browser.'); }
  }
  async function act(action: Command['action']) {
    if (flight.current || initial.error) return;
    const value = draft ?? { editor: crypto.randomUUID(), revision: turn.revision, text: turn.text, files: turn.files.map(file => file.id), held: false, pending: null };
    const command: Command = value.pending ?? { id: crypto.randomUUID(), editor: value.editor, revision: action === 'hold' ? turn.revision : value.revision, action, ...(action === 'save' ? { text: value.text, files: value.files } : {}) };
    try { persist({ ...value, revision: command.revision, pending: command }); } catch { setError('Identitas edit belum tersimpan. Periksa penyimpanan browser.'); return; }
    flight.current = true; setBusy(true); setOpen(true); setError('');
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
        setError(error instanceof Error ? error.message : 'Perubahan belum terkonfirmasi. Coba lagi.');
      }
    }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  if (!draft && turn.status !== 'queued' && !initial.error) return null;
  return <section aria-label="Edit pesan antrean" className="queue-editor">
    {!open && <button ref={opener} className="secondary" disabled={busy || archived || !!initial.error || !!turn.editing} onClick={() => void act('hold')}>{turn.editing ? 'Pesan sedang diedit' : 'Edit pesan antrean'}</button>}
    {open && draft && <><p>{draft.held || draft.pending ? 'Pesan dengan hold terkonfirmasi ditahan sampai edit disimpan atau dibatalkan.' : 'Editor ini tidak menahan pesan. Salinan draft tetap tersimpan di browser.'}</p><label>Pesan pengganti<textarea ref={textarea} value={draft.text} maxLength={16000} readOnly={busy || !draft.held || !!draft.pending} onChange={event => update({ text: event.target.value })} /></label>
      {fileError && <p role="status">{fileError}</p>}
      <fieldset disabled={busy || !draft.held || !!draft.pending}><legend>Lampiran pesan</legend>{[...turn.files, ...files.filter(file => !turn.files.some(old => old.id === file.id))].map(file => <label className="member-option" key={file.id}><input type="checkbox" checked={draft.files.includes(file.id)} disabled={!draft.files.includes(file.id) && draft.files.length >= 4} onChange={event => update({ files: event.target.checked ? [...draft.files, file.id] : draft.files.filter(id => id !== file.id) })} />{file.name}</label>)}</fieldset>
      <div className="form-actions">{!draft.held && !draft.pending ? <><button className="secondary" disabled={busy || archived || turn.status !== 'queued'} onClick={() => void act('hold')}>Edit lagi</button><button className="secondary" onClick={() => { try { sessionStorage.removeItem(key); setDraft(null); closing.current = true; setOpen(false); } catch { setError('Draft belum dapat dihapus.'); } }}>Buang salinan draft</button></> : draft.pending ? <button className="secondary" disabled={busy} onClick={() => void act(draft.pending!.action)}>Coba perubahan lagi</button> : <><button disabled={busy || archived || !draft.held || !draft.text.trim()} onClick={() => void act('save')}>Simpan pesan</button><button className="secondary" disabled={busy || !draft.held} onClick={() => void act('cancel')}>Batal edit</button></>}</div></>}
    {draft && !busy && turn.status !== 'queued' && <button className="secondary" onClick={() => { try { sessionStorage.removeItem(key); setDraft(null); closing.current = true; setOpen(false); setError(''); } catch { setError('Draft belum dapat dihapus dari browser.'); } }}>Tutup edit pesan yang sudah selesai</button>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
