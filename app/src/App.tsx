import { HtmlPreview } from './HtmlPreview';
import { QuestionCard, type Question } from './QuestionCard';
import { CompactionPanel } from './CompactionPanel';
import { MemoryPanel } from './MemoryPanel';
import { SkillsPanel } from './SkillsPanel';
import { BackupPanel } from './BackupPanel';
import { AgentTemplateImport, AgentTemplateExport } from './AgentTemplateImport';
import { UsagePanel } from './UsagePanel';
import { useEffect, useRef, useState, useId, type FormEvent } from 'react';
import { WorkflowPanel } from './WorkflowPanel';
import { WorkflowDirectory } from './WorkflowDirectory';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import { validateFlow, type FlowGraph, type FlowLink } from '../flows.ts';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './style.css';

type Agent = { backup_model?: string; thread_limit: number; revision: number; id: string; name: string; model: string; instructions: string };
type Channel = { activity: number; read_position: number; revision: number; archived: number; id: string; name: string; instructions: string; members: string[]; lead: string | null };
type Thread = { id: string; agent: string; name: string; revision: number; archived: number; deleted: number };
type AgentMessage = { paused: number; request: string; expects_reply: number; settled: number; id: string; agent: string; thread: string; name: string; status: string; error: string | null; reply: string | null; truncated: boolean };
type Turn = { receivedAgentReplies?: (AgentMessage & { source: string })[]; messageOrigin?: { name: string; agent: string; channel: string | null; thread: string | null } | null; agentMessages?: AgentMessage[]; partial?: { text: string; model: string; status: string } | null; answer_model?: string | null; questions?: Question[]; workflow_run?: string | null; no_update: number; generatedFiles?: { id: string; name: string; size: number }[]; seq: number; files?: { id: string; name: string; size: number }[]; revision: number; paused: number; agent: string; parent?: string | null; waiting_for?: string | null; coordination?: { kind: string; child: string | null; prompt: string; owner_name: string; target_name: string }[]; routing?: string | null; agent_name?: string; id: string; text: string; reply: string | null; status: string; error: string | null; created: string };
type Directory = { agents: Agent[]; configured: boolean; defaultModel: string };
type Pending = { files?: string[]; id: string; text: string; recipient?: string; automatic?: boolean };
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

