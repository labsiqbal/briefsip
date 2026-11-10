import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './style.css';

type Agent = { revision: number; id: string; name: string; model: string; instructions: string };
type Channel = { activity: number; read_position: number; revision: number; archived: number; id: string; name: string; instructions: string; members: string[]; lead: string | null };
type Thread = { id: string; agent: string; name: string; revision: number; archived: number; deleted: number };
type Turn = { revision: number; paused: number; agent: string; parent?: string | null; waiting_for?: string | null; coordination?: { kind: string; child: string | null; prompt: string; owner_name: string; target_name: string }[]; routing?: string | null; agent_name?: string; id: string; text: string; reply: string | null; status: string; error: string | null; created: string };
type Directory = { agents: Agent[]; configured: boolean; defaultModel: string };
type Pending = { id: string; text: string; recipient?: string; automatic?: boolean };
const statusNames: Record<string, string> = { queued: 'Dalam antrean', running: 'Sedang menjawab', done: 'Selesai', failed: 'Gagal', interrupted: 'Terputus', cancelled: 'Dibatalkan' };
class HttpError extends Error { status: number; constructor(status: number, text: string) { super(text); this.status = status; } }
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : undefined)
    .catch(() => { throw new Error('Koneksi ke Briefsip terputus. Periksa koneksi, lalu coba lagi.'); });
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, body.error ?? `HTTP ${response.status}`);
  return body;
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Koneksi gagal. Coba lagi.';

function TaskControls({ turn, path, members, archived }: { turn: Turn; path: string; members: Agent[]; archived: boolean }) {
  const [recipient, setRecipient] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ action: string; data: { id: string; revision: number; recipient?: string; acknowledgeUncertain?: boolean } } | null>(null);
  if (['done','cancelled'].includes(turn.status)) return null;
  const resumable = !!turn.paused || ['failed','interrupted'].includes(turn.status);
  async function control(action: string) {
    if (busy) return;
    const request = pending.current ?? { action, data: { id: crypto.randomUUID(), revision: turn.revision, ...(action === 'reassign' ? { recipient } : {}), ...(action !== 'pause' ? { acknowledgeUncertain: confirmed } : {}) } };
    pending.current = request; setBusy(true); setError('');
    try { await api(`${path}/${turn.id}/${request.action}`, request.data); pending.current = null; }
    catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); }
    finally { setBusy(false); }
  }
  return <div className="task-controls">
    {pending.current ? <button className="secondary" disabled={busy} onClick={() => void control(pending.current!.action)}>Coba kontrol lagi</button> : resumable ? <details><summary>Lanjutkan atau alihkan tugas</summary>
      <p>Periksa hasil dan efek sebelumnya di provider. Melanjutkan dapat mengirim ulang langkah yang belum terkonfirmasi.</p>
      <label className="member-option"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Saya sudah memeriksa hasil dan efek sebelumnya</label>
      <button className="secondary" disabled={busy || archived || !confirmed} onClick={() => void control('resume')}>Lanjutkan tugas</button>
      {members.length > 0 && <><label htmlFor={`owner-${turn.id}`}>Pemilik baru</label><select id={`owner-${turn.id}`} value={recipient} onChange={event => setRecipient(event.target.value)}><option value="">Pilih agent</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select><button className="secondary" disabled={busy || archived || !confirmed || !recipient} onClick={() => void control('reassign')}>Alihkan tugas</button></>}
    </details> : <button className="secondary" disabled={busy || archived} onClick={() => void control('pause')}>Jeda tugas</button>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}

