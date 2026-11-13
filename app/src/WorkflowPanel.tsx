import { EventConnection } from './EventConnection';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WorkflowEditor, type Workflow, type WorkflowDraft } from './WorkflowEditor';
import { WorkflowSchedule } from './WorkflowSchedule';
import { WorkflowWebhook, type WorkflowHook } from './WorkflowWebhook';
import type { WorkflowGraph } from '../workflows';
import { WorkflowGraph as GraphView } from './WorkflowGraph';
import { restoreWorkflowEditorDraft, workflowDraftMatches, workflowStatusLabels as statuses, workflowStepLabel, workflowNodeLabels } from '../workflow-editor-state';
import { restoreWorkflowCommand, type WorkflowCommand as Command } from '../workflow-command';

type Agent = { id: string; name: string; model: string };
type Run = { id: string; version: number; revision: number; status: string; cursor: string; error: string | null; last: string; graph: WorkflowGraph; steps: { seq: number; node: string; status: string; detail: string | null; task_status: string | null; paused: number | null; thread: string | null; agent: string | null }[] };

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
  return <section><h2>Saved versions</h2><p>Restore the graph as a new revision. The workflow name and runs already started stay unchanged.</p>
    {error ? <p className="error" role="alert">{error} <button className="secondary" onClick={() => setRetry(value => value + 1)}>Reload versions</button></p> : !page ? <p role="status">Loading versions...</p> : <ul className="routine-list">{page.versions.map(version => <li key={version.revision}><p>Version {version.revision} · {version.graph.nodes.length} steps · Start: {version.graph.entry}</p><details><summary>View graph version {version.revision}</summary><pre className="message-text">{JSON.stringify(version.graph, null, 2)}</pre></details><button className="secondary" disabled={locked || version.revision === workflow.revision} onClick={() => { if (window.confirm(`Restore graph version ${version.revision} as a new revision? Runs already started stay unchanged.`)) onRestore(version.revision); }}>Restore version {version.revision}</button></li>)}</ul>}
    <div className="form-actions routine-actions"><button className="secondary" disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}>Newer versions</button><button className="secondary" disabled={!page?.next_before} onClick={() => { if (page?.next_before) setCursors(value => [...value, page.next_before!]); }}>Older versions</button></div>
  </section>;
}

function RunGraph({ run }: { run: Run }) {
  const [node, setNode] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement>()), detail = useRef<HTMLDivElement>(null);
  const steps = run.steps.filter(step => step.node === node), selected = run.graph.nodes.find(item => item.id === node);
  useEffect(() => { if (node) detail.current?.focus(); }, [node]);
  return <section><GraphView graph={run.graph} selected={node || run.cursor} locked={false} labels={workflowNodeLabels(run.steps)} buttonRefs={buttons.current} onSelect={id => { setNode(id); if (id === node) detail.current?.focus(); }} />
    {selected && <div className="workflow-step-detail" tabIndex={-1} ref={detail}><h3>Step {node}</h3>{steps.length ? <ol>{steps.map((step, index) => <li key={step.seq}>Attempt {index + 1}: {workflowStepLabel(step)}{step.detail && <p className="message-text">{step.detail}</p>}</li>)}</ol> : <p>Step has not run in this execution yet.</p>}<button className="secondary" onClick={() => { buttons.current.get(node)?.focus(); buttons.current.get(node)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }}>Back to run graph</button></div>}
  </section>;
}

