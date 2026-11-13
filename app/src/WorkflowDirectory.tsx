import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WorkflowPanel } from './WorkflowPanel';
import { WorkflowInbox } from './WorkflowInbox';
import type { Workflow } from './WorkflowEditor';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, PageHeader, Row, Section, Select, SkeletonRows } from './ui/kit';
import { ChevronLeft, ChevronRight, Inbox, Plus, RefreshCw, Workflow as WorkflowIcon } from 'lucide-react';

type Agent = { id: string; name: string; model: string };
type Page = { workflows: (Workflow & { owner_name: string })[]; next_after: string | null };
export function WorkflowDirectory({ agents, request, onClose, renderConversation }: {
  agents: Agent[]; request: <T>(path: string, data?: unknown) => Promise<T>;
  onClose: () => void; renderConversation: (thread: string, owner: string) => ReactNode;
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
    onNavigate={() => {}} onBack={() => { setOpened(null); setRefresh(value => value + 1); }} renderConversation={renderConversation} />;
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Workspace workflows" description="Manage workflows for all agents. Each step can use a different agent or model."
      actions={<><Button variant="ghost" onClick={onClose}>Back</Button><IconButton label="Reload" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton><Button onClick={() => setInbox(true)} icon={<Inbox size={14} aria-hidden />}>Results inbox</Button><Button variant="primary" disabled={!selectedOwner} type="submit" form="create-workflow" icon={<Plus size={14} aria-hidden />}>Create workflow</Button></>} />
    {error && <Alert tone="error">{error}</Alert>}
    <Section title="Workflow library" actions={<Checkbox label="Show deleted" checked={deleted} onChange={value => { setDeleted(value); setCursors(['']); }} />}>
      {agents.length ? <form id="create-workflow" onSubmit={event => { event.preventDefault(); if (selectedOwner) setOpened('new'); }} className="k-grid-2">
        <Field label="Workflow starting agent" hint={agents.find(agent => agent.id === owner)?.name}><Select value={owner} onChange={setOwner} options={agents.map(agent => ({ value: agent.id, label: agent.name.length > 24 ? agent.name.slice(0, 21) + '...' : agent.name }))} /></Field>
      </form> : <EmptyState icon={<WorkflowIcon size={18} />} title="No agents yet">Create an agent first to build a workflow.</EmptyState>}
      {!page ? !error && <><span className="sr-only" role="status">Loading workflow list...</span><SkeletonRows /></> : !page.workflows.length ? <EmptyState icon={<WorkflowIcon size={18} />} title="No workflows on this page yet" /> : <Card>{page.workflows.map(workflow => <Row key={workflow.id} title={workflow.name} leading={<WorkflowIcon size={16} aria-hidden />} onClick={() => setOpened(workflow)} disabled={!agents.some(agent => agent.id === workflow.agent)} meta={<><span>{workflow.owner_name}</span><Badge>Version {workflow.revision}</Badge><span>{workflow.graph.nodes.length} steps</span></>} />)}</Card>}
      {(cursors.length > 1 || page?.next_after) && <div className="k-pager"><IconButton label="Previous workflows" disabled={cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Next workflows" disabled={!page?.next_after} onClick={() => { if (page?.next_after) setCursors(value => [...value, page.next_after!]); }}><ChevronRight size={16} aria-hidden /></IconButton></div>}
    </Section>
  </div>;
}