function Chat({ agent, configured, channel, thread, members = [], onRead, onEdit }: { onRead?: () => Promise<void>; onEdit?: () => void; agent: Agent | Channel; configured: boolean; channel?: Channel; thread?: Thread; members?: Agent[] }) {
  const archived = !!(channel?.archived || thread?.archived);
  const scope = thread ? `thread:${thread.id}` : channel ? `channel:${agent.id}` : agent.id;
  const path = thread ? `/api/threads/${thread.id}/turns` : `/api/${channel ? 'channels' : 'agents'}/${agent.id}/turns`;
  const [focusedTask, setFocusedTask] = useState('');
  const focusedOnce = useRef('');
  const loadedTask = useRef<string | null>(null);
  const recipientKey = `briefsip:recipient:${scope}`;
  const [recipient, setRecipient] = useState(() => {
    try { const saved = sessionStorage.getItem(recipientKey); if (saved !== null) return ((saved === '@automatic' && channel?.lead) || members.some(member => member.id === saved)) ? saved : ''; } catch { /* Keep the visible default when storage is unavailable. */ }
    return channel?.lead ?? (members.length === 1 ? members[0].id : '');
  });
  const storageKey = `briefsip:pending:${scope}`;
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const draftKey = `briefsip:draft:${scope}`;
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [pending, setPending] = useState<Pending | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'); return value && typeof value.id === 'string' && typeof value.text === 'string' ? value : null; } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [markingRead, setMarkingRead] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const requestActive = useRef(false);
  useEffect(() => {
    let stopped = false;
    loadedTask.current = null;
    setTurns(null);
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const data = await api<Turn[]>(focusedTask ? `${path}?focus=${focusedTask}` : path); if (!stopped) { loadedTask.current = focusedTask; setTurns(data); setReadError(''); } }
      catch (error) { if (!stopped) setReadError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [path, focusedTask]);
  useEffect(() => {
    if (focusedTask && loadedTask.current === focusedTask && turns && focusedOnce.current !== focusedTask) {
      const target = document.getElementById(`turn-${focusedTask}`);
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); focusedOnce.current = focusedTask; }
    }
    if (!focusedTask && nearBottom.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [focusedTask, turns]);
  useEffect(() => {
    if (!requestActive.current && pending && turns?.some(turn => turn.id === pending.id)) {
      try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); } catch { /* The same ID remains safe to retry. */ }
      setPending(null); setDraft(''); setError('');
    }
  }, [turns, pending, storageKey, draftKey]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (requestActive.current || (!pending && !draft.trim())) return;
    if (archived) { setError('Pulihkan percakapan sebelum mengirim pesan baru.'); return; }
    const automatic = pending ? pending.automatic === true : recipient === '@automatic';
    if (channel && (automatic ? !channel.lead : !members.some(member => member.id === (pending?.recipient ?? recipient)))) {
      if (pending) {
        try { sessionStorage.removeItem(storageKey); sessionStorage.setItem(draftKey, pending.text); } catch { /* Preserve recoverable text in memory. */ }
        setDraft(pending.text); setPending(null);
      }
      setError('Pilih agent penerima sebelum mengirim.'); return;
    }
    const request = pending ?? { id: crypto.randomUUID(), text: draft.trim(), ...(channel ? automatic ? { automatic: true } : { recipient } : {}) };
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError('Browser tidak bisa menyimpan status kirim. Aktifkan penyimpanan situs sebelum mengirim.'); return; }
    requestActive.current = true; setBusy(true); setPending(request); setError(''); nearBottom.current = true;
    try {
      await api(path, request);
      sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); setPending(null); setDraft(''); setFocusedTask('');
    } catch (error) {
      if (error instanceof HttpError && (error.status < 500 || error.status === 503)) {
        try { sessionStorage.removeItem(storageKey); sessionStorage.setItem(draftKey, request.text); } catch { /* Keep the draft in memory if storage fails. */ }
        setPending(null); setDraft(request.text);
      }
      setError(message(error));
    }
    finally { requestActive.current = false; setBusy(false); }
  }
  async function cancel(turn: Turn) {
    try { await api(`${path}/${turn.id}/cancel`, { id: crypto.randomUUID() }); setError(''); }
    catch (error) { setError(message(error)); }
  }
  const active = turns?.filter(turn => turn.status === 'queued' || turn.status === 'running').length ?? 0;
  return <>
    <header className="chat-header"><span className="avatar">{agent.name.slice(0, 1)}</span><div><h1>{thread?.name ?? agent.name}</h1><p>{channel ? `${members.length} anggota` : thread ? `Percakapan samping · ${agent.name}` : (agent as Agent).model}</p></div><span className="activity" role="status">{active ? `${active} pesan diproses` : channel ? 'Channel bersama' : 'Percakapan langsung'}</span>{onEdit && <button className="secondary" onClick={onEdit}>{channel ? 'Pengaturan channel' : thread ? 'Pengaturan percakapan' : 'Edit profil'}</button>}</header>
    {channel && <div className="recipient"><label htmlFor="recipient">Respons oleh</label><select id="recipient" value={pending?.automatic ? '@automatic' : pending?.recipient ?? recipient} disabled={!!pending || busy} onChange={event => { setRecipient(event.target.value); try { sessionStorage.setItem(recipientKey, event.target.value); } catch { setError('Pilihan penerima tidak tersimpan. Periksa kembali sebelum mengirim.'); } }}><option value="">Pilih agent</option>{channel.lead && <option value="@automatic">Otomatis melalui lead</option>}{members.map(member => <option key={member.id} value={member.id}>{member.name}{member.id === channel.lead ? ' (lead)' : ''}</option>)}</select></div>}
    {channel && <div className="recipient"><span>{channel.activity > channel.read_position ? 'Ada aktivitas belum dibaca' : 'Semua aktivitas sudah dibaca'}</span><button className="secondary" disabled={markingRead || channel.activity <= channel.read_position} onClick={() => { setMarkingRead(true); void onRead?.().catch(error => setError(message(error))).finally(() => setMarkingRead(false)); }}>Tandai semua dibaca</button></div>}
    {focusedTask && <div className="recipient"><button className="secondary" onClick={() => { setFocusedTask(''); focusedOnce.current = ''; nearBottom.current = true; }}>Kembali ke pesan terbaru</button></div>}
    <section className="transcript" aria-label="Riwayat percakapan" onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {readError && <p role="alert" className="error">{readError} Riwayat akan dicoba lagi.</p>}
      {turns === null ? <p className="empty">Memuat percakapan...</p> : turns.length === 0 ? <div className="empty"><h2>Mulai bersama {agent.name}</h2><p>Kirim pekerjaan atau pertanyaan pertama. Percakapan tersimpan di komputer ini.</p></div> : turns.map(turn => <article key={turn.id} id={`turn-${turn.id}`} tabIndex={-1} className="turn">
        <div className="message-head"><strong>{turn.parent ? 'Subtugas' : 'Kamu'}</strong>{turn.parent && <a href={`#turn-${turn.parent}`} onClick={event => { event.preventDefault(); focusedOnce.current = ''; setFocusedTask(turn.parent!); }}>Lihat tugas induk</a>}<time dateTime={turn.created}>{new Date(turn.created).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time></div>
        <p className="message-text">{turn.text}</p>
        <div className="answer"><div className="message-head"><strong>{turn.agent_name ?? agent.name}</strong><span>{turn.paused && !['done','cancelled'].includes(turn.status) ? 'Dijeda' : turn.waiting_for && turn.status === 'queued' ? 'Menunggu delegasi' : turn.routing === 'pending' && turn.status === 'running' ? 'Memilih penerima' : turn.routing === 'clarify' ? 'Perlu klarifikasi' : turn.routing === 'none' ? 'Tidak perlu tugas' : statusNames[turn.status] ?? turn.status}</span></div>
          {turn.reply ? <p className="message-text">{turn.reply}</p> : <p className={turn.error ? 'error' : 'muted'}>{turn.error ?? (turn.waiting_for ? 'Menunggu hasil tugas anak.' : turn.status === 'queued' ? 'Menunggu giliran.' : 'Menunggu jawaban provider...')}</p>}
          {!!turn.coordination?.length && <details><summary>Koordinasi tugas ({turn.coordination.length})</summary>{turn.coordination.map((action, index) => <div key={index}><p>{action.owner_name} {action.kind === 'delegate_task' ? 'mendelegasikan ke' : 'mengalihkan tugas ke'} {action.target_name}.</p><p className="message-text">{action.prompt}</p>{action.child && <a href={`#turn-${action.child}`} onClick={event => { event.preventDefault(); focusedOnce.current = ''; setFocusedTask(action.child!); }}>Lihat subtugas</a>}</div>)}</details>}
          <TaskControls key={`${turn.id}:${turn.revision}`} turn={turn} path={path} members={channel ? members : []} archived={archived} />
          {(!['done','cancelled'].includes(turn.status)) && <button className="secondary" onClick={() => void cancel(turn)}>{turn.waiting_for ? 'Batalkan tugas dan delegasi' : turn.status === 'running' ? 'Hentikan' : turn.status === 'queued' && !turn.paused ? 'Batalkan antrean' : 'Batalkan tugas'}</button>}
        </div>
      </article>)}<div ref={bottom} />
    </section>
    <footer className="composer-area">
      {archived && <p className="notice">Percakapan diarsipkan. Riwayat tetap tersedia. Pulihkan melalui pengaturan untuk mengirim pesan baru.</p>}
      {!configured && <p className="notice">Provider belum terhubung. Atur OPENAI_BASE_URL dan kredensial di server, lalu mulai ulang app. Agent dan riwayat tetap tersimpan.</p>}
      {error && <p className="error" role="alert">{error} {pending && 'Gunakan Coba kirim lagi untuk memeriksa permintaan yang sama tanpa membuat pesan ganda.'}</p>}
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="message">Pesan untuk {agent.name}</label>
        <textarea id="message" placeholder={`Pesan untuk ${agent.name}...`} maxLength={16000} value={pending?.text ?? draft} readOnly={!!pending || busy} onChange={event => { setDraft(event.target.value); try { sessionStorage.setItem(draftKey, event.target.value); } catch { setError('Draft tidak tersimpan di browser. Jangan pindah agent sebelum menyalin pesan.'); } }} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-actions"><span>Ctrl / Cmd + Enter untuk kirim</span><button type="submit" disabled={archived || !configured || busy || (!pending && !draft.trim()) || (!!channel && !recipient && !pending)}>{busy ? 'Mengirim...' : pending ? 'Coba kirim lagi' : 'Kirim pesan'}</button></div>
      </form><p className="footnote">{focusedTask ? 'Rangkaian tugas ditampilkan.' : '100 pesan terakhir ditampilkan.'} Provider menerima hingga 40 percakapan sebelumnya.</p>
    </footer>
  </>;
}

