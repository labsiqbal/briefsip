import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './style.css';

type Agent = { id: string; name: string; model: string; instructions: string };
type Turn = { id: string; text: string; reply: string | null; status: string; error: string | null; created: string };
type Directory = { agents: Agent[]; configured: boolean; defaultModel: string };
type Pending = { id: string; text: string };
const statusNames: Record<string, string> = { queued: 'Dalam antrean', running: 'Sedang menjawab', done: 'Selesai', failed: 'Gagal', interrupted: 'Terputus', cancelled: 'Dibatalkan' };
class HttpError extends Error { status: number; constructor(status: number, text: string) { super(text); this.status = status; } }
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : undefined);
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, body.error ?? `HTTP ${response.status}`);
  return body;
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Koneksi gagal. Coba lagi.';

function Chat({ agent, configured }: { agent: Agent; configured: boolean }) {
  const storageKey = `briefsip:pending:${agent.id}`;
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const draftKey = `briefsip:draft:${agent.id}`;
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [pending, setPending] = useState<Pending | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'); return value && typeof value.id === 'string' && typeof value.text === 'string' ? value : null; } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const requestActive = useRef(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const data = await api<Turn[]>(`/api/agents/${agent.id}/turns`); if (!stopped) { setTurns(data); setReadError(''); } }
      catch (error) { if (!stopped) setReadError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [agent.id]);
  useEffect(() => {
    if (nearBottom.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns?.length, turns?.at(-1)?.status]);
  useEffect(() => {
    if (!requestActive.current && pending && turns?.some(turn => turn.id === pending.id)) {
      try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); } catch { /* The same ID remains safe to retry. */ }
      setPending(null); setDraft(''); setError('');
    }
  }, [turns, pending, storageKey, draftKey]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (requestActive.current || (!pending && !draft.trim())) return;
    const request = pending ?? { id: crypto.randomUUID(), text: draft.trim() };
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError('Browser tidak bisa menyimpan status kirim. Aktifkan penyimpanan situs sebelum mengirim.'); return; }
    requestActive.current = true; setBusy(true); setPending(request); setError(''); nearBottom.current = true;
    try {
      await api(`/api/agents/${agent.id}/turns`, request);
      sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); setPending(null); setDraft('');
    } catch (error) { setError(message(error)); }
    finally { requestActive.current = false; setBusy(false); }
  }
  const active = turns?.filter(turn => turn.status === 'queued' || turn.status === 'running').length ?? 0;
  return <>
    <header className="chat-header"><span className="avatar">{agent.name.slice(0, 1)}</span><div><h1>{agent.name}</h1><p>{agent.model}</p></div><span className="activity" role="status">{active ? `${active} pesan diproses` : 'Percakapan langsung'}</span></header>
    <section className="transcript" aria-label="Riwayat percakapan" onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {readError && <p role="alert" className="error">{readError} Riwayat akan dicoba lagi.</p>}
      {turns === null ? <p className="empty">Memuat percakapan...</p> : turns.length === 0 ? <div className="empty"><h2>Mulai bersama {agent.name}</h2><p>Kirim pekerjaan atau pertanyaan pertama. Percakapan tersimpan di komputer ini.</p></div> : turns.map(turn => <article key={turn.id} className="turn">
        <div className="message-head"><strong>Kamu</strong><time dateTime={turn.created}>{new Date(turn.created).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time></div>
        <p className="message-text">{turn.text}</p>
        <div className="answer"><div className="message-head"><strong>{agent.name}</strong><span>{statusNames[turn.status] ?? turn.status}</span></div>
          {turn.reply ? <p className="message-text">{turn.reply}</p> : <p className={turn.error ? 'error' : 'muted'}>{turn.error ?? (turn.status === 'queued' ? 'Menunggu giliran.' : 'Menunggu jawaban provider...')}</p>}
        </div>
      </article>)}<div ref={bottom} />
    </section>
    <footer className="composer-area">
      {!configured && <p className="notice">Provider belum terhubung. Atur OPENAI_BASE_URL dan kredensial di server, lalu mulai ulang app. Agent dan riwayat tetap tersimpan.</p>}
      {error && <p className="error" role="alert">{error} {pending && 'Gunakan Coba kirim lagi untuk memeriksa permintaan yang sama tanpa membuat pesan ganda.'}</p>}
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="message">Pesan untuk {agent.name}</label>
        <textarea id="message" placeholder={`Pesan untuk ${agent.name}...`} maxLength={16000} value={pending?.text ?? draft} readOnly={!!pending || busy} onChange={event => { setDraft(event.target.value); try { sessionStorage.setItem(draftKey, event.target.value); } catch { setError('Draft tidak tersimpan di browser. Jangan pindah agent sebelum menyalin pesan.'); } }} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-actions"><span>Ctrl / Cmd + Enter untuk kirim</span><button type="submit" disabled={!configured || busy || (!pending && !draft.trim())}>{busy ? 'Mengirim...' : pending ? 'Coba kirim lagi' : 'Kirim pesan'}</button></div>
      </form><p className="footnote">100 pesan terakhir ditampilkan. Provider menerima hingga 40 percakapan sebelumnya.</p>
    </footer>
  </>;
}

