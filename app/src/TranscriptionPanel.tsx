import { attachmentSize } from './attachments';
import { usePolling } from './hooks/usePolling';
import { Alert, Button, Checkbox, Collapsible, IconButton, Tooltip } from './ui/kit';
import { RefreshCw } from 'lucide-react';
import './machines-data.css';
import { useEffect, useRef, useState } from 'react';

type Operation = { id: string; status: string; model: string; origin: string; result: { id: string; name: string; size: number } | null; usage: { type: string; input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null; seconds?: number } | null };
type Info = { provider: { id: string; model: string; origin: string } | null; format: string | null; operation: Operation | null };
export function TranscriptionPanel({ path, request }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const [open, setOpen] = useState(false);
  return <Collapsible title="Transcribe" open={open} onOpenChange={setOpen}>{open && <TranscriptionControls key={path} path={path} request={request} />}</Collapsible>;
}
function TranscriptionControls({ path, request }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const [info, setInfo] = useState<Info | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false), [cancelling, setCancelling] = useState(false);
  const generation = useRef(0), locked = useRef(false), endpoint = `${path}?transcription=1`;
  async function refresh(signal?: AbortSignal) {
    if (locked.current) return;
    locked.current = true; const version = ++generation.current; setBusy(true);
    try { const value = await request<Info>(endpoint); if (!signal?.aborted && version === generation.current) { setInfo(value); setError(''); setConsent(false); } }
    catch { if (!signal?.aborted && version === generation.current) { setInfo(null); setError('Transcription status unavailable. Reload status before trying again.'); } }
    finally { if (version === generation.current) { locked.current = false; setBusy(false); } }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []);
  usePolling(signal => refresh(signal), { interval: 1500, enabled: info?.operation?.status === 'pending', immediate: false });
  async function send() {
    if (locked.current || !consent || !info?.provider || !info.format) return;
    locked.current = true; const version = ++generation.current; setBusy(true); setError(''); setConsent(false);
    const id = crypto.randomUUID();
    setInfo({ ...info, operation: { id, status: 'pending', model: info.provider.model, origin: info.provider.origin, result: null, usage: null } });
    try {
      const operation = await request<Operation>(endpoint, { id, provider: info.provider.id, consent: true, ...(info.operation && ['uncertain', 'cancelled'].includes(info.operation.status) ? { retryOf: info.operation.id } : {}) });
      if (version === generation.current) setInfo({ ...info, operation });
    } catch { if (version === generation.current) { setInfo(null); setError('Delivery is unconfirmed. Reload status; do not resend until status is known.'); } }
    finally { if (version === generation.current) { locked.current = false; setBusy(false); } }
  }
  async function cancel() {
    if (cancelling || info?.operation?.status !== 'pending') return;
    const current = info, version = ++generation.current; locked.current = true; setBusy(true); setCancelling(true); setConsent(false);
    try {
      const operation = await request<Operation>(endpoint, { action: 'cancel', id: current.operation!.id });
      if (version === generation.current) { setInfo({ ...current, operation }); setError(''); }
    } catch { if (version === generation.current) { setInfo(null); setError('Cancellation is unconfirmed. Reload status before trying again.'); } }
    finally { if (version === generation.current) { locked.current = false; setBusy(false); setCancelling(false); } }
  }
  const operation = info?.operation, ready = info?.provider && info.format && (!operation || ['uncertain', 'cancelled'].includes(operation.status));
  return <section className="k-stack bs-root set4-transcription">
    <div className="set4-transcription__head"><Tooltip content={<span className="bs-root set4-tooltip">{"WAV, MP3, FLAC, OGG, WebM, M4A/MP4; up to 10 MiB. Provider may charge fees. Transcript is saved as a text file, separate from chat."}</span>}><span className="k-field__hint" tabIndex={0}>File transcription</span></Tooltip><IconButton label="Reload transcription status" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden /></IconButton></div>
    {error && <Alert tone="error">{error}</Alert>}
    {info && !info.provider && <p className="k-field__hint">Transcription unavailable. No provider configured.</p>}
    {info && !info.format && <p className="k-field__hint">Unsupported file. WAV, MP3, FLAC, OGG, WebM or M4A/MP4, up to 10 MiB.</p>}
    {(info?.format === 'mp4' || info?.format === 'webm') && <Alert tone="warn">Whole file is sent, including any video. Provider must support its format and codec.</Alert>}
    {operation?.status === 'pending' && <p role="status">Processing. Closing keeps transcription running.</p>}
    {operation?.status === 'pending' && <Button size="sm" disabled={cancelling} onClick={() => void cancel()}>Cancel transcription</Button>}
    {operation?.status === 'cancelled' && <p role="status">Cancelled in Minarbot. Provider may still process or bill this request. New attempts may incur another charge.</p>}
    {operation?.status === 'uncertain' && <Alert tone="warn">The previous result is uncertain. Check the provider before retrying. A new request may incur another charge.</Alert>}
    {operation && <p className="k-field__hint">{operation.usage?.type === 'duration' ? `Duration: ${operation.usage.seconds} seconds.` : operation.usage?.type === 'tokens' ? `Tokens: input ${operation.usage.input_tokens ?? 'unknown'}, output ${operation.usage.output_tokens ?? 'unknown'}, total ${operation.usage.total_tokens ?? 'unknown'}.` : 'Usage unknown ·'} Cost unknown.</p>}
    {operation?.result && <a className="k-link" href={`${path.slice(0, path.lastIndexOf('/'))}/${operation.result.id}`} download={operation.result.name}>Download transcript ({attachmentSize(operation.result.size)})</a>}
    {ready && <><p className="k-field__hint">{info.provider!.origin} · {info.provider!.model} · Cost unknown</p><Checkbox checked={consent} disabled={busy} onChange={setConsent} label={`Send this file to ${info.provider!.origin}${info.format === 'mp4' || info.format === 'webm' ? ' (including any video)' : ''}${operation ? ' and accept a possible additional charge' : ''}.`} /><Button size="sm" variant="primary" disabled={busy || !consent} onClick={() => void send()}>Transcribe</Button></>}
  </section>;
}