function AgentConversations({ agent, configured, onEdit }: { agent: Agent; configured: boolean; onEdit: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]), [error, setError] = useState('');
  const storageKey = `briefsip:thread:${agent.id}`;
  const [selected, setSelected] = useState(() => { try { return sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; } });
  const [form, setForm] = useState(false), [editing, setEditing] = useState(false), [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const loadVersion = useRef(0);
  const thread = threads.find(item => item.id === selected);
  function select(id: string) { loadVersion.current++; setSelected(id); setForm(false); setEditing(false); try { sessionStorage.setItem(storageKey, id); } catch { /* Selection remains usable in memory. */ } }
  async function load(preferred = selected, afterSave = false) {
    const version = ++loadVersion.current;
    try {
      const rows = await api<Thread[]>(`/api/agents/${agent.id}/threads`);
      if (version !== loadVersion.current) return;
      const missing = !!preferred && !rows.some(row => row.id === preferred);
      setThreads(rows); setLoaded(true); setReload(value => value + 1);
      setError(missing ? 'Percakapan tidak lagi tersedia. Chat utama dibuka.' : '');
      if (missing || afterSave) select(missing ? '' : preferred);
    }
    catch (error) { if (!afterSave && version === loadVersion.current) setError(message(error)); throw new Error(message(error)); }
  }
  useEffect(() => { void load().catch(() => {}); return () => { loadVersion.current++; }; }, []);
  const navigationVersion = loadVersion.current;
  return <>
    <div className="recipient"><label htmlFor="conversation">Percakapan</label><select id="conversation" value={thread?.id ?? ''} disabled={!loaded} onChange={event => select(event.target.value)}><option value="">Chat utama</option>{threads.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (diarsipkan)' : ''}</option>)}</select><button className="secondary" disabled={!loaded} onClick={() => { loadVersion.current++; setForm(true); setEditing(false); }}>Percakapan baru</button></div>
    {error && <p className="error" role="alert">{error} <button className="secondary" onClick={() => void load().catch(() => {})}>Muat ulang percakapan</button></p>}
    {!loaded ? <p className="empty">Memuat percakapan...</p> : form ? <ThreadForm key={editing ? `${thread?.id}:${thread?.revision}:${reload}` : 'new'} agent={agent} thread={editing ? thread : undefined} onCancel={() => { loadVersion.current++; setForm(false); }} onReload={() => { void load().catch(() => {}); }} onSaved={item => navigationVersion === loadVersion.current ? load(item.deleted ? '' : item.id, true) : Promise.resolve()} /> : <Chat key={thread?.id ?? agent.id} agent={agent} thread={thread} configured={configured} onEdit={thread ? () => { loadVersion.current++; setEditing(true); setForm(true); } : onEdit} />}
  </>;
}

function ThreadForm({ agent, thread, onCancel, onSaved, onReload }: { agent: Agent; thread?: Thread; onCancel: () => void; onSaved: (thread: Thread) => Promise<void>; onReload: () => void }) {
  const [archived, setArchived] = useState(!!thread?.archived), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ path: string; data: { id: string; name?: string; revision?: number; archived?: boolean } } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const deleting = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'delete';
    if (deleting && (!thread?.archived || !confirmed)) return;
    const request = pending.current ?? { path: thread ? `/api/threads/${thread.id}/${deleting ? 'delete' : 'edit'}` : `/api/agents/${agent.id}/threads`, data: { id: crypto.randomUUID(), ...(thread ? { revision: thread.revision } : {}), ...(!deleting ? { name: String(form.get('name')).trim(), ...(thread ? { archived } : {}) } : {}) } };
    pending.current = request; setBusy(true); setError('');
    try { await onSaved(await api<Thread>(request.path, request.data)); }
    catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); }
    finally { setBusy(false); }
  }
  return <section className="setup"><h1>{thread ? 'Pengaturan percakapan' : 'Percakapan samping baru'}</h1><p className="muted">Agent {agent.name}, dengan riwayat dan antrean terpisah dari chat utama.</p><form onSubmit={save}>
    <label>Nama percakapan<input name="name" required maxLength={80} defaultValue={thread?.name} readOnly={!!pending.current} autoFocus /></label>
    {thread && <label className="member-option"><input type="checkbox" checked={archived} disabled={!!pending.current} onChange={event => setArchived(event.target.checked)} />Arsipkan dan batalkan pekerjaan yang belum selesai</label>}
    {!!thread?.archived && <label className="member-option"><input type="checkbox" checked={confirmed} disabled={!!pending.current} onChange={event => setConfirmed(event.target.checked)} />Saya mengerti percakapan yang dihapus tidak bisa dibuka lagi</label>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="secondary" onClick={onCancel}>Batal</button><button disabled={busy}>{busy ? 'Menyimpan...' : pending.current ? 'Coba perubahan lagi' : thread ? 'Simpan percakapan' : 'Buat percakapan'}</button>{!!thread?.archived && <button className="secondary" value="delete" disabled={busy || !confirmed || !!pending.current}>Hapus percakapan</button>}{thread && error && !pending.current && <button type="button" className="secondary" onClick={onReload}>Muat ulang pengaturan</button>}</div>
  </form></section>;
}

