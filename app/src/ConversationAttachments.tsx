import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Ellipsis, Eye, Mic, RefreshCw, X } from 'lucide-react';
import { AudioRecorder } from './AudioRecorder';
import { TranscriptionPanel } from './TranscriptionPanel';
import { HtmlPreview } from './HtmlPreview';
import { Attachment, Attachments } from './Attachments';
import { isAttachmentImage, removeAttachment, uploadLimitError } from './attachments';
import { ActionPopover, Alert, Button, Checkbox, CodeBlock, Dialog, EmptyState, IconButton, RecoveryAlert, SkeletonRows } from './ui/kit';

type Request = <T>(path: string, data?: unknown) => Promise<T>;
class HttpError extends Error { status: number; constructor(status: number, text: string) { super(text); this.status = status; } }
const message = (error: unknown) => error instanceof Error ? error.message : 'Connection failed. Try again.';

// Keep upload receipts in conversation scope, independent of the right panel.
export function useConversationAttachments({ path, archived, attached, onAttach, locked, pastedFiles, onPasteSettled, onFiles, libraryOpen, api }: {
  path: string; archived: boolean; attached: string[]; onAttach: (ids: string[]) => void; locked: boolean;
  libraryOpen: boolean; pastedFiles: File[]; onPasteSettled: () => void; onFiles: (files: File[]) => void; api: Request;
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
  const [files, setFiles] = useState<StoredFile[]>([]), [metadata, setMetadata] = useState<Record<string, StoredFile>>({});
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<File | null>(null), [recording, setRecording] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [preview, setPreview] = useState<StoredFile | null>(null), [previewText, setPreviewText] = useState<string | null>(null), [previewError, setPreviewError] = useState('');
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
    setPreviewText(null); setPreviewError('');
    if (!preview) return;
    let stopped = false;
    void api<{ text: string }>(`${path}/${preview.id}?preview=text`).then(result => { if (!stopped) setPreviewText(result.text); }).catch(error => { if (!stopped) setPreviewError(message(error)); });
    return () => { stopped = true; };
  }, [path, preview]);
  useEffect(() => {
    if (busy) return;
    let stopped = false;
    setLoading(true);
    void api<StoredFile[]>(path).then(rows => { if (!stopped) { setFiles(rows); setMore(rows.length === 100); setError(''); } }).catch(error => { if (!stopped) setError(message(error)); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [path, reload, libraryOpen]);
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
      const result = await response.json();
      if (!response.ok) throw new HttpError(response.status, result.error ?? 'Upload failed.');
      setFiles(current => [result, ...current.filter(file => file.id !== result.id)]);
      if (request.attach) attachUploaded(result.id);
      clearUpload(request.id); setSelected(null); if (input.current) input.current.value = '';
      return true;
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
  async function loadMore() {
    if (busy) return; setBusy(true); setError('');
    try {
      const rows = await api<StoredFile[]>(`${path}?before=${files.at(-1)!.seq}`);
      setFiles(current => [...current, ...rows.filter(row => !current.some(file => file.id === row.id))]); setMore(rows.length === 100);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
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
    {recordingOpen && <Dialog open onOpenChange={setRecordingOpen} title="Record audio"><AudioRecorder disabled={archived || busy || loading || !!pending.current || !!selected} onRecording={setRecording} onReady={file => { setSelected(file); setRecordingOpen(false); }} /></Dialog>}
  </div>;
  const library = <section className="conversation-files k-stack bs-root" aria-label="Attachments"><div className="section-label">Attachments</div>
    {loading ? <SkeletonRows /> : files.length === 0 ? <EmptyState title="No files yet" /> : <>
      <div className="attachments__gallery">{files.filter(isAttachmentImage).map(file => <div className="attachment-library-image" key={file.id}><Attachment file={file} path={`${path}/${file.id}`} /><Checkbox label={<span className="sr-only">{`Attach ${file.name}`}</span>} checked={attached.includes(file.id)} disabled={disabled || (!attached.includes(file.id) && attached.length >= 4)} onChange={checked => onAttach(checked ? [...attached, file.id] : removeAttachment(attached, file.id))} /></div>)}</div>
      <div className="attachments__list">{files.filter(file => !isAttachmentImage(file)).map(file => <div className="attachment-library-file" key={file.id}>
        <Attachment file={file} path={`${path}/${file.id}`} />
        <div className="k-inline"><Checkbox label={<span className="sr-only">{`Attach ${file.name}`}</span>} checked={attached.includes(file.id)} disabled={disabled || (!attached.includes(file.id) && attached.length >= 4)} onChange={checked => onAttach(checked ? [...attached, file.id] : removeAttachment(attached, file.id))} /><ActionPopover label={`File actions: ${file.name}`} trigger={<IconButton label={`File actions: ${file.name}`}><Ellipsis size={14} aria-hidden /></IconButton>}><div className="k-stack attachment-file-actions"><Button size="sm" variant="ghost" aria-label={`View text: ${file.name}`} onClick={() => setPreview(file)}><Eye size={14} aria-hidden />View text</Button><HtmlPreview path={`${path}/${file.id}`} name={file.name} request={api} /><TranscriptionPanel path={`${path}/${file.id}`} request={api} /></div></ActionPopover></div>
      </div>)}</div>
    </>}
    {more && <Button size="sm" disabled={busy} onClick={() => void loadMore()}>Earlier files</Button>}
    {preview && <Dialog open onOpenChange={open => { if (!open) setPreview(null); }} title={preview.name}>{previewError ? <Alert tone="error">{previewError}</Alert> : previewText === null ? <p role="status">Loading preview...</p> : <CodeBlock label={`Preview ${preview.name}`}>{previewText || '(Empty file)'}</CodeBlock>}</Dialog>}
  </section>;
  return { composer, library, choose, uploading: busy || recording, recordingAction: <IconButton label="Record audio" disabled={disabled || !!pending.current || !!selected} onClick={() => setRecordingOpen(true)}><Mic size={14} aria-hidden /></IconButton> };
}
