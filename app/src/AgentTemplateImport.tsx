import { useEffect, useRef, useState } from 'react';
import { parseAgentTemplate, restoreTemplateImport, templateCommand, type AgentTemplate } from '../agent-template';

type Agent = { id: string; name: string; model: string; instructions: string; thread_limit: number; revision: number };
const storage = 'briefsip:agent-template-import';
export function AgentTemplateImport({ request, onCreated, onClose }: { request: <T>(path: string, data?: unknown) => Promise<T>; onCreated: (agent: Agent) => void; onClose: () => void }) {
  const [recovery] = useState(() => { try { return { pending: restoreTemplateImport(sessionStorage.getItem(storage)), invalid: false }; } catch { return { pending: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.pending), [invalid, setInvalid] = useState(recovery.invalid);
  const [draft, setDraft] = useState<AgentTemplate | null>(recovery.pending?.template ?? null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), generation = useRef(0), inFlight = useRef(false);
  useEffect(() => { heading.current?.focus(); return () => { generation.current++; }; }, []);
  async function choose(file?: File) {
    if (!file || pending || invalid || inFlight.current) return;
    const current = ++generation.current; setError(''); setDraft(null); setBusy(true);
    try {
      if (file.size > 64000) throw new Error('Template maksimum 64 KB.');
      const parsed = parseAgentTemplate(JSON.parse(await file.text()));
      if (current === generation.current) setDraft(parsed);
    } catch (error) { if (current === generation.current) setError(error instanceof SyntaxError ? 'File bukan JSON valid.' : error instanceof Error ? error.message : 'Template gagal dibaca.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function apply() {
    if (inFlight.current || busy || invalid || !draft) return;
    const current = generation.current; setError('');
    try {
      const command = pending ?? { id: crypto.randomUUID(), template: parseAgentTemplate(draft) };
      sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command);
      inFlight.current = true; setBusy(true);
      const agent = await request<Agent>('/api/agents', templateCommand(command.template, command.id));
      if (current !== generation.current) return;
      // Remove only this command; preserve any newer recovery data.
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      onCreated(agent);
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Impor belum terkonfirmasi. Coba lagi.'); }
    finally { inFlight.current = false; if (current === generation.current) setBusy(false); }
  }
  function discard() {
    if (inFlight.current || busy || !window.confirm('Abaikan pemulihan impor? Agent mungkin sudah dibuat. Periksa daftar agent sebelum mengimpor lagi.')) return;
    try { sessionStorage.removeItem(storage); setPending(null); setDraft(null); setInvalid(false); setError(''); }
    catch { setError('Penyimpanan browser belum dapat diubah. Coba lagi.'); }
  }
  return <section className="setup"><h1 ref={heading} tabIndex={-1}>Impor template agent</h1>
    <p>Periksa nama, model, dan instruksi sebelum membuat agent baru. Template tidak memberikan izin tool, tidak mengubah konfigurasi kredensial provider, dan tidak mengganti agent yang sudah ada.</p>
    <button className="secondary" onClick={onClose}>Kembali ke agent</button>
    {error && <p role="alert" className="error">{error}</p>}
    {invalid ? <p role="alert">Data pemulihan impor tidak dapat dibaca. <button className="secondary" disabled={busy} onClick={discard}>Abaikan pemulihan impor</button></p> : <>
      <label>File template JSON<input type="file" accept=".json,application/json" disabled={!!pending || busy} onChange={event => void choose(event.target.files?.[0])} /></label>
      {busy && <p role="status">Memproses template...</p>}
      {pending && <p className="notice">Pembuatan belum terkonfirmasi. Coba lagi memakai permintaan yang sama untuk menghindari duplikasi.</p>}
      {draft && <form onSubmit={event => { event.preventDefault(); void apply(); }}><fieldset disabled={busy || !!pending}>
        <legend>Pratinjau profil baru</legend>
        <label>Nama<input required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Model<input required maxLength={160} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
        <p className="muted">Model memakai provider yang dikonfigurasi di komputer ini. ID model dari komputer lain mungkin tidak tersedia.</p>
        <label>Instruksi<textarea required maxLength={8000} rows={8} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <label>Percakapan samping bersamaan<input type="number" required min={1} max={32} step={1} value={draft.threadLimit} onChange={event => setDraft({ ...draft, threadLimit: Number(event.target.value) })} /></label>
      </fieldset><div className="form-actions"><button disabled={busy}>{pending ? 'Coba pembuatan lagi' : 'Buat agent dari template'}</button>{pending && <button type="button" className="secondary" disabled={busy} onClick={discard}>Abaikan pemulihan impor</button>}</div></form>}
    </>}
  </section>;
}

export function AgentTemplateExport({ id, request }: { id: string; request: <T>(path: string) => Promise<T> }) {
  const [template, setTemplate] = useState<AgentTemplate | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, [id]);
  async function preview() {
    const current = ++version.current; setBusy(true); setError(''); setTemplate(null);
    try { const data = parseAgentTemplate(await request(`/api/agents/${id}/template`)); if (current === version.current) setTemplate(data); }
    catch (error) { if (current === version.current) setError(error instanceof Error ? error.message : 'Template gagal dimuat.'); }
    finally { if (current === version.current) setBusy(false); }
  }
  return <section><h2>Ekspor template profil</h2><p>Ekspor mengambil profil tersimpan, tanpa riwayat, file, atau konfigurasi kredensial provider. Instruksi tetap ikut diunduh: periksa informasi sensitif sebelum membagikan file.</p>
    <button className="secondary" disabled={busy} onClick={() => void preview()}>{busy ? 'Memuat profil tersimpan...' : 'Pratinjau template ekspor'}</button>
    {error && <p className="error" role="alert">{error}</p>}
    {template && <><label>Isi file yang akan diunduh<textarea readOnly rows={10} value={JSON.stringify(template, null, 2)} /></label><button className="secondary" onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'briefsip-agent-template.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>Unduh template yang diperiksa</button></>}
  </section>;
}
