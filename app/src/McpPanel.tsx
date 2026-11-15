import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Ellipsis, Plug, Plus, RefreshCw } from 'lucide-react';
import { ActionMenu, Alert, Badge, Button, Card, Checkbox, CodeBlock, Collapsible, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, Select, SkeletonRows, Switch, useConfirm, RecoveryAlert } from './ui/kit';
type Connection = { id: string; name: string; url: string; hasToken: boolean; enabled: number; revision: number };
type Tool = { name: string; title?: string; description?: string; inputSchema: unknown; _meta?: Record<string, unknown> };
const label = (tool: Tool) => `${tool._meta?.['briefsip.kind'] === 'resource-template' ? 'Resource template: ' : tool._meta?.['briefsip.kind'] === 'resource' ? 'Resource: ' : tool._meta?.['briefsip.kind'] === 'prompt' ? 'Prompt: ' : 'Tool: '}${tool.title && tool.title !== tool.name && !tool._meta?.['briefsip.kind'] ? `${tool.title} (${tool.name})` : tool.title ?? tool.name}`;
type Detail = Connection & { tools: Tool[]; grant: { revision: number; tools: string[] } };
type Command = { path: string; body: Record<string, unknown> & { id: string } };
function restore(raw: string | null): Command | null {
  if (raw === null) return null;
  if (raw.length > 16000) throw new Error('MCP recovery data is too large.');
  const value = JSON.parse(raw), uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (!value || typeof value.path !== 'string' || !new RegExp(`^/api/(mcp(?:/${uuid}(?:/remove)?)?|agents/${uuid}/mcp/${uuid})$`, 'i').test(value.path) || !value.body || typeof value.body !== 'object' || !new RegExp(`^${uuid}$`, 'i').test(value.body.id) || Object.keys(value.body).some(key => !['id', 'test', 'revision', 'enabled', 'connectionRevision', 'tools', 'confirmed'].includes(key))) throw new Error('MCP recovery data is invalid.');
  return value;
}
export function McpPanel({ agents, request, project }: { project?: string; agents: { id: string; name: string }[]; request: <T>(path: string, body?: unknown) => Promise<T>; onClose: () => void }) {
  const storage = 'briefsip:mcp-command'+(project?`:${project}`:'');
  const [recovery] = useState(() => { try { return { command: restore(sessionStorage.getItem(storage)), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.command), [invalid, setInvalid] = useState(recovery.invalid);
  const [page, setPage] = useState<{ items: Connection[]; next_after: string | null } | null>(null), [cursors, setCursors] = useState(['']);
  const [agent, setAgent] = useState(agents[0]?.id ?? ''), [selected, setSelected] = useState(''), [detail, setDetail] = useState<Detail | null>(null), [tools, setTools] = useState<string[]>([]);
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [token, setToken] = useState('');
  const [editing, setEditing] = useState<Connection | null>(null), [rotate, setRotate] = useState(false);
  const [tested, setTested] = useState<{ id: string; tools: Tool[]; expires: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), reads = useRef(0), flight = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const [showForm, setShowForm] = useState(false);
  const confirm = useConfirm();
  const locked = busy || !!pending || invalid, after = cursors.at(-1)!;
  useEffect(() => { heading.current?.focus(); return () => { generation.current++; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [after, selected]);
  useEffect(() => {
    let stopped = false; const current = ++reads.current; setPage(null); setDetail(null); setError('');
    void Promise.all([request<NonNullable<typeof page>>(`/api/mcp${after ? `?after=${after}` : ''}`), selected && agent ? request<Detail>(`/api/mcp/${selected}?agent=${agent}`) : Promise.resolve(null)]).then(([page, detail]) => { if (!stopped && current === reads.current) { setPage(page); setDetail(detail); setTools(detail?.grant.tools ?? []); } }).catch(error => { if (!stopped && current === reads.current) setError(error.message); });
    return () => { stopped = true; };
  }, [after, selected, agent, refresh]);
  async function reload() {
    if (busy || flight.current) return;
    if (!editing || pending || invalid) { setRefresh(value => value + 1); return; }
    if (!await confirm({ title: 'Load the latest connection revision for this draft?', description: 'The entered name and token stay saved, but old test results are discarded. Test again before saving.', confirm: 'Reload' })) return;
    const current = generation.current; flight.current = true; setBusy(true); setError(''); setTested(null);
    try { const latest = await request<Detail>(`/api/mcp/${editing.id}`); if (current === generation.current) { setEditing(latest); setRefresh(value => value + 1); } }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Connection could not reload.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function test() {
    if (flight.current || locked) return;
    const current = generation.current; flight.current = true; setBusy(true); setError(''); setTested(null);
    try { const result = await request<NonNullable<typeof tested>>('/api/mcp/test', { id: crypto.randomUUID(), name, ...(editing ? { connection: editing.id, revision: editing.revision, ...(rotate ? { token } : {}) } : { url, token }) }); if (current === generation.current) setTested(result); }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Connection test failed.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function execute(command: Command) {
    if (flight.current || busy || invalid) return;
    const current = generation.current;
    try {
      restore(JSON.stringify(command)); sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command); setBusy(true); flight.current = true; reads.current++; setError('');
      await request(command.path, command.body);
      if (current !== generation.current) return;
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      setPending(null);
      if (command.body.test && (editing ? command.path === `/api/mcp/${editing.id}` : command.path === '/api/mcp')) { setTested(null); setEditing(null); setRotate(false); setToken(''); setName(''); setUrl(''); setShowForm(false); }
      else if (editing && command.path === `/api/mcp/${editing.id}`) setTested(null);
      if(command.path.endsWith('/remove')){setSelected('');setDetail(null);}
      setRefresh(value => value + 1); heading.current?.focus();
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Changes are not confirmed yet. Try again.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  const ignoreRecovery = <Button size="sm" disabled={busy} onClick={async () => { if (!await confirm({ title: 'Ignore the saved request?', description: 'Changes may already have succeeded. Check the list after it reloads.', confirm: 'Ignore' })) return; try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); } catch { setError('Browser storage could not be updated.'); } }}>Ignore recovery</Button>;
  const recoveryNotice = <>
    {invalid && <Alert tone="error" title="MCP recovery data could not be read." actions={!pending && ignoreRecovery} />}
    {pending && <RecoveryAlert inFlight={busy} tone="warn" title="Changes are not confirmed yet" actions={<><Button size="sm" variant="primary" disabled={busy} onClick={() => void execute(pending)}>Retry change</Button>{ignoreRecovery}</>}>Retry sends the same saved request.</RecoveryAlert>}
  </>;
  const host = (value: string) => { try { return new URL(value).host; } catch { return value; } };
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="MCP connections" description={project?'Connect services for this project, then grant catalog access to its member agents.':'Connect external services, then choose which tools, resources, and prompts each agent may use in private conversations.'}
      actions={<><IconButton label="Reload" disabled={busy} onClick={() => void reload()}><RefreshCw size={15} aria-hidden /></IconButton><Button variant="primary" icon={<Plus size={14} aria-hidden />} disabled={locked} onClick={() => setShowForm(true)}>{editing ? 'Continue update' : 'Add connection'}</Button></>} />
    <Alert>Tools can change data in the target service. Resources and prompts are untrusted reference data. Binary results become conversation files.</Alert>
    {error && <Alert tone="error">{error}</Alert>}
    {recoveryNotice}

    <Section id="mcp-connections" title="Connections">
      {!page ? !error && <><span className="sr-only" role="status">Loading connections...</span><SkeletonRows /></> : page.items.length ? <Card>{page.items.map(row => <Row key={row.id} title={row.name} leading={<Plug size={16} aria-hidden />}
        meta={<><span title={row.url}>{host(row.url)}</span><Badge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'Active' : 'Inactive'}</Badge><span>{row.hasToken ? 'Token saved' : 'No token'}</span></>}
        trailing={<ActionMenu label={`Menu ${row.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Menu ${row.name}`} disabled={locked}><Ellipsis size={16} aria-hidden /></button>} items={[
          { label: `Update ${row.name}`, onSelect: async () => { if ((name || url || token) && !await confirm({ title: 'Discard the current connection draft and open this connection?', confirm: 'Discard draft', danger: true })) return; generation.current++; setEditing(row); setName(row.name); setUrl(row.url); setToken(''); setRotate(false); setTested(null); heading.current?.focus(); setShowForm(true); } },
          { label: `Manage permissions for ${row.name}`, disabled: !agent, onSelect: () => { generation.current++; reads.current++; setDetail(null); setSelected(row.id); setRefresh(value => value + 1); } },
          {label:`Remove ${row.name}`,danger:true,onSelect:async()=>{if(await confirm({title:`Remove ${row.name}?`,description:'This removes the saved connection and revokes agent access. External effects already completed remain.',confirm:'Remove connection',danger:true}))void execute({path:`/api/mcp/${row.id}/remove`,body:{id:crypto.randomUUID(),confirmed:true}});}},
          'separator',
          { label: `${row.enabled ? 'Disable' : 'Enable'} ${row.name}`, onSelect: () => void execute({ path: `/api/mcp/${row.id}`, body: { id: crypto.randomUUID(), revision: row.revision, enabled: !row.enabled } }) },
        ]} />} />)}</Card> : <EmptyState icon={<Plug size={18} />} title="No connections on this page yet." />}
      {(cursors.length > 1 || page?.next_after) && <div className="k-pager">
        <IconButton label="Previous connections" disabled={locked || cursors.length < 2} onClick={() => { generation.current++; setCursors(value => value.slice(0, -1)); }}><ChevronLeft size={16} aria-hidden /></IconButton>
        <IconButton label="Next connections" disabled={locked || !page?.next_after} onClick={() => { generation.current++; setCursors(value => [...value, page!.next_after!]); }}><ChevronRight size={16} aria-hidden /></IconButton>
      </div>}
    </Section>

    <Section id="mcp-agent-access" title="Agent access" actions={<Select size="sm" label="Agent" value={agent} disabled={locked} onChange={value => { generation.current++; reads.current++; setDetail(null); setAgent(value); }} options={agents.map(item => ({ value: item.id, label: item.name.length > 24 ? item.name.slice(0, 21) + '...' : item.name }))} />}>
      <span className="k-field__hint" style={{ overflowWrap: 'anywhere' }}>{agents.find(item => item.id === agent)?.name}</span>
      {detail ? <form onSubmit={async event => { event.preventDefault(); if (!locked && await confirm({ title: 'Allow selected access for this agent?', description: 'Effects in external services may still occur after the task is canceled.', confirm: 'Save access permissions' })) void execute({ path: `/api/agents/${agent}/mcp/${detail.id}`, body: { id: crypto.randomUUID(), revision: detail.grant.revision, connectionRevision: detail.revision, tools } }); }}>
        <fieldset disabled={locked} className="k-fieldset" style={{ padding: 0, border: 0, background: 'none' }}><legend className="k-field__label">Permissions for {detail.name}</legend>
          <Alert>Catalog updates revoke all access permissions; select permissions again afterward. Inactive connections cannot be called.</Alert>
          <Card>{detail.tools.map(tool => <div key={tool.name}>
            <Row title={tool._meta?.['briefsip.kind'] === 'resource-template' ? <label className="k-check__label"><input type="checkbox" aria-describedby={`template-scope-${tool.name}`} checked={tools.includes(tool.name)} onChange={event => setTools(value => event.target.checked ? [...value, tool.name] : value.filter(name => name !== tool.name))} />{label(tool)}</label> : label(tool)}
              meta={tool.description} trailing={tool._meta?.['briefsip.kind'] !== 'resource-template' && <Switch checked={tools.includes(tool.name)} disabled={locked} label={label(tool)} onChange={checked => setTools(value => checked ? [...value, tool.name] : value.filter(name => name !== tool.name))} />} />
            <div className="k-fieldset" style={{ padding: '0 10px 10px' }}>
              {tool._meta?.['briefsip.kind'] === 'resource-template' && <div id={`template-scope-${tool.name}`}><Alert tone="warn">Permissions cover all URIs this template can form, including parameter values chosen by the agent. The target server still controls access to its data.</Alert></div>}
              {typeof tool._meta?.['briefsip.target'] === 'string' && <span className="k-field__hint" style={{ overflowWrap: 'anywhere' }}>{tool._meta['briefsip.target']}</span>}
              <Collapsible title={<>Parameter {label(tool)}</>}><CodeBlock label={`Parameter ${label(tool)}`}>{JSON.stringify(tool.inputSchema, null, 2)}</CodeBlock></Collapsible>
            </div>
          </div>)}</Card>
          <Button type="submit" disabled={locked}>Save access permissions</Button>
        </fieldset>
      </form> : !selected || !agent ? <EmptyState icon={<Plug size={18} />} title={!agent ? 'No agents yet' : 'Select a connection'}>{!agent ? 'Create an agent to manage access.' : 'Choose Manage permissions from a connection menu.'}</EmptyState> : !error && <><span className="sr-only" role="status">Loading permissions...</span><SkeletonRows /></>}
    </Section>

    <Dialog open={showForm} size="lg" onOpenChange={setShowForm} title={editing ? `Update ${editing.name}` : 'New connection'}
      footer={<>
        {editing && <Button className="k-dialog__foot-start" disabled={locked} onClick={() => { setEditing(null); setRotate(false); setName(''); setUrl(''); setToken(''); setTested(null); }}>Cancel update</Button>}
        <Button type="submit" form="mcp-connection" disabled={locked} busy={busy}>Test connection</Button>
        {tested && <Button variant="primary" disabled={locked} onClick={async () => { if (editing && !await confirm({ title: 'Save the tested catalog and token, revoke all access permissions, and stop active MCP calls for this connection?', description: 'External effects that have already occurred cannot be undone.', confirm: 'Save tested update', danger: true })) return; void execute({ path: editing ? `/api/mcp/${editing.id}` : '/api/mcp', body: { id: crypto.randomUUID(), test: tested.id, ...(editing ? { revision: editing.revision } : {}) } }); }}>{editing ? 'Save tested update' : 'Save tested connection'}</Button>}
      </>}>
      {error && <Alert tone="error">{error}</Alert>}
      <form id="mcp-connection" onSubmit={event => { event.preventDefault(); void test(); }}>
        {recoveryNotice}
        <fieldset disabled={locked} className="k-fieldset" style={{ padding: 0, border: 0, background: 'none' }}>
          <Field label="Name"><Input required maxLength={80} value={name} onChange={event => { setName(event.target.value); setTested(null); }} /></Field>
          <Field label="Streamable HTTP URL"><Input required readOnly={!!editing} type="url" maxLength={2000} value={url} onChange={event => { setUrl(event.target.value); setTested(null); }} /></Field>
          {editing && <Checkbox checked={rotate} label="Replace saved token" onChange={checked => { setRotate(checked); setToken(''); setTested(null); }} />}
          {(!editing || rotate) && <Field label="Bearer token" optional><Input type="password" autoComplete="off" maxLength={4096} value={token} onChange={event => { setToken(event.target.value); setTested(null); }} /></Field>}
          <Alert>Tokens are stored encrypted on this host. Saved URLs cannot be changed. OAuth is not available yet. Testing makes a real request to the service.</Alert>
          {editing && <Alert tone="warn">Updating refreshes the catalog and revokes all access permissions for this connection. Select permissions again after saving. The old token is used unless Replace saved token is selected; an empty token removes authentication.</Alert>}
          {tested && <>
            <Alert title="Test passed">{tested.tools.length} items found. Test results are valid for 10 minutes.</Alert>
            <Card>{tested.tools.map(tool => <Row key={tool.name} title={label(tool)} meta={tool.description} />)}</Card>
          </>}
        </fieldset>
      </form>
    </Dialog>
  </div>;
}