function NewAgent({ model, onCreated, onCancel }: { model: string; onCreated: (agent: Agent) => void; onCancel?: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const pending = useRef<Agent | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const data = { id: pending.current?.id ?? crypto.randomUUID(), name: String(form.get('name')).trim(), model: String(form.get('model')).trim(), instructions: String(form.get('instructions')).trim() };
    pending.current = data; setBusy(true); setError('');
    try { onCreated(await api<Agent>('/api/agents', data)); } catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); } finally { setBusy(false); }
  }
  return <section className="setup"><h1>Agent baru</h1><p className="muted">Beri nama, pilih model, lalu jelaskan cara kerjanya.</p><form onSubmit={create}>
    <label>Nama<input name="name" required maxLength={80} readOnly={!!pending.current} autoFocus placeholder="Misalnya: Rekan riset" /></label>
    <label>Model<input name="model" required maxLength={160} readOnly={!!pending.current} defaultValue={model} placeholder="ID model dari provider kamu" /></label>
    <label>Instruksi<textarea name="instructions" required maxLength={8000} readOnly={!!pending.current} rows={6} placeholder="Apa tugas agent ini? Bagaimana hasilnya perlu disampaikan?" /></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="form-actions">{onCancel && <button type="button" className="secondary" onClick={onCancel}>Batal</button>}<button disabled={busy}>{busy ? 'Menyimpan...' : 'Buat agent'}</button></div>
  </form></section>;
}

function App() {
  const [directory, setDirectory] = useState<Directory | null>(null); const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false); const [error, setError] = useState('');
  async function load() {
    try { const data = await api<Directory>('/api/agents'); setDirectory(data); setSelected(id => id || data.agents[0]?.id || ''); setError(''); }
    catch (error) { setError(message(error)); }
  }
  useEffect(() => { void load(); }, []);
  const agent = directory?.agents.find(agent => agent.id === selected);
  return <div className="workspace">
    <aside className="sidebar"><a className="brand" href="/">Briefsip<span>Ruang kerja lokal</span></a>
      <div className="sidebar-title"><h2>Agents</h2><button className="secondary" onClick={() => setCreating(true)} aria-label="Buat agent baru">Baru</button></div>
      <nav aria-label="Pilih agent">{directory?.agents.map(agent => <button key={agent.id} className={`agent-row ${agent.id === selected && !creating ? 'selected' : ''}`} aria-current={agent.id === selected && !creating ? 'page' : undefined} onClick={() => { setSelected(agent.id); setCreating(false); }}><span className="avatar">{agent.name.slice(0, 1)}</span><span><strong>{agent.name}</strong><small>{agent.model}</small></span></button>)}</nav>
      <div className="sidebar-footer"><span className={`dot ${directory?.configured ? 'connected' : ''}`} /><span>{directory?.configured ? 'Provider dikonfigurasi' : 'Provider belum terhubung'}</span></div>
    </aside>
    <main>{error ? <div className="empty"><h1>Ruang kerja belum terbuka</h1><p role="alert">{error}</p><button onClick={() => void load()}>Coba lagi</button></div> : !directory ? <p className="empty" role="status">Memuat ruang kerja...</p> : creating || !agent ? <NewAgent model={directory.defaultModel} onCancel={agent ? () => setCreating(false) : undefined} onCreated={created => { setDirectory({ ...directory, agents: [...directory.agents.filter(agent => agent.id !== created.id), created] }); setSelected(created.id); setCreating(false); }} /> : <Chat key={agent.id} agent={agent} configured={directory.configured} />}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