function AgentForm({ model, profile, onCreated, onCancel, onReload }: { model: string; profile?: Agent; onCreated: (agent: Agent) => void; onCancel?: () => void; onReload?: () => void }) {
  const [models, setModels] = useState<string[]>([]);
  const [catalogStatus, setCatalogStatus] = useState('Memuat daftar model...');
  useEffect(() => {
    let stopped = false;
    void api<{ models: string[] }>('/api/models').then(data => {
      if (!stopped) { setModels(data.models); setCatalogStatus(data.models.length ? `${data.models.length} model tersedia. Pilih saran atau masukkan ID model.` : 'Provider belum menampilkan model. Masukkan ID model yang tersedia di akunmu.'); }
    }).catch(error => { if (!stopped) setCatalogStatus(`${message(error)} ID model tetap bisa diisi manual.`); });
    return () => { stopped = true; };
  }, []);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const pending = useRef<{ id: string; name: string; model: string; instructions: string; revision?: number } | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const data = pending.current ?? { id: crypto.randomUUID(), ...(profile ? { revision: profile.revision } : {}), name: String(form.get('name')).trim(), model: String(form.get('model')).trim(), instructions: String(form.get('instructions')).trim() };
    pending.current = data; setBusy(true); setError('');
    try { onCreated(await api<Agent>(profile ? `/api/agents/${profile.id}/edit` : '/api/agents', data)); } catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); } finally { setBusy(false); }
  }
  return <section className="setup"><h1>{profile ? 'Edit profil agent' : 'Agent baru'}</h1><p className="muted">Beri nama, pilih model, lalu jelaskan cara kerjanya.</p><form onSubmit={create}>
    <label>Nama<input name="name" required maxLength={80} readOnly={!!pending.current} autoFocus defaultValue={profile?.name} placeholder="Misalnya: Rekan riset" /></label>
    <label>Model<input name="model" list="provider-models" aria-describedby="model-catalog-status" required maxLength={160} readOnly={!!pending.current} defaultValue={profile?.model ?? model} placeholder="ID model dari provider kamu" /><datalist id="provider-models">{models.map(id => <option key={id} value={id} />)}</datalist><span id="model-catalog-status" className="muted" role="status">{catalogStatus}</span></label>
    <label>Instruksi<textarea name="instructions" required maxLength={8000} readOnly={!!pending.current} defaultValue={profile?.instructions} rows={6} placeholder="Apa tugas agent ini? Bagaimana hasilnya perlu disampaikan?" /></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="form-actions">{onCancel && <button type="button" className="secondary" onClick={onCancel}>Batal</button>}<button disabled={busy}>{busy ? 'Menyimpan...' : profile ? 'Simpan profil' : 'Buat agent'}</button>{profile && error && onReload && <button type="button" className="secondary" onClick={onReload}>Buang perubahan dan muat ulang</button>}</div>
  </form></section>;
}