export function WorkflowPanel({ owner, agents, request, onBack, renderConversation, onNavigate, initial }: {
  owner: Agent; agents: Agent[]; request: <T>(path: string, data?: unknown) => Promise<T>;
  onBack: () => void; renderConversation: (thread: string, owner: string) => ReactNode; onNavigate: () => void;
  initial?: Workflow | 'new';
}) {
  const storage = `briefsip:workflow-command:${owner.id}`, listPath = `/api/agents/${owner.id}/workflows`;
  const [recovery, setRecovery] = useState(() => {
    try { return { command: restoreWorkflowCommand(sessionStorage.getItem(storage), owner.id, new Set(agents.map(agent => agent.id))), invalid: false }; }
    catch { return { command: null, invalid: true }; }
  });
  const [pending, setPending] = useState<Command | null>(recovery.command);
  const [page, setPage] = useState<{ workflows: Workflow[]; next_after: string | null } | null>(null), [cursors, setCursors] = useState(['']);
  const [editing, setEditing] = useState<Workflow | 'new' | null>(pending?.kind === 'save' ? pending.workflow ?? 'new' : initial === 'new' && !pending ? 'new' : null);
  const [selected, setSelected] = useState<Workflow | null>(pending?.workflow ?? (initial && initial !== 'new' ? initial : null)), [runs, setRuns] = useState<{ seq: number; id: string; status: string; created: string }[] | null>(null);
  const [runId, setRunId] = useState(pending?.kind === 'run' ? String(pending.body.id) : pending && ['approve', 'cancel', 'retry'].includes(pending.kind) ? pending.path.split('/')[3] : ''), [run, setRun] = useState<Run | null>(null), [input, setInput] = useState('');
  const [runCursors, setRunCursors] = useState<number[]>([]), beforeRun = runCursors.at(-1);
  const [conversation, setConversation] = useState<{ thread: string; agent: string; node: string } | null>(null);
  const stepButtons = useRef(new Map<number, HTMLButtonElement>()), returnStep = useRef<number | null>(null), conversationBack = useRef<HTMLButtonElement>(null);
  useEffect(() => { setRunCursors([]); }, [selected?.id]);
  useEffect(() => { setRuns(null); }, [selected?.id, beforeRun]);
  useEffect(() => {
    if (conversation) conversationBack.current?.focus();
    else if (returnStep.current !== null) stepButtons.current.get(returnStep.current)?.focus();
  }, [conversation]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [conflict, setConflict] = useState(false), [editorReload, setEditorReload] = useState(0);
  const [scheduleRefresh, setScheduleRefresh] = useState(0), [scheduleConflict, setScheduleConflict] = useState('');
  const [hookRefresh, setHookRefresh] = useState(0), [hookConflict, setHookConflict] = useState('');
  const [hookSecret, setHookSecret] = useState<{ workflow: string; value: string } | null>(null);
  const mounted = useRef(true), inFlight = useRef(false), navigation = useRef(0), heading = useRef<HTMLHeadingElement>(null);
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
        const rows = await request<NonNullable<typeof runs>>(`/api/workflows/${selected!.id}/runs${beforeRun ? `?before=${beforeRun}` : ''}`);
        const detail = runId ? await request<Run>(`/api/workflow-runs/${runId}`) : null;
        if (!stopped) { setRuns(rows); setRun(detail); }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'History has not loaded.'); }
      if (!stopped) timer = setTimeout(poll, 1200);
    }
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [selected?.id, runId, refresh, beforeRun]);
  async function execute(command: Command) {
    if (busy || inFlight.current) return false;
    const version = navigation.current;
    try { sessionStorage.setItem(storage, JSON.stringify(command)); }
    catch { setError('Request has not been saved in the browser. Check site storage.'); return false; }
    inFlight.current = true; setPending(command); setBusy(true); setError('');
    if (command.kind === 'webhook') setHookSecret(null);
    try {
      const result = await request<{ id: string } & Partial<WorkflowHook>>(command.path, command.body);
      if (JSON.parse(sessionStorage.getItem(storage) ?? 'null')?.body?.id === command.body.id) sessionStorage.removeItem(storage);
      if (command.kind === 'save') {
        const key = `briefsip:workflow-draft:${owner.id}:${command.workflow?.id ?? 'new'}`;
        try {
          const draft = restoreWorkflowEditorDraft(sessionStorage.getItem(key));
          if (draft && draft.revision === command.body.revision && workflowDraftMatches(draft.name, draft.graph, command.body as unknown as WorkflowDraft, new Set(agents.map(agent => agent.id)))) sessionStorage.removeItem(key);
        } catch { /* Preserve an unreadable or newer local draft. */ }
      }
      if (!mounted.current) return false;
      setPending(null); setRefresh(value => value + 1);
      if (command.kind === 'schedule' && command.workflow?.id === selected?.id && version === navigation.current) setScheduleRefresh(value => value + 1);
      if (version === navigation.current) {
        if (command.kind === 'delete') { setSelected(null); setRunId(''); setRun(null); if (initial) onBack(); }
        if (command.kind === 'webhook' && command.workflow?.id === selected?.id) {
          setHookRefresh(value => value + 1);
          if (result.secret) setHookSecret({ workflow: selected!.id, value: result.secret });
        }
        if (command.kind === 'save') { setEditing(command.autosave ? result as Workflow : null); if (command.workflow?.id === selected?.id || (initial && !command.workflow)) setSelected(result as Workflow); }
        if (command.kind === 'run' && command.workflow?.id === selected?.id) { setRun(null); setRunId(result.id); }
        if (command.kind === 'restore' && command.workflow?.id === selected?.id) setSelected(result as Workflow);
      }
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      if (typeof error === 'object' && error && 'status' in error && Number(error.status) < 500) {
        if (JSON.parse(sessionStorage.getItem(storage) ?? 'null')?.body?.id === command.body.id) sessionStorage.removeItem(storage); setPending(null);
        if (command.kind === 'save' && Number(error.status) === 409 && version === navigation.current) setConflict(true);
        if (command.kind === 'webhook' && Number(error.status) === 409) setHookConflict(command.workflow!.id);
        if (command.kind === 'schedule' && Number(error.status) === 409) setScheduleConflict(command.workflow!.id);
      }
      setError(error instanceof Error ? error.message : 'Request is not confirmed yet.');
      return false;
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function reloadEdit() {
    if (!editing || editing === 'new' || busy) return;
    const version = navigation.current; setBusy(true);
    try {
      const current = await request<Workflow>(`/api/workflows/${editing.id}`);
      if (mounted.current && version === navigation.current) { setEditing(current); setEditorReload(value => value + 1); setConflict(false); setError(''); }
    } catch (error) { if (mounted.current && version === navigation.current) setError(error instanceof Error ? error.message : 'Workflow has not loaded.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const locked = busy || !!pending || conflict || recovery.invalid || !!selected?.deleted || !!(editing && editing !== 'new' && editing.deleted);
  const banner = <>{editing && editing !== 'new' && !!editing.deleted && <p className="notice" role="alert">Workflow has been deleted. The draft remains saved in the browser.</p>}{recovery.invalid && <p className="error" role="alert">Saved request could not be read. Check history before resending. <button className="secondary" onClick={() => { try { sessionStorage.removeItem(storage); setRecovery({ command: null, invalid: false }); } catch { setError('Site storage is unavailable.'); } }}>Ignore recovery data</button></p>}{error && <p className="error" role="alert">{error}</p>}{pending && <p className="notice">Request is not confirmed yet. <button className="secondary" disabled={busy} onClick={() => void execute(pending)}>Retry request</button></p>}{conflict && editing && <p className="notice">Draft remains visible. Load the latest version; previous graph changes can be restored with Undo graph. <button className="secondary" disabled={busy} onClick={() => void reloadEdit()}>Load latest version</button></p>}</>;
  if (conversation && selected && run) return <><div className="recipient"><button ref={conversationBack} className="secondary" onClick={() => setConversation(null)}>Back to run {selected.name}</button><span>{selected.name} · Version {run.version} · Step {conversation.node} · Run {run.id}</span></div>{renderConversation(conversation.thread, conversation.agent)}</>;
  if (editing) return <><div className="recipient">{banner}</div><WorkflowEditor key={editing === 'new' ? 'new' : editing.id} reload={editorReload} owner={owner} agents={agents} request={request} locked={locked} saved={editing === 'new' ? undefined : editing} draftKey={`briefsip:workflow-draft:${owner.id}:${editing === 'new' ? 'new' : editing.id}`} pendingSave={pending?.kind === 'save'} onReload={() => void reloadEdit()}
    initial={pending?.kind === 'save' ? pending.body as unknown as WorkflowDraft : editing === 'new' ? undefined : editing}
    onBack={() => { navigate(); if (initial && !selected) onBack(); else { setEditing(null); setConflict(false); setRefresh(value => value + 1); } }}
    onSave={(draft, automatic) => execute({ kind: 'save', ...(automatic ? { autosave: true } : {}), workflow: editing === 'new' ? undefined : editing, path: editing === 'new' ? listPath : `/api/workflows/${editing.id}/edit`, body: { id: crypto.randomUUID(), ...draft } })} /></>;
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>{selected ? selected.name : 'Workflows'}</h1>{banner}
    <div className="form-actions routine-actions"><button className="secondary" onClick={() => { navigate(); if (selected && !initial) { setSelected(null); setRunId(''); setRun(null); } else onBack(); }}>Back</button>{selected && !selected.deleted && initial && <button className="secondary" disabled={locked} onClick={() => { navigate(); setEditing(selected); }}>Edit workflow</button>}<button className="secondary" onClick={() => setRefresh(value => value + 1)}>Reload workflow</button></div>
    {!selected ? <><button disabled={locked} onClick={() => { navigate(); setEditing('new'); }}>New workflow</button>
      {!page ? <p role="status">Loading workflow...</p> : !page.workflows.length ? <p>No workflows on this page yet.</p> : <ul className="routine-list">{page.workflows.map(item => <li key={item.id}><h2>{item.name}</h2><p>Version {item.revision} · {item.graph.nodes.length} steps</p><div className="form-actions routine-actions"><button className="secondary" disabled={locked} onClick={() => { navigate(); setEditing(item); }}>Edit {item.name}</button><button onClick={() => { navigate(); setSelected(item); setRunId(''); setRun(null); setRuns(null); setInput(''); }}>Open {item.name}</button></div></li>)}</ul>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}>Previous workflows</button><button className="secondary" disabled={!page?.next_after} onClick={() => { if (page?.next_after) setCursors(value => [...value, page.next_after!]); }}>Next workflows</button></div>
    </> : <>{selected.deleted ? <p className="notice">Workflow has been deleted. Saved results can still be read.</p> : <form onSubmit={event => { event.preventDefault(); if (!locked) void execute({ kind: 'run', workflow: selected, path: `/api/workflows/${selected.id}/run`, body: { id: crypto.randomUUID(), revision: selected.revision, input } }); }}><label>Workflow input<textarea maxLength={16000} value={input} readOnly={locked} onChange={event => setInput(event.target.value)} /></label><button disabled={locked}>Run version {selected.revision}</button></form>}
      {!selected.deleted && <><button className="secondary" disabled={locked} onClick={() => { if (window.confirm(`Delete workflow ${selected.name}? Schedules are stopped and the webhook URL is revoked. Saved results remain available. Active runs must be stopped first.`)) void execute({ kind: 'delete', workflow: selected, path: `/api/workflows/${selected.id}/delete`, body: { id: crypto.randomUUID(), revision: selected.revision } }); }}>Delete workflow</button>
      <WorkflowSchedule key={`schedule:${selected.id}`} workflow={selected.id} request={request} locked={locked} refresh={scheduleRefresh} conflict={scheduleConflict === selected.id} onLoaded={() => setScheduleConflict(current => current === selected.id ? '' : current)} pending={pending?.kind === 'schedule' && pending.workflow?.id === selected.id ? pending : undefined} onSave={async body => { await execute({ kind: 'schedule', workflow: selected, path: `/api/workflows/${selected.id}/schedule`, body }); }} onRun={id => { navigate(); setRun(null); setRunId(id); }} />
      <WorkflowWebhook key={`hook:${selected.id}`} workflow={selected.id} request={request} locked={locked} busy={busy} refresh={hookRefresh} secret={hookSecret?.workflow === selected.id ? hookSecret.value : undefined} conflict={hookConflict === selected.id} onLoaded={() => setHookConflict(current => current === selected.id ? '' : current)} pending={pending?.kind === 'webhook' && pending.workflow?.id === selected.id ? pending : undefined} onSave={async body => { await execute({ kind: 'webhook', workflow: selected, path: `/api/workflows/${selected.id}/webhook`, body }); }} onRun={id => { navigate(); setRun(null); setRunId(id); }} />
      <WorkflowVersions key={selected.id} workflow={selected} request={request} locked={locked} refresh={refresh} onRestore={version => void execute({ kind: 'restore', workflow: selected, path: `/api/workflows/${selected.id}/restore`, body: { id: crypto.randomUUID(), revision: selected.revision, version } })} /></>}
      <h2>Run history</h2>{!runs ? <p role="status">Loading run history...</p> : !runs.length ? <p>No runs on this page yet.</p> : <ul className="routine-list">{runs.map(item => <li key={item.id}><button className="secondary" aria-pressed={runId === item.id} onClick={() => { navigate(); setRun(null); setRunId(item.id); }}>{new Date(item.created).toLocaleString('en-US')} · {statuses[item.status] ?? item.status}</button></li>)}</ul>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={!runCursors.length} onClick={() => setRunCursors(value => value.slice(0, -1))}>Newer runs</button><button className="secondary" disabled={runs?.length !== 20} onClick={() => { if (runs?.length) setRunCursors(value => [...value, runs.at(-1)!.seq]); }}>Older runs</button></div>
      {run && <section><h2>Version {run.version} · {statuses[run.status]}</h2>{run.error && <p className="error">{run.error}</p>}
        <RunGraph key={run.id} run={run} />
        {run.status === 'failed' && ['agent', 'model', 'condition'].includes(run.graph.nodes.find(node => node.id === run.cursor)?.kind ?? '') && run.steps.length < run.graph.maxSteps && <button className="secondary" disabled={locked} onClick={() => { if (window.confirm('Retry the failed step? Previous effects may already have occurred. The latest node settings of the same type will be used; previous results remain saved.')) void execute({ kind: 'retry', workflow: selected, path: `/api/workflow-runs/${run.id}/retry`, body: { id: crypto.randomUUID(), revision: run.revision } }); }}>Retry failed step</button>}
        {run.status === 'waiting' && run.graph.nodes.find(node => node.id === run.cursor)?.kind === 'wait' && <EventConnection key={`${run.id}:${run.steps.at(-1)?.seq}`} path={`/api/workflow-waits/${run.id}/${run.steps.at(-1)!.seq}`} request={request} />}
        {run.status === 'approval' && <><p>{run.graph.nodes.find(node => node.id === run.cursor)?.kind === 'approval' ? (run.graph.nodes.find(node => node.id === run.cursor) as { prompt: string }).prompt : ''}</p><div className="form-actions routine-actions">{[true, false].map(accepted => <button key={String(accepted)} disabled={locked} onClick={() => void execute({ kind: 'approve', workflow: selected, path: `/api/workflow-runs/${run.id}/approve`, body: { id: crypto.randomUUID(), revision: run.revision, accepted } })}>{accepted ? 'Approve step' : 'Reject step'}</button>)}</div></>}
        {!['done', 'failed', 'cancelled'].includes(run.status) && <button className="secondary" disabled={locked} onClick={() => { if (window.confirm('Cancel the workflow and its active step? Saved results remain available.')) void execute({ kind: 'cancel', workflow: selected, path: `/api/workflow-runs/${run.id}/cancel`, body: { id: crypto.randomUUID(), revision: run.revision } }); }}>Cancel workflow</button>}
        <p className="message-text">{run.last}</p><ol className="routine-list">{run.steps.map(step => <li key={step.seq}><strong>{step.node}</strong><p>{workflowStepLabel(step)}</p>{step.detail && <p>{step.detail}</p>}{step.thread && step.agent && <button ref={element => { if (element) stepButtons.current.set(step.seq, element); else stepButtons.current.delete(step.seq); }} className="secondary" onClick={() => { navigate(); returnStep.current = step.seq; setConversation({ thread: step.thread!, agent: step.agent!, node: step.node }); }}>Open step {step.node}</button>}</li>)}</ol>
      </section>}
    </>}
  </section>;
}