function ConversationFiles({ path, archived, attached, onAttach, locked }: { path: string; archived: boolean; attached: string[]; onAttach: (ids: string[]) => void; locked: boolean }) {
  type StoredFile = { seq: number; id: string; name: string; size: number };
  type Upload = { id: string; name: string; size: number; digest: string; file?: File };
  const storageKey = `briefsip:upload:${path}`;
  const [recovered] = useState<Upload | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return value && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.name === 'string' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 10 * 1024 * 1024 && /^[0-9a-f]{64}$/.test(value.digest) ? { id: value.id, name: value.name, size: value.size, digest: value.digest } : null;
    } catch { return null; }
  });
  const [open, setOpen] = useState(false), [files, setFiles] = useState<StoredFile[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<File | null>(null);
  const [preview, setPreview] = useState<StoredFile | null>(null), [previewText, setPreviewText] = useState<string | null>(null), [previewError, setPreviewError] = useState('');
  const pending = useRef<Upload | null>(recovered);
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
    if (!open || busy) return;
    let stopped = false;
    setLoading(true);
    void api<StoredFile[]>(path).then(rows => { if (!stopped) { setFiles(rows); setMore(rows.length === 100); setError(''); } }).catch(error => { if (!stopped) setError(message(error)); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [open, path, reload]);
  async function upload(event: FormEvent) {
    event.preventDefault(); if (busy || loading) return;
    const file = pending.current?.file ?? selected;
    if (!file) { setError('Pilih kembali file yang sama untuk melanjutkan unggahan.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Ukuran file maksimum 10 MiB.'); return; }
    setBusy(true); setError('');
    try {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (!mounted.current) return;
      if (pending.current && (pending.current.name !== file.name || pending.current.size !== file.size || pending.current.digest !== digest)) throw new Error('File berbeda dari unggahan tertunda. Pilih file asli atau periksa status unggahan.');
      const request = pending.current ?? { id: crypto.randomUUID(), name: file.name, size: file.size, digest };
      sessionStorage.setItem(storageKey, JSON.stringify({ id: request.id, name: request.name, size: request.size, digest: request.digest }));
      pending.current = { ...request, file };
      const response = await fetch(`${path}/${request.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file }).catch(() => { throw new Error('Koneksi terputus. Coba unggahan yang sama lagi.'); });
      const result = await response.json();
      if (!response.ok) throw new HttpError(response.status, result.error ?? 'Unggahan gagal.');
      setFiles(current => [result, ...current.filter(file => file.id !== result.id)]);
      clearUpload(request.id); setSelected(null); if (input.current) input.current.value = '';
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
      if (result.name !== request.name || result.size !== request.size || result.digest !== request.digest) throw new Error('Receipt tidak cocok dengan unggahan tertunda.');
      setFiles(current => [result, ...current.filter(file => file.id !== result.id)]);
      clearUpload(request.id); setSelected(null); if (input.current) input.current.value = '';
    } catch (error) { setError(error instanceof HttpError && error.status === 404 ? 'Unggahan belum tersimpan. Pilih kembali file asli untuk melanjutkan.' : message(error)); }
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
  return <details className="conversation-files" onToggle={event => setOpen(event.currentTarget.open)}><summary>File percakapan</summary>
    <p className="muted">Maksimum 10 MiB per file. Pilih lampiran untuk dikirim bersama pesan berikutnya. Maksimum empat lampiran: teks UTF-8 total 32 KiB dan gambar PNG/JPEG/WebP total 4 MiB. Pilih model yang mendukung gambar.</p>
    <form onSubmit={upload}><label>File<input ref={input} type="file" disabled={busy || loading || !!pending.current?.file || (archived && !pending.current)} onChange={event => setSelected(event.target.files?.[0] ?? null)} /></label><button disabled={busy || loading || (archived && !pending.current) || (!selected && !pending.current?.file)}>{busy ? 'Memproses...' : pending.current ? 'Coba unggahan lagi' : 'Unggah file'}</button></form>
    {pending.current && <p className="notice">Unggahan {pending.current.name} belum terkonfirmasi. Pilih kembali file yang sama atau <button className="secondary" disabled={busy || loading} onClick={() => void checkPending()}>Periksa status unggahan</button></p>}
    {error && <p className="error" role="alert">{error} {!pending.current && <button className="secondary" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>Muat ulang file</button>}</p>}
    {loading ? <p role="status">Memuat file...</p> : !error && files.length === 0 && <p className="muted">Belum ada file.</p>}
    <ul>{files.map(file => <li key={file.id}><label className="member-option"><input type="checkbox" checked={attached.includes(file.id)} disabled={locked || archived || (!attached.includes(file.id) && attached.length >= 4)} onChange={event => onAttach(event.target.checked ? [...attached, file.id] : attached.filter(id => id !== file.id))} /><span className="sr-only">Lampirkan {file.name}</span></label><a href={`${path}/${file.id}`} download={file.name}>{file.name}</a><span className="muted">{file.size.toLocaleString('id-ID')} byte</span><button className="secondary" aria-label={`Lihat teks: ${file.name}`} onClick={() => setPreview(file)}>Lihat teks</button><HtmlPreview path={`${path}/${file.id}`} name={file.name} request={api} /></li>)}</ul>
    {preview && <section aria-label={`Preview ${preview.name}`}><strong>{preview.name}</strong><button className="secondary" onClick={() => setPreview(null)}>Tutup preview</button>{previewError ? <p className="error" role="alert">{previewError}</p> : previewText === null ? <p role="status">Memuat preview...</p> : <pre tabIndex={0}>{previewText || '(File kosong)'}</pre>}</section>}
    {more && <button className="secondary" disabled={busy} onClick={() => void loadMore()}>File sebelumnya</button>}
  </details>;
}

function TaskControls({ turn, path, members, archived }: { turn: Turn; path: string; members: Agent[]; archived: boolean }) {
  const [recipient, setRecipient] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ action: string; data: { id: string; revision: number; recipient?: string; acknowledgeUncertain?: boolean } } | null>(null);
  if (['done','cancelled'].includes(turn.status) || turn.questions?.some(question => question.answer === null)) return null;
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

function Chat({ agent, configured, channel, thread, members = [], onRead, onEdit, onOpenAgent, onOpenChannel }: { onOpenChannel?: (channel: string) => void; onOpenAgent?: (agent: string, thread: string) => void; onRead?: () => Promise<void>; onEdit?: () => void; agent: Agent | Channel; configured: boolean; channel?: Channel; thread?: Thread; members?: Agent[] }) {
  const archived = !!(channel?.archived || thread?.archived);
  const scope = thread ? `thread:${thread.id}` : channel ? `channel:${agent.id}` : agent.id;
  const path = thread ? `/api/threads/${thread.id}/turns` : `/api/${channel ? 'channels' : 'agents'}/${agent.id}/turns`;
  const [showMemory, setShowMemory] = useState(false);
  const memoryButton = useRef<HTMLButtonElement>(null);
  const [focusedTask, setFocusedTask] = useState('');
  const [historyPages, setHistoryPages] = useState<number[]>([]);
  const before = historyPages.at(-1);
  const historyTop = useRef<HTMLDivElement>(null);
  const focusHistory = useRef(false);
  const focusedOnce = useRef('');
  const loadedTask = useRef<string | null>(null);
  const recipientKey = `briefsip:recipient:${scope}`;
  const [recipient, setRecipient] = useState(() => {
    try { const saved = sessionStorage.getItem(recipientKey); if (saved !== null) return ((saved === '@automatic' && channel?.lead) || members.some(member => member.id === saved)) ? saved : ''; } catch { /* Keep the visible default when storage is unavailable. */ }
    return channel?.lead ?? (members.length === 1 ? members[0].id : '');
  });
  const attachmentKey = `briefsip:attachments:${scope}`;
  const [attached, setAttached] = useState<string[]>(() => { try { const ids = JSON.parse(sessionStorage.getItem(attachmentKey) ?? '[]'); return Array.isArray(ids) && ids.length <= 4 && ids.every(id => typeof id === 'string') ? ids : []; } catch { return []; } });
  function attach(ids: string[]) { try { sessionStorage.setItem(attachmentKey, JSON.stringify(ids)); setAttached(ids); } catch { setError('Pilihan lampiran tidak tersimpan. Periksa penyimpanan browser.'); } }
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
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let stopped = false;
    loadedTask.current = null;
    setTurns(null);
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const data = await api<Turn[]>(focusedTask ? `${path}?focus=${focusedTask}` : before ? `${path}?before=${before}` : path); if (!stopped) { loadedTask.current = focusedTask; setTurns(data); setReadError(''); } }
      catch (error) { if (!stopped) setReadError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [path, focusedTask, before]);
  useEffect(() => {
    if (focusedTask && loadedTask.current === focusedTask && turns && focusedOnce.current !== focusedTask) {
      const target = document.getElementById(`turn-${focusedTask}`);
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); focusedOnce.current = focusedTask; }
    }
    if (!focusedTask && loadedTask.current === '' && turns && focusHistory.current) {
      const target = !before && turns.length ? document.getElementById(`turn-${turns.at(-1)!.id}`) : historyTop.current;
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: before ? 'start' : 'end' }); focusHistory.current = false; }
    }
    if (!focusedTask && !before && nearBottom.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [focusedTask, turns, before]);
  useEffect(() => {
    if (!requestActive.current && pending && turns?.some(turn => turn.id === pending.id)) {
      try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); sessionStorage.removeItem(attachmentKey); } catch { /* The same ID remains safe to retry. */ }
      setPending(null); setDraft(''); setAttached([]); setError('');
    }
  }, [turns, pending, storageKey, draftKey, attachmentKey]);
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
    const request = pending ?? { id: crypto.randomUUID(), text: draft.trim(), ...(attached.length ? { files: attached } : {}), ...(channel ? automatic ? { automatic: true } : { recipient } : {}) };
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError('Browser tidak bisa menyimpan status kirim. Aktifkan penyimpanan situs sebelum mengirim.'); return; }
    requestActive.current = true; setBusy(true); setPending(request); setError(''); nearBottom.current = true;
    try {
      await api(path, request);
      // A remounted conversation owns recovery and any newer draft after navigation.
      if (!mounted.current) return;
      sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); sessionStorage.removeItem(attachmentKey); setPending(null); setDraft(''); setAttached([]); setFocusedTask(''); setHistoryPages([]);
    } catch (error) {
      if (!mounted.current) return;
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
  if (showMemory) return <MemoryPanel key={scope} path={`/api/${channel ? 'channels' : 'agents'}/${agent.id}/memory`} channel={!!channel} archived={!!channel?.archived} request={api} onClose={() => { setShowMemory(false); requestAnimationFrame(() => memoryButton.current?.focus()); }} />;
  const active = turns?.filter(turn => turn.status === 'queued' || turn.status === 'running').length ?? 0;
  return <>
    <header className="chat-header"><span className="avatar">{agent.name.slice(0, 1)}</span><div><h1>{thread?.name ?? agent.name}</h1><p>{channel ? `${members.length} anggota` : thread ? `Percakapan samping · ${agent.name}` : (agent as Agent).model}</p></div><span className="activity" role="status">{active ? `${active} pesan diproses` : channel ? 'Channel bersama' : 'Percakapan langsung'}</span>{onEdit && <button className="secondary" onClick={onEdit}>{channel ? 'Pengaturan channel' : thread ? 'Pengaturan percakapan' : 'Edit profil'}</button>}</header>
    {channel && <div className="recipient"><label htmlFor="recipient">Respons oleh</label><select id="recipient" value={pending?.automatic ? '@automatic' : pending?.recipient ?? recipient} disabled={!!pending || busy} onChange={event => { setRecipient(event.target.value); try { sessionStorage.setItem(recipientKey, event.target.value); } catch { setError('Pilihan penerima tidak tersimpan. Periksa kembali sebelum mengirim.'); } }}><option value="">Pilih agent</option>{channel.lead && <option value="@automatic">Otomatis melalui lead</option>}{members.map(member => <option key={member.id} value={member.id}>{member.name}{member.id === channel.lead ? ' (lead)' : ''}</option>)}</select></div>}
    {channel && <div className="recipient"><span>{channel.activity > channel.read_position ? 'Ada aktivitas belum dibaca' : 'Semua aktivitas sudah dibaca'}</span><button className="secondary" disabled={markingRead || channel.activity <= channel.read_position} onClick={() => { setMarkingRead(true); void onRead?.().catch(error => setError(message(error))).finally(() => setMarkingRead(false)); }}>Tandai semua dibaca</button></div>}
    <div className="recipient"><button ref={memoryButton} className="secondary" onClick={() => setShowMemory(true)}>Memori {channel ? 'channel' : 'agent'}</button></div>
    <CompactionPanel path={path.replace(/\/turns$/, '/compaction')} request={api} />
    <ConversationFiles path={path.replace(/\/turns$/, '/files')} archived={archived} attached={pending?.files ?? attached} onAttach={attach} locked={!!pending || busy} />
    {(focusedTask || before) && <div className="recipient"><span>{focusedTask ? 'Keluarga tugas' : 'Riwayat lama'}</span><button className="secondary" onClick={() => { focusHistory.current = true; setTurns(null); setFocusedTask(''); setHistoryPages([]); focusedOnce.current = ''; nearBottom.current = true; }}>Kembali ke pesan terbaru</button></div>}
    <section className="transcript" aria-label="Riwayat percakapan" onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {!focusedTask && <div ref={historyTop} tabIndex={-1} className="history-navigation" aria-label="Navigasi riwayat">
        <button className="secondary" disabled={!turns || turns.length < 100} onClick={() => { if (turns?.length) { focusHistory.current = true; setTurns(null); setHistoryPages([...historyPages, turns[0].seq]); } }}>Pesan lebih lama</button>
        {!!before && <button className="secondary" onClick={() => { focusHistory.current = true; setTurns(null); setHistoryPages(historyPages.slice(0, -1)); nearBottom.current = true; }}>Pesan lebih baru</button>}
      </div>}
      {readError && <p role="alert" className="error">{readError} Riwayat akan dicoba lagi.</p>}
      {turns === null ? <p className="empty">Memuat percakapan...</p> : turns.length === 0 && before ? <p className="empty" role="status">Awal riwayat tercapai. Pilih Pesan lebih baru untuk kembali.</p> : turns.length === 0 ? <div className="empty"><h2>Mulai bersama {agent.name}</h2><p>Kirim pekerjaan atau pertanyaan pertama. Percakapan tersimpan di komputer ini.</p></div> : turns.map(turn => <article key={turn.id} id={`turn-${turn.id}`} tabIndex={-1} className="turn">
        <div className="message-head"><strong>{turn.workflow_run ? 'Workflow' : turn.parent ? 'Subtugas' : 'Kamu'}</strong>{turn.parent && !turn.messageOrigin && <a href={`#turn-${turn.parent}`} onClick={event => { event.preventDefault(); focusedOnce.current = ''; setFocusedTask(turn.parent!); }}>Lihat tugas induk</a>}{turn.messageOrigin && <button className="secondary" onClick={() => turn.messageOrigin!.channel ? onOpenChannel?.(turn.messageOrigin!.channel) : onOpenAgent?.(turn.messageOrigin!.agent, turn.messageOrigin!.thread ?? '')}>Buka percakapan peminta</button>}<time dateTime={turn.created}>{new Date(turn.created).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time></div>
        <p className="message-text">{turn.text}</p>{!!turn.files?.length && <ul aria-label="Lampiran pesan">{turn.files.map(file => <li key={file.id}><a href={`${path.replace(/\/turns$/, '/files')}/${file.id}`} download={file.name}>{file.name}</a></li>)}</ul>}
        <div className="answer"><div className="message-head"><strong>{turn.agent_name ?? agent.name}</strong><span>{turn.questions?.some(question => question.answer === null) && !['done','cancelled'].includes(turn.status) ? 'Menunggu jawabanmu' : turn.no_update ? 'Tidak ada pembaruan' : turn.paused && !['done','cancelled'].includes(turn.status) ? 'Dijeda' : turn.agentMessages?.some(item => item.expects_reply && !item.settled) && turn.status === 'queued' ? 'Menunggu balasan agent' : turn.waiting_for && turn.status === 'queued' ? 'Menunggu delegasi' : turn.routing === 'pending' && turn.status === 'running' ? 'Memilih penerima' : turn.routing === 'clarify' ? 'Perlu klarifikasi' : turn.routing === 'none' ? 'Tidak perlu tugas' : statusNames[turn.status] ?? turn.status}</span></div>
          {turn.reply ? <p className="message-text">{turn.reply}</p> : <p className={turn.error ? 'error' : 'muted'}>{turn.error ?? (turn.questions?.some(question => question.answer === null) ? 'Jawab pertanyaan untuk melanjutkan tugas.' : turn.workflow_run ? 'Workflow selesai tanpa teks hasil.' : turn.agentMessages?.some(item => item.expects_reply && !item.settled) ? 'Hasil akan digabung setelah semua penerima selesai. Pesan baru membawa hasil yang sudah tersedia.' : turn.waiting_for ? 'Menunggu hasil tugas anak.' : turn.status === 'queued' ? 'Menunggu giliran.' : 'Menunggu jawaban provider...')}</p>}
          {!turn.reply && turn.partial?.text && <div><p className="muted message-text">{turn.partial.status === 'pending' ? 'Teks sementara' : 'Teks dari percobaan sebelumnya'} dari {turn.partial.model}. Belum menjadi hasil akhir.</p><p className="message-text">{turn.partial.text}</p></div>}
          {turn.answer_model && <p className="muted message-text">Model: {turn.answer_model}</p>}
          {turn.questions?.map(question => <QuestionCard key={question.id} question={question} path={`${path}/${turn.id}`} status={turn.status} archived={archived} request={api} />)}
          {!!turn.generatedFiles?.length && <ul aria-label="File hasil agent">{turn.generatedFiles.map(file => <li key={file.id}><a href={`${path.replace(/\/turns$/, '/files')}/${file.id}`} download={file.name}>{file.name}</a> <span className="muted">{file.size} byte</span><HtmlPreview path={`${path.replace(/\/turns$/, '/files')}/${file.id}`} name={file.name} request={api} /></li>)}</ul>}
          {!!turn.receivedAgentReplies?.length && <details><summary>Hasil agent yang diterima bersama pesan ini ({turn.receivedAgentReplies.length})</summary>{turn.receivedAgentReplies.map(item => <div key={item.id}><p className="message-text"><strong>{item.name}</strong>: {statusNames[item.status] ?? item.status}</p>{item.error && <p className="error">{item.error}</p>}{item.reply && <p className="message-text">{item.reply}</p>}{item.truncated && <p className="muted">Cuplikan hasil. Buka percakapan untuk teks lengkap.</p>}{onOpenAgent && <button className="secondary" onClick={() => onOpenAgent(item.agent, item.thread)}>Buka percakapan {item.name}</button>}</div>)}</details>}
          {!!turn.agentMessages?.length && <details><summary>Pesan antar-agent ({turn.agentMessages.length})</summary>{turn.agentMessages.map(item => <div key={item.id}><p className="message-text"><strong>{item.name}</strong>: {item.paused && !['done','cancelled'].includes(item.status) ? 'Dijeda' : statusNames[item.status] ?? item.status}{!item.expects_reply && ' (tanpa balasan)'}</p>{item.error && <p className="error">{item.error}</p>}{item.reply && <p className="message-text">{item.reply.slice(0, 1000)}</p>}{(item.truncated || (item.reply?.length ?? 0) > 1000) && <p className="muted">Cuplikan hasil. Buka percakapan untuk teks lengkap.</p>}{onOpenAgent && <button className="secondary" onClick={() => onOpenAgent(item.agent, item.thread)}>Buka percakapan {item.name}</button>}</div>)}</details>}
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
      {(pending?.files ?? attached).length > 0 && <p className="notice">{(pending?.files ?? attached).length} lampiran akan dikirim ke provider bersama pesan.</p>}
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="message">Pesan untuk {agent.name}</label>
        <textarea id="message" placeholder={`Pesan untuk ${agent.name}...`} maxLength={16000} value={pending?.text ?? draft} readOnly={!!pending || busy} onChange={event => { setDraft(event.target.value); try { sessionStorage.setItem(draftKey, event.target.value); } catch { setError('Draft tidak tersimpan di browser. Jangan pindah agent sebelum menyalin pesan.'); } }} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-actions"><span>Ctrl / Cmd + Enter untuk kirim</span><button type="submit" disabled={archived || !configured || busy || (!pending && !draft.trim()) || (!!channel && !recipient && !pending)}>{busy ? 'Mengirim...' : pending ? 'Coba kirim lagi' : 'Kirim pesan'}</button></div>
      </form><p className="footnote">{focusedTask ? 'Rangkaian tugas ditampilkan.' : '100 pesan terakhir ditampilkan.'} Provider menerima hingga 40 percakapan sebelumnya.</p>
    </footer>
  </>;
}

type Routine = { trigger: 'schedule' | 'webhook'; id: string; agent: string; name: string; prompt: string; next_at: number; interval_ms: number | null; enabled: number; revision: number };
type RoutineRun = { source: string; no_update: number; turn: string; thread: string; scheduled_at: number | null; created: string; missed: number; status: string; reply: string | null; error: string | null };
type RoutineCommand = { routineId: string | null; data: { id: string; revision?: number; trigger?: 'schedule' | 'webhook'; name: string; prompt: string; nextAt: number; intervalSeconds: number | null; enabled: boolean } };
function pendingRoutine(agent: string): RoutineCommand | null {
  try { const value = JSON.parse(sessionStorage.getItem(`briefsip:routine-command:${agent}`) ?? 'null'); return value && typeof value.data?.id === 'string' && typeof value.data.name === 'string' && typeof value.data.prompt === 'string' && Number.isSafeInteger(value.data.nextAt) && value.data.nextAt > 0 && value.data.nextAt <= 253370764799999 && typeof value.data.enabled === 'boolean' && (value.data.intervalSeconds === null || Number.isSafeInteger(value.data.intervalSeconds)) && (value.routineId === null || typeof value.routineId === 'string') ? value : null; } catch { return null; }
}
function TestRoutine({ routine }: { routine: Routine }) {
  const key = `briefsip:routine-test:${routine.id}`;
  const [pending, setPending] = useState<{ id: string; revision: number } | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) ? value : null; } catch { return null; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [accepted, setAccepted] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  async function run() {
    if (busy) return;
    const request = pending ?? { id: crypto.randomUUID(), revision: routine.revision };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Status uji tidak tersimpan di browser. Periksa penyimpanan situs.'); return; }
    setPending(request); setBusy(true); setError(''); setAccepted(false);
    try {
      await api(`/api/routines/${routine.id}/test`, request);
      if (!mounted.current) return;
      sessionStorage.removeItem(key); setPending(null); setAccepted(true);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div><button className="secondary" disabled={busy} onClick={() => void run()}>{busy ? 'Mengirim uji...' : pending ? `Coba uji lagi ${routine.name}` : `Uji sekarang ${routine.name}`}</button>{error && <p className="error" role="alert">{error}</p>}{pending && !busy && <p className="muted">Coba lagi untuk memeriksa permintaan yang sama tanpa membuat eksekusi ganda.</p>}{accepted && <p role="status">Uji sudah diterima. Lihat perkembangannya di Eksekusi.</p>}</div>;
}
function ScriptAccess({ agent }: { agent: string }) {
  const key = `briefsip:script-access:${agent}`;
  const [access, setAccess] = useState<{ enabled: number; revision: number; configured: boolean } | null>(null);
  const [pending, setPending] = useState<{ id: string; revision: number; enabled: boolean } | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && typeof value.enabled === 'boolean' ? value : null; } catch { return null; }
  });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const readVersion = useRef(0);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let stopped = false;
    const version = ++readVersion.current;
    void api<NonNullable<typeof access>>(`/api/agents/${agent}/scripts`).then(data => { if (!stopped && version === readVersion.current) { setAccess(data); setError(''); } }).catch(error => { if (!stopped && version === readVersion.current) setError(message(error)); });
    return () => { stopped = true; };
  }, [agent, reload]);
  async function save() {
    if (busy || !access) return;
    const request = pending ?? { id: crypto.randomUUID(), revision: access.revision, enabled: !access.enabled };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Status izin tidak tersimpan di browser. Periksa penyimpanan situs.'); return; }
    readVersion.current++;
    setPending(request); setBusy(true); setError('');
    try {
      await api(`/api/agents/${agent}/scripts`, request);
      const latest = await api<NonNullable<typeof access>>(`/api/agents/${agent}/scripts`);
      if (!mounted.current) return;
      sessionStorage.removeItem(key); setPending(null); setAccess(latest);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); setAccess(null); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="script-access" aria-label="Akses script lokal"><h2>Script lokal</h2><p className="muted">Script dengan token server dapat membaca rutinitas dan menjalankannya untuk agent ini. Mematikan akses tidak menghentikan pekerjaan yang sudah diterima.</p>{access && <p role="status">{access.enabled ? 'Akses script aktif.' : 'Akses script nonaktif.'}{!access.configured && ' Token script belum dikonfigurasi pada server.'}</p>}{pending && <p className="muted">Perubahan izin belum terkonfirmasi. Coba simpan lagi untuk memeriksa permintaan yang sama.</p>}{error && <p role="alert" className="error">{error}</p>}<div className="form-actions"><button className="secondary" disabled={busy || !access || (!pending && !access.enabled && !access.configured)} onClick={() => void save()}>{busy ? 'Menyimpan izin...' : pending ? 'Coba simpan izin lagi' : access?.enabled ? 'Matikan akses script' : 'Izinkan akses script'}</button><button className="secondary" disabled={busy} onClick={() => setReload(value => value + 1)}>Muat ulang izin</button></div></section>;
}
type WebhookConfig = { route: string; revision: number; url: string; event_name: string; filters: unknown[]; secret?: string };
function WebhookSettings({ routine, onBack }: { routine: Routine; onBack: () => void }) {
  type Command = { id: string; revision: number; rotate: boolean; eventName: string; filters: unknown[] };
  const key = `briefsip:webhook:${routine.id}`, path = `/api/routines/${routine.id}/webhook`;
  const [pending, setPending] = useState<Command | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && typeof value.rotate === 'boolean' && typeof value.eventName === 'string' && Array.isArray(value.filters) ? value : null; } catch { return null; }
  });
  const [hook, setHook] = useState<WebhookConfig | null | undefined>(undefined), [secret, setSecret] = useState('');
  const [events, setEvents] = useState<{ delivery: string; received: number; result: { outcome: string; reason?: string } }[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const mounted = useRef(true), loadVersion = useRef(0);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let stopped = false; const version = ++loadVersion.current;
    void Promise.all([api<WebhookConfig | null>(path), api<typeof events>(`/api/routines/${routine.id}/webhook-events`)]).then(([config, receipts]) => {
      if (!stopped && version === loadVersion.current) { setHook(config); setEvents(receipts); setConflict(false); setError(''); }
    }).catch(error => { if (!stopped && version === loadVersion.current) setError(message(error)); });
    return () => { stopped = true; };
  }, [path, routine.id, reload]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || conflict || hook === undefined) return;
    let request: Command;
    try {
      const fields = new FormData(event.currentTarget);
      request = pending ?? { id: crypto.randomUUID(), revision: hook?.revision ?? 0, rotate: !hook || fields.get('rotate') === 'on', eventName: String(fields.get('eventName')), filters: JSON.parse(String(fields.get('filters'))) };
      if (!Array.isArray(request.filters)) throw new Error('Filter harus berupa daftar JSON.');
      sessionStorage.setItem(key, JSON.stringify(request));
    } catch { setError('Filter harus berupa daftar JSON valid dan penyimpanan browser harus tersedia.'); return; }
    loadVersion.current++; setPending(request); setBusy(true); setError(''); setSecret('');
    try {
      const result = await api<WebhookConfig>(path, request);
      const latest = await api<WebhookConfig | null>(path);
      if (!mounted.current) return;
      if (!latest || latest.revision !== result.revision || latest.route !== result.route) throw new HttpError(409, 'Webhook berubah. Muat ulang sebelum memakai secret.');
      sessionStorage.removeItem(key); setPending(null); setHook(latest); setSecret(result.secret ?? '');
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); setConflict(true); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="setup webhook-settings"><h1>Webhook {routine.name}</h1><p className="muted">URL lokal menerima event bertanda tangan saat Briefsip berjalan. Payload dikirim ke provider. URL ini belum tersedia dari internet.</p>
    {hook && <label>URL webhook<input readOnly value={hook.url} onFocus={event => event.target.select()} /></label>}
    {secret && <label>Secret baru<input readOnly value={secret} autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /><span className="muted">Salin ke penyimpanan secret pengirim. Secret tidak disimpan di browser dan tidak tampil lagi setelah halaman ditutup.</span></label>}
    {hook === undefined ? <p role="status">Memuat webhook...</p> : <form key={`${hook?.route ?? 'new'}:${hook?.revision ?? 0}:${reload}`} onSubmit={save}>
      <label>Nama event<input name="eventName" maxLength={256} readOnly={!!pending} defaultValue={pending?.eventName ?? hook?.event_name ?? ''} /><span className="muted">Kosongkan untuk semua event.</span></label>
      <label>Filter payload<textarea name="filters" rows={4} readOnly={!!pending} defaultValue={JSON.stringify(pending?.filters ?? hook?.filters ?? [], null, 2)} /><span className="muted">Daftar filter JSON, contoh: {'[{"pointer":"/environment","equals":"production"}]'}. Semua filter harus cocok.</span></label>
      {hook && <label className="member-option"><input type="checkbox" name="rotate" disabled={!!pending} defaultChecked={pending?.rotate ?? false} />Ganti secret. Secret lama langsung tidak berlaku.</label>}
      {pending && <p className="notice">Penyimpanan belum terkonfirmasi. Coba lagi dengan permintaan yang sama.</p>}
      <div className="form-actions routine-actions"><button disabled={busy || conflict}>{busy ? 'Menyimpan...' : pending ? 'Coba simpan webhook lagi' : hook ? 'Simpan webhook' : 'Buat URL dan secret'}</button></div>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}<div className="form-actions routine-actions"><button className="secondary" onClick={onBack}>Kembali ke rutinitas</button><button className="secondary" disabled={busy} onClick={() => { setSecret(''); setReload(value => value + 1); }}>Muat ulang webhook</button></div>
    <h2>Event diterima</h2>{!events.length ? <p className="muted">Belum ada event tersimpan. Muat ulang untuk melihat event baru.</p> : <ul className="routine-list">{events.map(event => <li key={`${event.delivery}:${event.received}`}><strong>{event.delivery}</strong><p>{new Date(event.received).toLocaleString('id-ID')} · {event.result.outcome === 'queued' ? 'Diterima untuk eksekusi' : 'Diabaikan'}</p>{event.result.reason && <p>{event.result.reason}</p>}</li>)}</ul>}
  </section>;
}
type FlowRun = { root_turn: string; created: string; steps: { agent: string; name: string; status: string; task_status: string | null; paused: number | null; thread: string | null; result: string; result_length: number }[] };
function FlowDiagram({ graph, agents }: { graph: FlowGraph; agents: Agent[] }) {
  const marker = useId();
  const depth = new Map<string, number>(), counts = new Map<number, number>(), positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const level = Math.max(0, ...graph.links.filter(link => link.to === node).map(link => (depth.get(link.from) ?? 0) + 1));
    depth.set(node, level); positions.set(node, { x: 12 + level * 200, y: 12 + (counts.get(level) ?? 0) * 84 }); counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  return <div className="flow-canvas" tabIndex={0} role="region" aria-label="Diagram alur, gulir untuk melihat seluruh graph"><svg width={Math.max(360, (Math.max(...depth.values()) + 1) * 200)} height={Math.max(...counts.values()) * 84} role="img" aria-label="Hubungan antar-agent dalam alur"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>{graph.links.map(link => { const start = positions.get(link.from)!, end = positions.get(link.to)!; return <path key={`${link.from}:${link.to}`} d={`M ${start.x + 160} ${start.y + 26} L ${end.x - 4} ${end.y + 26}`} fill="none" stroke="currentColor" strokeWidth="2" markerEnd={`url(#${marker})`} />; })}{graph.nodes.map(node => { const pos = positions.get(node)!; return <g key={node} transform={`translate(${pos.x},${pos.y})`}><title>{name(node)}</title><rect width="160" height="52" rx="7" /><text x="12" y="31">{name(node).length > 20 ? `${name(node).slice(0, 18)}...` : name(node)}</text></g>; })}</svg></div>;
}
function FlowEditor({ routine, onBack, onOpen }: { routine: Routine; onBack: () => void; onOpen: (thread: string, owner: string) => Promise<void> }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldId = useId();
  const optionName = (name: string) => name.length > 24 ? name.slice(0, 21) + '...' : name;
  useEffect(() => { heading.current?.focus(); }, []);
  type Command = { id: string; revision: number; links: FlowLink[] };
  const key = `briefsip:flow:${routine.id}`, path = `/api/routines/${routine.id}/flow`;
  const [pending, setPending] = useState<Command | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && Array.isArray(value.links) ? value : null; } catch { return null; }
  });
  const [agents, setAgents] = useState<Agent[]>([]), [links, setLinks] = useState<FlowLink[]>([]), [revision, setRevision] = useState(0);
  const [runs, setRuns] = useState<FlowRun[]>([]), [runError, setRunError] = useState('');
  const [from, setFrom] = useState(routine.agent), [to, setTo] = useState('');
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let stopped = false; setLoaded(false);
    void Promise.all([api<{ graph: FlowGraph; revision: number }>(path), api<Directory>('/api/agents')]).then(([flow, directory]) => {
      if (!stopped) { setAgents(directory.agents); setLinks(pending?.links ?? flow.graph.links); setRevision(flow.revision); setLoaded(true); setError(''); setConflict(false); }
    }).catch(error => { if (!stopped) setError(message(error)); });
    return () => { stopped = true; };
  }, [path, reload]);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const rows = await api<FlowRun[]>(`/api/routines/${routine.id}/flow-runs`); if (!stopped) { setRuns(rows); setRunError(''); } } catch (error) { if (!stopped) setRunError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [routine.id]);
  const locked = !loaded || busy || !!pending || conflict;
  let graph: FlowGraph = { root: routine.agent, nodes: [routine.agent], links: [] };
  try { if (loaded) graph = validateFlow(links, routine.agent, new Set(agents.map(agent => agent.id))); } catch { /* Server validates recovered requests; keep the editable edge list visible. */ }
  function change(next: FlowLink[]) {
    if (locked) return;
    try { validateFlow(next, routine.agent, new Set(agents.map(agent => agent.id))); setLinks(next); setError(''); } catch (error) { setError(message(error)); }
  }
  async function save() {
    if (!loaded || busy || conflict) return;
    const request = pending ?? { id: crypto.randomUUID(), revision, links };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Alur belum tersimpan di browser. Periksa penyimpanan situs.'); return; }
    setPending(request); setBusy(true); setError('');
    try {
      await api(path, request);
      const latest = await api<{ graph: FlowGraph; revision: number }>(path);
      if (!mounted.current) return;
      sessionStorage.removeItem(key); setPending(null); setLinks(latest.graph.links); setRevision(latest.revision);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); setConflict(true); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  return <section className="setup flow-editor"><h1 ref={heading} tabIndex={-1}>Alur {routine.name}</h1><p className="muted">Hubungkan hasil rutinitas ke agent berikutnya. Agent dengan beberapa input menunggu semuanya; cabang tanpa hasil berhasil dilewati. Perubahan hanya berlaku untuk run baru.</p>
    {!loaded ? <p role="status">Memuat alur...</p> : <><FlowDiagram graph={graph} agents={agents} />
    <div className="flow-link-fields"><label>Dari agent<select aria-describedby={`${fieldId}-from`} value={from} disabled={locked} onChange={event => { setFrom(event.target.value); if (to === event.target.value) setTo(''); }}>{graph.nodes.map(id => <option key={id} value={id} aria-label={name(id)}>{optionName(name(id))}</option>)}</select><span className="flow-selected-name muted" id={`${fieldId}-from`}>{name(from)}</span></label><label>Ke agent<select aria-describedby={`${fieldId}-to`} value={to} disabled={locked} onChange={event => setTo(event.target.value)}><option value="">Pilih agent</option>{agents.filter(agent => agent.id !== routine.agent && agent.id !== from).map(agent => <option key={agent.id} value={agent.id} aria-label={agent.name}>{optionName(agent.name)}</option>)}</select><span className="flow-selected-name muted" id={`${fieldId}-to`}>{to ? name(to) : 'Belum dipilih'}</span></label><button disabled={locked || !to || to === from} onClick={() => change([...links, { from, to }])}>Hubungkan</button></div>
    <ul className="routine-list">{links.map(link => <li key={`${link.from}:${link.to}`}><p>{name(link.from)} ke {name(link.to)}</p><button className="secondary" disabled={locked} onClick={() => { const remaining = links.filter(item => item !== link), reachable = new Set([routine.agent]); let changed = true; while (changed) { changed = false; for (const edge of remaining) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } } change(remaining.filter(edge => reachable.has(edge.from))); setFrom(routine.agent); }}>Hapus hubungan {name(link.from)} ke {name(link.to)}</button></li>)}</ul><p className="muted">Menghapus hubungan juga menghapus cabang yang tidak lagi terhubung ke asal.</p></>}
    {pending && <p className="notice">Penyimpanan belum terkonfirmasi. Coba lagi dengan permintaan yang sama.</p>}{error && <p role="alert" className="error">{error}</p>}
    <div className="form-actions routine-actions"><button className="secondary" onClick={onBack}>Kembali ke rutinitas</button><button className="secondary" disabled={busy} onClick={() => setReload(value => value + 1)}>Muat ulang alur</button><button disabled={!loaded || busy || conflict} onClick={() => void save()}>{busy ? 'Menyimpan...' : pending ? 'Coba simpan alur lagi' : 'Simpan alur'}</button></div>
    <h2>Langkah eksekusi</h2>{runError && <p role="alert" className="error">{runError}</p>}{!runs.length ? <p className="muted">Belum ada run dengan alur tersimpan.</p> : runs.map(run => <section className="flow-run" key={run.root_turn}><h3>{new Date(run.created).toLocaleString('id-ID')}</h3><ul className="routine-list">{run.steps.map(step => <li key={step.agent}><strong>{step.name}</strong><p>{step.paused ? 'Dijeda' : step.status === 'waiting' ? 'Menunggu input' : step.status === 'skipped' ? 'Dilewati' : statusNames[step.task_status ?? step.status] ?? step.status}</p>{step.result && <p className="message-text">{step.result}{step.result_length > 1000 ? '...' : ''}</p>}{step.thread && <button className="secondary" onClick={() => void onOpen(step.thread!, step.agent).catch(error => setRunError(message(error)))}>Buka langkah {step.name}</button>}</li>)}</ul></section>)}
  </section>;
}
function Routines({ agent, onClose, onOpen }: { agent: Agent; onClose: () => void; onOpen: (thread: string, owner: string) => Promise<void> }) {
  const [rows, setRows] = useState<Routine[] | null>(null), [error, setError] = useState('');
  const [webhook, setWebhook] = useState<Routine | null>(null);
  const [flow, setFlow] = useState<Routine | null>(null);
  const [editing, setEditing] = useState<Routine | null | undefined>(() => pendingRoutine(agent.id) ? null : undefined);
  const [selected, setSelected] = useState(''), [runs, setRuns] = useState<RoutineRun[] | null>(null), [runError, setRunError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const data = await api<Routine[]>(`/api/agents/${agent.id}/routines`); if (!stopped) { setRows(data); setError(''); } } catch (error) { if (!stopped) setError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [agent.id, reload]);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>; setRuns(null); setRunError('');
    async function refresh() {
      try { const data = await api<RoutineRun[]>(`/api/routines/${selected}/runs`); if (!stopped) { setRuns(data); setRunError(''); } } catch (error) { if (!stopped) setRunError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    if (selected) void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [selected]);
  if (flow) return <FlowEditor key={flow.id} routine={flow} onBack={() => setFlow(null)} onOpen={onOpen} />;
  if (webhook) return <WebhookSettings key={webhook.id} routine={webhook} onBack={() => setWebhook(null)} />;
  if (editing !== undefined) return <RoutineForm key={`${editing?.id ?? 'new'}:${reload}`} agent={agent} routine={editing} onBack={() => { setEditing(undefined); setReload(value => value + 1); }} />;
  return <section className="setup"><h1>Rutinitas {agent.name}</h1><p className="muted">Setiap eksekusi punya percakapan terpisah. Briefsip harus berjalan agar jadwal diproses.</p>
    <p className="muted">Uji sekarang menjalankan pekerjaan tersimpan melalui provider, termasuk saat jadwal nonaktif. Jadwal tidak berubah; penggunaan provider tetap dihitung.</p>
    <ScriptAccess key={agent.id} agent={agent.id} />
    <div className="form-actions routine-actions"><button className="secondary" onClick={onClose}>Kembali ke chat</button><a href={`/api/agents/${agent.id}/routines/calendar.ics`} download="briefsip-routines.ics">Unduh kalender</a><button onClick={() => setEditing(null)}>{pendingRoutine(agent.id) ? 'Lanjutkan penyimpanan' : 'Rutinitas baru'}</button></div>
    {error && <p className="error" role="alert">{error} Daftar akan dicoba lagi.</p>}
    {rows === null ? <p role="status">Memuat rutinitas...</p> : !rows.length ? <p className="empty">Belum ada rutinitas. Buat jadwal untuk pekerjaan berulang atau sekali jalan.</p> : <ul className="routine-list">{rows.map(row => <li key={row.id}><strong>{row.name}</strong><p className="muted">{row.trigger === 'webhook' ? row.enabled ? 'Menunggu event webhook' : 'Webhook nonaktif' : row.enabled ? `Berikutnya ${new Date(row.next_at).toLocaleString('id-ID')}` : 'Jadwal tidak aktif'}{row.trigger === 'webhook' ? '' : row.interval_ms ? ` · Setiap ${row.interval_ms / 60000} menit` : ' · Sekali jalan'}</p><div className="form-actions"><button className="secondary" onClick={() => setEditing(row)}>Edit {row.name}</button><button className="secondary" onClick={() => setSelected(row.id)} aria-pressed={selected === row.id}>Eksekusi {row.name}</button></div><TestRoutine routine={row} /><button className="secondary" onClick={() => setFlow(row)}>Alur {row.name}</button>{row.trigger === 'webhook' && <button className="secondary" onClick={() => setWebhook(row)}>Pengaturan webhook {row.name}</button>}</li>)}</ul>}
    {selected && <section aria-label="Riwayat eksekusi"><h2>Riwayat eksekusi</h2>{runError && <p className="error" role="alert">{runError}</p>}{runs === null ? <p role="status">Memuat eksekusi...</p> : !runs.length ? <p>Belum ada eksekusi tersimpan.</p> : <ul className="routine-list">{runs.map(run => <li key={run.turn}><p>{run.source === 'webhook' ? 'Webhook · ' : run.source === 'script' ? 'Script lokal · ' : run.scheduled_at === null ? 'Uji manual · ' : ''}{new Date(run.scheduled_at ?? run.created).toLocaleString('id-ID')} · {run.no_update ? 'Tidak ada pembaruan' : statusNames[run.status] ?? run.status}</p>{run.missed > 0 && <p className="muted">{run.missed} jadwal terlewat digabung ke eksekusi ini.</p>}{run.error && <p className="error">{run.error}</p>}<button className="secondary" onClick={() => void onOpen(run.thread, agent.id).catch(error => setRunError(message(error)))}>Buka hasil</button></li>)}</ul>}</section>}
  </section>;
}
function RoutineForm({ agent, routine, onBack }: { agent: Agent; routine: Routine | null; onBack: () => void }) {
  const key = `briefsip:routine-command:${agent.id}`;
  const pending = useRef<RoutineCommand | null>(pendingRoutine(agent.id));
  const [initial] = useState(() => pending.current);
  const routineId = initial?.routineId ?? routine?.id ?? null;
  const revision = initial?.data.revision ?? routine?.revision;
  const [conflict, setConflict] = useState(false);
  const snapshot = initial?.data;
  const [trigger, setTrigger] = useState<'schedule' | 'webhook'>(snapshot?.trigger ?? routine?.trigger ?? 'schedule');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const date = new Date(snapshot?.nextAt ?? routine?.next_at ?? Date.now() + 60000);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || conflict) return;
    const fields = new FormData(event.currentTarget);
    const request = pending.current ?? { routineId, data: { id: crypto.randomUUID(), ...(routineId ? { revision } : {}), name: String(fields.get('name')).trim(), prompt: String(fields.get('prompt')).trim(), trigger, nextAt: trigger === 'webhook' ? routine?.next_at ?? Date.now() + 60000 : new Date(String(fields.get('nextAt'))).getTime(), intervalSeconds: fields.get('interval') ? Number(fields.get('interval')) * 60 : null, enabled: fields.get('enabled') === 'on' } };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Status simpan tidak tersimpan di browser. Periksa penyimpanan situs.'); return; }
    pending.current = request; setBusy(true); setError('');
    try {
      await api(request.routineId ? `/api/routines/${request.routineId}/edit` : `/api/agents/${agent.id}/routines`, request.data);
      if (!mounted.current) return;
      if (pendingRoutine(agent.id)?.data.id === request.data.id) sessionStorage.removeItem(key);
      pending.current = null; onBack();
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { if (pendingRoutine(agent.id)?.data.id === request.data.id) sessionStorage.removeItem(key); pending.current = null; }
      if (error instanceof HttpError && error.status === 409) setConflict(true);
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="setup"><h1>{initial?.routineId || routine ? 'Edit rutinitas' : 'Rutinitas baru'}</h1><p className="muted">Waktu mengikuti zona waktu browser. Menonaktifkan atau mengubah jadwal membatalkan run yang masih antre; run yang sudah berjalan tetap berlangsung.</p>
    <form onSubmit={save}><label>Nama<input name="name" required maxLength={80} autoFocus readOnly={!!pending.current} defaultValue={snapshot?.name ?? routine?.name} /></label><label>Pekerjaan<textarea name="prompt" required maxLength={16000} readOnly={!!pending.current} defaultValue={snapshot?.prompt ?? routine?.prompt} rows={5} /></label><label>Pemicu<select value={trigger} disabled={!!pending.current} onChange={event => setTrigger(event.target.value as typeof trigger)}><option value="schedule">Jadwal</option><option value="webhook">Webhook</option></select></label>{trigger === 'webhook' && <p className="notice">Setelah menyimpan, buka Pengaturan webhook untuk membuat URL dan secret. Beralih ke jadwal menghapus URL dan secret lama.</p>}<label hidden={trigger === 'webhook'}>Waktu mulai<input disabled={trigger === 'webhook'} name="nextAt" type="datetime-local" required readOnly={!!pending.current} defaultValue={localDate} /></label><label hidden={trigger === 'webhook'}>Ulangi setiap (menit)<input disabled={trigger === 'webhook'} name="interval" type="number" min={1} max={525600} step={1} readOnly={!!pending.current} defaultValue={snapshot ? snapshot.intervalSeconds === null ? '' : snapshot.intervalSeconds / 60 : routine?.interval_ms ? routine.interval_ms / 60000 : ''} /><span className="muted">Kosongkan untuk sekali jalan.</span></label><label className="member-option"><input type="checkbox" name="enabled" disabled={!!pending.current} defaultChecked={snapshot?.enabled ?? (routine ? !!routine.enabled : true)} /> {trigger === 'webhook' ? 'Webhook aktif' : 'Jadwal aktif'}</label>
    {error && <p className="error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={onBack}>{error && !pending.current ? 'Buang perubahan dan muat ulang' : 'Kembali'}</button><button disabled={busy || conflict}>{busy ? 'Menyimpan...' : pending.current ? 'Coba simpan lagi' : 'Simpan rutinitas'}</button></div></form>
  </section>;
}

function AgentConversations({ agent, configured, onEdit, workflowAgents, initialThread, onOpenAgent, onOpenChannel, onThreadOpened }: { onOpenChannel: (channel: string) => void; agent: Agent; workflowAgents: Agent[]; configured: boolean; onEdit: () => void; initialThread?: string; onThreadOpened: () => void; onOpenAgent: (owner: string, thread: string) => void }) {
  const [threads, setThreads] = useState<Thread[]>([]), [error, setError] = useState('');
  const storageKey = `briefsip:thread:${agent.id}`;
  const [selected, setSelected] = useState(() => { if (initialThread) return initialThread; try { return sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; } });
  const [form, setForm] = useState(false), [editing, setEditing] = useState(false), [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [showRoutines, setShowRoutines] = useState(false);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const loadVersion = useRef(0);
  const navigation = useRef(0);
  const thread = threads.find(item => item.id === selected);
  function select(id: string) { setShowRoutines(false); setShowWorkflows(false); navigation.current++; loadVersion.current++; setSelected(id); setForm(false); setEditing(false); try { sessionStorage.setItem(storageKey, id); } catch { /* Selection remains usable in memory. */ } }
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
  useEffect(() => {
    if (initialThread) {
      onThreadOpened();
      try { sessionStorage.setItem(storageKey, initialThread); } catch { /* Selection remains usable in memory. */ }
    }
    void load().catch(() => {});
    return () => { navigation.current++; loadVersion.current++; };
  }, []);
  const navigationVersion = navigation.current;
  return <>
    <div className="recipient"><label htmlFor="conversation">Percakapan</label><select id="conversation" value={thread?.id ?? ''} disabled={!loaded} onChange={event => select(event.target.value)}><option value="">Chat utama</option>{threads.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (diarsipkan)' : ''}</option>)}</select><button className="secondary" disabled={!loaded} onClick={() => { navigation.current++; loadVersion.current++; setShowRoutines(false); setShowWorkflows(false); setForm(true); setEditing(false); }}>Percakapan baru</button><button className="secondary" onClick={() => { navigation.current++; loadVersion.current++; setShowRoutines(true); setShowWorkflows(false); }}>Rutinitas</button><button className="secondary" onClick={() => { navigation.current++; loadVersion.current++; setShowRoutines(false); setShowWorkflows(true); }}>Workflow</button></div>
    {error && <p className="error" role="alert">{error} <button className="secondary" onClick={() => void load().catch(() => {})}>Muat ulang percakapan</button></p>}
    {showWorkflows ? <WorkflowPanel owner={agent} agents={workflowAgents} request={api} onNavigate={() => { navigation.current++; loadVersion.current++; }} onBack={() => { navigation.current++; loadVersion.current++; setShowWorkflows(false); }} onOpen={async (id, owner) => { if (owner === agent.id) await load(id, true); else onOpenAgent(owner, id); }} /> : showRoutines ? <Routines agent={agent} onClose={() => { navigation.current++; loadVersion.current++; setShowRoutines(false); setShowWorkflows(false); }} onOpen={async (id, owner) => { if (owner === agent.id) await load(id, true); else onOpenAgent(owner, id); }} /> : !loaded ? <p className="empty">Memuat percakapan...</p> : form ? <ThreadForm key={editing ? `${thread?.id}:${thread?.revision}:${reload}` : 'new'} agent={agent} thread={editing ? thread : undefined} onCancel={() => { navigation.current++; loadVersion.current++; setForm(false); }} onReload={() => { void load().catch(() => {}); }} onSaved={item => navigationVersion === navigation.current ? load(item.deleted ? '' : item.id, true) : Promise.resolve()} /> : <Chat onOpenChannel={onOpenChannel} onOpenAgent={onOpenAgent} key={thread?.id ?? agent.id} agent={agent} thread={thread} configured={configured} onEdit={thread ? () => { navigation.current++; loadVersion.current++; setEditing(true); setForm(true); } : onEdit} />}
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
  const pending = useRef<{ id: string; name: string; model: string; backupModel: string; instructions: string; threadLimit: number; revision?: number } | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const data = pending.current ?? { id: crypto.randomUUID(), ...(profile ? { revision: profile.revision } : {}), name: String(form.get('name')).trim(), model: String(form.get('model')).trim(), backupModel: String(form.get('backupModel')).trim(), instructions: String(form.get('instructions')).trim(), threadLimit: Number(form.get('threadLimit')) };
    pending.current = data; setBusy(true); setError('');
    try { onCreated(await api<Agent>(profile ? `/api/agents/${profile.id}/edit` : '/api/agents', data)); } catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); } finally { setBusy(false); }
  }
  return <section className="setup"><h1>{profile ? 'Edit profil agent' : 'Agent baru'}</h1><p className="muted">Beri nama, pilih model, lalu jelaskan cara kerjanya.</p><form onSubmit={create}>
    <label>Nama<input name="name" required maxLength={80} readOnly={!!pending.current} autoFocus defaultValue={profile?.name} placeholder="Misalnya: Rekan riset" /></label>
    <label>Model<input name="model" list="provider-models" aria-describedby="model-catalog-status" required maxLength={160} readOnly={!!pending.current} defaultValue={profile?.model ?? model} placeholder="ID model dari provider kamu" /><datalist id="provider-models">{models.map(id => <option key={id} value={id} />)}</datalist><span id="model-catalog-status" className="muted" role="status">{catalogStatus}</span></label>
    <label>Model cadangan (opsional)<input name="backupModel" list="provider-models" maxLength={160} readOnly={!!pending.current} defaultValue={profile?.backup_model ?? ''} aria-describedby="backup-model-help" /><span id="backup-model-help" className="muted">Dicoba sekali jika model utama menolak karena kuota atau sedang tidak tersedia, sebelum jawaban atau tool diterima. Memakai provider yang sama. Kosongkan untuk menonaktifkan.</span></label>
    <label>Percakapan samping bersamaan<input name="threadLimit" type="number" min={1} max={32} step={1} required readOnly={!!pending.current} defaultValue={profile?.thread_limit ?? 2} /><span className="muted">Chat utama memiliki antrean sendiri. Semua percakapan tetap berbagi kapasitas server.</span></label>
    <label>Instruksi<textarea name="instructions" required maxLength={8000} readOnly={!!pending.current} defaultValue={profile?.instructions} rows={6} placeholder="Apa tugas agent ini? Bagaimana hasilnya perlu disampaikan?" /></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="form-actions">{onCancel && <button type="button" className="secondary" onClick={onCancel}>Batal</button>}<button disabled={busy}>{busy ? 'Menyimpan...' : profile ? 'Simpan profil' : 'Buat agent'}</button>{profile && error && onReload && <button type="button" className="secondary" onClick={onReload}>Buang perubahan dan muat ulang</button>}</div>
  </form>{profile && <AgentTemplateExport key={profile.id} id={profile.id} request={api} />}</section>;
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

function FlowDirectory({ agents, onClose, onOpen }: { agents: Agent[]; onClose: () => void; onOpen: (owner: string, thread: string) => void }) {
  type Entry = Routine & { owner_name: string; graph: FlowGraph; flow_revision: number };
  const [page, setPage] = useState<{ flows: Entry[]; next_after: string | null } | null>(null);
  const [cursors, setCursors] = useState(['']), [refresh, setRefresh] = useState(0), [error, setError] = useState('');
  const [editing, setEditing] = useState<Entry | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const after = cursors[cursors.length - 1];
  useEffect(() => {
    let stopped = false; setPage(null); setError('');
    void api<{ flows: Entry[]; next_after: string | null }>(`/api/flows${after ? `?after=${after}` : ''}`).then(data => {
      if (!stopped) { setPage(data); heading.current?.focus(); }
    }).catch(error => { if (!stopped) setError(message(error)); });
    return () => { stopped = true; };
  }, [after, refresh]);
  if (editing) return <FlowEditor routine={editing} onBack={() => { setEditing(null); setRefresh(value => value + 1); }} onOpen={async (thread, owner) => onOpen(owner, thread)} />;
  const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  return <section className="setup flow-directory"><h1 ref={heading} tabIndex={-1}>Alur agent</h1><p className="muted">Hubungan tersimpan dari semua rutinitas. Setiap diagram berjalan sendiri; hubungan dari rutinitas berbeda tidak digabung saat eksekusi.</p>
    <div className="form-actions routine-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Muat ulang daftar alur</button></div>
    {error ? <p role="alert" className="error">{error}</p> : !page ? <p role="status">Memuat daftar alur...</p> : !page.flows.length ? <p>Belum ada alur pada halaman ini. Buka Rutinitas pada agent, lalu simpan alurnya.</p> : page.flows.map(row => <section key={row.id} className="flow-run"><h2>{row.name}</h2><p className="muted">{row.owner_name} · {row.trigger === 'webhook' ? 'Webhook' : 'Jadwal'} · {row.enabled ? 'Aktif' : 'Nonaktif'}</p><FlowDiagram graph={row.graph} agents={agents} />
      {row.graph.links.length ? <ul>{row.graph.links.map(link => <li key={`${link.from}:${link.to}`}>{name(link.from)} ke {name(link.to)}</li>)}</ul> : <p>Belum ada hubungan ke agent lain.</p>}
      <button className="secondary" onClick={() => setEditing(row)}>Edit alur {row.name}</button></section>)}
    <div className="form-actions routine-actions"><button className="secondary" disabled={cursors.length < 2} onClick={() => setCursors(values => values.slice(0, -1))}>Alur sebelumnya</button><button className="secondary" disabled={!page?.next_after} onClick={() => { if (page?.next_after) setCursors(values => [...values, page.next_after!]); }}>Alur berikutnya</button></div>
  </section>;
}

function App() {
  const [showSkills, setShowSkills] = useState(false), skillsButton = useRef<HTMLButtonElement>(null);
  const [showBackup, setShowBackup] = useState(false), backupButton = useRef<HTMLButtonElement>(null);
  const [importing, setImporting] = useState(false), importButton = useRef<HTMLButtonElement>(null);
  const [showUsage, setShowUsage] = useState(false), usageButton = useRef<HTMLButtonElement>(null);
  const [directory, setDirectory] = useState<Directory | null>(null); const [selected, setSelected] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]), [selectedChannel, setSelectedChannel] = useState('');
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [showFlows, setShowFlows] = useState(false);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [openedThread, setOpenedThread] = useState<{ agent: string; thread: string } | null>(null);
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
      <div className="sidebar-title"><h2>Channels</h2><button className="secondary" disabled={!directory?.agents.length} onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(false); setShowWorkflows(false); setShowFlows(false); setCreatingChannel(true); setCreating(false); setEditing(false); }} aria-label="Buat channel baru">Baru</button></div>
      <nav aria-label="Pilih channel">{channels.map(room => <button key={room.id} className={`agent-row ${room.id === selectedChannel && !showSkills && !showBackup && !importing && !showUsage && !showWorkflows && !showFlows && !creatingChannel && !creating ? 'selected' : ''}`} aria-current={room.id === selectedChannel && !showSkills && !showBackup && !importing && !showUsage && !showWorkflows && !showFlows && !creatingChannel && !creating ? 'page' : undefined} onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(false); setShowWorkflows(false); setShowFlows(false); setSelectedChannel(room.id); setCreating(false); setCreatingChannel(false); setEditing(false); }}><span className="avatar" aria-hidden="true">#</span><span><strong>{room.name}</strong><small>{room.archived ? 'Diarsipkan' : `${room.members.length} anggota`}{room.activity > room.read_position && ' · Belum dibaca'}</small></span></button>)}</nav>
      <div className="sidebar-title"><h2>Agents</h2><button className="secondary" onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(false); setShowWorkflows(false); setShowFlows(false); setCreating(true); setCreatingChannel(false); setEditing(false); }} aria-label="Buat agent baru">Baru</button></div>
      <nav aria-label="Pilih agent">{directory?.agents.map(agent => <button key={agent.id} className={`agent-row ${agent.id === selected && !showSkills && !showBackup && !importing && !showUsage && !showWorkflows && !showFlows && !selectedChannel && !creating && !creatingChannel ? 'selected' : ''}`} aria-current={agent.id === selected && !showSkills && !showBackup && !importing && !showUsage && !showWorkflows && !showFlows && !selectedChannel && !creating && !creatingChannel ? 'page' : undefined} onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(false); setShowWorkflows(false); setShowFlows(false); setOpenedThread(null); setSelected(agent.id); setSelectedChannel(''); setCreating(false); setCreatingChannel(false); setEditing(false); }}><span className="avatar">{agent.name.slice(0, 1)}</span><span><strong>{agent.name}</strong><small>{agent.model}</small></span></button>)}</nav>
      <button className="secondary" disabled={!directory} aria-pressed={showFlows && !showSkills && !showBackup && !importing && !showUsage} onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(false); setShowWorkflows(false); setShowFlows(true); setCreating(false); setCreatingChannel(false); setEditing(false); }}>Alur agent</button>
      <button className="secondary" disabled={!directory} aria-pressed={showWorkflows && !showSkills && !showBackup && !importing && !showUsage} onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(false); setShowWorkflows(true); setShowFlows(false); setCreating(false); setCreatingChannel(false); setEditing(false); }}>Workflow</button>
      <button className="secondary" ref={usageButton} disabled={!directory} aria-pressed={showUsage && !showSkills && !showBackup && !importing} onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(true); setShowWorkflows(false); setShowFlows(false); }}>Pemakaian</button>
      <button ref={importButton} className="secondary" disabled={!directory} aria-pressed={importing && !showSkills && !showBackup} onClick={() => { setShowSkills(false); setShowBackup(false); setImporting(true); setShowUsage(false); setShowWorkflows(false); setShowFlows(false); }}>Impor agent</button>
      <button ref={backupButton} className="secondary" disabled={!directory} aria-pressed={showBackup && !showSkills} onClick={() => { setShowSkills(false); setShowBackup(true); setImporting(false); setShowUsage(false); setShowFlows(false); setShowWorkflows(false); }}>Backup</button>
      <button ref={skillsButton} className="secondary" disabled={!directory} aria-pressed={showSkills} onClick={() => { setShowSkills(true); setShowBackup(false); setImporting(false); setShowUsage(false); setShowFlows(false); setShowWorkflows(false); }}>Skills</button>
      {activityError && <p className="notice" role="status">Status baca belum diperbarui. Mencoba lagi.</p>}
      <div className="sidebar-footer"><span className={`dot ${directory?.configured ? 'connected' : ''}`} /><span>{directory?.configured ? 'Provider dikonfigurasi' : 'Provider belum terhubung'}</span></div>
    </aside>
    <main>{error ? <div className="empty"><h1>Ruang kerja belum terbuka</h1><p role="alert">{error}</p><button onClick={() => void load()}>Coba lagi</button></div> : !directory ? <p className="empty" role="status">Memuat ruang kerja...</p> : showSkills ? <SkillsPanel agents={directory.agents} request={api} onClose={() => { setShowSkills(false); skillsButton.current?.focus(); }} /> : showBackup ? <BackupPanel onClose={() => { setShowSkills(false); setShowBackup(false); backupButton.current?.focus(); }} /> : importing ? <AgentTemplateImport request={api} onClose={() => { setShowSkills(false); setShowBackup(false); setImporting(false); importButton.current?.focus(); }} onCreated={created => { setDirectory({ ...directory, agents: [...directory.agents.filter(agent => agent.id !== created.id), created] }); setSelected(created.id); setSelectedChannel(''); setCreating(false); setCreatingChannel(false); setEditing(false); setImporting(false); }} /> : showUsage ? <UsagePanel request={api} onClose={() => { setShowSkills(false); setShowBackup(false); setImporting(false); setShowUsage(false); usageButton.current?.focus(); }} /> : showWorkflows ? <WorkflowDirectory agents={directory.agents} request={api} onClose={() => setShowWorkflows(false)} onOpen={(owner, thread) => { setOpenedThread({ agent: owner, thread }); setSelected(owner); setSelectedChannel(''); setShowWorkflows(false); }} /> : showFlows ? <FlowDirectory agents={directory.agents} onClose={() => setShowFlows(false)} onOpen={(owner, thread) => { setOpenedThread({ agent: owner, thread }); setSelected(owner); setSelectedChannel(''); setShowWorkflows(false); setShowFlows(false); }} /> : editing && channel ? <ChannelForm key={`${channel.id}:${channel.revision}:${editReload}`} agents={directory.agents} channel={channel} onCancel={() => setEditing(false)} onReload={() => { void load().then(() => setEditReload(value => value + 1)); }} onCreated={() => { void load(); setEditing(false); }} /> : editing && agent ? <AgentForm key={`${agent.id}:${agent.revision}:${editReload}`} model={directory.defaultModel} profile={agent} onCancel={() => setEditing(false)} onReload={() => { void load().then(() => setEditReload(value => value + 1)); }} onCreated={() => { void load(); setEditing(false); }} /> : creatingChannel ? <ChannelForm agents={directory.agents} onCancel={() => setCreatingChannel(false)} onCreated={created => { setChannels([...channels.filter(room => room.id !== created.id), created]); setSelectedChannel(created.id); setCreatingChannel(false); }} /> : creating || (!agent && !channel) ? <AgentForm model={directory.defaultModel} onCancel={agent || channel ? () => setCreating(false) : undefined} onCreated={created => { setDirectory({ ...directory, agents: [...directory.agents.filter(agent => agent.id !== created.id), created] }); setSelected(created.id); setSelectedChannel(''); setCreating(false); }} /> : channel ? <Chat onOpenAgent={(owner, thread) => { setOpenedThread({ agent: owner, thread }); setSelected(owner); setSelectedChannel(''); setEditing(false); }} key={`channel:${channel.id}`} agent={channel} channel={channel} onRead={() => markRead(channel)} members={directory.agents.filter(agent => channel.members.includes(agent.id))} onEdit={() => setEditing(true)} configured={directory.configured} /> : agent && <AgentConversations onOpenChannel={id => { setSelectedChannel(id); setEditing(false); }} key={agent.id} agent={agent} workflowAgents={directory.agents} configured={directory.configured} initialThread={openedThread?.agent === agent.id ? openedThread.thread : undefined} onThreadOpened={() => setOpenedThread(null)} onOpenAgent={(owner, thread) => { setOpenedThread({ agent: owner, thread }); setSelected(owner); setSelectedChannel(''); setEditing(false); }} onEdit={() => setEditing(true)} />}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