function ChannelForm({ agents, channel, onCreated, onCancel, onReload }: { agents: Agent[]; channel?: Channel; onCreated: (channel: Channel) => void; onCancel: () => void; onReload?: () => void }) {
  const [members, setMembers] = useState<string[]>(channel?.members ?? []), [lead, setLead] = useState(channel?.lead ?? '');
  const [archived, setArchived] = useState(!!channel?.archived);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef<{ id: string; name: string; instructions: string; members: string[]; lead: string | null; revision?: number; archived?: boolean } | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const data = pending.current ?? { id: crypto.randomUUID(), ...(channel ? { revision: channel.revision, archived } : {}), name: String(form.get('name')).trim(), instructions: String(form.get('instructions')).trim(), members, lead: lead || null };
    pending.current = data; setBusy(true); setError('');
    try { onCreated(await api<Channel>(channel ? `/api/channels/${channel.id}/edit` : '/api/channels', data)); }
    catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); }
    finally { setBusy(false); }
  }
  return <section className="setup"><h1>{channel ? 'Pengaturan channel' : 'Channel baru'}</h1><p className="muted">Satukan agent dalam satu percakapan. Pilih siapa yang mengoordinasikan pekerjaan.</p><form onSubmit={create}>
    <label>Nama channel<input name="name" required maxLength={80} readOnly={!!pending.current} defaultValue={channel?.name} autoFocus /></label>
    <label>Tujuan<textarea name="instructions" required maxLength={8000} rows={3} readOnly={!!pending.current} defaultValue={channel?.instructions} /></label>
    <fieldset disabled={!!pending.current}><legend>Anggota</legend>{agents.map(agent => <label className="member-option" key={agent.id}><input type="checkbox" checked={members.includes(agent.id)} onChange={event => { setMembers(event.target.checked ? [...members, agent.id] : members.filter(id => id !== agent.id)); if (!event.target.checked && lead === agent.id) setLead(''); }} />{agent.name}</label>)}</fieldset>
    <label>Lead<select value={lead} disabled={!!pending.current} onChange={event => setLead(event.target.value)}><option value="">Tanpa lead, pilih penerima saat mengirim</option>{agents.filter(agent => members.includes(agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    {channel && <label className="member-option"><input type="checkbox" checked={archived} disabled={!!pending.current} onChange={event => setArchived(event.target.checked)} />Arsipkan channel dan batalkan pekerjaan yang belum selesai</label>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="secondary" onClick={onCancel}>Batal</button><button disabled={busy || !members.length}>{busy ? 'Menyimpan...' : channel ? 'Simpan channel' : 'Buat channel'}</button>{channel && error && onReload && <button type="button" className="secondary" onClick={onReload}>Buang perubahan dan muat ulang</button>}</div>
  </form></section>;
}

function App() {
  const [directory, setDirectory] = useState<Directory | null>(null); const [selected, setSelected] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]), [selectedChannel, setSelectedChannel] = useState('');
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [activityError, setActivityError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editReload, setEditReload] = useState(0);
  const [creating, setCreating] = useState(false); const [error, setError] = useState('');
  async function load() {
    try { const [data, rooms] = await Promise.all([api<Directory>('/api/agents'), api<Channel[]>('/api/channels')]); setDirectory(data); setChannels(rooms); setSelected(id => id || data.agents[0]?.id || ''); setError(''); }
    catch (error) { setError(message(error)); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshActivity() {
      try {
        const rooms = await api<Channel[]>('/api/channels');
        if (!stopped) { setActivityError(false); setChannels(current => current.map(room => {
          const fresh = rooms.find(item => item.id === room.id);
          return fresh ? { ...room, activity: Math.max(room.activity, fresh.activity), read_position: Math.max(room.read_position, fresh.read_position) } : room;
        })); }
      } catch { if (!stopped) setActivityError(true); }
      if (!stopped) timer = setTimeout(refreshActivity, 2400);
    }
    timer = setTimeout(refreshActivity, 2400);
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  async function markRead(room: Channel) {
    const updated = await api<Channel>(`/api/channels/${room.id}/read`, { id: crypto.randomUUID(), position: room.activity });
    setChannels(current => current.map(item => item.id === room.id ? { ...item, activity: Math.max(item.activity, updated.activity), read_position: Math.max(item.read_position, updated.read_position) } : item));
  }
  const agent = directory?.agents.find(agent => agent.id === selected);
  const channel = channels.find(channel => channel.id === selectedChannel);
  return <div className="workspace">
    <aside className="sidebar"><a className="brand" href="/">Briefsip<span>Ruang kerja lokal</span></a>
      <div className="sidebar-title"><h2>Channels</h2><button className="secondary" disabled={!directory?.agents.length} onClick={() => { setCreatingChannel(true); setCreating(false); setEditing(false); }} aria-label="Buat channel baru">Baru</button></div>
      <nav aria-label="Pilih channel">{channels.map(room => <button key={room.id} className={`agent-row ${room.id === selectedChannel && !creatingChannel && !creating ? 'selected' : ''}`} aria-current={room.id === selectedChannel && !creatingChannel && !creating ? 'page' : undefined} onClick={() => { setSelectedChannel(room.id); setCreating(false); setCreatingChannel(false); setEditing(false); }}><span className="avatar" aria-hidden="true">#</span><span><strong>{room.name}</strong><small>{room.archived ? 'Diarsipkan' : `${room.members.length} anggota`}{room.activity > room.read_position && ' · Belum dibaca'}</small></span></button>)}</nav>
      <div className="sidebar-title"><h2>Agents</h2><button className="secondary" onClick={() => { setCreating(true); setCreatingChannel(false); setEditing(false); }} aria-label="Buat agent baru">Baru</button></div>
      <nav aria-label="Pilih agent">{directory?.agents.map(agent => <button key={agent.id} className={`agent-row ${agent.id === selected && !selectedChannel && !creating && !creatingChannel ? 'selected' : ''}`} aria-current={agent.id === selected && !selectedChannel && !creating && !creatingChannel ? 'page' : undefined} onClick={() => { setSelected(agent.id); setSelectedChannel(''); setCreating(false); setCreatingChannel(false); setEditing(false); }}><span className="avatar">{agent.name.slice(0, 1)}</span><span><strong>{agent.name}</strong><small>{agent.model}</small></span></button>)}</nav>
      {activityError && <p className="notice" role="status">Status baca belum diperbarui. Mencoba lagi.</p>}
      <div className="sidebar-footer"><span className={`dot ${directory?.configured ? 'connected' : ''}`} /><span>{directory?.configured ? 'Provider dikonfigurasi' : 'Provider belum terhubung'}</span></div>
    </aside>
    <main>{error ? <div className="empty"><h1>Ruang kerja belum terbuka</h1><p role="alert">{error}</p><button onClick={() => void load()}>Coba lagi</button></div> : !directory ? <p className="empty" role="status">Memuat ruang kerja...</p> : editing && channel ? <ChannelForm key={`${channel.id}:${channel.revision}:${editReload}`} agents={directory.agents} channel={channel} onCancel={() => setEditing(false)} onReload={() => { void load().then(() => setEditReload(value => value + 1)); }} onCreated={() => { void load(); setEditing(false); }} /> : editing && agent ? <AgentForm key={`${agent.id}:${agent.revision}:${editReload}`} model={directory.defaultModel} profile={agent} onCancel={() => setEditing(false)} onReload={() => { void load().then(() => setEditReload(value => value + 1)); }} onCreated={() => { void load(); setEditing(false); }} /> : creatingChannel ? <ChannelForm agents={directory.agents} onCancel={() => setCreatingChannel(false)} onCreated={created => { setChannels([...channels.filter(room => room.id !== created.id), created]); setSelectedChannel(created.id); setCreatingChannel(false); }} /> : creating || (!agent && !channel) ? <AgentForm model={directory.defaultModel} onCancel={agent || channel ? () => setCreating(false) : undefined} onCreated={created => { setDirectory({ ...directory, agents: [...directory.agents.filter(agent => agent.id !== created.id), created] }); setSelected(created.id); setSelectedChannel(''); setCreating(false); }} /> : channel ? <Chat key={`channel:${channel.id}`} agent={channel} channel={channel} onRead={() => markRead(channel)} members={directory.agents.filter(agent => channel.members.includes(agent.id))} onEdit={() => setEditing(true)} configured={directory.configured} /> : agent && <AgentConversations key={agent.id} agent={agent} configured={directory.configured} onEdit={() => setEditing(true)} />}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
