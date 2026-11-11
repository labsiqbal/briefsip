import { useEffect, useRef, useState } from 'react';

type Operation = { id: string; status: string; model: string; origin: string; result: { id: string; name: string; size: number } | null; usage: { type: string; input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null; seconds?: number } | null };
type Info = { provider: { id: string; model: string; origin: string } | null; format: string | null; operation: Operation | null };
export function TranscriptionPanel({ path, request }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Transkripsi audio</summary>{open && <TranscriptionControls key={path} path={path} request={request} />}</details>;
}
function TranscriptionControls({ path, request }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const [info, setInfo] = useState<Info | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false), [cancelling, setCancelling] = useState(false);
  const generation = useRef(0), locked = useRef(false), endpoint = `${path}?transcription=1`;
  async function refresh() {
    if (locked.current) return;
    locked.current = true; const version = ++generation.current; setBusy(true);
    try { const value = await request<Info>(endpoint); if (version === generation.current) { setInfo(value); setError(''); setConsent(false); } }
    catch { if (version === generation.current) { setInfo(null); setError('Status transkripsi belum tersedia. Muat ulang status sebelum mencoba lagi.'); } }
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
    } catch { if (version === generation.current) { setInfo(null); setError('Hasil pengiriman belum terkonfirmasi. Muat ulang status; jangan mengirim ulang sebelum status diketahui.'); } }
    finally { if (version === generation.current) { locked.current = false; setBusy(false); } }
  }
  async function cancel() {
    if (cancelling || info?.operation?.status !== 'pending') return;
    const current = info, version = ++generation.current; locked.current = true; setBusy(true); setCancelling(true); setConsent(false);
    try {
      const operation = await request<Operation>(endpoint, { action: 'cancel', id: current.operation!.id });
      if (version === generation.current) { setInfo({ ...current, operation }); setError(''); }
    } catch { if (version === generation.current) { setInfo(null); setError('Pembatalan belum terkonfirmasi. Muat ulang status sebelum mencoba lagi.'); } }
    finally { if (version === generation.current) { locked.current = false; setBusy(false); setCancelling(false); } }
  }
  const operation = info?.operation, ready = info?.provider && info.format && (!operation || ['uncertain', 'cancelled'].includes(operation.status));
  return <section className="speech-controls">
    <p>File dikirim ke provider transkripsi hanya setelah persetujuan. Provider dapat mengenakan biaya. Hasil disimpan sebagai file teks; tidak otomatis dikirim ke chat.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {info && !info.provider && <p className="muted">Provider transkripsi belum dikonfigurasi pada host.</p>}
    {info && !info.format && <p className="muted">File ini tidak dikenali sebagai WAV, MP3, FLAC, OGG, WebM, atau M4A/MP4. Batas file 10 MiB.</p>}
    {(info?.format === 'mp4' || info?.format === 'webm') && <p className="notice">File M4A/MP4 atau WebM dikirim utuh, termasuk video jika ada. Briefsip tidak memisahkan trek audio. Provider harus mendukung format dan codec file ini.</p>}
    {operation?.status === 'pending' && <p role="status">Transkripsi sedang diproses. Menutup panel tidak membatalkan pengiriman.</p>}
    {operation?.status === 'pending' && <button type="button" className="secondary" disabled={cancelling} onClick={() => void cancel()}>Batalkan transkripsi</button>}
    {operation?.status === 'cancelled' && <p role="status">Transkripsi dibatalkan di Briefsip. Provider mungkin sudah memproses atau menagih permintaan. Percobaan baru dapat dikenai biaya lagi.</p>}
    {operation?.status === 'uncertain' && <p className="notice">Hasil sebelumnya belum pasti. Periksa provider sebelum mencoba lagi. Permintaan baru dapat dikenai biaya lagi.</p>}
    {operation && <p className="muted">{operation.usage?.type === 'duration' ? `Durasi dilaporkan provider: ${operation.usage.seconds} detik.` : operation.usage?.type === 'tokens' ? `Token dilaporkan provider: input ${operation.usage.input_tokens ?? 'tidak diketahui'}, output ${operation.usage.output_tokens ?? 'tidak diketahui'}, total ${operation.usage.total_tokens ?? 'tidak diketahui'}.` : 'Pemakaian belum dilaporkan provider.'} Biaya belum diketahui.</p>}
    {operation?.result && <a href={`${path.slice(0, path.lastIndexOf('/'))}/${operation.result.id}`} download={operation.result.name}>Unduh transkrip ({operation.result.size} byte)</a>}
    {ready && <><p>Tujuan: {info.provider!.origin}. Model: {info.provider!.model}.</p><label className="member-option"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>Saya setuju mengirim file ini ke provider tersebut{operation ? ' dan menerima risiko biaya tambahan dari percobaan baru' : ''}.</span></label><button type="button" disabled={busy || !consent} onClick={() => void send()}>Kirim untuk transkripsi</button></>}
    <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>Muat ulang status transkripsi</button>
  </section>;
}
