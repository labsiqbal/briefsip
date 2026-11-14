import { Alert, Button, Checkbox, Collapsible } from './ui/kit';
import { useEffect, useRef, useState } from 'react';

type Operation = { id: string; status: string; model: string; origin: string; result: { id: string; name: string; size: number } | null; usage: { type: string; input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null; seconds?: number } | null };
type Info = { provider: { id: string; model: string; origin: string } | null; format: string | null; operation: Operation | null };
export function TranscriptionPanel({ path, request }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const [open, setOpen] = useState(false);
  return <Collapsible title="Audio transcription" open={open} onOpenChange={setOpen}>{open && <TranscriptionControls key={path} path={path} request={request} />}</Collapsible>;
}
function TranscriptionControls({ path, request }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const [info, setInfo] = useState<Info | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false), [cancelling, setCancelling] = useState(false);
  const generation = useRef(0), locked = useRef(false), endpoint = `${path}?transcription=1`;
  async function refresh() {
    if (locked.current) return;
    locked.current = true; const version = ++generation.current; setBusy(true);
    try { const value = await request<Info>(endpoint); if (version === generation.current) { setInfo(value); setError(''); setConsent(false); } }
    catch { if (version === generation.current) { setInfo(null); setError('Transcription status unavailable. Reload status before trying again.'); } }
    finally { if (version === generation.current) { locked.current = false; setBusy(false); } }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []);
  useEffect(() => { if (info?.operation?.status !== 'pending') return; const timer = setInterval(() => void refresh(), 1500); return () => clearInterval(timer); }, [info?.operation?.status]);
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
  return <section className="k-stack bs-root">
    <p>File is sent to the transcription provider only after approval. The provider may charge fees. Results are saved as a text file and are not sent to chat automatically.</p>
    {error && <Alert tone="error">{error}</Alert>}
    {info && !info.provider && <p className="k-field__hint">Transcription provider is not configured on the host.</p>}
    {info && !info.format && <p className="k-field__hint">This file is not recognized as WAV, MP3, FLAC, OGG, WebM, or M4A/MP4. File limit is 10 MiB.</p>}
    {(info?.format === 'mp4' || info?.format === 'webm') && <Alert tone="warn">M4A/MP4 or WebM files are sent whole, including video when present. Briefsip does not separate audio tracks. The provider must support this format and codec.</Alert>}
    {operation?.status === 'pending' && <p role="status">Transcription is processing. Closing the panel does not cancel delivery.</p>}
    {operation?.status === 'pending' && <Button size="sm" disabled={cancelling} onClick={() => void cancel()}>Cancel transcription</Button>}
    {operation?.status === 'cancelled' && <p role="status">Transcription was cancelled in Briefsip. The provider may have processed or billed the request. A new attempt may incur another charge.</p>}
    {operation?.status === 'uncertain' && <Alert tone="warn">The previous result is uncertain. Check the provider before retrying. A new request may incur another charge.</Alert>}
    {operation && <p className="k-field__hint">{operation.usage?.type === 'duration' ? `Provider-reported duration: ${operation.usage.seconds} seconds.` : operation.usage?.type === 'tokens' ? `Provider-reported tokens: input ${operation.usage.input_tokens ?? 'unknown'}, output ${operation.usage.output_tokens ?? 'unknown'}, total ${operation.usage.total_tokens ?? 'unknown'}.` : 'Provider has not reported usage.'} Cost is unknown.</p>}
    {operation?.result && <a className="k-link" href={`${path.slice(0, path.lastIndexOf('/'))}/${operation.result.id}`} download={operation.result.name}>Download transcript ({operation.result.size} bytes)</a>}
    {ready && <><p>Destination: {info.provider!.origin}. Model: {info.provider!.model}.</p><Checkbox checked={consent} disabled={busy} onChange={setConsent} label={`I agree to send this file to that provider${operation ? ' and accept the risk of an additional charge from a new attempt' : ''}.`} /><Button size="sm" variant="primary" disabled={busy || !consent} onClick={() => void send()}>Send for transcription</Button></>}
    <Button size="sm" disabled={busy} onClick={() => void refresh()}>Reload transcription status</Button>
  </section>;
}
