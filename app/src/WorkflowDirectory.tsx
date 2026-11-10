import { useEffect, useRef, useState } from 'react';
import { WorkflowPanel } from './WorkflowPanel';
import { WorkflowInbox } from './WorkflowInbox';
import type { Workflow } from './WorkflowEditor';

type Agent = { id: string; name: string; model: string };
type Page = { workflows: (Workflow & { owner_name: string })[]; next_after: string | null };
export function WorkflowDirectory({ agents, request, onClose, onOpen }: {
  agents: Agent[]; request: <T>(path: string, data?: unknown) => Promise<T>;
  onClose: () => void; onOpen: (owner: string, thread: string) => void;
}) {
  const [page, setPage] = useState<Page | null>(null), [cursors, setCursors] = useState(['']);
  const [deleted, setDeleted] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [refresh, setRefresh] = useState(0), [error, setError] = useState('');
  const [owner, setOwner] = useState(agents[0]?.id ?? '');
  const [opened, setOpened] = useState<Workflow | 'new' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), after = cursors.at(-1)!;
  useEffect(() => {
    if (opened || inbox) return;
    let stopped = false; setPage(null); setError('');
    void request<Page>(`/api/workflows?deleted=${deleted ? 1 : 0}${after ? `&after=${after}` : ''}`).then(data => { if (!stopped) setPage(data); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [after, refresh, opened, deleted, inbox]);
  useEffect(() => { if (!opened && !inbox) heading.current?.focus(); }, [opened, after, inbox]);
  const selectedOwner = agents.find(agent => agent.id === (opened && opened !== 'new' ? opened.agent : owner));
  if (inbox) return <WorkflowInbox request={request} onBack={() => setInbox(false)} />;
  if (opened && selectedOwner) return <WorkflowPanel key={selectedOwner.id} owner={selectedOwner} agents={agents} initial={opened} request={request}
    onNavigate={() => {}} onBack={() => { setOpened(null); setRefresh(value => value + 1); }} onOpen={async (thread, agent) => onOpen(agent, thread)} />;
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Workflow workspace</h1>
    <p>Kelola workflow semua agent. Setiap langkah dapat memakai agent atau model berbeda.</p>
    <button className="secondary" onClick={() => setInbox(true)}>Buka inbox hasil workflow</button>
    <div className="form-actions routine-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Muat ulang daftar workflow</button></div>
    <label className="member-option"><input type="checkbox" checked={deleted} onChange={event => { setDeleted(event.target.checked); setCursors(['']); }} /> Tampilkan workflow yang dihapus</label>
    {error && <p className="error" role="alert">{error}</p>}
    {agents.length ? <form onSubmit={event => { event.preventDefault(); if (selectedOwner) setOpened('new'); }}>
      <label>Agent awal workflow<select value={owner} onChange={event => setOwner(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name.length > 24 ? agent.name.slice(0, 21) + '...' : agent.name}</option>)}</select><span className="flow-selected-name muted">{agents.find(agent => agent.id === owner)?.name}</span></label>
      <button disabled={!selectedOwner}>Buat workflow</button>
    </form> : <p>Buat agent terlebih dahulu untuk menyusun workflow.</p>}
    {!page ? !error && <p role="status">Memuat daftar workflow...</p> : !page.workflows.length ? <p>Belum ada workflow pada halaman ini.</p> : <ul className="routine-list">{page.workflows.map(workflow => <li key={workflow.id}><h2>{workflow.name}</h2><p>{workflow.owner_name} · Versi {workflow.revision} · {workflow.graph.nodes.length} langkah</p><button className="secondary" disabled={!agents.some(agent => agent.id === workflow.agent)} onClick={() => setOpened(workflow)}>Buka workflow {workflow.name}</button></li>)}</ul>}
    <div className="form-actions routine-actions"><button className="secondary" disabled={cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}>Workflow sebelumnya</button><button className="secondary" disabled={!page?.next_after} onClick={() => { if (page?.next_after) setCursors(value => [...value, page.next_after!]); }}>Workflow berikutnya</button></div>
  </section>;
}
