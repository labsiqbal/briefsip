import { useEffect, useRef, useState, type FormEvent } from 'react';
import { WorkflowGraph as GraphView } from './WorkflowGraph';
import { editWorkflowHistory, moveWorkflowNode, restoreWorkflowEditorDraft, workflowAutosaveDraft, workflowDraftMatches, workflowUnconditionalCycles, type WorkflowHistory } from '../workflow-editor-state';
import { removeWorkflowNode, validateWorkflow, type WorkflowGraph, type WorkflowNode } from '../workflows.ts';

export type Workflow = { id: string; agent: string; name: string; revision: number; graph: WorkflowGraph; deleted?: number };
export type WorkflowDraft = { name: string; graph: WorkflowGraph; revision: number };
type Agent = { id: string; name: string; model: string };

export function WorkflowEditor({ owner, agents, request, initial, saved, reload = 0, locked: parentLocked, draftKey, pendingSave, onReload, onSave, onBack }: {
  owner: Agent; agents: Agent[]; initial?: WorkflowDraft; saved?: WorkflowDraft; locked: boolean;
  request: <T>(path: string, data?: unknown) => Promise<T>;
  reload?: number;
  draftKey: string; pendingSave: boolean; onReload: () => void;
  onSave: (draft: WorkflowDraft, automatic?: boolean) => Promise<boolean>; onBack: () => void;
}) {
  const [channels, setChannels] = useState<{ id: string; name: string; archived: number; members: string[] }[] | null>(null);
  const [channelError, setChannelError] = useState(''), [channelRefresh, setChannelRefresh] = useState(0);
  useEffect(() => {
    let stopped = false; setChannelError('');
    void request<NonNullable<typeof channels>>('/api/channels').then(rows => { if (!stopped) setChannels(rows.filter(row => !row.archived && row.members.includes(owner.id))); }).catch(error => { if (!stopped) setChannelError(error.message); });
    return () => { stopped = true; };
  }, [owner.id, channelRefresh]);
  const [recovery, setRecovery] = useState(() => {
    try { return { draft: restoreWorkflowEditorDraft(sessionStorage.getItem(draftKey)), invalid: false, held: pendingSave }; }
    catch { return { draft: null, invalid: true, held: pendingSave }; }
  });
  const [draftConflict, setDraftConflict] = useState(!!recovery.draft && recovery.draft.revision !== (saved?.revision ?? 0));
  const locked = parentLocked || recovery.invalid || recovery.held || draftConflict;
  const [name, setName] = useState((!recovery.held ? recovery.draft?.name : undefined) ?? initial?.name ?? '');
  const [history, setHistory] = useState<WorkflowHistory>({ past: [], future: [], graph: (!recovery.held ? recovery.draft?.graph : undefined) ?? initial?.graph ?? { entry: 'work', maxSteps: 20, nodes: [
    { id: 'work', kind: 'agent', agent: owner.id, prompt: '', next: 'review' },
    { id: 'review', kind: 'approval', prompt: 'Setujui hasil untuk menyelesaikan workflow?', yes: 'output' },
    { id: 'output', kind: 'output' },
  ] } });
  const graph = history.graph, cycles = workflowUnconditionalCycles(history.graph);
  const [selected, setSelected] = useState(graph.entry);
  const panels = useRef(new Map<string, HTMLFieldSetElement>()), buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRemoval = useRef('');
  function setGraph(change: WorkflowGraph | ((graph: WorkflowGraph) => WorkflowGraph)) {
    setHistory(current => editWorkflowHistory(current, typeof change === 'function' ? change(current.graph) : change));
  }
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const saveRef = useRef(onSave), attempted = useRef('');
  saveRef.current = onSave;
  async function submit(value: WorkflowDraft, automatic?: boolean) {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(draftKey); } catch { /* The command path reports unavailable storage. */ }
    const accepted = await saveRef.current(value, automatic);
    if (accepted) try { if (sessionStorage.getItem(draftKey) === raw) sessionStorage.removeItem(draftKey); } catch { /* Keep the recoverable draft if cleanup fails. */ }
    return accepted;
  }
  const draft = workflowAutosaveDraft(name, graph, saved, new Set(agents.map(agent => agent.id)));
  const stamp = draft ? JSON.stringify(draft) : '';
  useEffect(() => {
    if (locked || !stamp || attempted.current === stamp) return;
    const timer = setTimeout(() => {
      attempted.current = stamp; setError('');
      void submit(JSON.parse(stamp) as WorkflowDraft, true);
    }, 400);
    return () => clearTimeout(timer);
  }, [stamp, locked]);
  const dirty = saved ? !workflowDraftMatches(name, graph, saved, new Set(agents.map(agent => agent.id))) : !!recovery.draft || !!name || history.past.length > 0;
  useEffect(() => {
    if (pendingSave || recovery.held || recovery.invalid || draftConflict) return;
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ name, graph, revision: saved?.revision ?? 0 }));
      else sessionStorage.removeItem(draftKey);
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [name, graph, saved?.revision, dirty, draftKey, recovery.invalid, recovery.held, pendingSave, draftConflict]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const heading = useRef<HTMLHeadingElement>(null);
  const appliedReload = useRef(reload);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (appliedReload.current === reload || !saved) return;
    appliedReload.current = reload; attempted.current = '';
    setDraftConflict(false); setRecovery({ draft: null, invalid: false, held: false });
    setHistory(current => editWorkflowHistory(current, saved.graph)); setName(saved.name); setError('');
    heading.current?.focus();
  }, [reload, saved]);
  useEffect(() => {
    if (!focusAfterRemoval.current) return;
    const button = buttons.current.get(focusAfterRemoval.current);
    button?.focus(); button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    focusAfterRemoval.current = '';
  }, [graph]);
  function update(index: number, patch: Partial<WorkflowNode>) {
    setGraph(current => ({ ...current, nodes: current.nodes.map((node, i) => i === index ? { ...node, ...patch } as WorkflowNode : node) }));
  }
  function changeKind(index: number, kind: WorkflowNode['kind']) {
    const id = graph.nodes[index].id, next = graph.nodes.find(node => node.id !== id)?.id ?? id;
    const node: WorkflowNode = kind === 'output' ? { id, kind } : kind === 'approval' ? { id, kind, prompt: '', yes: next }
      : kind === 'condition' ? { id, kind, operator: 'equals', value: '', yes: next, no: next }
        : kind === 'agent' ? { id, kind, agent: owner.id, prompt: '', next } : { id, kind, model: owner.model, prompt: '', next };
    setGraph(current => ({ ...current, nodes: current.nodes.map((item, i) => i === index ? node : item) }));
  }
  const targets = [<option key="" value="">Pilih langkah</option>, ...graph.nodes.map(node => <option key={node.id} value={node.id}>{node.id}</option>)];
  async function save(event: FormEvent) {
    event.preventDefault(); if (locked) return;
    try {
      const validated = validateWorkflow(graph, new Set(agents.map(agent => agent.id)));
      setError(''); await submit({ name: name.trim(), graph: validated, revision: saved?.revision ?? initial?.revision ?? 0 });
    } catch (error) { setError(error instanceof Error ? error.message : 'Workflow belum tersimpan.'); }
  }
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>{initial ? 'Edit workflow' : 'Workflow baru'}</h1>
    <p className="muted">Susun langkah dan tujuan berikutnya. Persetujuan menunggu keputusan Anda. Perubahan tersimpan hanya berlaku untuk eksekusi baru.</p>
    {recovery.held && !pendingSave && <p className="notice" role="alert">Permintaan sudah selesai. Periksa draft lokal sebelum melanjutkan edit. <button type="button" className="secondary" disabled={parentLocked} onClick={() => {
      try {
        const local = restoreWorkflowEditorDraft(sessionStorage.getItem(draftKey));
        setRecovery({ draft: local, invalid: false, held: false });
        setDraftConflict(!!local && local.revision !== (saved?.revision ?? 0));
        if (local) { setName(local.name); setHistory(current => editWorkflowHistory(current, local.graph)); }
      } catch { setRecovery({ draft: null, invalid: true, held: false }); }
    }}>Periksa draft lokal</button></p>}
    {storageError && <p className="error" role="alert">Draft belum tersimpan di browser. Jangan tutup halaman sebelum menyimpan ke server.</p>}
    {recovery.invalid && <p className="error" role="alert">Draft browser tidak dapat dibaca. <button type="button" className="secondary" onClick={() => { if (window.confirm('Buang draft browser yang tidak dapat dibaca?')) try { sessionStorage.removeItem(draftKey); setRecovery({ draft: null, invalid: false, held: false }); } catch { setStorageError(true); } }}>Buang draft browser</button></p>}
    {draftConflict && <p className="notice" role="alert">Draft berasal dari revisi lama. Muat versi terbaru sebelum menyimpan; graph draft tetap tersedia lewat Urungkan graph. <button type="button" className="secondary" disabled={parentLocked} onClick={onReload}>Muat versi terbaru</button></p>}
    {saved && <p className="muted" role="status">{locked ? 'Penyimpanan menunggu konfirmasi atau pemulihan.' : !dirty ? `Tersimpan, versi ${saved.revision}.` : draft ? attempted.current === stamp ? 'Perubahan belum tersimpan. Gunakan Simpan workflow untuk mencoba lagi.' : 'Perubahan disimpan otomatis setelah jeda mengetik.' : 'Lengkapi graph dan nama agar perubahan dapat disimpan.'}</p>}
    <form onSubmit={event => void save(event)}><fieldset disabled={locked}>
      <label>Nama workflow<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Langkah awal<select required value={graph.entry} onChange={event => setGraph({ ...graph, entry: event.target.value })}>{targets}</select></label>
      <label>Batas langkah<input type="number" min={1} max={1000} required value={graph.maxSteps} onChange={event => setGraph({ ...graph, maxSteps: Number(event.target.value) })} /><span className="muted">Loop berhenti dengan status gagal jika batas ini tercapai.</span></label>
      <div className="form-actions routine-actions"><button type="button" className="secondary" disabled={!history.past.length} onClick={() => setHistory(current => editWorkflowHistory(current, 'undo'))}>Urungkan graph</button><button type="button" className="secondary" disabled={!history.future.length} onClick={() => setHistory(current => editWorkflowHistory(current, 'redo'))}>Ulangi graph</button><button type="button" className="secondary" disabled={!graph.positions} onClick={() => { const { positions, ...automatic } = graph; void positions; setGraph(automatic); }}>Rapikan otomatis</button></div>
      <p className="muted">Pilih langkah pada graph untuk membuka pengaturannya. Urungkan dan ulangi berlaku untuk perubahan graph, bukan nama workflow.</p>
      {!!cycles.length && <p className="notice" role="status">Loop tanpa kondisi: {cycles.map(cycle => cycle.join(', ')).join('; ')}. Loop berhenti jika persetujuan ditolak, eksekusi dibatalkan, atau batas langkah tercapai.</p>}
      <GraphView graph={graph} loops={new Set(cycles.flat())} onMove={(id, x, y) => { setSelected(id); setGraph(current => moveWorkflowNode(current, id, x, y)); }} selected={selected} locked={locked} buttonRefs={buttons.current} onSelect={id => { setSelected(id); panels.current.get(id)?.focus(); panels.current.get(id)?.scrollIntoView({ block: 'nearest' }); }} />
      {graph.nodes.map((node, index) => <fieldset className="workflow-node" key={node.id} tabIndex={-1} ref={element => { if (element) panels.current.set(node.id, element); else panels.current.delete(node.id); }}><legend>Langkah {node.id}</legend>
        <button type="button" className="secondary" onClick={() => { setSelected(node.id); buttons.current.get(node.id)?.focus(); buttons.current.get(node.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }}>Kembali ke graph {node.id}</button>
        <label>Jenis langkah<select value={node.kind} onChange={event => changeKind(index, event.target.value as WorkflowNode['kind'])}><option value="agent">Agent</option><option value="model">Model</option><option value="condition">Kondisi</option><option value="approval">Persetujuan</option><option value="output">Output</option></select></label>
        {node.kind === 'agent' && <label>Agent pelaksana<select value={node.agent} onChange={event => update(index, { agent: event.target.value })}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name.length > 24 ? agent.name.slice(0, 21) + '...' : agent.name}</option>)}</select><span className="flow-selected-name muted">{agents.find(agent => agent.id === node.agent)?.name}</span></label>}
        {node.kind === 'model' && <label>Model<input required maxLength={200} value={node.model} onChange={event => update(index, { model: event.target.value })} /></label>}
        {'prompt' in node && <label>{node.kind === 'approval' ? 'Pertanyaan persetujuan' : 'Instruksi langkah'}<textarea required maxLength={node.kind === 'approval' ? 4000 : 16000} rows={3} value={node.prompt} onChange={event => update(index, { prompt: event.target.value })} /></label>}
        {node.kind === 'condition' && <><label>Evaluasi kondisi<select value={node.operator} onChange={event => {
          const operator = event.target.value as 'equals' | 'contains' | 'model';
          const base = { id: node.id, kind: 'condition' as const, value: node.value, yes: node.yes, no: node.no };
          const replacement: WorkflowNode = operator === 'model' ? { ...base, operator, model: owner.model } : { ...base, operator };
          setGraph(current => ({ ...current, nodes: current.nodes.map((item, i) => i === index ? replacement : item) }));
        }}><option value="equals">Sama persis</option><option value="contains">Mengandung teks</option><option value="model">Penilaian model</option></select></label>{node.operator === 'model' && <label>Model kondisi<input required maxLength={200} value={node.model} onChange={event => update(index, { model: event.target.value })} /></label>}<label>{node.operator === 'model' ? 'Pertanyaan kondisi' : 'Teks pembanding'}<input required={node.operator === 'model'} maxLength={16000} value={node.value} onChange={event => update(index, { value: event.target.value })} /><span className="muted">{node.operator === 'model' ? 'Model menjawab yes atau no tanpa tools. Jawaban lain menggagalkan langkah; hasil sebelumnya tetap diteruskan.' : 'Huruf besar dan kecil dibedakan.'}</span></label></>}
        {'next' in node && <label>Lanjut ke<select required value={node.next} onChange={event => update(index, { next: event.target.value })}>{targets}</select></label>}
        {'yes' in node && <><label>{node.kind === 'approval' ? 'Jika disetujui' : 'Jika cocok'}<select required value={node.yes} onChange={event => update(index, { yes: event.target.value })}>{targets}</select></label>{node.kind === 'condition' ? <label>Jika tidak cocok<select required value={node.no} onChange={event => update(index, { no: event.target.value })}>{targets}</select></label> : <p className="muted">Penolakan menghentikan eksekusi. Hasil sebelumnya tetap tersimpan.</p>}</>}
        {node.kind === 'output' && <><label>Tujuan hasil<select value={node.channel === undefined ? 'inbox' : 'channel'} onChange={event => {
          setGraph(current => ({ ...current, nodes: current.nodes.map(item => item.id === node.id ? { id: node.id, kind: 'output', ...(event.target.value === 'channel' ? { channel: '' } : {}) } : item) }));
        }}><option value="inbox">Inbox workflow</option><option value="channel">Channel dan inbox</option></select></label>
          {node.channel !== undefined && <><label>Channel tujuan<select required value={node.channel} onChange={event => update(index, { channel: event.target.value })}><option value="">Pilih channel</option>{node.channel && !channels?.some(channel => channel.id === node.channel) && <option value={node.channel}>Channel tidak tersedia</option>}{channels?.map(channel => <option key={channel.id} value={channel.id}>{channel.name.length > 24 ? channel.name.slice(0, 21) + '...' : channel.name}</option>)}</select><span className="flow-selected-name muted">{channels?.find(channel => channel.id === node.channel)?.name}</span></label>
            {channelError && <p className="error" role="alert">{channelError}</p>}{!channels && !channelError && <p role="status">Memuat channel...</p>}<button type="button" className="secondary" onClick={() => setChannelRefresh(value => value + 1)}>Muat ulang channel tujuan</button>
            <p className="muted">Hasil dikirim atas nama agent pemilik workflow. Channel harus aktif dan agent masih menjadi anggota saat hasil dikirim.</p></>}
          <p className="muted">Selesaikan workflow dengan hasil langkah terakhir.</p></>}
        <button type="button" className="secondary" disabled={graph.nodes.length === 1} onClick={() => {
          const next = graph.nodes.find(item => item.id !== node.id)?.id;
          if (next) { focusAfterRemoval.current = next; setSelected(next); setGraph(current => removeWorkflowNode(current, node.id)); }
        }}>Hapus langkah {node.id}</button>
      </fieldset>)}
      <button type="button" className="secondary" disabled={graph.nodes.length >= 64} onClick={() => { let n = graph.nodes.length + 1; while (graph.nodes.some(node => node.id === `step${n}`)) n++; setGraph({ ...graph, nodes: [...graph.nodes, { id: `step${n}`, kind: 'output' }] }); }}>Tambah langkah</button>
    </fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="form-actions routine-actions"><button type="button" className="secondary" onClick={() => { if (!dirty || window.confirm('Ada perubahan yang belum tersimpan. Keluar dari editor?')) onBack(); }}>Kembali ke workflow</button><button disabled={locked}>Simpan workflow</button></div></form>
  </section>;
}
