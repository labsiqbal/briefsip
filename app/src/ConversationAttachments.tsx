import { HttpError, readJson } from './http';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { AudioRecorder } from './AudioRecorder';
import { Attachments } from './Attachments';
import { removeAttachment, uploadLimitError } from './attachments';
import { Alert, Button, IconButton, RecoveryAlert } from './ui/kit';

type Request = <T>(path: string, data?: unknown) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : 'Connection failed. Try again.';

// Keep upload receipts in conversation scope, independent of the right panel.
export function useConversationAttachments({ path, archived, attached, onAttach, locked, pastedFiles, onPasteSettled, onFiles, filesOpen, api }: {
  path: string; archived: boolean; attached: string[]; onAttach: (ids: string[]) => void; locked: boolean;
  filesOpen: boolean; pastedFiles: File[]; onPasteSettled: () => void; onFiles: (files: File[]) => void; api: Request;
}) {
  type StoredFile = { seq: number; id: string; name: string; size: number; image?: boolean };
  type Upload = { id: string; name: string; size: number; digest: string; file?: File; attach?: boolean };
  const storageKey = `briefsip:upload:${path}`;
  const [recovered] = useState<Upload | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return value && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.name === 'string' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 10 * 1024 * 1024 && /^[0-9a-f]{64}$/.test(value.digest) ? { id: value.id, name: value.name, size: value.size, digest: value.digest, attach: value.attach === true } : null;
    } catch { return null; }
  });
  const [files, setFiles] = useState<StoredFile[]>([]), [metadata, setMetadata] = useState<Record<string, StoredFile>>({}), [panelCopies, setPanelCopies] = useState<Record<string, string>>({});
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<File | null>(null), [recording, setRecording] = useState(false);
  const pending = useRef<Upload | null>(recovered);
  const pasteSeen = useRef<File[] | undefined>(undefined);
  const attachmentState = useRef({ attached, onAttach });
  attachmentState.current = { attached, onAttach };
  const attachUploaded = (id: string) => {
    const current = attachmentState.current;
    if (!current.attached.includes(id) && current.attached.length < 4) {
      const ids = [...current.attached, id]; current.attached = ids; current.onAttach(ids);
    }
  };
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function clearUpload(id: string) {
    if (JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')?.id === id) sessionStorage.removeItem(storageKey);
    if (pending.current?.id === id) pending.current = null;
  }
  useEffect(() => {
    if (busy) return;
    let stopped = false;
    setLoading(true);
    void api<StoredFile[]>(path).then(rows => { if (!stopped) { setFiles(rows); setError(''); } }).catch(error => { if (!stopped) setError(message(error)); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [path, reload, filesOpen]);
  useEffect(() => {
    if (!pastedFiles?.length || pasteSeen.current === pastedFiles || busy || loading) return;
    pasteSeen.current = pastedFiles;
    if (archived || locked || recording || pending.current || selected) { setError('Finish the current upload before pasting files.'); onPasteSettled?.(); return; }
    const limitError = uploadLimitError(pastedFiles, attachmentState.current.attached.length);
    if (limitError) { setError(limitError); onPasteSettled?.(); return; }
    void (async () => { try { for (const file of pastedFiles) { if (!mounted.current || !await upload(undefined, file)) break; } } finally { onPasteSettled?.(); } })();
  }, [pastedFiles, busy, loading]);
  useEffect(() => {
    const missing = attached.filter(id => !metadata[id] && !files.some(file => file.id === id));
    if (!missing.length || loading) return;
    let stopped = false;
    void Promise.all(missing.map(id => api<StoredFile>(`${path}/${encodeURIComponent(id)}?metadata=1`))).then(rows => {
      if (!stopped) setMetadata(current => ({ ...current, ...Object.fromEntries(rows.map(row => [row.id, row])) }));
    }).catch(error => { if (!stopped) setError(message(error)); });
    return () => { stopped = true; };
  }, [attached, files, metadata, path, loading]);
  async function upload(event?: FormEvent, pasted?: File) {
    event?.preventDefault(); if (busy || loading || recording) return false;
    const file = pending.current?.file ?? pasted ?? selected;
    if (!file) { setError('Select the same file again to continue the upload.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Maximum file size is 10 MiB.'); return; }
    setBusy(true); setError(''); if (pasted) setSelected(pasted);
    try {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (!mounted.current) return;
      if (pending.current && (pending.current.name !== file.name || pending.current.size !== file.size || pending.current.digest !== digest)) throw new Error('File differs from the pending upload. Select the original file or check upload status.');
      const request = pending.current ?? { id: crypto.randomUUID(), name: file.name, size: file.size, digest, attach: !!pasted };
      sessionStorage.setItem(storageKey, JSON.stringify({ id: request.id, name: request.name, size: request.size, digest: request.digest, attach: request.attach }));
      pending.current = { ...request, file };
      const response = await fetch(`${path}/${request.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file }).catch(() => { throw new Error('Connection lost. Try the same upload again.'); });
      const result = await readJson<StoredFile>(response, 'Upload failed.');
      setFiles(current => [result, ...current.filter(file => file.id !== result.id)]);
      if (request.attach) attachUploaded(result.id);
      clearUpload(request.id); setSelected(null); if (input.current) input.current.value = '';
      return request.id;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 409) {
        try { if (pending.current) clearUpload(pending.current.id); } catch { /* Retain retry identity if browser storage is unavailable. */ }
      }
      setError(message(error));
    }
    finally { setBusy(false); }
  }
  async function checkPending() {
    const request = pending.current; if (!request || busy || loading) return;
    setBusy(true); setError('');
    try {
      const result = await api<StoredFile & { digest: string }>(`${path}/${request.id}?metadata=1`);
      if (result.name !== request.name || result.size !== request.size || result.digest !== request.digest) throw new Error('Receipt does not match the pending upload.');
      setFiles(current => [result, ...current.filter(file => file.id !== result.id)]);
      if (request.attach) attachUploaded(result.id);
      clearUpload(request.id); setSelected(null); if (input.current) input.current.value = '';
    } catch (error) { setError(error instanceof Error && 'status' in error && error.status === 404 ? 'Upload was not saved. Select the original file again to continue.' : message(error)); }
    finally { setBusy(false); }
  }
  async function togglePanelFile(file: StoredFile) {
    if (disabled || pending.current || selected) return;
    const id = panelCopies[file.id] ?? file.id;
    if (attached.includes(id)) { onAttach(removeAttachment(attached, id)); return; }
    if (attached.length >= 4) return;
    if (files.some(row => row.id === id) || metadata[id]) { onAttach([...attached, id]); return; }
    // Returned task files keep their source scope. Copy through the owner upload API before sending.
    setBusy(true); setError('');
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Maximum file size is 10 MiB.');
      const response = await fetch(`${path.replace(/\/files$/, '/panel/files')}/${file.id}`);
      if (!response.ok) throw new Error('File could not load. Try again.');
      const copy = await upload(undefined, new File([await response.blob()], file.name));
      if (typeof copy === 'string') setPanelCopies(current => ({ ...current, [file.id]: copy }));
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  const selectedFiles = attached.map(id => files.find(file => file.id === id) ?? metadata[id] ?? { id, name: 'Attachment', size: 0 });
  const disabled = archived || locked || recording || busy || loading || !!pastedFiles.length;
  const choose = () => input.current?.click();
  const composer = <div className="composer-attachments bs-root">
    <input ref={input} type="file" multiple hidden aria-label="Attach files" disabled={recording || busy || loading || locked || (archived && !pending.current)} onChange={event => {
      const chosen = Array.from(event.target.files ?? []); event.target.value = '';
      if (pending.current && chosen[0]) { setSelected(chosen[0]); void upload(undefined, chosen[0]); }
      else if (chosen.length) onFiles(chosen);
    }} />
    {!!selectedFiles.length && <Attachments files={selectedFiles} path={path} label="Composer attachments" disabled={disabled} onRemove={id => onAttach(removeAttachment(attached, id))} />}
    {busy && <span className="k-field__hint" role="status">Uploading...</span>}
    {selected && !busy && !pending.current && <div className="k-inline"><span className="attachment__name">{selected.name}</span><Button size="sm" onClick={() => selected && void upload(undefined, selected)}>Upload file</Button><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Remove file</Button></div>}
    {pending.current && <RecoveryAlert inFlight={busy} tone="warn" title={`Upload ${pending.current.name} is not confirmed yet`} actions={<><Button size="sm" disabled={busy || loading} onClick={() => pending.current?.file ? void upload() : choose()}>Retry upload</Button><Button size="sm" disabled={busy || loading} onClick={() => void checkPending()}>Check upload status</Button></>}>Select the same file again or check upload status.</RecoveryAlert>}
    {error && <Alert tone="error" actions={!pending.current && <><IconButton label="Reload files" disabled={busy || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden /></IconButton><IconButton label="Dismiss attachment error" onClick={() => setError('')}><X size={14} aria-hidden /></IconButton></>}>{error}</Alert>}
  </div>;
  return { composer, selectedFiles, choose, togglePanelFile, panelAttached: [...attached, ...Object.entries(panelCopies).filter(([, id]) => attached.includes(id)).map(([id]) => id)], uploading: busy || recording, recordingAction: <AudioRecorder disabled={archived || locked || busy || loading || !!pastedFiles.length || !!pending.current || !!selected || attached.length >= 4} onRecording={setRecording} onReady={file => onFiles([file])} /> };
}
