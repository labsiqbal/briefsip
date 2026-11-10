import { useEffect, useRef, useState } from 'react';
import { WorkflowEditor, type Workflow, type WorkflowDraft } from './WorkflowEditor';
import { WorkflowSchedule } from './WorkflowSchedule';
import { WorkflowWebhook, type WorkflowHook } from './WorkflowWebhook';
import type { WorkflowGraph } from '../workflows';
import { restoreWorkflowCommand, type WorkflowCommand as Command } from '../workflow-command';

type Agent = { id: string; name: string; model: string };
type Run = { id: string; version: number; revision: number; status: string; cursor: string; error: string | null; last: string; graph: WorkflowGraph; steps: { seq: number; node: string; status: string; detail: string | null; task_status: string | null; paused: number | null; thread: string | null; agent: string | null }[] };
const statuses: Record<string, string> = { ready: 'Siap', waiting: 'Menunggu langkah', approval: 'Menunggu persetujuan', done: 'Selesai', failed: 'Gagal', cancelled: 'Dibatalkan', interrupted: 'Terputus', queued: 'Antre', running: 'Berjalan' };

function WorkflowVersions({ workflow, request, locked, refresh, onRestore }: {
  workflow: Workflow; request: <T>(path: string, data?: unknown) => Promise<T>; locked: boolean; refresh: number; onRestore: (version: number) => void;
}) {
  const [cursors, setCursors] = useState<number[]>([]), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [page, setPage] = useState<{ versions: { revision: number; graph: WorkflowGraph }[]; next_before: number | null } | null>(null);
  const before = cursors.at(-1);
  useEffect(() => {
    let stopped = false; setPage(null); setError('');
    void request<NonNullable<typeof page>>(`/api/workflows/${workflow.id}/versions${before ? `?before=${before}` : ''}`).then(data => { if (!stopped) setPage(data); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [workflow.id, workflow.revision, before, refresh, retry]);
  return <section><h2>Versi tersimpan</h2><p>Pulihkan graph sebagai revisi baru. Nama workflow dan eksekusi yang sudah dimulai tetap sama.</p>
    {error ? <p className="error" role="alert">{error} <button className="secondary" onClick={() => setRetry(value => value + 1)}>Muat ulang versi</button></p> : !page ? <p role="status">Memuat versi...</p> : <ul className="routine-list">{page.versions.map(version => <li key={version.revision}><p>Versi {version.revision} · {version.graph.nodes.length} langkah · Awal: {version.graph.entry}</p><details><summary>Lihat graph versi {version.revision}</summary><pre className="message-text">{JSON.stringify(version.graph, null, 2)}</pre></details><button className="secondary" disabled={locked || version.revision === workflow.revision} onClick={() => { if (window.confirm(`Pulihkan graph versi ${version.revision} sebagai revisi baru? Eksekusi yang sudah dimulai tidak berubah.`)) onRestore(version.revision); }}>Pulihkan versi {version.revision}</button></li>)}</ul>}
    <div className="form-actions routine-actions"><button className="secondary" disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}>Versi lebih baru</button><button className="secondary" disabled={!page?.next_before} onClick={() => { if (page?.next_before) setCursors(value => [...value, page.next_before!]); }}>Versi lebih lama</button></div>
  </section>;
}

export function WorkflowPanel({ owner, agents, request, onBack, onOpen, onNavigate }: {
  owner: Agent; agents: Agent[]; request: <T>(path: string, data?: unknown) => Promise<T>;
  onBack: () => void; onOpen: (thread: string, owner: string) => Promise<void>; onNavigate: () => void;
}) {
  const storage = `briefsip:workflow-command:${owner.id}`, listPath = `/api/agents/${owner.id}/workflows`;
  const [recovery, setRecovery] = useState(() => {
    try { return { command: restoreWorkflowCommand(sessionStorage.getItem(storage), owner.id, new Set(agents.map(agent => agent.id))), invalid: false }; }
    catch { return { command: null, invalid: true }; }
  });
  const [pending, setPending] = useState<Command | null>(recovery.command);
  const [page, setPage] = useState<{ workflows: Workflow[]; next_after: string | null } | null>(null), [cursors, setCursors] = useState(['']);
  const [editing, setEditing] = useState<Workflow | 'new' | null>(pending?.kind === 'save' ? pending.workflow ?? 'new' : null);
  const [selected, setSelected] = useState<Workflow | null>(pending && pending.kind !== 'save' ? pending.workflow ?? null : null), [runs, setRuns] = useState<{ id: string; status: string; created: string }[]>([]);
  const [runId, setRunId] = useState(pending?.kind === 'run' ? String(pending.body.id) : pending && ['approve', 'cancel', 'retry'].includes(pending.kind) ? pending.path.split('/')[3] : ''), [run, setRun] = useState<Run | null>(null), [input, setInput] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [scheduleRefresh, setScheduleRefresh] = useState(0), [scheduleConflict, setScheduleConflict] = useState('');
  const [hookRefresh, setHookRefresh] = useState(0), [hookConflict, setHookConflict] = useState('');
  const [hookSecret, setHookSecret] = useState<{ workflow: string; value: string } | null>(null);
  const mounted = useRef(true), navigation = useRef(0), heading = useRef<HTMLHeadingElement>(null);
  function navigate() { navigation.current++; setHookSecret(null); onNavigate(); }
  useEffect(() => () => { mounted.current = false; navigation.current++; }, []);
  const after = cursors[cursors.length - 1];
  useEffect(() => {
    let stopped = false; setPage(null);
    void Promise.all([
      request<{ workflows: Workflow[]; next_after: string | null }>(`${listPath}${after ? `?after=${after}` : ''}`),
      selected ? request<Workflow>(`/api/workflows/${selected.id}`) : Promise.resolve(null),
    ]).then(([data, current]) => { if (!stopped) { setPage(data); if (current) setSelected(current); setError(''); } }).catch(error => { if (!stopped) setError(String(error.message)); });
    return () => { stopped = true; };
  }, [after, refresh, listPath, selected?.id]);
  useEffect(() => { heading.current?.focus(); }, [editing, selected?.id]);
  useEffect(() => {
    if (!selected) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const rows = await request<typeof runs>(`/api/workflows/${selected!.id}/runs`);
        const detail = runId ? await request<Run>(`/api/workflow-runs/${runId}`) : null;
        if (!stopped) { setRuns(rows); setRun(detail); }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Riwayat belum dimuat.'); }
      if (!stopped) timer = setTimeout(poll, 1200);
    }
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [selected?.id, runId, refresh]);
  async function execute(command: Command) {
    if (busy) return;
    const version = navigation.current;
    try { sessionStorage.setItem(storage, JSON.stringify(command)); }
    catch { setError('Permintaan belum tersimpan di browser. Periksa penyimpanan situs.'); return; }
    setPending(command); setBusy(true); setError('');
    if (command.kind === 'webhook') setHookSecret(null);
    try {
      const result = await request<{ id: string } & Partial<WorkflowHook>>(command.path, command.body);
      if (JSON.parse(sessionStorage.getItem(storage) ?? 'null')?.body?.id === command.body.id) sessionStorage.removeItem(storage);
      if (!mounted.current) return;
      setPending(null); setRefresh(value => value + 1);
      if (command.kind === 'schedule' && command.workflow?.id === selected?.id && version === navigation.current) setScheduleRefresh(value => value + 1);
      if (version === navigation.current) {
        if (command.kind === 'webhook' && command.workflow?.id === selected?.id) {
          setHookRefresh(value => value + 1);
          if (result.secret) setHookSecret({ workflow: selected!.id, value: result.secret });
        }
        if (command.kind === 'save') setEditing(null);
        if (command.kind === 'run' && command.workflow?.id === selected?.id) { setRun(null); setRunId(result.id); }
        if (command.kind === 'restore' && command.workflow?.id === selected?.id) setSelected(result as Workflow);
      }
    } catch (error) {
      if (!mounted.current) return;
      if (typeof error === 'object' && error && 'status' in error && Number(error.status) < 500) {
        if (JSON.parse(sessionStorage.getItem(storage) ?? 'null')?.body?.id === command.body.id) sessionStorage.removeItem(storage); setPending(null);
        if (command.kind === 'save' && Number(error.status) === 409 && version === navigation.current) setConflict(true);
        if (command.kind === 'webhook' && Number(error.status) === 409) setHookConflict(command.workflow!.id);
        if (command.kind === 'schedule' && Number(error.status) === 409) setScheduleConflict(command.workflow!.id);
      }
      setError(error instanceof Error ? error.message : 'Permintaan belum terkonfirmasi.');
    } finally { if (mounted.current) setBusy(false); }
  }
  async function reloadEdit() {
    if (!editing || editing === 'new' || busy) return;
    const version = navigation.current; setBusy(true);
    try {
      const current = await request<Workflow>(`/api/workflows/${editing.id}`);
      if (mounted.current && version === navigation.current) { setEditing(current); setConflict(false); setError(''); }
    } catch (error) { if (mounted.current && version === navigation.current) setError(error instanceof Error ? error.message : 'Workflow belum dimuat.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const locked = busy || !!pending || conflict || recovery.invalid;
  const banner = <>{recovery.invalid && <p className="error" role="alert">Permintaan tersimpan tidak dapat dibaca. Periksa riwayat sebelum mengirim ulang. <button className="secondary" onClick={() => { try { sessionStorage.removeItem(storage); setRecovery({ command: null, invalid: false }); } catch { setError('Penyimpanan situs belum dapat diakses.'); } }}>Abaikan data pemulihan</button></p>}{error && <p className="error" role="alert">{error}</p>}{pending && <p className="notice">Permintaan belum terkonfirmasi. <button className="secondary" disabled={busy} onClick={() => void execute(pending)}>Coba permintaan lagi</button></p>}{conflict && editing && <p className="notice">Draft tetap ditampilkan. Memuat versi terbaru akan mengganti draft ini. <button className="secondary" disabled={busy} onClick={() => void reloadEdit()}>Buang draft dan muat versi terbaru</button></p>}</>;
  if (editing) return <><div className="recipient">{banner}</div><WorkflowEditor key={editing === 'new' ? 'new' : `${editing.id}:${editing.revision}`} owner={owner} agents={agents} locked={locked}
    initial={pending?.kind === 'save' ? pending.body as unknown as WorkflowDraft : editing === 'new' ? undefined : editing}
    onBack={() => { navigate(); setEditing(null); setConflict(false); setRefresh(value => value + 1); }}
    onSave={async draft => { await execute({ kind: 'save', workflow: editing === 'new' ? undefined : editing, path: editing === 'new' ? listPath : `/api/workflows/${editing.id}/edit`, body: { id: crypto.randomUUID(), ...draft } }); }} /></>;
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>{selected ? selected.name : 'Workflow'}</h1>{banner}
    <div className="form-actions routine-actions"><button className="secondary" onClick={() => { navigate(); if (selected) { setSelected(null); setRunId(''); setRun(null); } else onBack(); }}>Kembali</button><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Muat ulang workflow</button></div>
    {!selected ? <><button disabled={locked} onClick={() => { navigate(); setEditing('new'); }}>Workflow baru</button>
      {!page ? <p role="status">Memuat workflow...</p> : !page.workflows.length ? <p>Belum ada workflow pada halaman ini.</p> : <ul className="routine-list">{page.workflows.map(item => <li key={item.id}><h2>{item.name}</h2><p>Versi {item.revision} · {item.graph.nodes.length} langkah</p><div className="form-actions routine-actions"><button className="secondary" disabled={locked} onClick={() => { navigate(); setEditing(item); }}>Edit {item.name}</button><button onClick={() => { navigate(); setSelected(item); setRunId(''); setRun(null); setRuns([]); setInput(''); }}>Buka {item.name}</button></div></li>)}</ul>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}>Workflow sebelumnya</button><button className="secondary" disabled={!page?.next_after} onClick={() => { if (page?.next_after) setCursors(value => [...value, page.next_after!]); }}>Workflow berikutnya</button></div>
    </> : <><form onSubmit={event => { event.preventDefault(); if (!locked) void execute({ kind: 'run', workflow: selected, path: `/api/workflows/${selected.id}/run`, body: { id: crypto.randomUUID(), revision: selected.revision, input } }); }}><label>Input workflow<textarea maxLength={16000} value={input} readOnly={locked} onChange={event => setInput(event.target.value)} /></label><button disabled={locked}>Jalankan versi {selected.revision}</button></form>
      <WorkflowSchedule key={`schedule:${selected.id}`} workflow={selected.id} request={request} locked={locked} refresh={scheduleRefresh} conflict={scheduleConflict === selected.id} onLoaded={() => setScheduleConflict(current => current === selected.id ? '' : current)} pending={pending?.kind === 'schedule' && pending.workflow?.id === selected.id ? pending : undefined} onSave={body => execute({ kind: 'schedule', workflow: selected, path: `/api/workflows/${selected.id}/schedule`, body })} onRun={id => { navigate(); setRun(null); setRunId(id); }} />
      <WorkflowWebhook key={`hook:${selected.id}`} workflow={selected.id} request={request} locked={locked} busy={busy} refresh={hookRefresh} secret={hookSecret?.workflow === selected.id ? hookSecret.value : undefined} conflict={hookConflict === selected.id} onLoaded={() => setHookConflict(current => current === selected.id ? '' : current)} pending={pending?.kind === 'webhook' && pending.workflow?.id === selected.id ? pending : undefined} onSave={body => execute({ kind: 'webhook', workflow: selected, path: `/api/workflows/${selected.id}/webhook`, body })} onRun={id => { navigate(); setRun(null); setRunId(id); }} />
      <WorkflowVersions key={selected.id} workflow={selected} request={request} locked={locked} refresh={refresh} onRestore={version => void execute({ kind: 'restore', workflow: selected, path: `/api/workflows/${selected.id}/restore`, body: { id: crypto.randomUUID(), revision: selected.revision, version } })} />
      <h2>Riwayat eksekusi</h2>{!runs.length ? <p>Belum ada eksekusi.</p> : <ul className="routine-list">{runs.map(item => <li key={item.id}><button className="secondary" aria-pressed={runId === item.id} onClick={() => { navigate(); setRun(null); setRunId(item.id); }}>{new Date(item.created).toLocaleString('id-ID')} · {statuses[item.status] ?? item.status}</button></li>)}</ul>}
      {run && <section><h2>Versi {run.version} · {statuses[run.status]}</h2>{run.error && <p className="error">{run.error}</p>}
        {run.status === 'failed' && ['agent', 'model', 'condition'].includes(run.graph.nodes.find(node => node.id === run.cursor)?.kind ?? '') && run.steps.length < run.graph.maxSteps && <button className="secondary" disabled={locked} onClick={() => { if (window.confirm('Coba lagi langkah yang gagal? Efek sebelumnya mungkin sudah terjadi. Pengaturan node terbaru yang sejenis akan digunakan; hasil sebelumnya tetap disimpan.')) void execute({ kind: 'retry', workflow: selected, path: `/api/workflow-runs/${run.id}/retry`, body: { id: crypto.randomUUID(), revision: run.revision } }); }}>Coba lagi langkah gagal</button>}
        {run.status === 'approval' && <><p>{run.graph.nodes.find(node => node.id === run.cursor)?.kind === 'approval' ? (run.graph.nodes.find(node => node.id === run.cursor) as { prompt: string }).prompt : ''}</p><div className="form-actions routine-actions">{[true, false].map(accepted => <button key={String(accepted)} disabled={locked} onClick={() => void execute({ kind: 'approve', workflow: selected, path: `/api/workflow-runs/${run.id}/approve`, body: { id: crypto.randomUUID(), revision: run.revision, accepted } })}>{accepted ? 'Setujui langkah' : 'Tolak langkah'}</button>)}</div></>}
        {!['done', 'failed', 'cancelled'].includes(run.status) && <button className="secondary" disabled={locked} onClick={() => { if (window.confirm('Batalkan workflow beserta langkah aktif? Hasil yang sudah tersimpan tetap ada.')) void execute({ kind: 'cancel', workflow: selected, path: `/api/workflow-runs/${run.id}/cancel`, body: { id: crypto.randomUUID(), revision: run.revision } }); }}>Batalkan workflow</button>}
        <p className="message-text">{run.last}</p><ol className="routine-list">{run.steps.map(step => <li key={step.seq}><strong>{step.node}</strong><p>{step.detail === 'rejected' ? 'Ditolak' : step.paused ? 'Dijeda' : statuses[step.status === 'waiting' ? step.task_status ?? step.status : step.status] ?? step.status}</p>{step.detail && <p>{step.detail}</p>}{step.thread && step.agent && <button className="secondary" onClick={() => void onOpen(step.thread!, step.agent!).catch(error => setError(error.message))}>Buka langkah {step.node}</button>}</li>)}</ol>
      </section>}
    </>}
  </section>;
}
